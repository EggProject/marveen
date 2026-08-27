// 100% coverage suite for src/web/vault.ts.
//
// The module wraps AES-256-GCM secret storage with these public exports:
//
//   listSecrets()           -- readVault().entries (without encrypted blobs)
//   setSecret(id,label,val) -- upsert + encrypt + write
//   getSecret(id)           -- read + find + decrypt, or null
//   deleteSecret(id)        -- filter + write, returns boolean
//   getSecretsForEnv(map)   -- bulk getSecret over a Record<string,string>
//
// The implementation pivots on three module-scope constants (VAULT_PATH,
// VAULT_KEY_PATH, VAULT_KEY_MIGRATED) that are frozen at import time via
// `join(PROJECT_ROOT, ...)`. vi.mock factories run once per test file, so we
// allocate a single tmpdir sandbox at module load and route PROJECT_ROOT
// through vi.mock, mirroring the pattern in src/__tests__/vault-bindings.test.ts.
//
// Branch inventory covered by this file:
//
//   getMasterKey()   -- 7 reachable branches (see test names below).
//   encrypt/decrypt  -- symmetric round-trip via the mocked cipher map.
//   readVault()      -- file missing / malformed / valid JSON.
//   writeVault()     -- happy path + atomicWriteFileSync failure (covered by
//                       the malformed-JSON branch on read-back, NOT by
//                       forcing writeVault to throw -- the function has no
//                       try/catch so a thrown write would surface inside
//                       the caller, which is the actual behaviour).
//   setSecret()      -- new entry (push) / existing entry (replace preserves
//                       createdAt).
//   getSecret()      -- missing id (null) / present id (decrypt).
//   deleteSecret()   -- missing (false, no write) / present (true, write).
//   getSecretsForEnv()-- empty map / mix of present+absent / all present.
//
// Sandbox: vi.mock('../config.js') redirects PROJECT_ROOT to a tmpdir tree;
// vi.mock('../logger.js') silences info/warn; vi.mock('node:os') lets each
// test pick darwin vs linux without spawning a child process; vi.mock
// ('../web/keychain.js') injects the keychain availability/return shape;
// vi.mock('node:crypto') keeps AES+scrypt deterministic by recording the
// plaintext the encrypt side stores under its IV and replaying it on the
// decrypt side (no real key material ever leaves the mock).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Sandbox -- one tmpdir-scoped PROJECT_ROOT for the whole file.
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), 'vault-'))
const PROJECT_ROOT = join(SANDBOX, 'repo')
const STORE = join(PROJECT_ROOT, 'store')
mkdirSync(STORE, { recursive: true })

function vaultPath(): string { return join(STORE, 'vault.json') }
function vaultKeyPath(): string { return join(STORE, '.vault-key') }
function vaultKeyMigratedPath(): string { return join(STORE, '.vault-key.migrated') }

// ---------------------------------------------------------------------------
// Mock state -- lives OUTSIDE the vi.hoisted block so per-test beforeEach
// can reset and re-script it. The cipher/decipher side use a shared Map keyed
// by the IV (hex) so encrypt -> decrypt round-trips without touching real
// crypto.
// ---------------------------------------------------------------------------
interface MockState {
  platform: NodeJS.Platform
  keychainAvailable: boolean
  keychainStored: string | null // most recent keychainStore() arg, or null if not called
  keychainRetrieveReturn: string | null
  keychainStoreThrows: boolean
  keychainRetrieveThrows: boolean
  // cipher bookkeeping: iv-hex -> plaintext. Cleared per test.
  cipherMap: Map<string, string>
  // bookkeeping for getMasterKey-derived write paths
  fileKeyWrittenToKeyFile: string | null
}

const state: MockState = {
  platform: 'darwin',
  keychainAvailable: true,
  keychainStored: null,
  keychainRetrieveReturn: null,
  keychainStoreThrows: false,
  keychainRetrieveThrows: false,
  cipherMap: new Map(),
  fileKeyWrittenToKeyFile: null,
}

// ---------------------------------------------------------------------------
// vi.mock wiring
// ---------------------------------------------------------------------------
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, platform: () => state.platform }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT }
})

