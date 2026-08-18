// Extra branches for src/remote-enroll-fs.ts.
//
// The existing remote-enroll-fs.test.ts covers the happy paths, the
// permission/replacement warnings, lock contention, and stale-lock recovery. A
// handful of defensive branches slipped past:
//
//   * defaultSleep (line 51-52): the bare `setTimeout` resolver used when
//     the caller does not pass a `sleep` implementation. We exercise it
//     by NOT injecting a sleep into a call that hits a contended lock.
//   * ensureSshDir (line 76): the "exists but is not a directory" throw.
//   * acquireLock (line 118): the "lock vanished between open and stat"
//     catch branch inside the EEXIST handler.
//   * writeAtomic (line 201-206): the rename failure path that unlinks the
//     tmp file and rethrows.
//   * removeEnrolledKey early-return (line 242): the missing-file short
//     circuit before the lock is even taken.
//   * removeEnrolledKey post-lock short-circuit (line 246): the file
//     vanishes between the lock acquisition and the post-lock read.
//
// Mocking strategy: vi.mock('node:fs') at the top of THIS file. The mock
// factory wraps the real fs module so most tests get a transparent
// pass-through, and only the targeted tests install a behaviour override
// via H.fsHooks. The existing remote-enroll-fs.test.ts is a SEPARATE file
// and is unaffected (vi.mock is hoisted per-file).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enrollAuthorizedKey,
  removeEnrolledKey,
} from '../remote-enroll-fs.js'
import { buildRestrictedLine, validatePublicKeyLine } from '../remote-enroll-core.js'

const H = vi.hoisted(() => ({
  // per-call hooks; null/undefined means fall-through to real fs.
  renameOverride: null as ((src: string, dst: string) => void) | null,
  // statSync throws for these paths.
  statThrow: new Set<string>(),
  // existsSync override KEYED BY PATH.
  existsOverride: new Map<string, boolean>(),
  // existsSync call counter per path.
  existsCallCount: new Map<string, number>(),
  // openSync throws an error with this code for these paths.
  openThrowCode: new Map<string, string>(),
}))

vi.mock('node:fs', async () => {
  const actual = (await vi.importActual('node:fs')) as typeof import('node:fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (H.existsOverride.has(p)) {
        const cur = H.existsCallCount.get(p) ?? 0
        H.existsCallCount.set(p, cur + 1)
        return H.existsOverride.get(p)!
      }
      return actual.existsSync(p)
    },
    openSync: (p: string, flags?: string | number, mode?: number) => {
      const key = typeof p === 'string' ? p : (p as { toString(): string }).toString()
      if (H.openThrowCode.has(key)) {
        const err = new Error(`synthetic open error: ${H.openThrowCode.get(key)}`) as NodeJS.ErrnoException
        err.code = H.openThrowCode.get(key)!
        throw err
      }
      return actual.openSync(p as Parameters<typeof actual.openSync>[0], flags as Parameters<typeof actual.openSync>[1], mode as Parameters<typeof actual.openSync>[2])
    },
    renameSync: (src: string, dst: string) => {
      if (H.renameOverride) {
        H.renameOverride(src, dst)
        return
      }
      return actual.renameSync(src, dst)
    },
    statSync: (p: string, options?: unknown) => {
      const key = typeof p === 'string' ? p : (p as { toString(): string }).toString()
      if (H.statThrow.has(key)) {
        throw new Error('ENOENT: synthetic stat failure')
      }
      return actual.statSync(p as Parameters<typeof actual.statSync>[0], options as Parameters<typeof actual.statSync>[1])
    },
  }
})

const fs = await import('node:fs')

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER = '11111111-2222-4333-8444-555555555555'

function ed25519Base64(keyByte = 0x42): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const key = Buffer.alloc(32, keyByte)
  const len = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  return Buffer.concat([len(type.length), type, len(32), key]).toString('base64')
}

