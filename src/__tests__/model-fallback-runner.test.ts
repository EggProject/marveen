// 100% coverage test for src/web/model-fallback-runner.ts.
//
// The runner exports exactly one symbol (`startModelFallbackRunner`), so every
// private helper -- readMainModel / writeMainModel / readModelFor /
// writeModelFor / sessionFor / restartFor / checkAgent -- is reached by driving
// the 50s initial sweep and the 60s interval sweep under fake timers.
//
// What is mocked and why:
//
//   node:child_process   hard guard (rule 5). Every mocked export throws, so a
//                        test that accidentally reaches a real tmux/launchctl
//                        call fails loudly instead of touching the host.
//   ../config.js         PROJECT_ROOT is `join(__dirname, '..')` (the repo
//                        checkout, NOT redirectable via CLAUDECLAW_ENV_DIR), and
//                        the runner bakes MAIN_SETTINGS_PATH from it at module
//                        eval. Mocked with a getter pointing at a fresh
//                        `os.tmpdir()` sandbox, re-read on each dynamic import.
//   agent-config /       the I/O seams the runner drives.
//   agent-process /
//   channel-monitor /
//   main-agent /
//   pane-state /
//   model-fallback-store
//   ../logger.js         assertions on the info/warn/debug records.
//
// Deliberately NOT mocked: `src/model-fallback.ts` (detectsUsageLimit,
// decideModelAction) and `src/web/atomic-write.ts`. The whole point of this
// suite is the fallback logic wired end-to-end, so the real decision function
// runs against real pane text and the main-agent model really lands on disk.
//
// Branch inventory covered here:
//
//   readMainModel()   valid string / missing file (catch) / malformed JSON
//                     (catch) / parsed null / non-string model / empty-string
//                     model
//   writeMainModel()  existing readable JSON (merge, other keys preserved) /
//                     unreadable or malformed (catch -> cfg = {})
//   readModelFor()    main -> settings.json ; sub-agent -> readAgentModel
//   writeModelFor()   main -> settings.json ; sub-agent -> writeAgentModel
//   sessionFor()      main -> MAIN_CHANNELS_SESSION ; sub -> agentSessionName
//   restartFor()      main ok / main {ok:false,error} / main {ok:false} (the
//                     `?? 'main channels hard restart failed'` default) / sub
//   checkAgent()      sub not running (early return) / capturePane null /
//                     action 'none' (bottom of chain, and no-limit-not-
//                     downgraded) / pane busy (defer) / downgrade / revert /
//                     restart throws (warn) / remote host null vs set /
//                     downgradedAt present vs absent
//   sweep()           disabled + empty map / disabled + non-empty map (clear) /
//                     enabled / main check throws (debug) / agent check throws
//                     (debug) / empty and non-empty agent list
//   startModelFallbackRunner()  returns the interval handle; first sweep only
//                     after INITIAL_DELAY_MS; repeats every INTERVAL_MS

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

const MAIN_ID = 'marveen'
const MAIN_SESSION = 'marveen-channels'

// chain[0] is the primary the runner reverts UP to; each next entry is one
// downgrade step. Distinct literals so an assertion can never pass by accident.
const CHAIN = ['primary-model', 'fallback-model', 'bottom-model']
const DEFAULT_MODEL = 'default-model'

// Bottom-of-pane banner text: detectsUsageLimit only looks at the last 15
// lines, so the phrase has to sit in the live region (real behaviour, real fn).
const PANE_LIMIT = ['> earlier work', '', 'Claude usage limit reached - your limit will reset at 3pm'].join('\n')
const PANE_CLEAN = ['> earlier work', '', 'waiting for input'].join('\n')