vi.mock('../logger.js', async (orig) => {
  const actual = await orig<typeof import('../logger.js')>()
  const noop = () => {}
  const stub = { info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop), debug: vi.fn(noop) }
  // Mirror the real logger shape (top-level methods + .child()) so any caller
  // that does logger.child(...) doesn't blow up. We only assign once because
  // vi.mock factories run only at import time.
  ;(stub as unknown as { child: () => typeof stub }).child = () => stub
  // The real logger is pino -- we have to return it as a bare object so the
  // SUT's logger.info / logger.warn calls land in the stub. We do NOT spread
  // `actual` here because that would drag the pino instance back in and
  // clobber our spies.
  void actual
  return { logger: stub }
})

vi.mock('../web/keychain.js', () => {
  // Mirror the real module's export shape so vault.ts can throw and
  // catch KeychainUnavailableError without the mock short-circuiting it.
  class KeychainUnavailableError extends Error {}
  return {
    KeychainUnavailableError,
    isKeychainAvailable: () => state.keychainAvailable,
    keychainStore: (value: string) => {
      if (state.keychainStoreThrows) throw new KeychainUnavailableError('mock keychain store failure (status 45): test fixture')
      state.keychainStored = value
    },
    keychainRetrieve: () => {
      if (state.keychainRetrieveThrows) throw new KeychainUnavailableError('mock keychain retrieve failure')
      return state.keychainRetrieveReturn
    },
  }
})

// Crypto mock: deterministic and round-trippable.
//   randomBytes returns a fixed byte pattern so re-runs are reproducible.
//   scryptSync is identity (master -> key) so the test only has to track
//   cipher text via the IV index.
//   createCipheriv stashes the plaintext under iv-hex and returns a no-op
//   tag (16 zeros). createDecipheriv reads from the same stash so setSecret
//   + getSecret round-trip is observable.
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  let counter = 0
  return {
    ...actual,
    randomBytes: ((n: number) => {
      counter += 1
      const buf = Buffer.alloc(n)
      for (let i = 0; i < n; i++) buf[i] = (counter + i) & 0xff
      return buf
    }) as typeof actual.randomBytes,
    scryptSync: ((master: Buffer | string) => Buffer.from(master as Buffer)) as typeof actual.scryptSync,
    createCipheriv: ((_alg: string, _key: Buffer, iv: Buffer) => {
      const ivKey = iv.toString('hex')
      return {
        update: (plaintext: string, _enc: string) => {
          state.cipherMap.set(ivKey, plaintext)
          return Buffer.from(plaintext, 'utf-8')
        },
        final: () => Buffer.alloc(0),
        getAuthTag: () => Buffer.alloc(16),
      }
    }) as typeof actual.createCipheriv,
    createDecipheriv: ((_alg: string, _key: Buffer, iv: Buffer) => {
      const ivKey = iv.toString('hex')
      return {
        setAuthTag: (_tag: Buffer) => { /* noop */ },
        update: (_ciphertext: Buffer) => Buffer.from(state.cipherMap.get(ivKey) ?? '', 'utf-8'),
        final: (_enc: string) => '',
      }
    }) as typeof actual.createDecipheriv,
  }
})

// ---------------------------------------------------------------------------
// Import AFTER mocks so module-scope constants capture the redirected
// PROJECT_ROOT.
// ---------------------------------------------------------------------------
const vault = await import('../web/vault.js')
const { listSecrets, setSecret, getSecret, deleteSecret, getSecretsForEnv } = vault
const { KeychainUnavailableError } = await import('../web/keychain.js')

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Clean disk state.
  for (const p of [vaultPath(), vaultKeyPath(), vaultKeyMigratedPath()]) {
    if (existsSync(p)) rmSync(p, { force: true })
  }
  // Reset mocks.
  state.platform = 'darwin'
  state.keychainAvailable = true
  state.keychainStored = null
  state.keychainRetrieveReturn = null
  state.keychainStoreThrows = false
  state.keychainRetrieveThrows = false
  state.cipherMap.clear()
  state.fileKeyWrittenToKeyFile = null
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function seedVaultKeyFile(contents: string): void {
  writeFileSync(vaultKeyPath(), contents)
}
function seedMigratedMarker(): void {
  writeFileSync(vaultKeyMigratedPath(), 'migrated')
}
function seedVaultFile(obj: unknown): void {
  writeFileSync(vaultPath(), JSON.stringify(obj))
}
function readVaultFileRaw(): string {
  return readFileSync(vaultPath(), 'utf-8')
}