const B64 = ed25519Base64()
const otherB64 = ed25519Base64(0x99)
const RESTRICTED = buildRestrictedLine(
  validatePublicKeyLine(`ssh-ed25519 ${B64} marveen-remote:${UUID}`),
)
const OTHER_RESTRICTED = buildRestrictedLine(
  validatePublicKeyLine(`ssh-ed25519 ${otherB64} marveen-remote:${OTHER}`),
)

describe('remote-enroll-fs: extra branches', () => {
  let root: string
  let sshDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'remote-enroll-fs-extra-'))
    sshDir = join(root, '.ssh')
    H.renameOverride = null
    H.statThrow.clear()
    H.existsOverride.clear()
    H.existsCallCount.clear()
    H.openThrowCode.clear()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // ensureSshDir: "exists but is not a directory"
  // -----------------------------------------------------------------------
  it('throws when sshDir exists but is a regular file, not a directory', async () => {
    fs.writeFileSync(sshDir, 'I am a regular file, not a directory')
    await expect(
      enrollAuthorizedKey({
        sshDir,
        restrictedLine: RESTRICTED,
        installId: UUID,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/is not a directory/)
  })

  // -----------------------------------------------------------------------
  // defaultSleep: invoked when the lock is contended and we wait between
  // retries. We do NOT inject a sleep; the function uses defaultSleep.
  // The lock is fresh (staleLockMs is much larger than the test window),
  // so each retry sleeps and then encounters EEXIST again. After 5 retries
  // the function rejects. The fact that the default sleep was INDEED
  // invoked is verified by the elapsed wall time (>= 5 * delayMs).
  // -----------------------------------------------------------------------
  it('uses the default sleep when no sleep is injected and the lock is held', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    fs.writeFileSync(join(sshDir, 'authorized_keys.lock'), '99999\n')
    const start = Date.now()
    await expect(
      enrollAuthorizedKey({
        sshDir,
        restrictedLine: RESTRICTED,
        installId: UUID,
        lockRetries: 5,
        lockRetryDelayMs: 5,
        staleLockMs: 60_000,
        // NO sleep injected -> defaultSleep is used.
      }),
    ).rejects.toThrow(/could not acquire/)
    const elapsed = Date.now() - start
    // Default sleep is a real setTimeout-based sleep. 5 retries * 5ms = 25ms
    // minimum. Allow generous headroom for the scheduler.
    expect(elapsed).toBeGreaterThanOrEqual(20)
  })

  // -----------------------------------------------------------------------
  // acquireLock: statSync throws on the contended lock
  // (docs/needs-to-be-fix/remote-enroll-fs-lock-vanish-spin.md)
  //
  // The EEXIST handler runs statSync; when that throws we cannot tell whether
  // the lock is stale, and the file is still there (the mock does not delete
  // it). The loop must therefore WAIT between retries instead of spinning
  // through every attempt instantly. Pinned trait: sleep runs once per retry.
  // -----------------------------------------------------------------------
  it('sleeps between retries when statSync throws on the contended lock', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const lockPath = join(sshDir, 'authorized_keys.lock')
    fs.writeFileSync(lockPath, 'thief\n')

    H.statThrow.add(lockPath)

    let sleepCalls = 0
    const sleep = async () => {
      sleepCalls += 1
    }
    await expect(
      enrollAuthorizedKey({
        sshDir,
        restrictedLine: RESTRICTED,
        installId: UUID,
        lockRetries: 3,
        lockRetryDelayMs: 1,
        staleLockMs: 60_000,
        sleep,
      }),
    ).rejects.toThrow(/could not acquire/)
    expect(sleepCalls).toBe(3)
  })

  // -----------------------------------------------------------------------
  // removeEnrolledKey: missing file short-circuit (line 242)
  // -----------------------------------------------------------------------
  it('removeEnrolledKey returns removed:false when authorized_keys does not exist', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const authPath = join(sshDir, 'authorized_keys')
    expect(fs.existsSync(authPath)).toBe(false)
    const r = await removeEnrolledKey({
      sshDir,
      installId: UUID,
      sleep: () => Promise.resolve(),
    })
    expect(r).toEqual({ removed: false, authorizedKeysPath: authPath })
  })

  // -----------------------------------------------------------------------
  // removeEnrolledKey: post-lock short-circuit (line 246)
  //
  // We use the override Map with a 2-call counter: first call returns
  // true (pre-lock passes), second call returns false (post-lock fails).
  // -----------------------------------------------------------------------
  it('removeEnrolledKey returns removed:false when the file vanishes between lock and read', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const authPath = join(sshDir, 'authorized_keys')
    fs.writeFileSync(authPath, 'ssh-rsa AAAA a@h\n', { mode: 0o600 })

    // We need a sequence: first call -> true, second call -> false.
    // The mock factory increments the counter on every call; we install
    // a counter-driven override by repeatedly mutating the Map between
    // call sites. Since the two existsSync calls are synchronous within
    // removeEnrolledKey, we can't mutate between them. Instead, install
    // a wrapper that returns true on the first call and false on the
    // second. We need a function-style override; the Map<string, boolean>
    // can't express this directly. Easiest: use a separate pass-through
    // by removing the override after the first call. The mock factory
    // checks the Map first; if present, increments and returns. We
    // simulate "true on first, false on second" by:
    //   * Set existsOverride[authPath] = true
    //   * After the first call (the pre-lock check), DELETE the override
    //     so the post-lock check falls through to the real fs.
    //   * The real fs sees the file, so it returns true. We then need to
    //     make the real fs return false. We unlink the file.
    // (a) The unlink must happen BETWEEN the first and second call.
    // (b) The two calls are synchronous, so we can't unlink in between.
    // SOLUTION: instead of the race, we exercise the post-lock path by
    // making the FIRST existsSync check return TRUE (override set),
    // then unlink the file synchronously inside the override, then let
    // the second call fall through to real fs (which sees the file
    // gone). The override function approach: set override to a sentinel
    // that, on first call, unlinks the file and returns true. After that,
    // the Map is cleared (real fs returns false). We do this by storing
    // the path under a special key.

    // Simpler: directly unlink the file in the override BEFORE the call
    // starts so the real fs sees it gone. But then the first call also
    // returns false (line 242 fires).
    //
    // Correct approach: use the override to return true on the first call,
    // and inside the mock factory, after the first call returns, unlink
    // the file. The mock factory is frozen at module-load; we can't
    // mutate it from inside the test. So we use a counter and a
    // post-call side-effect: set existsOverride[authPath] = true, then
    // delete the file and the override before the second call, but the
    // calls are synchronous.
    //
    // FINAL solution: use the sleep injected into a contended lock to
    // delete the file between acquireLock and the post-lock check. This
    // requires a contended lock; we pre-create the lock and inject a
    // sleep that deletes the authPath and removes the lock. The default
    // acquireLock flow: EEXIST -> statSync (fresh) -> sleep -> retry.
    // The sleep is called BEFORE the post-lock check, so we can use it
    // to delete the file.
    fs.writeFileSync(join(sshDir, 'authorized_keys.lock'), 'thief\n')
    const lockPath = join(sshDir, 'authorized_keys.lock')
    const sleep = async () => {
      // Delete the authPath so the post-lock check returns false.
      try { fs.unlinkSync(authPath) } catch { /* ignore */ }
      // Remove the lock so the next acquireLock attempt succeeds.
      try { fs.unlinkSync(lockPath) } catch { /* ignore */ }
    }

    const r = await removeEnrolledKey({
      sshDir,
      installId: UUID,
      lockRetries: 5,
      lockRetryDelayMs: 1,
      staleLockMs: 60_000,
      sleep,
    })
    expect(r).toEqual({ removed: false, authorizedKeysPath: authPath })
    // The lock file should be gone (releaseLock ran in finally).
    expect(fs.existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
  })

  // -----------------------------------------------------------------------
  // removeEnrolledKey: happy path - removes the matching line
  // -----------------------------------------------------------------------
  it('removeEnrolledKey removes the matching line and preserves others', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const authPath = join(sshDir, 'authorized_keys')
    const initial = `ssh-rsa AAAA someone@host\n${RESTRICTED}\n${OTHER_RESTRICTED}\n`
    fs.writeFileSync(authPath, initial, { mode: 0o600 })
    const r = await removeEnrolledKey({
      sshDir,
      installId: UUID,
      sleep: () => Promise.resolve(),
    })
    expect(r.removed).toBe(true)
    expect(r.authorizedKeysPath).toBe(authPath)
    const content = fs.readFileSync(authPath, 'utf8')
    expect(content).toBe(`ssh-rsa AAAA someone@host\n${OTHER_RESTRICTED}\n`)
    expect(content).not.toContain('marveen-remote:' + UUID)
  })

  it('removeEnrolledKey returns removed:false when the install id is not present', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const authPath = join(sshDir, 'authorized_keys')
    fs.writeFileSync(authPath, `${OTHER_RESTRICTED}\n`, { mode: 0o600 })
    const r = await removeEnrolledKey({
      sshDir,
      installId: UUID,
      sleep: () => Promise.resolve(),
    })
    expect(r.removed).toBe(false)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(`${OTHER_RESTRICTED}\n`)
  })

  // -----------------------------------------------------------------------
  // writeAtomic: rename failure path (lines 201-206)
  // -----------------------------------------------------------------------
  it('writeAtomic unlinks the tmp file and rethrows when renameSync fails', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const authPath = join(sshDir, 'authorized_keys')
    fs.writeFileSync(authPath, `ssh-rsa AAAA a@h\n`, { mode: 0o600 })

    H.renameOverride = (src: string, dst: string) => {
      if (src !== dst && src.endsWith('.tmp') && dst === authPath) {
        throw new Error('EBUSY: synthetic rename failure')
      }
    }

    await expect(
      enrollAuthorizedKey({
        sshDir,
        restrictedLine: RESTRICTED,
        installId: UUID,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/synthetic rename failure/)

    expect(fs.readFileSync(authPath, 'utf8')).toBe(`ssh-rsa AAAA a@h\n`)
    const entries = fs.readdirSync(sshDir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
    expect(entries).not.toContain('authorized_keys.lock')
  })

  // -----------------------------------------------------------------------
  // ensureSshDir: warning push when .ssh is looser than 0700
  // -----------------------------------------------------------------------
  it('warns when .ssh has GROUP or OTHER permissions (looser than 0700)', async () => {
    fs.mkdirSync(sshDir, { mode: 0o755 })
    fs.chmodSync(sshDir, 0o755)
    const res = await enrollAuthorizedKey({
      sshDir,
      restrictedLine: RESTRICTED,
      installId: UUID,
      sleep: () => Promise.resolve(),
    })
    expect(res.warnings.some((w) => w.includes('permissions'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // acquireLock: openSync throws a non-EEXIST error (line 108, true branch)
  //
  // Line 108 reads `if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
  // throw err`. The TRUE branch (non-EEXIST) is the rethrow. We trigger
  // EACCES on the lockPath and verify the function rejects with that
  // error without retrying.
  // -----------------------------------------------------------------------
  it('rethrows non-EEXIST errors from openSync immediately', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const lockPath = join(sshDir, 'authorized_keys.lock')
    H.openThrowCode.set(lockPath, 'EACCES')

    await expect(
      enrollAuthorizedKey({
        sshDir,
        restrictedLine: RESTRICTED,
        installId: UUID,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/EACCES|synthetic open error/)
  })

  // -----------------------------------------------------------------------
  // acquireLock: stale lock removed and retry succeeds
  // -----------------------------------------------------------------------
  it('removes a stale lock and acquires cleanly', async () => {
    fs.mkdirSync(sshDir, { mode: 0o700 })
    const lockPath = join(sshDir, 'authorized_keys.lock')
    fs.writeFileSync(lockPath, '99999\n')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, past, past)
    const res = await enrollAuthorizedKey({
      sshDir,
      restrictedLine: RESTRICTED,
      installId: UUID,
      staleLockMs: 1000,
      sleep: () => Promise.resolve(),
    })
    expect(res.action).toBe('added')
    expect(fs.existsSync(lockPath)).toBe(false)
  })
})