const mocks = vi.hoisted(() => ({
  projectRoot: '',
  listAgentNames: vi.fn<() => string[]>(),
  readAgentRemoteHost: vi.fn<(name: string) => string | null>(),
  readAgentModel: vi.fn<(name: string) => string>(),
  writeAgentModel: vi.fn<(name: string, model: string) => void>(),
  agentRunState: vi.fn<(name: string) => string>(),
  restartAgentProcess: vi.fn<(name: string, opts: { fresh?: boolean }) => { ok: boolean }>(),
  capturePane: vi.fn<(session: string, host: string | null) => string | null>(),
  hardRestart: vi.fn<() => { ok: boolean; error?: string }>(),
  paneLooksIdle: vi.fn<(pane: string) => boolean>(),
  readCfg: vi.fn<() => { enabled: boolean; chain: string[]; revertAfterMinutes: number }>(),
  info: vi.fn<(obj: unknown, msg?: string) => void>(),
  warn: vi.fn<(obj: unknown, msg?: string) => void>(),
  debug: vi.fn<(obj: unknown, msg?: string) => void>(),
}))

// Rule 5 guard: nothing in this suite may spawn a process. Every export throws.
vi.mock('node:child_process', () => {
  const forbid = (name: string) => () => {
    throw new Error(`node:child_process.${name} must not be called from this suite`)
  }
  return {
    execSync: forbid('execSync'),
    execFileSync: forbid('execFileSync'),
    spawnSync: forbid('spawnSync'),
    spawn: forbid('spawn'),
    exec: forbid('exec'),
    execFile: forbid('execFile'),
    fork: forbid('fork'),
  }
})

// Getter: the runner reads PROJECT_ROOT once, at its own module-eval time, and
// every test re-imports it after pointing `mocks.projectRoot` at a new sandbox.
vi.mock('../config.js', () => ({
  get PROJECT_ROOT() { return mocks.projectRoot },
  MAIN_AGENT_ID: MAIN_ID,
}))

vi.mock('../logger.js', () => ({
  logger: { info: mocks.info, warn: mocks.warn, debug: mocks.debug },
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mocks.listAgentNames,
  readAgentRemoteHost: mocks.readAgentRemoteHost,
  readAgentModel: mocks.readAgentModel,
  writeAgentModel: mocks.writeAgentModel,
  // Identity: resolution is agent-config's own contract, tested there. Keeping
  // it transparent here means an assertion on a model id reads literally.
  resolveModelId: (raw: string): string => raw,
  DEFAULT_MODEL,
}))

vi.mock('../web/agent-process.js', () => ({
  agentRunState: mocks.agentRunState,
  agentSessionName: (name: string): string => `agent-${name}`,
  restartAgentProcess: mocks.restartAgentProcess,
  capturePane: mocks.capturePane,
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: mocks.hardRestart,
}))

vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: MAIN_SESSION }))

vi.mock('../pane-state.js', () => ({ paneLooksIdle: mocks.paneLooksIdle }))

vi.mock('../web/model-fallback-store.js', () => ({
  readModelFallbackConfig: mocks.readCfg,
}))

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000
const T0 = 1_700_000_000_000

let sandbox: string
let envSnapshot: { restore: () => void }
let timer: NodeJS.Timeout | null = null
// Every sweep checks the main agent first and then each listed sub-agent, so
// the two panes are routed independently: a test that only cares about a
// sub-agent leaves the main pane null (uncapturable -> checkAgent returns).
let mainPane: string | null = null
let agentPane: string | null = null
// Mirror of the fake clock. setInterval is armed at t=0, so its ticks land on
// 60s boundaries -- NOT 60s after the 50s initial setTimeout sweep.
let clock = 0

const settingsPath = (): string => join(sandbox, '.claude', 'settings.json')

/** Write (or overwrite) the main agent's `.claude/settings.json` raw body. */
function writeMainSettings(body: string): void {
  writeFileSync(settingsPath(), body)
}

function readMainSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('settings.json is not an object')
  return parsed satisfies object as Record<string, unknown>
}

/** Fresh module registry -> fresh module-scope `downgradedAt` map and a
 *  MAIN_SETTINGS_PATH rebuilt from the current sandbox. */
async function startRunner(): Promise<NodeJS.Timeout> {
  vi.resetModules()
  const mod = await import('../web/model-fallback-runner.js')
  timer = mod.startModelFallbackRunner()
  return timer
}

async function advance(ms: number): Promise<void> {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
}

/** Advance to the initial setTimeout sweep (t = 50s). */
async function firstSweep(): Promise<void> {
  await advance(INITIAL_DELAY_MS)
}

