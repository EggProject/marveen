// 100% coverage test for src/web/keychain.ts.
//
// The module is a thin `/usr/bin/security` wrapper with four exports:
//   isKeychainAvailable  -- platform() === 'darwin'
//   keychainStore        -- add-generic-password -U ... -A  (no try/catch)
//   keychainRetrieve     -- find-generic-password -w, catch -> null
//   keychainDelete       -- delete-generic-password, catch -> false
//
// Mocking strategy (rule 5 + rule 4):
//   - node:child_process is mocked so `execFileSync` never spawns anything.
//     This suite must NEVER touch a real keychain: the service/account pair
//     it drives (`com.marveen.vault` / `master-key`) is the LIVE vault master
//     key on any macOS box with marveen installed, and `add-generic-password
//     -U` would silently overwrite it, making every existing vault entry
//     permanently undecryptable (see src/web/vault.ts:44-55). There is
//     therefore no `process.platform === 'darwin'` integration path here --
//     mocking is the only safe option, so the suite is fully
//     platform-independent and passes on Linux CI too.
//   - node:os is mocked via importOriginal so only `platform` is replaced;
//     `tmpdir` stays real because setup/temp-sandbox.ts depends on it.
//
// keychain.ts holds no module-scope STORE_DIR / PROJECT_ROOT / homedir()
// derived state (SECURITY / SERVICE / ACCOUNT are literals), so rules 2 and 3
// have nothing to redirect: a single static import is sufficient and no
// vi.resetModules() dance is needed. snapshotEnv() is still installed as a
// cheap guard so a stray env mutation can never escape this file.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { snapshotEnv } from './setup/temp-sandbox.js'

// The exact literals from src/web/keychain.ts:4-6. Duplicated (not imported --
// they are not exported) so a silent rename of the service or account, which
// would orphan every already-stored key, fails this suite.
const SECURITY = '/usr/bin/security'
const SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

type ExecFileSync = (file: string, args: readonly string[], opts?: unknown) => string

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn<ExecFileSync>(),
  platform: vi.fn<() => NodeJS.Platform>(),
}))

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: mocks.platform }
})

const { isKeychainAvailable, keychainStore, keychainRetrieve, keychainDelete } =
  await import('../web/keychain.js')

const envSnapshot = snapshotEnv()

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.platform.mockReset()
  mocks.platform.mockReturnValue('darwin')
})

afterEach(() => {
  vi.clearAllMocks()
})

afterAll(() => {
  envSnapshot.restore()
})

/** The single (file, args, opts) triple execFileSync was called with. */
function onlyCall(): { file: string; args: readonly string[]; opts: unknown } {
  expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
  const call = mocks.execFileSync.mock.calls[0]
  return { file: call[0], args: call[1], opts: call[2] }
}

/** Value of the flag directly following `flag` in an argv array. */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx === -1 ? undefined : args[idx + 1]
}

