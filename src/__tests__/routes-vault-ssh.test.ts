// 100% coverage suite for src/web/routes/vault-ssh.ts.
//
// `tryHandleVaultSsh` owns six endpoints under /api/vault/ssh-servers:
//
//   GET    /api/vault/ssh-servers                       -- list (with key status)
//   POST   /api/vault/ssh-servers                       -- create
//   PUT    /api/vault/ssh-servers/:id                   -- update
//   DELETE /api/vault/ssh-servers/:id                   -- delete
//   POST   /api/vault/ssh-servers/:id/generate-key      -- generate + assign
//   GET    /api/vault/ssh-servers/:id/public-key        -- public key text
//
// Every collaborator is mocked at the module boundary: db.ts (all 8 vault
// functions plus computeSshKeyStatus), the sibling vault-ssh-keys module
// (generateSshKeyPair), vault.ts (setSecret), plus the standard
// logger/config/db/auth-gate/auth-sessions stubs. The dynamic import
// `await import('../../db.js')` inside the generate-key handler is resolved
// at call time, so the mocked `createVaultSshKey` is reached.
//
// Branches covered (per file inspection):
//   * dispatcher: false arm (path doesn't start with /api/vault/ssh-servers)
//   * GET list:
//       - empty server list -> { servers: [] }
//       - server list with one server missing ssh_key_id -> keyStatus="missing"
//       - server list with ssh_key_id, key in pool -> keyStatus="ok"
//       - server list with ssh_key_id, key NOT in pool (getVaultSshKey returns
//         undefined) -> keyStatus="ok" but keyType/fingerprint null
//   * POST create:
//       - missing name       -> 400
//       - missing host       -> 400
//       - missing user       -> 400
//       - non-string name/host/user (defensive) -> 400
//       - non-integer port   -> default 22
//       - port > 65535       -> default 22
//       - port <= 0          -> default 22
//       - desc empty string  -> null
//       - desc non-string    -> null
//       - custom id (valid)  -> used as id
//       - custom id (invalid format) -> falls back to slugify(name)
//       - name slugifies to empty AND host also empty -> 400 (defensive)
//       - existing id        -> 409
//       - happy path         -> 201 with toApiShape result
//       - JSON.parse throws  -> 500
//   * PUT update:
//       - server not found           -> 404
//       - body JSON parse throws     -> 500
//       - update with name only      -> patch.name set
//       - update with host only      -> patch.host set
//       - update with user only      -> patch.username set
//       - update with invalid port   -> port omitted
//       - update with valid port     -> patch.port set
//       - update with desc=string    -> patch.description = trimmed or null
//       - update with desc=""        -> patch.description = null
//       - update with desc=null      -> patch.description = null
//       - update with sshKeyId valid -> patch.ssh_key_id = keyId
//       - update with sshKeyId null  -> patch.ssh_key_id = null
//       - update with sshKeyId not found -> 404
//       - update with sshKeyId undefined -> no patch.ssh_key_id
//   * DELETE:
//       - not found   -> 404
//       - found       -> 200 { ok: true }
//   * POST generate-key:
//       - server not found                -> 404
//       - body parse throws               -> uses default (server.username)
//       - body has invalid JSON           -> uses default
//       - body has valid JSON with username -> uses provided username
//       - body has valid JSON without username -> uses default
//       - empty body                      -> uses default
//       - generateSshKeyPair throws       -> 500 with err.message
//       - generateSshKeyPair throws non-Error -> 500 with String(err)
//       - happy path                      -> 200 with toApiShape + publicKey + fingerprint
//   * GET public-key:
//       - server not found           -> 404
//       - server has no key assigned -> 404
//       - server has key_id but key not in pool -> 404
//       - happy path                 -> 200 with publicKey/fingerprint/keyType
//
// The `toApiShape` helper is also exercised through the POST create response
// (the 201 arm), the GET list response (each server), and the generate-key
// response. The `slugify` helper is exercised by the POST create custom-id
// fallback path. The `validateId` helper is exercised by the POST custom-id
// branch.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { updateVaultSshServer } from '../db.js'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted harness. vi.hoisted keeps these accessible in vi.mock factories.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  // db -- vault ssh server + key CRUD
  listVaultSshServers: vi.fn<() => unknown[]>(() => []),
  getVaultSshServer: vi.fn<(id: string) => unknown | undefined>(),
  createVaultSshServer: vi.fn(),
  updateVaultSshServer: vi.fn<typeof updateVaultSshServer>(() => true),
  deleteVaultSshServer: vi.fn(() => true),
  computeSshKeyStatus: vi.fn((s: { ssh_key_id?: string | null }) => (s.ssh_key_id ? 'ok' : 'missing')),
  getVaultSshKey: vi.fn<(id: string) => unknown | undefined>(),
  listVaultSshKeys: vi.fn<() => unknown[]>(() => []),
  createVaultSshKey: vi.fn(),

  // vault-ssh-keys (sibling module)
  generateSshKeyPair: vi.fn(() => ({
    privateKey: 'PRIV',
    publicKey: 'ssh-ed25519 AAAA comment\n',
    fingerprint: 'SHA256:abc',
  })),

  // vault.ts
  setSecret: vi.fn(),

  // logger
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}))