/** Advance to the next 60s interval boundary (t = 60s, 120s, 180s, ...). */
async function nextSweep(): Promise<void> {
  const next = (Math.floor(clock / INTERVAL_MS) + 1) * INTERVAL_MS
  await advance(next - clock)
}

beforeEach(() => {
  envSnapshot = snapshotEnv()
  sandbox = mkTempDir('marveen-model-fallback-runner-')
  mocks.projectRoot = sandbox
  mkdirSync(join(sandbox, '.claude'), { recursive: true })

  vi.clearAllMocks()
  mainPane = null
  agentPane = null
  clock = 0
  mocks.listAgentNames.mockReturnValue([])
  mocks.agentRunState.mockReturnValue('running')
  mocks.readAgentRemoteHost.mockReturnValue(null)
  mocks.readAgentModel.mockReturnValue(CHAIN[0]!)
  mocks.capturePane.mockImplementation((session: string) => (session === MAIN_SESSION ? mainPane : agentPane))
  mocks.paneLooksIdle.mockReturnValue(true)
  mocks.hardRestart.mockReturnValue({ ok: true })
  mocks.restartAgentProcess.mockReturnValue({ ok: true })
  mocks.readCfg.mockReturnValue({ enabled: true, chain: [...CHAIN], revertAfterMinutes: 1 })

  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  if (timer) clearInterval(timer)
  timer = null
  vi.useRealTimers()
  rmTempDir(sandbox)
  envSnapshot.restore()
})

/** The 'switched model' info record the runner emits on a successful swap. */
function switchRecords(): Array<Record<string, unknown>> {
  return mocks.info.mock.calls
    .filter((call) => call[1] === 'model-fallback: switched model')
    .map((call) => call[0] satisfies unknown as Record<string, unknown>)
}

describe('startModelFallbackRunner scheduling', () => {
  it('does not sweep before INITIAL_DELAY_MS and returns the interval handle', async () => {
    const handle = await startRunner()

    await advance(INITIAL_DELAY_MS - 1)
    expect(mocks.readCfg).not.toHaveBeenCalled()

    await advance(1)
    expect(mocks.readCfg).toHaveBeenCalledTimes(1)
    expect(handle).toBeDefined()
    // A real interval handle: clearing it stops all further sweeps.
    clearInterval(handle)
    await advance(INTERVAL_MS * 3)
    expect(mocks.readCfg).toHaveBeenCalledTimes(1)
  })

  it('sweeps once per INTERVAL_MS after the initial delay', async () => {
    await startRunner()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(mocks.readCfg).toHaveBeenCalledTimes(3)
  })
})

describe('sweep gating on the enabled flag', () => {
  it('does nothing while disabled', async () => {
    mocks.readCfg.mockReturnValue({ enabled: false, chain: [...CHAIN], revertAfterMinutes: 1 })
    await startRunner()
    await firstSweep()

    expect(mocks.listAgentNames).not.toHaveBeenCalled()
    expect(mocks.capturePane).not.toHaveBeenCalled()
  })

  it('clears remembered downgrades when the feature is turned off, so re-enabling does not auto-revert', async () => {
    writeMainSettings(JSON.stringify({ model: CHAIN[0] }))
    mainPane = PANE_LIMIT
    await startRunner()

    // Sweep 1 (t = 50s): downgrade -> downgradedAt is now populated.
    await firstSweep()
    expect(readMainSettings().model).toBe(CHAIN[1])

    // Sweep 2 (t = 60s): disabled with a non-empty map -> the map is cleared.
    mocks.readCfg.mockReturnValue({ enabled: false, chain: [...CHAIN], revertAfterMinutes: 1 })
    await nextSweep()

    // Sweep 3 (t = 120s): re-enabled, no limit, and 70s past the downgrade --
    // i.e. past the 1-minute revert window. Because the map was cleared the
    // agent is treated as "on primary", so no revert fires and the model stays
    // on the fallback.
    mocks.readCfg.mockReturnValue({ enabled: true, chain: [...CHAIN], revertAfterMinutes: 1 })
    mainPane = PANE_CLEAN
    await nextSweep()

    expect(readMainSettings().model).toBe(CHAIN[1])
    expect(switchRecords()).toHaveLength(1)
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
  })
})

