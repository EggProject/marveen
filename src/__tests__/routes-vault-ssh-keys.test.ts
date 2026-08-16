// 100% line + branch coverage for src/web/routes/vault-ssh-keys.ts.
//
// The SUT owns the dispatch surface for /api/vault/ssh-keys[*]. It shells out
// to `ssh-keygen` via execFileSync, writes the temp key under os.tmpdir(),
// and fans out into db.js + vault.js for the persisted state. Every
// collaborator is mocked here so the suite runs against a deterministic fake
// and never touches the live store, the live ssh-keygen, or a real vault
// encryption round-trip.
//
// Branches covered:
//
//   fingerprintFromPubKey (private helper):
//     - parts.length < 2 (single-word input)         -> '' (NO fingerprint)
//     - parts.length >= 2 (real authorized_keys line) -> 'SHA256:...'
//
//   generateSshKeyPair:
//     - happy path: execFileSync runs, fingerprint is non-empty
//     - execFileSync throws -> the exception propagates past the finally
//
//   extractPublicKeyFromVault:
//     - getSecret returns null                       -> returns null
//     - getSecret returns a key string               -> returns extracted public key
//
//   tryHandleVaultSshKeys:
//     - non-matching path                            -> returns false
//     - GET  /api/vault/ssh-keys                     -> 200 with mapped keys
//     - POST /api/vault/ssh-keys (label empty)       -> 400
//     - POST /api/vault/ssh-keys (username empty)    -> 400
//     - POST /api/vault/ssh-keys (keygen throws)     -> 500
//     - POST /api/vault/ssh-keys (success)           -> 201 with key + publicKey
//     - POST /api/vault/ssh-keys/import (fields)     -> 400
//     - POST /api/vault/ssh-keys/import (err.stderr) -> 400 with stderr
//     - POST /api/vault/ssh-keys/import (err.msg)    -> 400 with err.message
//     - POST /api/vault/ssh-keys/import (String(err))-> 400 with String(err)
//     - POST /api/vault/ssh-keys/import (ed25519)    -> 201 (keyType=ed25519)
//     - POST /api/vault/ssh-keys/import (rsa)        -> 201 (keyType=rsa)
//     - POST /api/vault/ssh-keys/import (ecdsa)      -> 201 (keyType=ecdsa)
//     - POST /api/vault/ssh-keys/import (unknown)    -> 201 (keyType=unknown)
//     - POST /api/vault/ssh-keys/import (parts<2)    -> 201 with fingerprint=''
//     - POST /api/vault/ssh-keys/import (no '\n')    -> 201 (newline-appended branch)
//     - POST /api/vault/ssh-keys/import (outer err)  -> 500
//     - POST /api/vault/ssh-keys/import (with '\n')  -> 201 (no-append branch)
//     - GET  /api/vault/ssh-keys/:id/public-key      -> 200
//     - GET  /api/vault/ssh-keys/:id/public-key (nf) -> 404
//     - DELETE /api/vault/ssh-keys/:id (not found)   -> 404 (getVaultSshKey)
//     - DELETE /api/vault/ssh-keys/:id (not deleted) -> 404 (deleted=false)
//     - DELETE /api/vault/ssh-keys/:id (success)     -> 200 + deleteSecret
//     - DELETE /api/vault/ssh-keys/:id (unassigned>0)-> surfaces unassigned
//     - final return false (path doesn't match any sub-handler)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// ---------------------------------------------------------------------------
// Hoisted harness. vi.mock factories below reference H; vi.hoisted keeps it
// in scope inside the hoisted factory closures.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  // db
  listVaultSshKeys: vi.fn<() => unknown[]>(() => []),
  getVaultSshKey: vi.fn<(id: string) => unknown | undefined>(() => undefined),
  createVaultSshKey: vi.fn<(key: Record<string, unknown>) => unknown>((k) => ({ ...k, created_at: Math.floor(Date.now() / 1000) })),
  deleteVaultSshKey: vi.fn<(id: string) => { deleted: boolean; unassigned: number }>(() => ({ deleted: false, unassigned: 0 })),

  // vault
  setSecret: vi.fn(),
  getSecret: vi.fn<(id: string) => string | null>(() => null),
  deleteSecret: vi.fn<() => boolean>(() => true),

  // logger
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),

  // child_process.execFileSync -- the fake ssh-keygen.
  // The SUT calls `ssh-keygen -t ed25519 ...` for generateSshKeyPair and
  // `ssh-keygen -y -f ...` for both extractPublicKeyFromVault and the
  // import handler. The output of `-t ed25519` is unused (the SUT reads
  // the produced files from disk); the output of `-y -f` IS the public key
  // line. Default to a sane ed25519 public-key shape.
  execFileSync: vi.fn<(_f: string, _args: unknown[], _opts: unknown) => Buffer>(() =>
    Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAA user@host\n'),
  ),

  // fs overrides. mkdtempSync/rmSync are stubbed to no-ops so we don't
  // touch the real tmpdir; readFileSync/writeFileSync/chmodSync are driven
  // per-test to simulate the on-disk key files ssh-keygen would write.
  mkdtempCalls: 0,
  rmCalls: 0,
  // Map `path -> bytes` so we can simulate "ssh-keygen wrote a key file" by
  // seeding this map before each test. readFileSync looks up by string path.
  fileBytes: new Map<string, string>(),

  // crypto id counter -- randomBytes(8).toString('hex') is the id used in
  // `ssh-key-${id}`. Make it deterministic.
  idCounter: 0,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('../db.js', () => ({
  listVaultSshKeys: H.listVaultSshKeys,
  getVaultSshKey: H.getVaultSshKey,
  createVaultSshKey: H.createVaultSshKey,
  deleteVaultSshKey: H.deleteVaultSshKey,
}))