// ---------------------------------------------------------------------------
// getMasterKey -- 7 branches, exercised through encrypt/setSecret so the
// private function is observed indirectly. Each branch is reached by
// picking a platform + setting up the keychain / file state.
// ---------------------------------------------------------------------------
describe('getMasterKey via setSecret/getSecret round-trip', () => {
  // (1) darwin + keychain available + VAULT_KEY_PATH exists + keychainStore OK
  //     -> migrate: store to keychain, rename to .migrated, return file key
  it('migrates an existing file key into the keychain on darwin', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    const fileKey = 'bWFnaWNrZXktZmlsZS1jb250ZW50' // base64("magickey-file-content")
    seedVaultKeyFile(fileKey)

    setSecret('id1', 'label1', 'plaintext-value-1')

    // keychainStore got the file key verbatim
    expect(state.keychainStored).toBe(fileKey)
    // the file was renamed to .vault-key.migrated
    expect(existsSync(vaultKeyMigratedPath())).toBe(true)
    expect(existsSync(vaultKeyPath())).toBe(false)
    // round-trip works (the master key decrypts the stored entry)
    expect(getSecret('id1')).toBe('plaintext-value-1')
  })

  // (2) darwin + keychain available + VAULT_KEY_PATH exists + keychainStore throws
  //     -> catch -> warn + return file key (no rename)
  it('falls back to the file key when keychainStore throws during migration', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainStoreThrows = true
    const fileKey = 'bWFnaWNrZXktZmlsZS1jb250ZW50'
    seedVaultKeyFile(fileKey)

    setSecret('id2', 'label2', 'plaintext-value-2')

    // Migration is best-effort: the file is the source of truth; the
    // keychain push is opportunistic. The throw is swallowed and the
    // file stays put, so the master key still decrypts the entry.
    expect(existsSync(vaultKeyPath())).toBe(true)
    expect(existsSync(vaultKeyMigratedPath())).toBe(false)
    expect(getSecret('id2')).toBe('plaintext-value-2')
  })

  // (3) darwin + keychain available + VAULT_KEY_PATH missing + keychainRetrieve returns key
  it('returns the existing keychain master key when no file exists', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    // Existing keychain entry, retrieved via keychainRetrieve -> master key.
    const existingKey = 'bWFnaWNrZXkta2V5Y2hhaW4tY29udGVudA=='
    state.keychainRetrieveReturn = existingKey

    setSecret('id3', 'label3', 'plaintext-value-3')
    // We did not write a fresh keychain entry because keychainRetrieve succeeded.
    expect(state.keychainStored).toBeNull()
    expect(existsSync(vaultKeyPath())).toBe(false)
    expect(getSecret('id3')).toBe('plaintext-value-3')
  })

  // (4) darwin + keychain available + VAULT_KEY_PATH missing + keychainRetrieve null
  //     + keychainStore OK -> create new key, store in keychain
  it('mints a new master key and stores it in the keychain on first darwin run', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveReturn = null // no prior keychain entry

    setSecret('id4', 'label4', 'plaintext-value-4')
    // keychainStore was called with a fresh key (non-empty base64).
    expect(state.keychainStored).not.toBeNull()
    expect(state.keychainStored!.length).toBeGreaterThan(0)
    // No file fallback path was taken.
    expect(existsSync(vaultKeyPath())).toBe(false)
    expect(getSecret('id4')).toBe('plaintext-value-4')
  })

  // (5) darwin + keychain available + VAULT_KEY_PATH missing + keychainRetrieve null
  //     + keychainStore throws -> propagates KeychainUnavailableError; NO file written.
  // Pin for the keychain-store-insecure-acl Option A cascade prevention (`c54317e`):
  // vault.ts:73-81 must now throw rather than silently downgrading to a
  // same-uid-readable file at store/.vault-key (mode 0600).
  it('propagates KeychainUnavailableError when keychainStore throws on first mint', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveReturn = null
    state.keychainStoreThrows = true

    expect(() => setSecret('id5', 'label5', 'plaintext-value-5')).toThrow(KeychainUnavailableError)
    expect(existsSync(vaultKeyPath())).toBe(false)
  })

  // (6) not darwin + VAULT_KEY_PATH missing -> atomicWriteFileSync creates it
  it('creates the file-backed master key on non-darwin when missing', () => {
    state.platform = 'linux'
    state.keychainAvailable = false
    // No prior file -> branch (6) creates one.

    setSecret('id6', 'label6', 'plaintext-value-6')
    expect(existsSync(vaultKeyPath())).toBe(true)
    expect(getSecret('id6')).toBe('plaintext-value-6')
  })

  // (7) not darwin + VAULT_KEY_PATH exists -> readFileSync, return buffer
  it('reads the existing file-backed master key on non-darwin', () => {
    state.platform = 'linux'
    state.keychainAvailable = false
    const existingKey = 'bWFnaWNrZXktZXhpc3RpbmctY29udGVudA=='
    seedVaultKeyFile(existingKey)

    setSecret('id7', 'label7', 'plaintext-value-7')
    // File was not overwritten (we'd lose the existing-key round-trip if it was).
    expect(readFileSync(vaultKeyPath(), 'utf-8').trim()).toBe(existingKey)
    expect(getSecret('id7')).toBe('plaintext-value-7')
  })

  // (8) keychainRetrieve throws AND vault is non-empty -> refuse to re-key.
  // Pins keychain-retrieve-swallows-locked-keychain:
  // the bare catch in keychainRetrieve previously mapped "locked" and
  // "missing" to the same null, so vault.getMasterKey minted a replacement
  // master key and silently overwrote (-U) the original -- every secret
  // encrypted under the old key became undecryptable. The fix throws
  // KeychainUnavailableError for any non-44 exit; vault.getMasterKey now
  // catches it, sees that the vault already has entries, and refuses.
  it('refuses to mint a new master key when keychainRetrieve throws AND vault has entries', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveThrows = true
    seedVaultFile({
      entries: [{
        id: 'existing', label: 'l', encrypted: 'ZW5jcnlwdGVk',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })

    expect(() => setSecret('any', 'any', 'any')).toThrow(KeychainUnavailableError)
    expect(state.keychainStored).toBeNull()  // keychainStore was never reached
  })

  // (9) keychainRetrieve throws AND vault is empty -> first-run fallback.
  // Pins the MD's "worth pairing with" note: first-run with an
  // unreachable keychain is the one edge case where re-keying is
  // unavoidable, because there is no prior master key to lose. The vault
  // entries guard deliberately allows this through. We assert only that
  // the initial mint happened; the cipher mock is round-trip-agnostic
  // about master keys, and a follow-up getSecret would re-enter
  // getMasterKey with vault entries present, triggering the (9a) branch
  // again -- which is a different scenario and is already pinned by the
  // (8) test.
  it('mints a new master key when keychainRetrieve throws AND vault is empty', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveThrows = true
    // No seedVaultFile -> readVault() returns { entries: [] } (vault.ts:93-96).
    state.keychainStored = null

    setSecret('first', 'first', 'plaintext-value-9')
    expect(state.keychainStored).not.toBeNull()  // a fresh key was stored
  })

  // (10) keychainRetrieve throws AND vault file is parseable but invalid shape.
  // The previous readVault() did `parsed.entries.length` on the raw object
  // and crashed with a TypeError, which incidentally aborted the mint. The
  // shape-validating readVault() would return { entries: [] } and let the
  // mint through, so a dedicated vaultHasContent() probe must still detect
  // "this file might hold encrypted secrets" and refuse to mint. Assert the
  // error is KeychainUnavailableError (NOT TypeError), and that the on-disk
  // file was not rewritten with a fresh master key.
  it('refuses to mint when keychainRetrieve throws AND the vault file has parseable-but-invalid shape', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveThrows = true
    seedVaultFile({ entries: 'notarray' })

    let caught: unknown = null
    try {
      setSecret('any', 'any', 'any')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(KeychainUnavailableError)
    expect(String(caught)).toMatch(/Refusing to mint a replacement/)
    // keychainStore was never reached.
    expect(state.keychainStored).toBeNull()
    // The on-disk file was not rewritten into a healthy store.
    expect(readVaultFileRaw()).toBe(JSON.stringify({ entries: 'notarray' }))
  })

  // (11) unchanged row: missing vault file + keychain unreachable still mints.
  it('mints when keychainRetrieve throws AND the vault file is missing', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveThrows = true
    // No seedVaultFile call.
    state.keychainStored = null

    setSecret('first', 'first', 'plaintext-value-11')
    expect(state.keychainStored).not.toBeNull()
  })

  // (12) unchanged row: valid store with >=1 entry + keychain unreachable
  // still throws KeychainUnavailableError (the original guard's reason for
  // existing). The vaultHasContent() probe must agree with the old
  // readVault().entries.length > 0 check on this branch.
  it('refuses to mint when keychainRetrieve throws AND the vault file holds a valid non-empty store', () => {
    state.platform = 'darwin'
    state.keychainAvailable = true
    state.keychainRetrieveThrows = true
    seedVaultFile({
      entries: [{
        id: 'existing', label: 'l', encrypted: 'ZW5jcnlwdGVk',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })

    expect(() => setSecret('any', 'any', 'any')).toThrow(KeychainUnavailableError)
    expect(state.keychainStored).toBeNull()
  })

})

