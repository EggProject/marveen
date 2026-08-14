// Coverage suite for src/web/stuck-tool-call-watcher.ts.
//
// The watcher exports two pure predicates (confirmsWedgeProfile,
// shouldDeferForRecentRespawn) and one starter (startStuckToolCallWatcher).
// Everything else -- checkSession's orchestration and the private
// sampleMainClaudeCpuPercent CPU probe -- is only reachable by starting the
// watcher and driving its timers, so the bulk of this file does exactly that
// with vitest fake timers.
//
// Mocking strategy mirrors stuck-input-watcher.test.ts:
//   - node:child_process is mocked (rule 5) so the CPU probe's `tmux
//     list-panes` + `/bin/ps` calls are scripted instead of shelling out.
//   - platform/agent-process/main-agent/channel-monitor/logger are mocked so
//     only the watcher's own orchestration is under test.
//   - ../pane-state.js is left REAL: stuckToolCallSignature /
//     decideStuckToolCallRecovery / detectPaneState are the decision logic the
//     watcher composes, and mocking them would assert against the mocks rather
//     than the real state machine.
//
// Timeline note. startStuckToolCallWatcher arms BOTH a 35s one-shot and a 30s
// interval, so sweeps land at t = 30, 35, 60, 90, 120, ... ms*1000. Recovery
// needs all three gates of decideStuckToolCallRecovery: >= 180s of WALL-CLOCK
// counter stagnation, >= 2 stagnant polls, and a spell peak >= 20s. With a
// pane frozen at "Worked for 31s" the first stagnant observation stamps
// stagnantSince at t=35s, so the 180s wall-clock gate opens at t=215s and the
// first sweep past it is t=240s. RECOVERY_MS below encodes that.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'


// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Must come BEFORE any import that transitively reaches '../config.js'.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, ...configSandbox }
})


const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(file: string, args: readonly string[], opts?: unknown) => string>(),
  capturePane: vi.fn<(session: string) => string | null>(),
  resumeMarveenSession: vi.fn<() => Promise<boolean>>(),
  lastMainRespawnAt: vi.fn<() => number>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}))

vi.mock('../logger.js', () => ({ logger: mocks.logger }))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string): string => `/usr/bin/${name}`,
  makeLazyBinResolver: (name: string) => (): string => `/usr/bin/${name}`,
}))