vi.mock('../web/vault.js', () => ({
  setSecret: H.setSecret,
  getSecret: H.getSecret,
  deleteSecret: H.deleteSecret,
}))

vi.mock('node:child_process', () => ({
  execFileSync: H.execFileSync,
}))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync: ((_prefix: string) => {
      H.mkdtempCalls += 1
      return `/tmp/marveen-ssh-mock-${H.mkdtempCalls}`
    }) as typeof import('node:fs').mkdtempSync,
    rmSync: ((_p: string, _opts?: unknown) => {
      H.rmCalls += 1
    }) as typeof import('node:fs').rmSync,
    readFileSync: ((p: string | URL, _enc?: unknown) => {
      const key = String(p)
      const v = H.fileBytes.get(key)
      if (v === undefined) {
        // Fall through to real readFileSync (covers any path the SUT did
        // not seed). The SUT only calls readFileSync on the mock tmpdir
        // paths we manage, so this branch should not fire in practice.
        return (actual.readFileSync as unknown as (p: string | URL, e?: unknown) => string)(p, _enc)
      }
      return v
    }) as typeof import('node:fs').readFileSync,
    writeFileSync: ((p: string | URL, data: unknown) => {
      const key = String(p)
      const text = typeof data === 'string' ? data : (data instanceof Buffer ? data.toString('utf-8') : String(data))
      H.fileBytes.set(key, text)
    }) as typeof import('node:fs').writeFileSync,
    chmodSync: (() => {
      // No-op -- the SUT sets 0o600 on the temp key file; we don't care.
    }) as typeof import('node:fs').chmodSync,
  }
})

// Deterministic id counter: every randomBytes(8) returns
// [counter+1, 0, 0, 0, ...] so toString('hex') is a stable 16-char string.
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: ((size: number) => {
      if (size === 8) {
        H.idCounter += 1
        const buf = Buffer.alloc(8)
        buf.writeUInt32BE(H.idCounter, 0)
        buf.writeUInt32BE(0, 4)
        return buf
      }
      // Fall through for any other size (none used here, but defensive).
      return actual.randomBytes(size)
    }) as typeof import('node:crypto').randomBytes,
  }
})

// SUT import (after mocks)
const { tryHandleVaultSshKeys, generateSshKeyPair, extractPublicKeyFromVault } =
  await import('../web/routes/vault-ssh-keys.js')

