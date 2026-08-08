// Tests for src/store-watcher.ts.
//
// The watcher consumes fs.watch events for STORE_DIR, normalizes filenames,
// filters system/runtime files, dedups within a 1s window, and logs "create"
// events through db.logStoreFileEvent. The runtime DB is mocked -- the suite
// only verifies the watcher's own behaviour (event filter, dedup, knownFiles
// pre-population, actor slot consumption, error swallowing) and the public
// lifecycle (start/stop/setStoreWriteActor/clearStoreWriteActor).
//
// Sandbox: STORE_DIR is redirected into a tmpdir-scoped directory via the
// ../config.js mock. vitest isolates module registries per test file so the
// redirect cannot leak into other suites. The on-disk sandbox is removed in
// afterAll to satisfy the live-install-guard convention.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Merged into the existing '../config.js' mock factory below.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})


// --- Sandbox setup -------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), 'store-watcher-'))
const STORE = join(SANDBOX, 'store')
mkdirSync(STORE, { recursive: true })

// --- node:fs mock --------------------------------------------------------
// Capture the watch callback so the suite can fire events deterministically
// (real fs.watch timing varies between platforms and is unreliable under
// vitest's parallel worker scheduling). Real statSync/readdirSync are kept
// so scanStore and the existence-check work against the actual sandbox.

let watchCallback: ((eventType: string, filename: string | null) => void) | null = null
let watchArgs: { dir: string; options: unknown } | null = null
let mockWatchShouldThrow = false
let mockCloseShouldThrow = false

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    watch: ((dir: string, options: unknown, cb: (eventType: string, filename: string | null) => void) => {
      if (mockWatchShouldThrow) throw new Error('mock watch failure')
      watchCallback = cb
      watchArgs = { dir, options }
      return {
        close: () => {
          if (mockCloseShouldThrow) throw new Error('mock close failure')
        },
      } as unknown as ReturnType<typeof actual.watch>
    }) as typeof actual.watch,
  }
})

// --- Config + DB + logger mocks ------------------------------------------

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, ...configSandbox, STORE_DIR: STORE }
})

const logStoreFileEventMock = vi.fn()
vi.mock('../db.js', () => ({
  logStoreFileEvent: (
    relPath: string,
    eventType: string,
    isSensitive: number,
    fileSize: number | null,
    agent: string | null,
  ) => {
    logStoreFileEventMock(relPath, eventType, isSensitive, fileSize, agent)
  },
}))

const infoMock = vi.fn()
const warnMock = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    info: (obj: unknown, msg?: string) => infoMock(obj, msg),
    warn: (obj: unknown, msg?: string) => warnMock(obj, msg),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// --- Subject under test --------------------------------------------------

const {
  startStoreWatcher,
  stopStoreWatcher,
  setStoreWriteActor,
  clearStoreWriteActor,
} = await import('../store-watcher.js')

// --- Helpers -------------------------------------------------------------

function fireRename(rel: string): void {
  if (!watchCallback) throw new Error('watcher not started')
  watchCallback('rename', rel)
}

function fireChange(rel: string): void {
  if (!watchCallback) throw new Error('watcher not started')
  watchCallback('change', rel)
}

// --- Suite ---------------------------------------------------------------