// ---------------------------------------------------------------------------
// vi.mock factories
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  listVaultSshServers: H.listVaultSshServers,
  getVaultSshServer: H.getVaultSshServer,
  createVaultSshServer: H.createVaultSshServer,
  updateVaultSshServer: H.updateVaultSshServer,
  deleteVaultSshServer: H.deleteVaultSshServer,
  computeSshKeyStatus: H.computeSshKeyStatus,
  getVaultSshKey: H.getVaultSshKey,
  listVaultSshKeys: H.listVaultSshKeys,
  createVaultSshKey: H.createVaultSshKey,
}))

vi.mock('../web/routes/vault-ssh-keys.js', () => ({
  generateSshKeyPair: H.generateSshKeyPair,
}))

vi.mock('../web/vault.js', () => ({
  setSecret: H.setSecret,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

// Standardised stubs per suite convention.
vi.mock('../config.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

const { tryHandleVaultSsh } = await import('../web/routes/vault-ssh.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string | Buffer): void
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
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) {
        this.body += typeof data === 'string' ? data : data.toString()
      }
    },
  }
}

function mkReq(opts: { body?: Buffer | string }): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Object.assign(
    Readable.from(payload),
    { headers: {} satisfies http.IncomingHttpHeaders },
  ) as http.IncomingMessage
  return r
}

async function call(method: string, path: string, opts: { body?: Buffer | string } = {}): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
  ctx: RouteContext
}> {
  const req = mkReq({ body: opts.body })
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    fedPeer: null,
  }
  const handled = await tryHandleVaultSsh(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null), ctx }
}

// Convenience shape helpers
function mkServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'srv1',
    name: 'prod',
    host: 'example.com',
    port: 22,
    username: 'root',
    ssh_key_id: null,
    description: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function mkKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key1',
    label: 'key-label',
    username: 'root',
    vault_key_id: 'ssh-key-key1',
    public_key: 'ssh-ed25519 AAAA comment\n',
    fingerprint: 'SHA256:abc',
    key_type: 'ed25519',
    created_at: 1700000000,
    ...overrides,
  }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  H.listVaultSshServers.mockReset().mockReturnValue([])
  H.getVaultSshServer.mockReset()
  H.createVaultSshServer.mockReset()
  H.updateVaultSshServer.mockReset().mockReturnValue(true)
  H.deleteVaultSshServer.mockReset().mockReturnValue(true)
  H.computeSshKeyStatus.mockReset().mockImplementation((s: { ssh_key_id?: string | null }) => (s.ssh_key_id ? 'ok' : 'missing'))
  H.getVaultSshKey.mockReset()
  H.listVaultSshKeys.mockReset().mockReturnValue([])
  H.createVaultSshKey.mockReset()
  H.generateSshKeyPair.mockReset().mockReturnValue({
    privateKey: 'PRIV',
    publicKey: 'ssh-ed25519 AAAA comment\n',
    fingerprint: 'SHA256:abc',
  })
  H.setSecret.mockReset()
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()
})

// ===========================================================================
// Dispatcher surface
// ===========================================================================