// ---------------------------------------------------------------------------
// isKeychainAvailable
// ---------------------------------------------------------------------------
describe('isKeychainAvailable - platform gate', () => {
  it('returns true on darwin', () => {
    mocks.platform.mockReturnValue('darwin')
    expect(isKeychainAvailable()).toBe(true)
  })

  it('returns false on linux', () => {
    mocks.platform.mockReturnValue('linux')
    expect(isKeychainAvailable()).toBe(false)
  })

  it('returns false on win32', () => {
    mocks.platform.mockReturnValue('win32')
    expect(isKeychainAvailable()).toBe(false)
  })

  // The gate is re-read on every call rather than captured at module load, so
  // a platform mock swapped mid-suite must be observed immediately.
  it('re-evaluates platform() on every call', () => {
    mocks.platform.mockReturnValueOnce('darwin').mockReturnValueOnce('linux')
    expect(isKeychainAvailable()).toBe(true)
    expect(isKeychainAvailable()).toBe(false)
    expect(mocks.platform).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// keychainStore
// ---------------------------------------------------------------------------
describe('keychainStore - add-generic-password', () => {
  it('invokes /usr/bin/security with the add-generic-password argv', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainStore('s3cret-key')

    const { file, args } = onlyCall()
    expect(file).toBe(SECURITY)
    expect(args[0]).toBe('add-generic-password')
    expect(argAfter(args, '-s')).toBe(SERVICE)
    expect(argAfter(args, '-a')).toBe(ACCOUNT)
    expect(argAfter(args, '-w')).toBe('s3cret-key')
  })

  it('passes -U so an existing item is updated instead of erroring', () => {
    // Without -U the security(1) man page states "the item cannot already
    // exist", i.e. every re-store after the first would throw.
    mocks.execFileSync.mockReturnValue('')
    keychainStore('k')
    expect(onlyCall().args).toContain('-U')
  })

  it('silences all three stdio streams', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainStore('k')
    expect(onlyCall().opts).toEqual({ stdio: ['ignore', 'ignore', 'ignore'] })
  })

  it('does not request utf-8 encoding (return value is unused)', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainStore('k')
    expect(onlyCall().opts).not.toHaveProperty('encoding')
  })

  it('returns undefined regardless of what security prints', () => {
    mocks.execFileSync.mockReturnValue('some output')
    expect(keychainStore('k')).toBeUndefined()
  })

  it('stores an empty string without special-casing it', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainStore('')
    expect(argAfter(onlyCall().args, '-w')).toBe('')
  })

  it('passes the value verbatim, without shell quoting or trimming', () => {
    // execFileSync takes an argv array (no shell), so metacharacters and
    // surrounding whitespace must survive untouched.
    mocks.execFileSync.mockReturnValue('')
    const raw = "  a b'c\"d;$(whoami)`x`\\y\n  "
    keychainStore(raw)
    expect(argAfter(onlyCall().args, '-w')).toBe(raw)
  })

  // keychainStore has no try/catch: propagation is what lets vault.ts's
  // callers (src/web/vault.ts:34-40 and :48-54) fall back to a file-based key.
  it('propagates the execFileSync error instead of swallowing it', () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error('boom') })
    expect(() => keychainStore('k')).toThrow('boom')
  })

  it('propagates ENOENT when /usr/bin/security is missing', () => {
    const enoent = Object.assign(new Error('spawnSync /usr/bin/security ENOENT'), {
      code: 'ENOENT',
    })
    mocks.execFileSync.mockImplementation(() => { throw enoent })
    expect(() => keychainStore('k')).toThrow(/ENOENT/)
  })
})