describe('main agent: reading the model from .claude/settings.json', () => {
  beforeEach(() => {
    mainPane = PANE_LIMIT
  })

  it('reads the configured model and downgrades one step down the chain', async () => {
    writeMainSettings(JSON.stringify({ model: CHAIN[0] }))
    await startRunner()
    await firstSweep()

    expect(mocks.capturePane).toHaveBeenCalledWith(MAIN_SESSION, null)
    // The main agent is never asked for a remote host.
    expect(mocks.readAgentRemoteHost).not.toHaveBeenCalled()
    expect(readMainSettings().model).toBe(CHAIN[1])
    expect(switchRecords()[0]).toMatchObject({
      name: MAIN_ID,
      from: CHAIN[0],
      to: CHAIN[1],
      action: 'downgrade',
    })
  })

  it.each([
    ['a missing settings.json', null],
    ['malformed JSON', '{not json'],
    ['a non-string model field', JSON.stringify({ model: 42 })],
    ['an empty-string model field', JSON.stringify({ model: '' })],
  ])('falls back to DEFAULT_MODEL on %s', async (_label, body) => {
    if (body !== null) writeMainSettings(body)
    await startRunner()
    await firstSweep()

    // An unrecognised current model is treated as the primary, so the first
    // downgrade target (chain[1]) applies.
    expect(switchRecords()[0]).toMatchObject({ from: DEFAULT_MODEL, to: CHAIN[1] })
    expect(readMainSettings().model).toBe(CHAIN[1])
  })

  it('preserves unrelated settings keys when rewriting the model', async () => {
    writeMainSettings(JSON.stringify({ model: CHAIN[0], permissions: { allow: ['Bash'] }, theme: 'dark' }))
    await startRunner()
    await firstSweep()

    const written = readMainSettings()
    expect(written.model).toBe(CHAIN[1])
    expect(written.permissions).toEqual({ allow: ['Bash'] })
    expect(written.theme).toBe('dark')
  })

  it('writes a fresh settings.json when the existing one is unparseable', async () => {
    writeMainSettings('}}} garbage')
    await startRunner()
    await firstSweep()

    expect(readMainSettings()).toEqual({ model: CHAIN[1] })
  })
})

// DEFECT PINNING -- model-fallback-runner-writemainmodel-nonobject
//
// writeMainModel() only guarded a JSON *parse* failure before the fix; a
// valid-JSON non-object body (null / number / string / array) flowed into
// `cfg: Record<string, unknown>` and broke the write. readMainModel() guards
// exactly this case (`cfg &&` on line 50); the writer now narrows to the
// same shape. A non-object body is replaced with a minimal `{ "model": ... }`,
// matching what the existing catch already does for unparseable content.
describe('main agent: non-object settings.json', () => {
  beforeEach(() => {
    mainPane = PANE_LIMIT
  })

  it('rewrites settings.json with a minimal object when the body is a JSON null', async () => {
    writeMainSettings('null')
    await startRunner()
    await firstSweep()

    // No throw: writeMainModel narrows null to {} and writes the model.
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(switchRecords()[0]).toMatchObject({ from: DEFAULT_MODEL, to: CHAIN[1], action: 'downgrade' })
    expect(readMainSettings().model).toBe(CHAIN[1])
  })

  it('rewrites settings.json with a minimal object when the body is a JSON array', async () => {
    writeMainSettings('[]')
    await startRunner()
    await firstSweep()

    // No silent drop: writeMainModel narrows [] to {} and writes the model.
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(switchRecords()[0]).toMatchObject({ from: DEFAULT_MODEL, to: CHAIN[1], action: 'downgrade' })
    expect(readMainSettings().model).toBe(CHAIN[1])
  })
})