vi.mock('../web/agent-process.js', () => ({
  capturePane: (session: string) => mocks.capturePane(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: () => mocks.resumeMarveenSession(),
  lastMainRespawnAt: () => mocks.lastMainRespawnAt(),
  MARVEEN_POST_RESPAWN_GRACE_MS: 360_000,
}))

type WatcherModule = typeof import('../web/stuck-tool-call-watcher.js')

const SESSION = 'marveen-channels'
const TMUX = '/usr/bin/tmux'
const GRACE_MS = 360_000

/** Wall-clock offset of the first sweep that satisfies all three recovery
 *  gates for a pane frozen at 31s (see the timeline note in the header). */
const RECOVERY_MS = 240_000

/** Pane frozen mid-tool-call: the "Worked for 31s" progress line plus a live
 *  `esc to interrupt` footer, so detectPaneState reads 'busy' and the
 *  idle-prompt guard does NOT short-circuit recovery. */
const WEDGED_PANE = [
  '  ⎿  mcp__telegram__reply(chat_id: 123)',
  '',
  '✻ Worked for 31s',
  '─────────────────────────────────────────',
  '❯',
  '─────────────────────────────────────────',
  '  bypass permissions on · esc to interrupt',
].join('\n')

/** Same frozen counter, but the pane sits at a live empty `❯` prompt under an
 *  idle footer -- the residual-footer shape of a COMPLETED turn (2026-06-22
 *  false-positive loop) that detectPaneState classifies 'idle'. */
const IDLE_RESIDUAL_PANE = [
  '  ⎿  done',
  '',
  '✻ Worked for 31s',
  '─────────────────────────────────────────',
  '❯ ',
  '─────────────────────────────────────────',
  '  bypass permissions on (shift+tab to cycle)',
].join('\n')

/** A wedged pane whose counter sits below THRESHOLDS.minPeakSeconds (20s):
 *  the residual band the spell-peak discriminator is meant to reject. */
const LOW_PEAK_PANE = WEDGED_PANE.replace('Worked for 31s', 'Worked for 4s')

/** Scripts execFileSync for the CPU probe: `tmux list-panes` yields `panePid`,
 *  `/bin/ps` yields `psOut`. Either may be an Error to script a throw. */
function scriptCpuProbe(panePid: string | Error, psOut: string | Error = '0.3\n'): void {
  mocks.execFileSync.mockImplementation((file: string) => {
    if (file === TMUX) {
      if (panePid instanceof Error) throw panePid
      return panePid
    }
    if (psOut instanceof Error) throw psOut
    return psOut
  })
}

describe('src/web/stuck-tool-call-watcher.ts', () => {
  let envSnapshot: { restore: () => void }
  let sandbox: string
  let watcher: WatcherModule
  let timer: NodeJS.Timeout | null = null

  beforeEach(async () => {
    envSnapshot = snapshotEnv()
    sandbox = mkTempDir('stuck-tool-call-watcher-')
    // Rule 3: point the STORE_DIR/.env chain at the sandbox BEFORE the dynamic
    // import so nothing this module transitively pulls in can touch a real
    // install. (The watcher itself is filesystem-free; this is belt-and-braces.)
    process.env.CLAUDECLAW_ENV_DIR = sandbox

    vi.clearAllMocks()
    mocks.capturePane.mockReturnValue(null)
    mocks.lastMainRespawnAt.mockReturnValue(0)
    mocks.resumeMarveenSession.mockResolvedValue(true)
    scriptCpuProbe('4242\n')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T06:41:00Z'))

    // resetModules gives every test a fresh module-scope `watchState` map.
    vi.resetModules()
    watcher = await import('../web/stuck-tool-call-watcher.js')
  })

  afterEach(() => {
    if (timer) clearInterval(timer)
    timer = null
    vi.useRealTimers()
    envSnapshot.restore()
    rmTempDir(sandbox)
  })

  /** Start the watcher and advance fake time by `ms`, flushing the async
   *  sweeps' microtasks at each timer step. */
  async function run(ms: number): Promise<void> {
    timer = watcher.startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(ms)
  }

  describe('confirmsWedgeProfile', () => {
    it('fails open on a null sample so a broken ps never blocks recovery', () => {
      expect(watcher.confirmsWedgeProfile(null, 30)).toBe(true)
    })

    it('confirms the idle stdio-wedge profile at the 2026-06-02 incident CPU (0.3%)', () => {
      expect(watcher.confirmsWedgeProfile(0.3, 30)).toBe(true)
    })

    it('treats the threshold itself as confirming (<=, not <)', () => {
      expect(watcher.confirmsWedgeProfile(30, 30)).toBe(true)
    })

    it('rejects a CPU-active process just above the threshold', () => {
      expect(watcher.confirmsWedgeProfile(30.1, 30)).toBe(false)
    })

    it('rejects a claude burning CPU (heavy sync work, not the wedge)', () => {
      expect(watcher.confirmsWedgeProfile(98.6, 30)).toBe(false)
    })
  })

  describe('shouldDeferForRecentRespawn', () => {
    it('does not defer when no respawn was ever recorded (0 stamp)', () => {
      expect(watcher.shouldDeferForRecentRespawn(0, 1_000_000, GRACE_MS)).toBe(false)
    })

    it('defers while inside the grace window', () => {
      expect(watcher.shouldDeferForRecentRespawn(1_000_000, 1_000_001, GRACE_MS)).toBe(true)
    })

    it('stops deferring exactly at the grace boundary (<, not <=)', () => {
      expect(watcher.shouldDeferForRecentRespawn(1_000_000, 1_000_000 + GRACE_MS, GRACE_MS)).toBe(false)
    })

    it('stops deferring after the grace window has elapsed', () => {
      expect(watcher.shouldDeferForRecentRespawn(1_000_000, 1_000_000 + GRACE_MS + 1, GRACE_MS)).toBe(false)
    })

    it('defaults graceMs to MARVEEN_POST_RESPAWN_GRACE_MS when omitted', () => {
      expect(watcher.shouldDeferForRecentRespawn(1_000_000, 1_000_000 + GRACE_MS - 1)).toBe(true)
      expect(watcher.shouldDeferForRecentRespawn(1_000_000, 1_000_000 + GRACE_MS)).toBe(false)
    })

    // Pins CURRENT behaviour, not desired behaviour: the comparison is a bare
    // `nowMs - lastRespawnMs < graceMs`, so a future-dated stamp (forward clock
    // step after a respawn, or a backwards step of the system clock) yields a
    // negative age that is trivially < graceMs and defers for as long as the
    // skew lasts -- not just for the grace window. Filed as
    // docs/needs-to-be-fix/stuck-tool-call-watcher-skew-defer.md.
    it('defers indefinitely on a future-dated respawn stamp (clock skew)', () => {
      expect(watcher.shouldDeferForRecentRespawn(2_000_000, 1_000_000)).toBe(true)
      expect(watcher.shouldDeferForRecentRespawn(Number.MAX_SAFE_INTEGER, 1_000_000)).toBe(true)
    })
  })

  describe('startStuckToolCallWatcher', () => {
    it('returns an interval handle and does not sweep before the 35s initial delay', async () => {
      await run(29_999)
      expect(timer).not.toBeNull()
      expect(mocks.capturePane).not.toHaveBeenCalled()
    })

    it('sweeps the main channels session once the initial delay elapses', async () => {
      await run(35_000)
      expect(mocks.capturePane).toHaveBeenCalledWith(SESSION)
    })

    it('keeps sweeping on the 30s interval', async () => {
      await run(35_000)
      const afterFirst = mocks.capturePane.mock.calls.length
      await vi.advanceTimersByTimeAsync(90_000)
      expect(mocks.capturePane.mock.calls.length).toBeGreaterThan(afterFirst)
    })

    it('swallows a sweep error and logs it at debug', async () => {
      mocks.capturePane.mockImplementation(() => {
        throw new Error('capture-pane exploded')
      })
      await expect(run(35_000)).resolves.toBeUndefined()
      expect(mocks.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'stuck-tool-call-watcher: main session check error',
      )
    })
  })

  describe('checkSession: state tracking', () => {
    it('records no spell when capturePane fails (null pane, no signature)', async () => {
      mocks.capturePane.mockReturnValue(null)
      await run(RECOVERY_MS + 30_000)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
      expect(mocks.logger.warn).not.toHaveBeenCalled()
    })

    it('records no spell when the pane has no tool-call progress line', async () => {
      mocks.capturePane.mockReturnValue('❯ \n  bypass permissions on (shift+tab to cycle)')
      await run(RECOVERY_MS + 30_000)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
    })

    it('never recovers while the counter keeps advancing (healthy long tool-call)', async () => {
      let seconds = 31
      mocks.capturePane.mockImplementation(() => {
        seconds += 30
        return WEDGED_PANE.replace('Worked for 31s', `Worked for ${seconds}s`)
      })
      await run(RECOVERY_MS + 120_000)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
      expect(mocks.logger.warn).not.toHaveBeenCalled()
    })

    it('never recovers a stagnant counter that never climbed past minPeakSeconds', async () => {
      mocks.capturePane.mockReturnValue(LOW_PEAK_PANE)
      await run(RECOVERY_MS + 120_000)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
    })

    it('does not recover before the wall-clock freeze threshold opens', async () => {
      mocks.capturePane.mockReturnValue(WEDGED_PANE)
      await run(RECOVERY_MS - 30_000)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
    })
  })

  describe('checkSession: recovery', () => {
    beforeEach(() => {
      mocks.capturePane.mockReturnValue(WEDGED_PANE)
    })

    it('respawns the main session once the counter is wedged past every gate', async () => {
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          session: SESSION,
          label: 'main',
          tag: 'worked',
          seconds: 31,
          spellPeakSeconds: 31,
          cpuPercent: 0.3,
        }),
        expect.stringContaining('recovering main channels session'),
      )
    })

    it('samples the pane-leader CPU via tmux list-panes + /bin/ps', async () => {
      await run(RECOVERY_MS)
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        TMUX,
        ['list-panes', '-t', SESSION, '-F', '#{pane_pid}'],
        expect.objectContaining({ timeout: 3000, encoding: 'utf-8' }),
      )
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        '/bin/ps',
        ['-o', '%cpu=', '-p', '4242'],
        expect.objectContaining({ timeout: 3000, encoding: 'utf-8' }),
      )
    })

    it('fires the recovery only once per spell (attempts cap)', async () => {
      await run(RECOVERY_MS + 180_000)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
    })

    it('logs an error when the respawn-pane recovery fails', async () => {
      mocks.resumeMarveenSession.mockResolvedValue(false)
      await run(RECOVERY_MS)
      expect(mocks.logger.error).toHaveBeenCalledWith(
        { label: 'main', session: SESSION },
        'stuck-tool-call-watcher: respawn-pane recovery failed',
      )
    })

    it('stays quiet on the error log when the respawn succeeds', async () => {
      await run(RECOVERY_MS)
      expect(mocks.logger.error).not.toHaveBeenCalled()
    })
  })

  describe('checkSession: idle-prompt guard', () => {
    it('skips recovery and clears the spell when the pane is at the idle prompt', async () => {
      mocks.capturePane.mockReturnValue(IDLE_RESIDUAL_PANE)
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ session: SESSION, tag: 'worked', seconds: 31, spellPeakSeconds: 31 }),
        expect.stringContaining('pane is at the idle prompt'),
      )
    })

    it('does not sample CPU when the idle guard short-circuits', async () => {
      mocks.capturePane.mockReturnValue(IDLE_RESIDUAL_PANE)
      await run(RECOVERY_MS)
      expect(mocks.execFileSync).not.toHaveBeenCalled()
    })
  })

  describe('checkSession: post-respawn grace', () => {
    beforeEach(() => {
      mocks.capturePane.mockReturnValue(WEDGED_PANE)
    })

    it('defers recovery when another respawner acted inside the grace window', async () => {
      // Stamp a respawn 1s before the sweep that would otherwise recover.
      mocks.lastMainRespawnAt.mockImplementation(() => Date.now() - 1_000)
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ session: SESSION, sinceRespawnMs: 1_000, graceMs: GRACE_MS }),
        expect.stringContaining('recent respawn within grace'),
      )
    })

    // A 192. sor `lastRespawn ? Date.now() - lastRespawn : null` ternary-jének
    // `: null` ága a JELENLEGI kódban strukturálisan elérhetetlen: a 190.
    // sor `if (shouldDeferForRecentRespawn(lastRespawn, Date.now()))` őre
    // CSAK akkor lép be, ha lastRespawnMs > 0; a 0 az egyetlen falsy érték,
    // amit a lastMainRespawnAt() visszaadhat, és a 0-val a log egyáltalán
    // nem hívódik. Tehát a log body-ban a lastRespawn MINDIG truthy szám,
    // a `: null` ág soha nem fut le. A részletes elemzés a
    // docs/needs-to-be-fix/stuck-tool-call-watcher-respawn-ternary-null-unreachable.md
    // fájlban.
    it('does not sample CPU when the grace guard defers', async () => {
      mocks.lastMainRespawnAt.mockImplementation(() => Date.now() - 1_000)
      await run(RECOVERY_MS)
      expect(mocks.execFileSync).not.toHaveBeenCalled()
    })

    it('proceeds when the last respawn is older than the grace window', async () => {
      mocks.lastMainRespawnAt.mockImplementation(() => Date.now() - (GRACE_MS + 1))
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('checkSession: CPU-profile guard', () => {
    beforeEach(() => {
      mocks.capturePane.mockReturnValue(WEDGED_PANE)
    })

    it('defers recovery when the claude is still burning CPU', async () => {
      scriptCpuProbe('4242\n', '95.4\n')
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).not.toHaveBeenCalled()
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ session: SESSION, cpuPercent: 95.4, maxCpuPercent: 30, seconds: 31 }),
        expect.stringContaining('CPU-active'),
      )
    })

    it('recovers on a CPU sample at the 30% ceiling', async () => {
      scriptCpuProbe('4242\n', ' 30.0 \n')
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
    })

    it('fails open when tmux list-panes throws', async () => {
      scriptCpuProbe(new Error('no server running'))
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cpuPercent: null }),
        expect.stringContaining('recovering main channels session'),
      )
    })

    it('fails open when tmux returns no pane pid', async () => {
      scriptCpuProbe('\n')
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
      // /bin/ps is never reached once the pid is rejected.
      expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    })

    it('fails open when tmux returns a non-numeric pane pid', async () => {
      scriptCpuProbe('%42\n')
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
      expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    })

    it('fails open when ps throws', async () => {
      scriptCpuProbe('4242\n', new Error('ps: no such process'))
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
    })

    it('fails open when ps prints an unparseable CPU value', async () => {
      scriptCpuProbe('4242\n', 'n/a\n')
      await run(RECOVERY_MS)
      expect(mocks.resumeMarveenSession).toHaveBeenCalledTimes(1)
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cpuPercent: null }),
        expect.stringContaining('recovering main channels session'),
      )
    })

    it('takes only the first line of a multi-pane list-panes response', async () => {
      scriptCpuProbe('4242\n9999\n')
      await run(RECOVERY_MS)
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        '/bin/ps',
        ['-o', '%cpu=', '-p', '4242'],
        expect.objectContaining({ timeout: 3000 }),
      )
    })
  })
})