describe('tryHandleVaultSsh -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for /api/vault/ssh-keys (handled by sibling router)', async () => {
    const { handled } = await call('GET', '/api/vault/ssh-keys')
    expect(handled).toBe(false)
  })

  it('returns false for /api/vault/ssh-servers on PATCH (unmatched method)', async () => {
    // PATCH on the collection path doesn't match any of the route's
    // branches (GET list, POST create, singleMatch PUT/DELETE, generate-key,
    // public-key) -> the dispatcher returns false.
    const { handled } = await call('PATCH', '/api/vault/ssh-servers')
    expect(handled).toBe(false)
  })

  it('returns false for /api/vault/ssh-servers/x on GET (only /public-key suffix matches)', async () => {
    // A GET on a non-/public-key single-id path doesn't match any branch.
    const { handled } = await call('GET', '/api/vault/ssh-servers/srv1/other')
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// GET /api/vault/ssh-servers
// ===========================================================================

describe('GET /api/vault/ssh-servers', () => {
  it('returns an empty list when no servers exist', async () => {
    H.listVaultSshServers.mockReturnValue([])
    const { res, json, handled } = await call('GET', '/api/vault/ssh-servers')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ servers: [] })
  })

  it('returns servers with keyStatus=missing when ssh_key_id is null', async () => {
    H.listVaultSshServers.mockReturnValue([mkServer({ id: 's1', ssh_key_id: null })])
    const { json } = await call('GET', '/api/vault/ssh-servers')
    const out = json() as { servers: Array<{ id: string; keyStatus: string; keyType: null; fingerprint: null; sshKeyId: null }> }
    expect(out.servers).toHaveLength(1)
    expect(out.servers[0]).toMatchObject({
      id: 's1',
      keyStatus: 'missing',
      sshKeyId: null,
      keyType: null,
      fingerprint: null,
    })
    // getVaultSshKey not called when ssh_key_id is null
    expect(H.getVaultSshKey).not.toHaveBeenCalled()
  })

  it('returns servers with keyStatus=ok and key fields populated when ssh_key_id resolves to a pool key', async () => {
    H.listVaultSshServers.mockReturnValue([
      mkServer({ id: 's1', ssh_key_id: 'k1' }),
      mkServer({ id: 's2', ssh_key_id: 'k2' }),
    ])
    H.getVaultSshKey.mockImplementation((id: string) => {
      if (id === 'k1') return mkKey({ id: 'k1', key_type: 'rsa', fingerprint: 'SHA256:k1-fp' })
      if (id === 'k2') return mkKey({ id: 'k2', key_type: 'ed25519', fingerprint: 'SHA256:k2-fp' })
      return undefined
    })
    const { json } = await call('GET', '/api/vault/ssh-servers')
    const out = json() as { servers: Array<{ id: string; keyStatus: string; sshKeyId: string; keyType: string; fingerprint: string }> }
    expect(out.servers).toHaveLength(2)
    expect(out.servers[0]).toMatchObject({ id: 's1', keyStatus: 'ok', sshKeyId: 'k1', keyType: 'rsa', fingerprint: 'SHA256:k1-fp' })
    expect(out.servers[1]).toMatchObject({ id: 's2', keyStatus: 'ok', sshKeyId: 'k2', keyType: 'ed25519', fingerprint: 'SHA256:k2-fp' })
    expect(H.getVaultSshKey).toHaveBeenCalledTimes(2)
  })

  it('returns servers with keyStatus=ok but null keyType/fingerprint when ssh_key_id points to a missing pool key', async () => {
    H.listVaultSshServers.mockReturnValue([mkServer({ id: 's1', ssh_key_id: 'gone' })])
    H.getVaultSshKey.mockReturnValue(undefined)
    const { json } = await call('GET', '/api/vault/ssh-servers')
    const out = json() as { servers: Array<{ keyStatus: string; keyType: null; fingerprint: null }> }
    expect(out.servers[0]).toMatchObject({ keyStatus: 'ok', keyType: null, fingerprint: null })
  })

  it('deduplicates duplicate ssh_key_id entries when building the keyMap', async () => {
    // buildKeyMap uses Set to dedupe; verify both servers hit getVaultSshKey once each
    H.listVaultSshServers.mockReturnValue([
      mkServer({ id: 's1', ssh_key_id: 'k1' }),
      mkServer({ id: 's2', ssh_key_id: 'k1' }),
    ])
    H.getVaultSshKey.mockReturnValue(mkKey({ id: 'k1' }))
    await call('GET', '/api/vault/ssh-servers')
    // Set dedupes; only one lookup
    expect(H.getVaultSshKey).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// POST /api/vault/ssh-servers
// ===========================================================================

describe('POST /api/vault/ssh-servers', () => {
  it('returns 400 when name is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ host: 'h', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'name, host and user are required' })
    expect(H.createVaultSshServer).not.toHaveBeenCalled()
  })

  it('returns 400 when host is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'name, host and user are required' })
  })

  it('returns 400 when user is missing', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'name, host and user are required' })
  })

  it('returns 400 when name is whitespace-only', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: '   ', host: 'h', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'name, host and user are required' })
  })

  it('returns 400 when host is whitespace-only', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: '   ', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when user is whitespace-only', async () => {
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: '   ' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('treats non-string name as empty (defensive)', async () => {
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 123, host: 'h', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('treats non-string host as empty (defensive)', async () => {
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: null, user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('treats non-string user as empty (defensive)', async () => {
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: undefined }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('defaults port to 22 when port is missing', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 22 }))
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u' }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 22 }))
    expect(json()).toMatchObject({ server: expect.objectContaining({ port: 22 }) })
  })

  it('defaults port to 22 when port is non-integer', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 22 }))
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', port: '22' }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 22 }))
  })

  it('defaults port to 22 when port is 0', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 22 }))
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', port: 0 }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 22 }))
  })

  it('defaults port to 22 when port is negative', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 22 }))
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', port: -1 }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 22 }))
  })

  it('defaults port to 22 when port > 65535', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 22 }))
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', port: 70000 }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 22 }))
  })

  it('accepts a valid integer port', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ port: 2222 }))
    const { res } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', port: 2222 }),
    })
    expect(res.statusCode).toBe(201)
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ port: 2222 }))
  })

  it('trims desc and passes it as a string when non-empty', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ description: 'hello' }))
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', desc: '  hello  ' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ description: 'hello' }))
  })

  it('passes desc as null when desc is missing', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer())
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ description: null }))
  })

  it('passes desc as null when desc is an empty string', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer())
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', desc: '   ' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ description: null }))
  })

  it('treats non-string desc as null (defensive)', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer())
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', desc: 123 }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ description: null }))
  })

  it('uses a custom id when validateId accepts it', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ id: 'my-custom-id' }))
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u', id: 'my-custom-id' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-custom-id' }))
  })

  it('falls back to slugify(name) when custom id is invalid format', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ id: 'my-name' }))
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'My Name!', host: 'h', user: 'u', id: 'BAD/ID!' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-name' }))
  })

  it('falls back to slugify(host) when name slugifies to empty and host is present', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue(mkServer({ id: 'host' }))
    await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: '!!!', host: 'MyHost', user: 'u' }),
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'myhost' }))
  })

  it('returns 400 when both slugify(name) and slugify(host) are empty', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: '!!!', host: '!!!', user: 'u' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Could not derive a valid id from the name' })
    expect(H.createVaultSshServer).not.toHaveBeenCalled()
  })

  it('returns 409 when the derived id already exists', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer({ id: 'my-name' }))
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'My Name', host: 'h', user: 'u' }),
    })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'Server with id "my-name" already exists' })
    expect(H.createVaultSshServer).not.toHaveBeenCalled()
  })

  it('happy path: creates the server and returns 201 with toApiShape', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    const created = mkServer({ id: 'my-name', name: 'My Name', host: 'example.com', port: 22, username: 'root', description: null })
    H.createVaultSshServer.mockReturnValue(created)
    const { res, json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'My Name', host: 'example.com', user: 'root' }),
    })
    expect(res.statusCode).toBe(201)
    expect(json()).toMatchObject({
      server: {
        id: 'my-name',
        name: 'My Name',
        host: 'example.com',
        port: 22,
        user: 'root',
        desc: '',
        sshKeyId: null,
        keyType: null,
        fingerprint: null,
        keyStatus: 'missing',
      },
    })
    expect(H.createVaultSshServer).toHaveBeenCalledWith({
      id: 'my-name',
      name: 'My Name',
      host: 'example.com',
      port: 22,
      username: 'root',
      description: null,
    })
    expect(H.loggerInfo).toHaveBeenCalledWith({ id: 'my-name' }, 'vault ssh server created')
  })

  it('returns 500 when the body is not valid JSON', async () => {
    const { res, json, handled } = await call('POST', '/api/vault/ssh-servers', {
      body: '{not json',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to create server' })
    expect(H.loggerError).toHaveBeenCalled()
  })
})