describe('main agent: restart handling', () => {
  beforeEach(() => {
    writeMainSettings(JSON.stringify({ model: CHAIN[0] }))
    mainPane = PANE_LIMIT
  })

  it('hard-restarts the channels session and never touches restartAgentProcess', async () => {
    await startRunner()
    await firstSweep()

    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(mocks.restartAgentProcess).not.toHaveBeenCalled()
  })

  it('warns and keeps the downgrade unrecorded when the hard restart reports an error', async () => {
    mocks.hardRestart.mockReturnValue({ ok: false, error: 'launchctl kickstart failed' })
    await startRunner()
    await firstSweep()

    expect(switchRecords()).toHaveLength(0)
    const [record, msg] = mocks.warn.mock.calls[0]!
    expect(msg).toBe('model-fallback: switch failed')
    const failure = record satisfies unknown as { err: Error; name: string }
    expect(failure.name).toBe(MAIN_ID)
    expect(failure.err.message).toBe('launchctl kickstart failed')
  })

  it('uses a default message when the hard restart fails without one', async () => {
    mocks.hardRestart.mockReturnValue({ ok: false })
    await startRunner()
    await firstSweep()

    const failure = mocks.warn.mock.calls[0]![0] satisfies unknown as { err: Error }
    expect(failure.err.message).toBe('main channels hard restart failed')
  })
})

describe('sub-agents', () => {
  beforeEach(() => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    agentPane = PANE_LIMIT
  })

  it('downgrades a running local agent and restarts it with the conversation intact', async () => {
    await startRunner()
    await firstSweep()

    expect(mocks.capturePane).toHaveBeenCalledWith('agent-scout', null)
    expect(mocks.writeAgentModel).toHaveBeenCalledWith('scout', CHAIN[1])
    expect(mocks.restartAgentProcess).toHaveBeenCalledWith('scout', { fresh: false })
    expect(mocks.hardRestart).not.toHaveBeenCalled()
    expect(switchRecords()[0]).toMatchObject({ name: 'scout', action: 'downgrade' })
  })

  it('captures a remote agent pane over its configured host', async () => {
    mocks.readAgentRemoteHost.mockReturnValue('builder@10.0.0.9')
    await startRunner()
    await firstSweep()

    expect(mocks.capturePane).toHaveBeenCalledWith('agent-scout', 'builder@10.0.0.9')
    expect(mocks.writeAgentModel).toHaveBeenCalledWith('scout', CHAIN[1])
  })

  it('skips an agent that is not running', async () => {
    mocks.agentRunState.mockReturnValue('stopped')
    await startRunner()
    await firstSweep()

    // The main session is still swept (it is launchd-managed, so agentRunState
    // is never consulted for it); only the sub-agent pane is skipped.
    expect(mocks.capturePane).not.toHaveBeenCalledWith('agent-scout', null)
    expect(mocks.writeAgentModel).not.toHaveBeenCalled()
  })

  it('skips an agent whose pane cannot be captured', async () => {
    agentPane = null
    await startRunner()
    await firstSweep()

    expect(mocks.readAgentModel).not.toHaveBeenCalled()
    expect(mocks.writeAgentModel).not.toHaveBeenCalled()
  })

  it('warns when the agent restart throws', async () => {
    mocks.restartAgentProcess.mockImplementation(() => { throw new Error('tmux respawn failed') })
    await startRunner()
    await firstSweep()

    expect(switchRecords()).toHaveLength(0)
    const failure = mocks.warn.mock.calls[0]![0] satisfies unknown as { err: Error; name: string }
    expect(failure.name).toBe('scout')
    expect(failure.err.message).toBe('tmux respawn failed')
  })
})

describe('no-op decisions', () => {
  it('does nothing when a limited agent is already at the bottom of the chain', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.readAgentModel.mockReturnValue(CHAIN[2]!)
    agentPane = PANE_LIMIT
    await startRunner()
    await firstSweep()

    expect(mocks.writeAgentModel).not.toHaveBeenCalled()
    expect(mocks.restartAgentProcess).not.toHaveBeenCalled()
    expect(mocks.paneLooksIdle).not.toHaveBeenCalled()
  })

  it('does nothing for an unlimited agent that was never downgraded', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    agentPane = PANE_CLEAN
    await startRunner()
    await firstSweep()

    expect(mocks.writeAgentModel).not.toHaveBeenCalled()
    expect(mocks.restartAgentProcess).not.toHaveBeenCalled()
  })

  it('defers the switch while the pane is busy', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    agentPane = PANE_LIMIT
    mocks.paneLooksIdle.mockReturnValue(false)
    await startRunner()
    await firstSweep()

    expect(mocks.writeAgentModel).not.toHaveBeenCalled()
    expect(mocks.restartAgentProcess).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(
      { name: 'scout', action: 'downgrade' },
      'model-fallback: action due but pane busy, deferring',
    )
  })
})