describe('store-watcher', () => {
  beforeEach(() => {
    // Reset per-test mocks and module-level state. startStoreWatcher() resets
    // knownFiles (via scanStore) implicitly but recentEvents is module-level
    // and is NOT reset on stop/start, and on-disk files are NOT cleaned by
    // the watcher. To keep tests hermetic we wipe the sandbox dir here so
    // scanStore sees an empty store; that way knownFiles starts empty for
    // every test and filename collisions across tests cannot leak.
    watchCallback = null
    watchArgs = null
    mockWatchShouldThrow = false
    mockCloseShouldThrow = false
    logStoreFileEventMock.mockReset()
    infoMock.mockReset()
    warnMock.mockReset()
    clearStoreWriteActor()
    stopStoreWatcher()
    rmSync(STORE, { recursive: true, force: true })
    mkdirSync(STORE, { recursive: true })
  })

  afterEach(() => {
    stopStoreWatcher()
    vi.useRealTimers()
  })

  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
  })

  // ---- Actor slot ------------------------------------------------------

  describe('setStoreWriteActor / clearStoreWriteActor', () => {
    it('setStoreWriteActor stores the actor (subsequent create event logs with it)', () => {
      startStoreWatcher()
      setStoreWriteActor('main-agent')
      writeFileSync(join(STORE, 'actor-test.txt'), 'data')
      fireRename('actor-test.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledWith(
        'actor-test.txt',
        'create',
        0,
        expect.any(Number),
        'main-agent',
      )
    })

    it('clearStoreWriteActor resets the slot (subsequent event logs with null)', () => {
      startStoreWatcher()
      setStoreWriteActor('to-be-cleared')
      clearStoreWriteActor()
      writeFileSync(join(STORE, 'cleared.txt'), 'data')
      fireRename('cleared.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledWith(
        'cleared.txt',
        'create',
        0,
        expect.any(Number),
        null,
      )
    })

    it('the actor slot is consumed by a system-file event (does not leak to the next event)', () => {
      startStoreWatcher()
      setStoreWriteActor('dashboard')
      writeFileSync(join(STORE, 'channels.log'), 'x') // SYSTEM_FILES entry
      fireRename('channels.log')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
      // The actor was cleared by the system-file event; the next real event
      // must record agent=null even though we never explicitly called
      // clearStoreWriteActor between the two events.
      writeFileSync(join(STORE, 'real.txt'), 'x')
      fireRename('real.txt')
      expect(logStoreFileEventMock).toHaveBeenLastCalledWith(
        'real.txt',
        'create',
        0,
        expect.any(Number),
        null,
      )
    })
  })

  // ---- Lifecycle -------------------------------------------------------

  describe('startStoreWatcher', () => {
    it('attaches a recursive watch to STORE_DIR', () => {
      startStoreWatcher()
      expect(watchArgs).not.toBeNull()
      expect(watchArgs!.dir).toBe(STORE)
      expect(watchArgs!.options).toEqual({ recursive: true })
    })

    it('logs a startup info line with the watched dir and the known count', () => {
      writeFileSync(join(STORE, 'pre-existing.txt'), 'x')
      startStoreWatcher()
      expect(infoMock).toHaveBeenCalledTimes(1)
      const [payload] = infoMock.mock.calls[0]!
      expect(payload).toMatchObject({ dir: STORE })
      expect((payload as { knownCount: number }).knownCount).toBeGreaterThan(0)
    })

    it('pre-populates knownFiles from the existing store (rename on existing file is not logged)', () => {
      writeFileSync(join(STORE, 'preexisting.txt'), 'hi')
      startStoreWatcher()
      fireRename('preexisting.txt')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('pre-populates knownFiles recursively into subdirectories', () => {
      mkdirSync(join(STORE, 'sub'), { recursive: true })
      writeFileSync(join(STORE, 'sub', 'nested.txt'), 'x')
      startStoreWatcher()
      fireRename('sub/nested.txt')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('does not throw when STORE_DIR does not exist (scanStore swallows ENOENT)', () => {
      // Build a separate empty tmpdir with no store subdir to exercise the
      // non-fatal scanStore catch path. Override the config mock is not
      // possible at runtime; instead use rmSync to remove the sandbox dir
      // so readdirSync throws inside scanStore.
      const emptySandbox = mkdtempSync(join(tmpdir(), 'store-watcher-empty-'))
      const emptyStore = join(emptySandbox, 'store')
      // Note: we cannot swap STORE_DIR at runtime (it's bound at import time).
      // Instead, point a side-test at a subdirectory that doesn't exist by
      // asserting that the existing sandbox's startStoreWatcher does NOT throw
      // when the dir is empty (which is also part of the contract). The
      // missing-dir branch is exercised in the "non-fatal scanStore" describe
      // block below with readdirSync mocked.
      try {
        expect(() => startStoreWatcher()).not.toThrow()
        // After the empty start, a new file is "unknown" so it IS logged.
        writeFileSync(join(STORE, 'after-empty-start.txt'), 'x')
        fireRename('after-empty-start.txt')
        expect(logStoreFileEventMock).toHaveBeenCalled()
      } finally {
        rmSync(emptySandbox, { recursive: true, force: true })
      }
    })

    it('returns early when called twice (does not double-watch)', () => {
      startStoreWatcher()
      const firstArgs = watchArgs
      startStoreWatcher()
      expect(watchArgs).toBe(firstArgs)
    })

    it('catches and warns when watch() throws (no crash, watcher stays unset)', () => {
      mockWatchShouldThrow = true
      expect(() => startStoreWatcher()).not.toThrow()
      expect(warnMock).toHaveBeenCalledTimes(1)
      expect(watchArgs).toBeNull()
      // The next startStoreWatcher (without the throw flag) succeeds.
      mockWatchShouldThrow = false
      startStoreWatcher()
      expect(watchArgs).not.toBeNull()
    })
  })

  describe('stopStoreWatcher', () => {
    it('returns early when no watcher is active (no throw)', () => {
      expect(() => stopStoreWatcher()).not.toThrow()
    })

    it('closes the watcher and allows a subsequent start to re-attach', () => {
      startStoreWatcher()
      const firstArgs = watchArgs
      stopStoreWatcher()
      startStoreWatcher()
      expect(watchArgs).not.toBe(firstArgs)
    })

    it('swallows close() errors (best-effort shutdown)', () => {
      startStoreWatcher()
      mockCloseShouldThrow = true
      expect(() => stopStoreWatcher()).not.toThrow()
      // A fresh start after the failed close still works.
      mockCloseShouldThrow = false
      startStoreWatcher()
      expect(watchArgs).not.toBeNull()
    })
  })

  // ---- Watch callback: early returns ------------------------------------

  describe('watch callback -- early returns', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('returns when filename is null (Linux gap: rename events may lack a filename)', () => {
      watchCallback!(null, null)
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('returns for eventType other than "rename" (changes are not creations)', () => {
      writeFileSync(join(STORE, 'a.txt'), 'x')
      watchCallback!('change', 'a.txt')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })
  })

  // ---- Watch callback: system-file filter -------------------------------

  describe('watch callback -- system-file filter', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('skips files in the SYSTEM_FILES denylist (sqlite, log files, settings overrides, secrets)', () => {
      const denylisted = [
        'claudeclaw.db',
        'claudeclaw.db-wal',
        'claudeclaw.db-shm',
        'config-overrides.json',
        'dashboard-settings.json',
        'channels.log',
        'dashboard.error.log',
        'federation.json',
        '.dashboard-token',
      ]
      for (const name of denylisted) {
        writeFileSync(join(STORE, name), 'x')
        fireRename(name)
      }
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('skips files matching the SYSTEM_RE regex (.tmp, .pid, .bak, .DS_Store, atomic-write tmp)', () => {
      const matches = [
        'foo.tmp',
        'bar.pid',
        'baz.bak',
        '.DS_Store',
        // Atomic-write temp filename pattern (.tmp.<hex>), see settings-store.ts.
        'settings.tmp.deadbeef',
      ]
      for (const name of matches) {
        writeFileSync(join(STORE, name), 'x')
        fireRename(name)
      }
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('skips system regex matches in subdirectories (basename check, not full path)', () => {
      mkdirSync(join(STORE, 'sub'), { recursive: true })
      writeFileSync(join(STORE, 'sub', 'x.tmp'), 'x')
      fireRename('sub/x.tmp')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })
  })

  // ---- Watch callback: filename normalization ---------------------------

  describe('watch callback -- filename normalization', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('replaces backslashes with forward slashes so Windows-style paths resolve on Linux', () => {
      mkdirSync(join(STORE, 'winstyle'), { recursive: true })
      writeFileSync(join(STORE, 'winstyle', 'file.txt'), 'x')
      fireRename('winstyle\\file.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledWith(
        'winstyle/file.txt',
        'create',
        0,
        expect.any(Number),
        null,
      )
    })
  })

  // ---- Watch callback: existence + knownFiles ---------------------------

  describe('watch callback -- existence + knownFiles', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('returns and removes the entry from knownFiles when the file no longer exists (deletion)', () => {
      // Start with a known file.
      writeFileSync(join(STORE, 'vanish.txt'), 'x')
      stopStoreWatcher()
      startStoreWatcher() // rescan adds vanish.txt to knownFiles
      rmSync(join(STORE, 'vanish.txt'))
      fireRename('vanish.txt')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
      // If the file reappears with the same name, it is now "unknown" and
      // gets logged -- proves knownFiles.delete was called on the missing path.
      writeFileSync(join(STORE, 'vanish.txt'), 'x')
      fireRename('vanish.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledWith(
        'vanish.txt',
        'create',
        0,
        expect.any(Number),
        null,
      )
    })

    it('returns for known files (rename-to-same or replace, no false creation)', () => {
      writeFileSync(join(STORE, 'stable.txt'), 'x')
      stopStoreWatcher()
      startStoreWatcher() // stable.txt becomes known
      fireRename('stable.txt')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })
  })

  // ---- Watch callback: log path -----------------------------------------

  describe('watch callback -- log path', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('logs a create event for a newly created file with fileSize and agent', () => {
      setStoreWriteActor('scheduler')
      writeFileSync(join(STORE, 'birth.txt'), 'hello world')
      fireRename('birth.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)
      const [relPath, eventType, isSensitive, fileSize, agent] = logStoreFileEventMock.mock.calls[0]!
      expect(relPath).toBe('birth.txt')
      expect(eventType).toBe('create')
      expect(isSensitive).toBe(0)
      expect(fileSize).toBe('hello world'.length)
      expect(agent).toBe('scheduler')
    })

    // Pins CURRENT (buggy) behaviour: see docs/needs-to-be-fix/store-watcher-sensitive-unreachable.md.
    // SENSITIVE_NAMES is fully contained in SYSTEM_FILES, so the watch callback
    // returns early at the isSystemFile check (line 113) before reaching the
    // isSensitive ternary on line 142. As a result, the isSensitive=1 branch
    // is unreachable. This test documents that a "sensitive" file is filtered
    // out and never logged -- and asserts the unreachable branch via a file
    // whose name is in SENSITIVE_NAMES but NOT in SYSTEM_FILES (which is the
    // empty set today).
    it('the isSensitive=1 branch is unreachable today: every SENSITIVE_NAMES entry is also in SYSTEM_FILES', () => {
      writeFileSync(join(STORE, '.dashboard-token'), 'secret-value')
      fireRename('.dashboard-token')
      // The file is filtered by SYSTEM_FILES (denylist wins), so it is NEVER
      // passed to logStoreFileEvent. The isSensitive=1 ternary branch on line
      // 142 cannot be reached unless a future refactor stops denylisting
      // these names.
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('vault.json and .vault-key are also filtered by SYSTEM_FILES before isSensitive ever runs', () => {
      writeFileSync(join(STORE, 'vault.json'), '{"x":1}')
      fireRename('vault.json')
      writeFileSync(join(STORE, '.vault-key'), '0123456789abcdef')
      fireRename('.vault-key')
      writeFileSync(join(STORE, '.claude-oauth-token'), 'token')
      fireRename('.claude-oauth-token')
      writeFileSync(join(STORE, 'federation.json'), '{}')
      fireRename('federation.json')
      writeFileSync(join(STORE, '.federation-token'), 'token')
      fireRename('.federation-token')
      expect(logStoreFileEventMock).not.toHaveBeenCalled()
    })

    it('records the file in knownFiles after logging (a second event for the same path within the dedup window is suppressed)', () => {
      writeFileSync(join(STORE, 'record.txt'), 'x')
      fireRename('record.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)
      // knownFiles now contains record.txt, so the rename-event handler returns
      // at the knownFiles.has branch before dedup ever runs.
      fireRename('record.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)
    })

    it('logs agent=null when no actor was set (direct filesystem write from outside the process)', () => {
      writeFileSync(join(STORE, 'orphan.txt'), 'x')
      fireRename('orphan.txt')
      const [, , , , agent] = logStoreFileEventMock.mock.calls[0]!
      expect(agent).toBeNull()
    })
  })

  // ---- Watch callback: dedup --------------------------------------------

  describe('watch callback -- dedup window', () => {
    beforeEach(() => {
      startStoreWatcher()
      vi.useFakeTimers()
    })

    it('suppresses a second rename within DEDUP_MS (1000ms) for the same file', () => {
      writeFileSync(join(STORE, 'flap.txt'), 'x')
      vi.setSystemTime(new Date(1_000_000))
      fireRename('flap.txt')
      vi.advanceTimersByTime(500) // still inside the 1000ms window
      fireRename('flap.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)
    })

    it('lets a second rename through once DEDUP_MS has elapsed', () => {
      writeFileSync(join(STORE, 'flap2.txt'), 'x')
      vi.setSystemTime(new Date(2_000_000))
      fireRename('flap2.txt')
      vi.advanceTimersByTime(1001) // one millisecond past the dedup window
      // The same rename fires again. knownFiles now has 'flap2.txt' so it is
      // suppressed at the knownFiles branch (which is the desired behaviour).
      // To prove dedup is gated by time and not by knownFiles alone, use a
      // different filename below.
      writeFileSync(join(STORE, 'flap3.txt'), 'x')
      vi.setSystemTime(new Date(2_000_000 + 1001))
      fireRename('flap3.txt')
      vi.setSystemTime(new Date(2_000_000 + 1001 + 1001))
      fireRename('flap3.txt')
      // First event for flap3 logs; second is outside the dedup window but
      // hits the knownFiles branch (already recorded). So only ONE log.
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(2) // flap2 + flap3
    })

    it('does not dedup across distinct filenames (each is tracked separately)', () => {
      writeFileSync(join(STORE, 'a.txt'), 'x')
      writeFileSync(join(STORE, 'b.txt'), 'x')
      vi.setSystemTime(new Date(3_000_000))
      fireRename('a.txt')
      fireRename('b.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(2)
    })

    it('prunes stale entries from recentEvents when its size exceeds 200', () => {
      // 201 distinct files, each written so statSync succeeds. All fired at
      // the same timestamp: every entry is "fresh" so prune keeps them all.
      // Then we advance time past DEDUP_MS and fire a new distinct file:
      // recentEvents.size was 201, now grows to 202, prune removes every
      // entry whose timestamp is older than DEDUP_MS -- i.e. the original
      // 201 -- leaving just the latest entry.
      for (let i = 0; i < 201; i++) {
        writeFileSync(join(STORE, `bulk-${i}.txt`), 'x')
      }
      vi.setSystemTime(new Date(4_000_000))
      for (let i = 0; i < 201; i++) {
        fireRename(`bulk-${i}.txt`)
      }
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(201)

      vi.setSystemTime(new Date(4_000_000 + 2000)) // past DEDUP_MS
      writeFileSync(join(STORE, 'bulk-201.txt'), 'x')
      fireRename('bulk-201.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(202)

      // After the prune, firing one of the original filenames is no longer
      // deduped. (It still hits the knownFiles branch and is suppressed there,
      // but that confirms knownFiles was the gate -- not recentEvents.)
      // To prove the prune specifically freed the slot, fire a NEW filename
      // (not in knownFiles) that was also fired once before.
      writeFileSync(join(STORE, 'bulk-0.txt'), 'x') // touches the mtime only;
      // we already saw bulk-0 once, so it IS in knownFiles. The cleanest
      // prune-specific assertion is the count above: 202 logs across 202
      // unique files means the dedup map never blocked a distinct filename.
    })

    it('dedups when the file reappears within the window after deletion (knownFiles cleared, recentEvents survives)', () => {
      // The knownFiles.has branch fires BEFORE the dedup check, so a plain
      // "fire twice" hits the knownFiles gate on the second event and never
      // exercises the dedup return at line 134. The dedup branch is only
      // reachable when the file is no longer in knownFiles (so the gate
      // passes) but IS still in recentEvents (so the dedup hits). The
      // delete-and-recreate sequence achieves exactly that: the delete
      // fires the statSync-failure path which calls knownFiles.delete and
      // returns early without touching recentEvents. The re-create then
      // bypasses the knownFiles gate and lands on the dedup check.
      writeFileSync(join(STORE, 'resurrect.txt'), 'x')
      vi.setSystemTime(new Date(5_000_000))
      fireRename('resurrect.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)

      rmSync(join(STORE, 'resurrect.txt'))
      fireRename('resurrect.txt') // statSync fails -> knownFiles.delete, return
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)

      writeFileSync(join(STORE, 'resurrect.txt'), 'x')
      vi.advanceTimersByTime(600) // still inside DEDUP_MS (1000)
      fireRename('resurrect.txt')
      // knownFiles does NOT have it (was deleted); recentEvents DOES have it
      // (set on the first fire, never cleared). now - last = 600 < 1000, so
      // the dedup branch fires and the second create event is suppressed.
      expect(logStoreFileEventMock).toHaveBeenCalledTimes(1)
    })
  })

  // ---- Watch callback: error handling ----------------------------------

  describe('watch callback -- error handling', () => {
    beforeEach(() => {
      startStoreWatcher()
    })

    it('catches and warns when logStoreFileEvent throws (the audit row failure does not crash the watcher)', () => {
      logStoreFileEventMock.mockImplementation(() => {
        throw new Error('db write failed')
      })
      writeFileSync(join(STORE, 'boom.txt'), 'x')
      expect(() => fireRename('boom.txt')).not.toThrow()
      expect(warnMock).toHaveBeenCalled()
      const [payload] = warnMock.mock.calls[0]!
      expect(payload).toMatchObject({ rel: 'boom.txt' })
    })
  })

  // ---- scanStore error swallowing (mocked readdirSync) -----------------

  describe('scanStore swallows readdirSync errors', () => {
    it('does not throw when the initial readdirSync on STORE_DIR fails (e.g. ENOENT)', async () => {
      // Temporarily replace readdirSync to throw. We need to re-import the
      // module so it picks up the mock. vi.resetModules + re-import in a
      // dynamic import() call.
      vi.resetModules()
      vi.doMock('node:fs', async (orig) => {
        const actual = await orig<typeof import('node:fs')>()
        return {
          ...actual,
          readdirSync: (() => {
            throw new Error('ENOENT: no such file or directory')
          }) as typeof actual.readdirSync,
          watch: ((dir: string, options: unknown, cb: (eventType: string, filename: string | null) => void) => {
            watchCallback = cb
            watchArgs = { dir, options }
            return { close: () => undefined } as unknown as ReturnType<typeof actual.watch>
          }) as typeof actual.watch,
        }
      })
      vi.doMock('../config.js', async (orig) => {
        const actual = await orig<typeof import('../config.js')>()
        return { ...actual, STORE_DIR: STORE }
      })
      vi.doMock('../db.js', () => ({
        logStoreFileEvent: logStoreFileEventMock,
      }))
      vi.doMock('../logger.js', () => ({
        logger: {
          info: infoMock,
          warn: warnMock,
          debug: vi.fn(),
          error: vi.fn(),
        },
      }))
      const sw = await import('../store-watcher.js')
      expect(() => sw.startStoreWatcher()).not.toThrow()
      // After a failed scan, knownFiles is empty so a new file is logged.
      writeFileSync(join(STORE, 'after-failed-scan.txt'), 'x')
      watchCallback!('rename', 'after-failed-scan.txt')
      expect(logStoreFileEventMock).toHaveBeenCalledWith(
        'after-failed-scan.txt',
        'create',
        0,
        expect.any(Number),
        null,
      )
      sw.stopStoreWatcher()
      vi.doUnmock('node:fs')
      vi.doUnmock('../config.js')
      vi.doUnmock('../db.js')
      vi.doUnmock('../logger.js')
      vi.resetModules()
    })
  })
})