// ---------------------------------------------------------------------------
// Mock response recorder
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(opts: { body?: unknown; raw?: Buffer | string } = {}): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [typeof opts.raw === 'string' ? Buffer.from(opts.raw) : opts.raw]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(JSON.stringify(opts.body))]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  fullPath: string,
  opts: { body?: unknown; raw?: Buffer | string } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | unknown[] | null }> {
  const urlStr = `http://127.0.0.1:3420${fullPath}`
  const url = new URL(urlStr)
  const req = mkReq({ body: opts.body, raw: opts.raw })
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleVaultSshKeys(ctx as unknown as Parameters<typeof tryHandleVaultSshKeys>[0])
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

// ---------------------------------------------------------------------------
// Defaults -- reset every test so individual assertions stay isolated.
// ---------------------------------------------------------------------------

beforeEach(() => {
  H.listVaultSshKeys.mockReset().mockReturnValue([])
  H.getVaultSshKey.mockReset().mockReturnValue(undefined)
  H.createVaultSshKey.mockReset().mockImplementation((k) => ({ ...k, created_at: Math.floor(Date.now() / 1000) }))
  H.deleteVaultSshKey.mockReset().mockReturnValue({ deleted: false, unassigned: 0 })

  H.setSecret.mockReset()
  H.getSecret.mockReset().mockReturnValue(null)
  H.deleteSecret.mockReset().mockReturnValue(true)

  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()

  H.execFileSync.mockReset()
  H.execFileSync.mockImplementation(() =>
    Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAA user@host\n'),
  )

  H.mkdtempCalls = 0
  H.rmCalls = 0
  H.fileBytes.clear()
  H.idCounter = 0
})

// ===========================================================================
// Surface-level guard
// ===========================================================================

describe('tryHandleVaultSshKeys -- surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/something/else')
    expect(handled).toBe(false)
  })

  it('returns false for a path that startsWith matches but no subroute does', async () => {
    // /api/vault/ssh-keys/extra/extra is not matched by either the
    // public-key regex (`/.../public-key$`) or the delete regex
    // (`/...$` with no trailing path segment).
    const { handled } = await call('GET', '/api/vault/ssh-keys/x/y')
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// GET /api/vault/ssh-keys
// ===========================================================================

describe('GET /api/vault/ssh-keys', () => {
  it('returns 200 with each key mapped through toApiShape', async () => {
    const created = 1700000000
    H.listVaultSshKeys.mockReturnValue([
      {
        id: 'abc',
        label: 'l1',
        username: 'u1',
        vault_key_id: 'ssh-key-abc',
        public_key: 'ssh-ed25519 AAAA pub1',
        fingerprint: 'SHA256:fp1',
        key_type: 'ed25519',
        created_at: created,
      },
      {
        id: 'def',
        label: 'l2',
        username: 'u2',
        vault_key_id: 'ssh-key-def',
        public_key: 'ssh-rsa AAAA pub2',
        fingerprint: 'SHA256:fp2',
        key_type: 'rsa',
        created_at: created + 60,
      },
    ])
    const { res, json } = await call('GET', '/api/vault/ssh-keys')
    expect(res.statusCode).toBe(200)
    const body = json() as { keys: Array<Record<string, unknown>> }
    expect(body.keys).toHaveLength(2)
    expect(body.keys[0]).toMatchObject({
      id: 'abc',
      label: 'l1',
      username: 'u1',
      publicKey: 'ssh-ed25519 AAAA pub1',
      fingerprint: 'SHA256:fp1',
      keyType: 'ed25519',
    })
    expect(body.keys[0].createdAt).toBe(new Date(created * 1000).toISOString())
    expect(body.keys[1].keyType).toBe('rsa')
  })

  it('returns an empty list when there are no keys', async () => {
    const { res, json } = await call('GET', '/api/vault/ssh-keys')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ keys: [] })
  })
})

// ===========================================================================
// POST /api/vault/ssh-keys
// ===========================================================================