// ===========================================================================
// PUT /api/vault/ssh-servers/:id
// ===========================================================================

describe('PUT /api/vault/ssh-servers/:id', () => {
  it('returns 404 when the server does not exist', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    const { res, json } = await call('PUT', '/api/vault/ssh-servers/missing', {
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Server "missing" not found' })
  })

  it('updates name only (patch.name set, others undefined)', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    H.updateVaultSshServer.mockReturnValue(true)
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ name: 'NewName' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ name: 'NewName' }))
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect(patch.host).toBeUndefined()
    expect(patch.username).toBeUndefined()
    expect(patch.port).toBeUndefined()
    expect(patch.description).toBeUndefined()
  })

  it('updates host only', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ host: 'newhost' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ host: 'newhost' }))
  })

  it('updates username via the user key', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ user: 'newuser' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ username: 'newuser' }))
  })

  it('omits port from the patch when port is invalid (non-integer)', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ port: 'not-a-number' }),
    })
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect(patch.port).toBeUndefined()
  })

  it('omits port from the patch when port <= 0', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ port: 0 }),
    })
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect(patch.port).toBeUndefined()
  })

  it('omits port from the patch when port > 65535', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ port: 99999 }),
    })
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect(patch.port).toBeUndefined()
  })

  it('includes port when valid integer', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ port: 2200 }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ port: 2200 }))
  })

  it('updates description (trimmed, non-empty)', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ desc: '  hello  ' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ description: 'hello' }))
  })

  it('clears description to null when desc is empty string', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ desc: '   ' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ description: null }))
  })

  it('clears description to null when desc is null', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ desc: null }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ description: null }))
  })

  it('omits description from the patch when desc is undefined', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ name: 'X' }),
    })
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect('description' in patch).toBe(false)
  })

  it('assigns a valid sshKeyId', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    H.getVaultSshKey.mockReturnValue(mkKey({ id: 'k1' }))
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ sshKeyId: 'k1' }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ ssh_key_id: 'k1' }))
  })

  it('unassigns sshKeyId when set to null', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer({ ssh_key_id: 'k1' }))
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ sshKeyId: null }),
    })
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ ssh_key_id: null }))
  })

  it('returns 404 when sshKeyId is a non-null string that does not match a pool key', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    H.getVaultSshKey.mockReturnValue(undefined)
    const { res, json } = await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ sshKeyId: 'unknown-key' }),
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'SSH key "unknown-key" not found' })
    expect(H.updateVaultSshServer).not.toHaveBeenCalled()
  })

  it('omits ssh_key_id from the patch when sshKeyId is undefined', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ name: 'X' }),
    })
    const patch = H.updateVaultSshServer.mock.calls[0][1]
    expect('ssh_key_id' in patch).toBe(false)
  })

  it('returns 200 with the updated server on the happy path', async () => {
    const srv = mkServer({ ssh_key_id: 'k1' })
    H.getVaultSshServer.mockReturnValueOnce(mkServer()).mockReturnValueOnce(srv)
    H.getVaultSshKey.mockReturnValue(mkKey({ id: 'k1' }))
    const { res, json } = await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ sshKeyId: 'k1' }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      server: expect.objectContaining({ id: 'srv1', sshKeyId: 'k1' }),
    })
    expect(H.loggerInfo).toHaveBeenCalledWith({ id: 'srv1' }, 'vault ssh server updated')
  })

  it('returns 200 with the updated server when ssh_key_id is null (key lookup not called)', async () => {
    H.getVaultSshServer.mockReturnValueOnce(mkServer()).mockReturnValueOnce(mkServer({ ssh_key_id: null }))
    const { res, handled } = await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: JSON.stringify({ name: 'X' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    // getVaultSshKey only called when ssh_key_id is truthy
    expect(H.getVaultSshKey).not.toHaveBeenCalled()
  })

  it('returns 500 when the body is not valid JSON', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer())
    const { res, json } = await call('PUT', '/api/vault/ssh-servers/srv1', {
      body: '{not json',
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update server' })
    expect(H.loggerError).toHaveBeenCalled()
  })
})