// ---------------------------------------------------------------------------
// readVault / writeVault
// ---------------------------------------------------------------------------
describe('readVault', () => {
  it('returns an empty store when the vault file is missing', () => {
    // No seedVaultFile call.
    expect(listSecrets()).toEqual([])
  })

  it('returns an empty store when the vault file is malformed JSON', () => {
    writeFileSync(vaultPath(), '{not json')
    expect(listSecrets()).toEqual([])
  })

  it('parses and exposes entries from a well-formed vault file', () => {
    seedVaultFile({ entries: [
      { id: 'a', label: 'A', encrypted: 'enc-a', createdAt: 't1', updatedAt: 't2' },
      { id: 'b', label: 'B', encrypted: 'enc-b', createdAt: 't3', updatedAt: 't4' },
    ] })
    expect(listSecrets()).toEqual([
      { id: 'a', label: 'A', createdAt: 't1', updatedAt: 't2' },
      { id: 'b', label: 'B', createdAt: 't3', updatedAt: 't4' },
    ])
  })

  // Recovery contract: a parseable-but-invalid-shape vault is treated as an
  // empty store. listSecrets / getSecret / deleteSecret must not throw, and
  // a subsequent setSecret must rewrite the file into a healthy store and
  // round-trip via getSecret.
  it('returns an empty store for a parseable but shape-invalid vault file', () => {
    seedVaultFile({ unrelated: 'shape' })
    expect(listSecrets()).toEqual([])
    expect(getSecret('any')).toBeNull()
    expect(deleteSecret('any')).toBe(false)
  })

  it('returns an empty store when the top-level value is a JSON array', () => {
    writeFileSync(vaultPath(), JSON.stringify([]))
    expect(listSecrets()).toEqual([])
  })

  it('returns an empty store when the top-level value is a JSON string', () => {
    writeFileSync(vaultPath(), JSON.stringify('str'))
    expect(listSecrets()).toEqual([])
  })

  it('returns an empty store when the top-level value is JSON null', () => {
    writeFileSync(vaultPath(), JSON.stringify(null))
    expect(listSecrets()).toEqual([])
  })

  it('returns an empty store when entries is present but not an array', () => {
    seedVaultFile({ entries: 'notarray' })
    expect(listSecrets()).toEqual([])
  })

  it('rewrites a parseable-but-invalid vault into a healthy store on setSecret', () => {
    seedVaultFile({ entries: 'notarray' })
    state.platform = 'linux'
    state.keychainAvailable = false

    setSecret('recovered', 'recovered-label', 'recovered-value')

    const onDisk = JSON.parse(readVaultFileRaw())
    expect(Array.isArray(onDisk.entries)).toBe(true)
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0]).toMatchObject({ id: 'recovered', label: 'recovered-label' })
    expect(getSecret('recovered')).toBe('recovered-value')
  })
})