describe('POST /api/vault/ssh-keys', () => {
  it('returns 400 when label is missing (or non-string)', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys', { body: { username: 'u' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label and username are required' })
  })

  it('returns 400 when username is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys', { body: { label: 'l' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label and username are required' })
  })

  it('returns 400 when both fields are missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label and username are required' })
  })

  it('returns 500 when generateSshKeyPair throws (keygen failure)', async () => {
    H.execFileSync.mockImplementation(() => { throw new Error('keygen blew up') })
    const { res, json } = await call('POST', '/api/vault/ssh-keys', {
      body: { label: 'l', username: 'u' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Key generation failed: keygen blew up' })
    expect(H.loggerError).toHaveBeenCalled()
  })

  it('returns 500 with String(err) when the thrown error has no .message', async () => {
    H.execFileSync.mockImplementation(() => { throw 'bare-string-error' })
    const { res, json } = await call('POST', '/api/vault/ssh-keys', {
      body: { label: 'l', username: 'u' },
    })
    expect(res.statusCode).toBe(500)
    // 'bare-string-error'.toString() == "bare-string-error"
    expect(json()).toEqual({ error: 'Key generation failed: bare-string-error' })
  })

  it('returns 201 with the new key and publicKey on success', async () => {
    // Seed the mock fs so generateSshKeyPair reads back the keypair from
    // the temp dir ssh-keygen would have written. The path is mkdtempSync
    // output followed by '/key' or '/key.pub'.
    H.execFileSync.mockImplementation((file: string, args: unknown[]) => {
      // -t ed25519 ... -f keyPath -> we don't care about stdout.
      if ((args as string[]).includes('-t')) return Buffer.alloc(0)
      // -y -f keyPath -> the public key line.
      return Buffer.from('ssh-ed25519 AAAAFAKE user@host\n')
    })
    // We don't know the temp path up front; the mock returns a synthetic
    // `/tmp/marveen-ssh-mock-<n>` directory. Seed both possible filenames.
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key', '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n')
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key.pub', 'ssh-ed25519 AAAAFAKE user@host\n')

    const { res, json } = await call('POST', '/api/vault/ssh-keys', {
      body: { label: 'l', username: 'u' },
    })
    expect(res.statusCode).toBe(201)
    const body = json() as { key: Record<string, unknown>; publicKey: string }
    expect(body.publicKey).toBe('ssh-ed25519 AAAAFAKE user@host')
    expect(body.key).toMatchObject({
      label: 'l',
      username: 'u',
      publicKey: 'ssh-ed25519 AAAAFAKE user@host',
      keyType: 'ed25519',
    })
    // id follows `randomBytes(8).toString('hex')`; with the id counter
    // starting at 1 the first id is 00000001/00000000 hex. toApiShape
    // surfaces `id` (NOT vault_key_id) on the API.
    expect(body.key.id).toBe('0000000100000000')
    // setSecret called with the labelled private key payload.
    expect(H.setSecret).toHaveBeenCalledWith(
      'ssh-key-0000000100000000',
      'SSH private key: l',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
    )
    expect(H.createVaultSshKey).toHaveBeenCalledOnce()
    expect(H.loggerInfo).toHaveBeenCalledOnce()
  })

  it('trims whitespace from label and username before generating the key', async () => {
    H.execFileSync.mockImplementation((_file: string, args: unknown[]) => {
      if ((args as string[]).includes('-t')) return Buffer.alloc(0)
      return Buffer.from('ssh-ed25519 AAAABBBB user@host\n')
    })
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key', 'priv')
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key.pub', 'ssh-ed25519 AAAABBBB user@host\n')

    const { res, json } = await call('POST', '/api/vault/ssh-keys', {
      body: { label: '  spaced  ', username: '  userx  ' },
    })
    expect(res.statusCode).toBe(201)
    const body = json() as { key: Record<string, unknown> }
    expect(body.key.label).toBe('spaced')
    expect(body.key.username).toBe('userx')
  })
})

// ===========================================================================
// POST /api/vault/ssh-keys/import
// ===========================================================================

describe('POST /api/vault/ssh-keys/import', () => {
  it('returns 400 when label is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { username: 'u', privateKey: '-----BEGIN----' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label, username and privateKey are required' })
  })

  it('returns 400 when username is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', privateKey: '-----BEGIN----' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label, username and privateKey are required' })
  })

  it('returns 400 when privateKey is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'label, username and privateKey are required' })
  })

  it('returns 400 with the ssh-keygen stderr when the private key is invalid', async () => {
    H.execFileSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('load failed')
      // execFileSync attaches stderr as a Buffer when ssh-keygen fails.
      err.stderr = Buffer.from('load failed: invalid format\n')
      throw err
    })
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: '-----BEGIN----\nbroken\n' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid private key: load failed: invalid format' })
    // The inner catch returns BEFORE the outer catch -- so logger.error
    // for "Failed to import SSH key" must NOT have fired.
    expect(H.loggerError).not.toHaveBeenCalled()
  })

  it('returns 400 with err.message when the failure has no stderr', async () => {
    H.execFileSync.mockImplementation(() => {
      throw new Error('no-keygen')
    })
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid private key: no-keygen' })
  })

  it('returns 400 with String(err) when the failure has no stderr AND no message', async () => {
    H.execFileSync.mockImplementation(() => {
      // A bare object with no message and no stderr.
      throw {}
    })
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid private key: [object Object]' })
  })

  it('imports an ed25519 key (keyType=ed25519) and returns 201', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('ssh-ed25519 AAAAED user@host'))
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(201)
    const body = json() as { key: Record<string, unknown>; publicKey: string }
    expect(body.key.keyType).toBe('ed25519')
    expect(body.publicKey).toBe('ssh-ed25519 AAAAED user@host')
    expect(body.key.fingerprint).toMatch(/^SHA256:/)
    expect(H.setSecret).toHaveBeenCalledWith('ssh-key-0000000100000000', 'SSH private key: l', 'pk')
    expect(H.createVaultSshKey).toHaveBeenCalledOnce()
    expect(H.loggerInfo).toHaveBeenCalledOnce()
  })

  it('imports an ssh-rsa key (keyType=rsa) and returns 201', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('ssh-rsa AAARSAKEY user@host'))
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(201)
    expect((json() as { key: Record<string, unknown> }).key.keyType).toBe('rsa')
  })

  it('imports an ecdsa key (keyType=ecdsa) and returns 201', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('ecdsa-sha2-nistp256 AAAECDSA user@host'))
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(201)
    expect((json() as { key: Record<string, unknown> }).key.keyType).toBe('ecdsa')
  })

  it('imports an unrecognised key prefix as keyType=unknown', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('sk-ssh-ed25519@openauth.com AAAA user@host'))
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(201)
    expect((json() as { key: Record<string, unknown> }).key.keyType).toBe('unknown')
  })

  it('returns fingerprint="" when the public key has fewer than 2 space-separated parts', async () => {
    // fingerprintFromPubKey's parts.length < 2 guard: a single-word pub
    // key line. This also exercises the "unknown" key-type branch.
    H.execFileSync.mockImplementation(() => Buffer.from('onewordnopartshere'))
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(201)
    expect((json() as { key: Record<string, unknown> }).key.fingerprint).toBe('')
  })

  it('appends a newline to the private key when one is not present', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('ssh-ed25519 AAAA user@host'))
    let writtenKeyContent: string | undefined
    const origWrite = H.fileBytes.set.bind(H.fileBytes)
    H.fileBytes.set = (k: string, v: string) => {
      if (k.endsWith('/key')) writtenKeyContent = v
      return origWrite(k, v)
    }
    const { res } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'no-trailing-newline' },
    })
    expect(res.statusCode).toBe(201)
    // SUT appended '\n' to the on-disk temp file.
    expect(writtenKeyContent).toBe('no-trailing-newline\n')
  })

  // PINNING TEST for docs/needs-to-be-fix/vault-ssh-keys-endsWith-newline.md.
  //
  // The handler trims privateKey before writing the temp key file, so the
  // written content is always exactly the trimmed key plus ONE newline,
  // whatever trailing whitespace the caller sent. That single newline is
  // what `ssh-keygen -y -f` needs; more than one buys nothing, and the temp
  // file is rmSync'd in the finally block, so nothing about the caller's
  // trailing whitespace is persisted anywhere (the vault stores the trimmed
  // key via setSecret). Mutation check: dropping the `+ '\n'` from the SUT
  // makes this assertion fail.
  it('normalises any number of trailing newlines to exactly one on the temp key file', async () => {
    H.execFileSync.mockImplementation(() => Buffer.from('ssh-ed25519 AAAA user@host'))
    let writtenKeyContent: string | undefined
    const origWrite = H.fileBytes.set.bind(H.fileBytes)
    H.fileBytes.set = (k: string, v: string) => {
      if (k.endsWith('/key')) writtenKeyContent = v
      return origWrite(k, v)
    }
    const { res } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'one\n\n' },
    })
    expect(res.statusCode).toBe(201)
    expect(writtenKeyContent).toBe('one\n')
  })

  it('returns 500 from the outer catch when JSON parsing the body fails', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      raw: '{not-json',
    })
    expect(res.statusCode).toBe(500)
    expect((json() as { error: string }).error).toMatch(/^Import failed: /)
    expect(H.loggerError).toHaveBeenCalledOnce()
  })

  it('falls back to String(err) in the outer catch when err.message is missing', async () => {
    // Force a synchronous throw AFTER the inner try/catch (which would
    // catch ssh-keygen failures and return 400). setSecret is called
    // AFTER the inner try/catch, so a throw there hits the OUTER catch
    // with whatever shape the thrower chose. Throwing a bare object
    // exercises the `err?.message ?? String(err)` falsy branch.
    H.setSecret.mockImplementation(() => { throw { code: 'X' } })
    const { res, json } = await call('POST', '/api/vault/ssh-keys/import', {
      body: { label: 'l', username: 'u', privateKey: 'pk\n' },
    })
    expect(res.statusCode).toBe(500)
    expect((json() as { error: string }).error).toMatch(/^Import failed: \[object Object\]$/)
    expect(H.loggerError).toHaveBeenCalledOnce()
  })
})