// ---------------------------------------------------------------------------
// keychainRetrieve
// ---------------------------------------------------------------------------
describe('keychainRetrieve - find-generic-password', () => {
  it('invokes /usr/bin/security with the find-generic-password argv', () => {
    mocks.execFileSync.mockReturnValue('key\n')
    keychainRetrieve()

    const { file, args } = onlyCall()
    expect(file).toBe(SECURITY)
    expect(args).toEqual(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
  })

  it('requests utf-8 encoding and pipes stdout+stderr', () => {
    mocks.execFileSync.mockReturnValue('key\n')
    keychainRetrieve()
    expect(onlyCall().opts).toEqual({
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('returns the trailing-newline-stripped password', () => {
    mocks.execFileSync.mockReturnValue('bXktc2VjcmV0\n')
    expect(keychainRetrieve()).toBe('bXktc2VjcmV0')
  })

  it('trims surrounding whitespace on both sides', () => {
    mocks.execFileSync.mockReturnValue('  \t padded \r\n')
    expect(keychainRetrieve()).toBe('padded')
  })

  it('preserves interior whitespace', () => {
    mocks.execFileSync.mockReturnValue('two words\n')
    expect(keychainRetrieve()).toBe('two words')
  })

  it('returns null for empty output', () => {
    mocks.execFileSync.mockReturnValue('')
    expect(keychainRetrieve()).toBeNull()
  })

  it('returns null for whitespace-only output', () => {
    // The `|| null` arm: trim() collapses to '' which is falsy.
    mocks.execFileSync.mockReturnValue('   \n\t  ')
    expect(keychainRetrieve()).toBeNull()
  })

  it('returns null when security exits non-zero (item not found)', () => {
    const notFound = Object.assign(
      new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'),
      { status: 44 },
    )
    mocks.execFileSync.mockImplementation(() => { throw notFound })
    expect(keychainRetrieve()).toBeNull()
  })

  it('returns null when /usr/bin/security is missing (non-darwin host)', () => {
    // Nothing gates the exec on isKeychainAvailable(), so a Linux caller that
    // skips the gate lands in the catch rather than crashing.
    mocks.platform.mockReturnValue('linux')
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync /usr/bin/security ENOENT'), { code: 'ENOENT' })
    })
    expect(keychainRetrieve()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// keychainDelete
// ---------------------------------------------------------------------------
describe('keychainDelete - delete-generic-password', () => {
  it('invokes /usr/bin/security with the delete-generic-password argv', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainDelete()

    const { file, args, opts } = onlyCall()
    expect(file).toBe(SECURITY)
    expect(args).toEqual(['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
    expect(opts).toEqual({ stdio: ['ignore', 'ignore', 'ignore'] })
  })

  it('returns true when security exits zero', () => {
    mocks.execFileSync.mockReturnValue('')
    expect(keychainDelete()).toBe(true)
  })

  it('returns false when the item does not exist', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
    })
    expect(keychainDelete()).toBe(false)
  })

  it('returns false on a non-Error throw', () => {
    // The bare `catch {}` has no binding, so any thrown shape is absorbed.
    mocks.execFileSync.mockImplementation(() => { throw 'not-an-error' })
    expect(keychainDelete()).toBe(false)
  })

  it('deletes only the com.marveen.vault / master-key pair', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainDelete()
    const { args } = onlyCall()
    expect(argAfter(args, '-s')).toBe(SERVICE)
    expect(argAfter(args, '-a')).toBe(ACCOUNT)
  })
})

// ---------------------------------------------------------------------------
// Known deviations (pinning). These lock in current behavior and MUST fail
// once the corresponding docs/needs-to-be-fix/ entry is fixed.
// ---------------------------------------------------------------------------
describe('keychain.ts - known deviations (pinning)', () => {
  // docs/needs-to-be-fix/keychain-store-insecure-acl.md
  it('passes -A, the flag security(1) itself calls insecure', () => {
    // security(1): "-A  Allow any application to access this item without
    // warning (insecure, not recommended!)". -A leaves the item's ACL empty,
    // so the vault master key is readable through the SecKeychain API
    // directly -- not only by way of an exec of /usr/bin/security. The MD
    // prescribes removing -A, but in the current install -A is what keeps
    // the background process able to access the keychain without a UI
    // prompt. A prompt would be silently swallowed as null by
    // keychainRetrieve, triggering vault re-key (vault.ts:44-49). Until
    // keychain-retrieve-swallows-locked-keychain is fixed first, -A must
    // stay so the background flow continues to work.
    mocks.execFileSync.mockReturnValue('')
    keychainStore('master')
    expect(onlyCall().args).toContain('-A')
  })

  // docs/needs-to-be-fix/keychain-retrieve-swallows-locked-keychain.md
  it('reports a LOCKED keychain identically to a MISSING item (both null)', () => {
    // errSecInteractionNotAllowed (-25308) surfaces from security(1) as exit
    // 36 / "User interaction is not allowed." -- the normal state for a login
    // keychain over non-interactive SSH or right after a reboot. The bare
    // catch maps it to null, which vault.ts:44-49 reads as "no key yet" and
    // answers by minting + storing (with -U) a REPLACEMENT master key.
    const locked = Object.assign(new Error('User interaction is not allowed.'), { status: 36 })
    mocks.execFileSync.mockImplementation(() => { throw locked })
    expect(keychainRetrieve()).toBeNull()

    mocks.execFileSync.mockReset()
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
    })
    expect(keychainRetrieve()).toBeNull()
  })

  // Not filed as a bug: the secret rides in argv rather than on stdin, which
  // exposes it to anything that can read this process's arguments. On macOS
  // that is same-uid and root only (unlike Linux /proc), and a same-uid
  // reader can already just run `security find-generic-password` itself, so
  // there is no confirmed additional exposure. Pinned as a behavioral fact,
  // not as a defect claim -- `security` offers no stdin path for the password
  // (only -w on argv or -X as hex), so this is not straightforwardly fixable.
  it('passes the secret as an argv element rather than on stdin', () => {
    mocks.execFileSync.mockReturnValue('')
    keychainStore('super-secret-master-key')
    expect(onlyCall().args).toContain('super-secret-master-key')
  })
})