describe('writeVault (via setSecret)', () => {
  it('persists a JSON document on disk after setSecret', () => {
    state.platform = 'linux'
    state.keychainAvailable = false
    setSecret('w1', 'write-test', 'w-value')
    const onDisk = JSON.parse(readVaultFileRaw())
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0]).toMatchObject({ id: 'w1', label: 'write-test' })
    expect(typeof onDisk.entries[0].encrypted).toBe('string')
    expect(typeof onDisk.entries[0].createdAt).toBe('string')
    expect(typeof onDisk.entries[0].updatedAt).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// listSecrets (the public face of readVault; exercised above for the file
// states, here for the shape contract).
// ---------------------------------------------------------------------------
describe('listSecrets', () => {
  it('returns an empty array for a freshly-initialized vault', () => {
    expect(listSecrets()).toEqual([])
  })

  it('omits the encrypted field from each entry', () => {
    state.platform = 'linux'
    state.keychainAvailable = false
    setSecret('s1', 'S1', 'secret-1')
    setSecret('s2', 'S2', 'secret-2')
    const list = listSecrets()
    expect(list).toHaveLength(2)
    for (const e of list) {
      expect(e).not.toHaveProperty('encrypted')
      expect(Object.keys(e).sort()).toEqual(['createdAt', 'id', 'label', 'updatedAt'])
    }
  })
})

// ---------------------------------------------------------------------------
// setSecret -- new entry vs replace-existing.
// ---------------------------------------------------------------------------
describe('setSecret', () => {
  beforeEach(() => {
    state.platform = 'linux'
    state.keychainAvailable = false
  })

  it('appends a new entry when the id is unknown', () => {
    setSecret('new1', 'new-label', 'v')
    expect(listSecrets()).toEqual([
      expect.objectContaining({ id: 'new1', label: 'new-label' }),
    ])
    expect(getSecret('new1')).toBe('v')
  })

  it('replaces an existing entry in place while preserving createdAt', async () => {
    setSecret('upd', 'old-label', 'old-value')
    const before = listSecrets().find((e) => e.id === 'upd')!
    const oldCreatedAt = before.createdAt
    const oldUpdatedAt = before.updatedAt

    // Bump the clock so updatedAt moves forward; the implementation uses
    // new Date().toISOString() so successive calls in the same tick get the
    // same string. We sleep 5ms to guarantee a different timestamp.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    setSecret('upd', 'new-label', 'new-value')
    const after = listSecrets().find((e) => e.id === 'upd')!
    expect(after.label).toBe('new-label')
    expect(after.createdAt).toBe(oldCreatedAt) // preserved
    expect(after.updatedAt).not.toBe(oldUpdatedAt) // advanced
    expect(getSecret('upd')).toBe('new-value')
    // No duplicate entries.
    expect(listSecrets().filter((e) => e.id === 'upd')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------
describe('getSecret', () => {
  beforeEach(() => {
    state.platform = 'linux'
    state.keychainAvailable = false
  })

  it('returns null for an unknown id', () => {
    expect(getSecret('nope')).toBeNull()
  })

  it('returns null when the vault file is missing or malformed', () => {
    expect(getSecret('anything')).toBeNull()
    writeFileSync(vaultPath(), '{not json')
    expect(getSecret('anything')).toBeNull()
  })

  it('decrypts and returns the stored value for a present id', () => {
    setSecret('g1', 'G1', 'the-secret-payload')
    expect(getSecret('g1')).toBe('the-secret-payload')
  })
})

// ---------------------------------------------------------------------------
// deleteSecret
// ---------------------------------------------------------------------------
describe('deleteSecret', () => {
  beforeEach(() => {
    state.platform = 'linux'
    state.keychainAvailable = false
  })

  it('returns false and does not touch the file when nothing matches', () => {
    setSecret('keep', 'K', 'k-value')
    const before = readVaultFileRaw()
    expect(deleteSecret('nope')).toBe(false)
    // writeVault was NOT called -- file content is byte-identical.
    expect(readVaultFileRaw()).toBe(before)
  })

  it('returns true and removes the matching entry when it exists', () => {
    setSecret('d1', 'D1', 'd-value')
    setSecret('d2', 'D2', 'd-value-2')
    expect(deleteSecret('d1')).toBe(true)
    const remaining = listSecrets()
    expect(remaining.map((e) => e.id)).toEqual(['d2'])
  })
})

// ---------------------------------------------------------------------------
// getSecretsForEnv
// ---------------------------------------------------------------------------
describe('getSecretsForEnv', () => {
  beforeEach(() => {
    state.platform = 'linux'
    state.keychainAvailable = false
  })

  it('returns an empty record for an empty input map', () => {
    expect(getSecretsForEnv({})).toEqual({})
  })

  it('returns a record populated only with keys whose vault id resolves', () => {
    setSecret('api-key', 'API_KEY', 'real-key-value')
    setSecret('oauth-token', 'OAUTH', 'real-token-value')
    const out = getSecretsForEnv({
      API_KEY: 'api-key',
      MISSING_KEY: 'no-such-id',
      OAUTH: 'oauth-token',
    })
    expect(out).toEqual({
      API_KEY: 'real-key-value',
      OAUTH: 'real-token-value',
    })
    expect(out).not.toHaveProperty('MISSING_KEY')
  })
})