// ===========================================================================
// GET /api/vault/ssh-keys/:id/public-key
// ===========================================================================

describe('GET /api/vault/ssh-keys/:id/public-key', () => {
  it('returns 200 with the public key + fingerprint + keyType when the key exists', async () => {
    H.getVaultSshKey.mockReturnValue({
      id: 'abc',
      public_key: 'ssh-ed25519 AAAAPUB user@host',
      fingerprint: 'SHA256:fp',
      key_type: 'ed25519',
    })
    const { res, json } = await call('GET', '/api/vault/ssh-keys/abc/public-key')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      publicKey: 'ssh-ed25519 AAAAPUB user@host',
      fingerprint: 'SHA256:fp',
      keyType: 'ed25519',
    })
  })

  it('returns 404 when the key is not found', async () => {
    H.getVaultSshKey.mockReturnValue(undefined)
    const { res, json } = await call('GET', '/api/vault/ssh-keys/missing/public-key')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Key "missing" not found' })
  })
})

// ===========================================================================
// DELETE /api/vault/ssh-keys/:id
// ===========================================================================

describe('DELETE /api/vault/ssh-keys/:id', () => {
  it('returns 404 when getVaultSshKey returns undefined (no pre-check hit)', async () => {
    H.getVaultSshKey.mockReturnValue(undefined)
    H.deleteVaultSshKey.mockReturnValue({ deleted: false, unassigned: 0 })
    const { res, json } = await call('DELETE', '/api/vault/ssh-keys/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Key "missing" not found' })
    // deleteSecret MUST NOT have fired -- the pre-check short-circuits.
    expect(H.deleteSecret).not.toHaveBeenCalled()
  })

  it('returns 404 when deleteVaultSshKey reports deleted=false (race / already gone)', async () => {
    H.getVaultSshKey.mockReturnValue({ id: 'gone', vault_key_id: 'ssh-key-gone' })
    H.deleteVaultSshKey.mockReturnValue({ deleted: false, unassigned: 0 })
    const { res, json } = await call('DELETE', '/api/vault/ssh-keys/gone')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Key "gone" not found' })
    expect(H.deleteSecret).not.toHaveBeenCalled()
  })

  it('returns 200, deletes the vault secret, and surfaces unassigned=0 on success', async () => {
    H.getVaultSshKey.mockReturnValue({ id: 'abc', vault_key_id: 'ssh-key-abc-pool' })
    H.deleteVaultSshKey.mockReturnValue({ deleted: true, unassigned: 0 })
    const { res, json } = await call('DELETE', '/api/vault/ssh-keys/abc')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, unassigned: 0 })
    // The vault secret is removed too (orphan-prevention comment in source).
    expect(H.deleteSecret).toHaveBeenCalledWith('ssh-key-abc-pool')
    expect(H.loggerInfo).toHaveBeenCalledOnce()
  })

  it('surfaces unassigned > 0 when the deletion unassigned one or more servers', async () => {
    H.getVaultSshKey.mockReturnValue({ id: 'abc', vault_key_id: 'ssh-key-abc-pool' })
    H.deleteVaultSshKey.mockReturnValue({ deleted: true, unassigned: 3 })
    const { res, json } = await call('DELETE', '/api/vault/ssh-keys/abc')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, unassigned: 3 })
    expect(H.deleteSecret).toHaveBeenCalledWith('ssh-key-abc-pool')
    // The unassigned count rides through to the logger payload.
    expect(H.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc', unassigned: 3 }),
      expect.any(String),
    )
  })

  it('URL-decodes the id segment before lookup', async () => {
    H.getVaultSshKey.mockReturnValue(undefined)
    const { res } = await call('DELETE', '/api/vault/ssh-keys/with%20space')
    expect(res.statusCode).toBe(404)
    expect(H.getVaultSshKey).toHaveBeenCalledWith('with space')
  })
})