describe('revert to the primary model', () => {
  it('climbs back to chain[0] once the agent has been limit-free past the window', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    agentPane = PANE_LIMIT
    await startRunner()

    // Sweep 1 (t = 50s): downgrade primary -> fallback.
    await firstSweep()
    expect(mocks.writeAgentModel).toHaveBeenLastCalledWith('scout', CHAIN[1])

    // Sweep 2 (t = 60s): no banner, but only 10s since the downgrade -- still
    // inside the 1-minute window, so the fallback holds.
    agentPane = PANE_CLEAN
    mocks.readAgentModel.mockReturnValue(CHAIN[1]!)
    await nextSweep()
    expect(mocks.writeAgentModel).toHaveBeenCalledTimes(1)

    // Sweep 3 (t = 120s): 70s since the downgrade -> revert to the primary.
    await nextSweep()

    expect(mocks.writeAgentModel).toHaveBeenLastCalledWith('scout', CHAIN[0])
    expect(mocks.restartAgentProcess).toHaveBeenCalledTimes(2)
    expect(switchRecords()[1]).toMatchObject({ from: CHAIN[1], to: CHAIN[0], action: 'revert' })

    // Sweep 4: the revert cleared the downgrade memory, so nothing repeats.
    mocks.readAgentModel.mockReturnValue(CHAIN[0]!)
    await nextSweep()
    expect(mocks.writeAgentModel).toHaveBeenCalledTimes(2)
  })

  it('holds the fallback model while still inside the revert window', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.readCfg.mockReturnValue({ enabled: true, chain: [...CHAIN], revertAfterMinutes: 10 })
    agentPane = PANE_LIMIT
    await startRunner()
    await firstSweep()

    agentPane = PANE_CLEAN
    mocks.readAgentModel.mockReturnValue(CHAIN[1]!)
    await nextSweep()
    await nextSweep()

    expect(mocks.writeAgentModel).toHaveBeenCalledTimes(1)
    expect(mocks.writeAgentModel).toHaveBeenLastCalledWith('scout', CHAIN[1])
  })
})

describe('per-agent error isolation', () => {
  it('logs and swallows a failure in the main-agent check', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockImplementation((session: string) => {
      if (session === MAIN_SESSION) throw new Error('main capture-pane blew up')
      return PANE_LIMIT
    })
    await startRunner()
    await firstSweep()

    expect(mocks.debug).toHaveBeenCalledTimes(1)
    const [record, msg] = mocks.debug.mock.calls[0]!
    expect(msg).toBe('model-fallback: main check error')
    expect((record satisfies unknown as { err: Error }).err.message).toBe('main capture-pane blew up')
    // The sub-agent is still processed.
    expect(mocks.writeAgentModel).toHaveBeenCalledWith('scout', CHAIN[1])
  })

  it('logs and swallows a failure in one agent check without skipping the rest', async () => {
    mocks.listAgentNames.mockReturnValue(['broken', 'scout'])
    mocks.agentRunState.mockImplementation((name: string) => {
      if (name === 'broken') throw new Error('tmux has-session exploded')
      return 'running'
    })
    agentPane = PANE_LIMIT
    await startRunner()
    await firstSweep()

    const [record, msg] = mocks.debug.mock.calls[0]!
    expect(msg).toBe('model-fallback: agent check error')
    const failure = record satisfies unknown as { err: Error; agent: string }
    expect(failure.agent).toBe('broken')
    expect(failure.err.message).toBe('tmux has-session exploded')
    expect(mocks.writeAgentModel).toHaveBeenCalledWith('scout', CHAIN[1])
  })
})