// ===========================================================================
// DELETE /api/vault/ssh-servers/:id
// ===========================================================================

describe('DELETE /api/vault/ssh-servers/:id', () => {
  it('returns 404 when deleteVaultSshServer returns false', async () => {
    H.deleteVaultSshServer.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/vault/ssh-servers/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Server "missing" not found' })
  })

  it('returns 200 { ok: true } on successful delete', async () => {
    H.deleteVaultSshServer.mockReturnValue(true)
    const { res, json, handled } = await call('DELETE', '/api/vault/ssh-servers/srv1')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.deleteVaultSshServer).toHaveBeenCalledWith('srv1')
    expect(H.loggerInfo).toHaveBeenCalledWith({ id: 'srv1' }, 'vault ssh server deleted')
  })
})

// ===========================================================================
// POST /api/vault/ssh-servers/:id/generate-key
// ===========================================================================

describe('POST /api/vault/ssh-servers/:id/generate-key', () => {
  it('returns 404 when the server does not exist', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/vault/ssh-servers/missing/generate-key', { body: '' })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Server "missing" not found' })
  })

  it('happy path: generates a keypair, stores the private key, and assigns it', async () => {
    const srv = mkServer({ name: 'prod', host: 'example.com', username: 'root' })
    const updatedSrv = mkServer({ name: 'prod', host: 'example.com', username: 'root', ssh_key_id: 'new-key' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(updatedSrv)
    H.getVaultSshKey.mockReturnValue(mkKey({ id: 'new-key' }))
    H.createVaultSshKey.mockReturnValue(mkKey({ id: 'new-key' }))
    const { res, json, handled } = await call('POST', '/api/vault/ssh-servers/srv1/generate-key', { body: '' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('root@example.com')
    expect(H.setSecret).toHaveBeenCalledWith(
      expect.stringMatching(/^ssh-key-[0-9a-f]+$/),
      'SSH private key: prod (root)',
      'PRIV',
    )
    expect(H.createVaultSshKey).toHaveBeenCalledWith(expect.objectContaining({
      username: 'root',
      label: 'prod (root)',
      public_key: 'ssh-ed25519 AAAA comment\n',
      fingerprint: 'SHA256:abc',
      key_type: 'ed25519',
    }))
    expect(H.updateVaultSshServer).toHaveBeenCalledWith('srv1', expect.objectContaining({ ssh_key_id: expect.any(String) }))
    expect(json()).toMatchObject({
      publicKey: 'ssh-ed25519 AAAA comment\n',
      fingerprint: 'SHA256:abc',
      server: expect.objectContaining({ sshKeyId: expect.any(String), keyStatus: 'ok' }),
    })
    expect(H.loggerInfo).toHaveBeenCalled()
  })

  it('uses server.username when body is empty', async () => {
    const srv = mkServer({ name: 'prod', host: 'example.com', username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', { body: '' })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('defaultUser@example.com')
    expect(H.createVaultSshKey).toHaveBeenCalledWith(expect.objectContaining({ username: 'defaultUser' }))
  })

  it('uses server.username when body is invalid JSON', async () => {
    const srv = mkServer({ name: 'prod', host: 'example.com', username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', { body: '{not json' })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('defaultUser@example.com')
  })

  it('uses server.username when body is valid JSON without a username field', async () => {
    const srv = mkServer({ name: 'prod', host: 'example.com', username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', {
      body: JSON.stringify({ unrelated: 'field' }),
    })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('defaultUser@example.com')
  })

  it('overrides the username when body provides a non-empty string username', async () => {
    const srv = mkServer({ name: 'prod', host: 'example.com', username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', {
      body: JSON.stringify({ username: 'overrideUser' }),
    })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('overrideUser@example.com')
    expect(H.createVaultSshKey).toHaveBeenCalledWith(expect.objectContaining({ username: 'overrideUser' }))
  })

  it('keeps the default when body username is an empty string', async () => {
    const srv = mkServer({ username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', {
      body: JSON.stringify({ username: '' }),
    })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('defaultUser@example.com')
  })

  it('keeps the default when body username is whitespace-only', async () => {
    const srv = mkServer({ username: 'defaultUser' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.createVaultSshKey.mockReturnValue(mkKey())
    await call('POST', '/api/vault/ssh-servers/srv1/generate-key', {
      body: JSON.stringify({ username: '   ' }),
    })
    expect(H.generateSshKeyPair).toHaveBeenCalledWith('defaultUser@example.com')
  })

  it('returns 500 with err.message when generateSshKeyPair throws', async () => {
    const srv = mkServer({ username: 'root' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.generateSshKeyPair.mockImplementation(() => { throw new Error('ssh-keygen missing') })
    const { res, json } = await call('POST', '/api/vault/ssh-servers/srv1/generate-key', { body: '' })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Key generation failed: ssh-keygen missing' })
    expect(H.loggerError).toHaveBeenCalled()
  })

  it('returns 500 with String(err) when generateSshKeyPair throws a non-Error', async () => {
    const srv = mkServer({ username: 'root' })
    H.getVaultSshServer.mockReturnValueOnce(srv).mockReturnValueOnce(srv)
    H.generateSshKeyPair.mockImplementation(() => { throw 'plain-string' })
    const { res, json } = await call('POST', '/api/vault/ssh-servers/srv1/generate-key', { body: '' })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Key generation failed: plain-string' })
  })
})

// ===========================================================================
// GET /api/vault/ssh-servers/:id/public-key
// ===========================================================================

describe('GET /api/vault/ssh-servers/:id/public-key', () => {
  it('returns 404 when the server does not exist', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    const { res, json } = await call('GET', '/api/vault/ssh-servers/missing/public-key')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Server "missing" not found' })
  })

  it('returns 404 when the server has no ssh_key_id assigned', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer({ ssh_key_id: null }))
    const { res, json } = await call('GET', '/api/vault/ssh-servers/srv1/public-key')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'No key assigned to this server' })
  })

  it('returns 404 when the assigned key is not in the pool', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer({ ssh_key_id: 'gone' }))
    H.getVaultSshKey.mockReturnValue(undefined)
    const { res, json } = await call('GET', '/api/vault/ssh-servers/srv1/public-key')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Assigned key not found' })
  })

  it('happy path: returns the public key, fingerprint, and keyType', async () => {
    H.getVaultSshServer.mockReturnValue(mkServer({ ssh_key_id: 'k1' }))
    H.getVaultSshKey.mockReturnValue(mkKey({
      id: 'k1',
      public_key: 'ssh-ed25519 AAAA user@host\n',
      fingerprint: 'SHA256:zzz',
      key_type: 'rsa',
    }))
    const { res, json } = await call('GET', '/api/vault/ssh-servers/srv1/public-key')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      publicKey: 'ssh-ed25519 AAAA user@host\n',
      fingerprint: 'SHA256:zzz',
      keyType: 'rsa',
    })
  })
})

// ===========================================================================
// toApiShape helper -- covered via every response; pin a single direct test
// for documentation purposes. We can't import toApiShape directly because
// it's not exported, but the response shape assertions above already cover
// it. We document this here.
// ===========================================================================

describe('toApiShape -- indirectly covered by GET / POST / generate-key responses', () => {
  it('formats created_at/updated_at epoch seconds to ISO', async () => {
    H.getVaultSshServer.mockReturnValue(undefined)
    H.createVaultSshServer.mockReturnValue({
      id: 'srv1', name: 'n', host: 'h', port: 22, username: 'u',
      ssh_key_id: null, description: null,
      created_at: 1700000000, updated_at: 1700000123,
    })
    const { json } = await call('POST', '/api/vault/ssh-servers', {
      body: JSON.stringify({ name: 'n', host: 'h', user: 'u' }),
    })
    const out = json() as { server: { createdAt: string; updatedAt: string } }
    expect(out.server.createdAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(out.server.updatedAt).toBe(new Date(1700000123 * 1000).toISOString())
  })
})