// ===========================================================================
// generateSshKeyPair (exported)
// ===========================================================================

describe('generateSshKeyPair', () => {
  it('runs ssh-keygen, reads back the keypair, and computes a fingerprint', () => {
    H.execFileSync.mockImplementation((_file: string, args: unknown[]) => {
      if ((args as string[]).includes('-t')) return Buffer.alloc(0)
      // -y isn't used here; default is fine. The SUT reads .pub from disk.
      return Buffer.from('')
    })
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key', 'priv-content')
    H.fileBytes.set('/tmp/marveen-ssh-mock-1/key.pub', 'ssh-ed25519 AAAAED25519 user@host\n')

    const result = generateSshKeyPair('alice@example.com')
    expect(result.privateKey).toBe('priv-content')
    expect(result.publicKey).toBe('ssh-ed25519 AAAAED25519 user@host')
    expect(result.fingerprint).toMatch(/^SHA256:/)
    // The temp dir was created and cleaned up in the finally.
    expect(H.mkdtempCalls).toBe(1)
    expect(H.rmCalls).toBe(1)
  })

  it('propagates execFileSync failures past the finally cleanup', () => {
    H.execFileSync.mockImplementation(() => { throw new Error('ssh-keygen missing') })
    expect(() => generateSshKeyPair('alice')).toThrow(/ssh-keygen missing/)
    // The cleanup still runs (rmSync was called in finally).
    expect(H.mkdtempCalls).toBe(1)
    expect(H.rmCalls).toBe(1)
  })
})

// ===========================================================================
// extractPublicKeyFromVault (exported)
// ===========================================================================

describe('extractPublicKeyFromVault', () => {
  it('returns null when the vault has no secret for the given id', () => {
    H.getSecret.mockReturnValue(null)
    expect(extractPublicKeyFromVault('ssh-key-none')).toBeNull()
    // No execFileSync -- short-circuit before ssh-keygen runs.
    expect(H.execFileSync).not.toHaveBeenCalled()
    // No temp dir created either.
    expect(H.mkdtempCalls).toBe(0)
  })

  it('runs ssh-keygen -y -f on the vault secret and returns the public key line', () => {
    H.getSecret.mockReturnValue('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n')
    H.execFileSync.mockImplementation(() => Buffer.from('ssh-ed25519 AAAAVAULTPUB user@host\n'))
    const result = extractPublicKeyFromVault('ssh-key-abc')
    expect(result).toBe('ssh-ed25519 AAAAVAULTPUB user@host')
    // mkdtemp + rm ran in the try/finally.
    expect(H.mkdtempCalls).toBe(1)
    expect(H.rmCalls).toBe(1)
  })

  it('runs rmSync even when execFileSync throws', () => {
    H.getSecret.mockReturnValue('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n')
    H.execFileSync.mockImplementation(() => { throw new Error('corrupt key') })
    expect(() => extractPublicKeyFromVault('ssh-key-bad')).toThrow(/corrupt key/)
    expect(H.mkdtempCalls).toBe(1)
    expect(H.rmCalls).toBe(1)
  })
})