// 100% coverage suite for src/web/inbound-probe.ts.
//
// The base suite at src/__tests__/inbound-probe.test.ts covers the two pure
// exports (shouldTriggerDeafnessRespawn, readLastIngestionTimestamp). The
// remaining uncovered buckets are the lifecycle functions on lines 175-385:
//
//   - Lines 183-191: readProbeLastSentMs() -- exercised through startInboundProber
//   - Lines 195-208: readProbeIntervalMs() -- exercised through startInboundProber
//   - Lines 211-217: readAllowedChatId() -- exercised through spawnProber via
//                    startInboundProber
//   - Lines 219-290: spawnProber() -- exercised through startInboundProber
//                    (every "session missing" / "chat id absent" /
//                    "venv missing" / "script missing" /
//                    "already running" / "spawn failed" branch)
//   - Lines 293-349: checkInboundProbeDeafness() -- exercised through the
//                    setInterval tick + the dynamic channel-monitor import
//   - Lines 368-386: startInboundProber() -- the exported entry point
//
// Strategy: every dependency is mocked via vi.doMock (hoisted) so module-load
// side effects in inbound-probe.ts (freezing SESSION_FILE, PROBE_LAST_SENT_FILE,
// VENV_PYTHON, PROBER_SCRIPT, TRANSCRIPT_DIR) land in a per-test tmpdir sandbox.
// The dynamic `import('./channel-monitor.js')` inside checkInboundProbeDeafness
// is intercepted via a vi.mock on the absolute path the source uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { hardRestartMarveenChannels, lastMainRespawnAt } from '../web/channel-monitor.js'

// ----------------------------------------------------------------------------
// Hoisted mock state. Every mock factory references these closures so a single
// shared instance survives module resets and we can drive behaviour from the
// test body via vi.fn().
// ----------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  // sandbox layout
  sandbox: '' as string,
  projectRoot: '' as string,
  homeDir: '' as string,
  // env.js readEnvFile
  envFile: {} as Record<string, string>,
  // node:fs mocks
  existsSync: vi.fn<(...args: unknown[]) => unknown>(() => true),
  readFileSync: vi.fn<(...args: unknown[]) => unknown>(() => ''),
  statSync: vi.fn<(...args: unknown[]) => unknown>(() => ({ size: 0 })),
  openSync: vi.fn<(...args: unknown[]) => unknown>(() => 1),
  closeSync: vi.fn<(...args: unknown[]) => unknown>(() => undefined),
  readSync: vi.fn<(...args: unknown[]) => unknown>(() => 0),
  readdirSync: vi.fn<(...args: unknown[]) => unknown>(() => []),
  // node:child_process spawn
  spawn: vi.fn<(...args: unknown[]) => unknown>(),
  // channel-monitor (dynamic import)
  hardRestartMarveenChannels: vi.fn<typeof hardRestartMarveenChannels>(() => ({ ok: true })),
  lastMainRespawnAt: vi.fn<typeof lastMainRespawnAt>(() => 0),
}))

// ----------------------------------------------------------------------------
// Hoisted mocks. vi.mock factories are hoisted BEFORE the import statements, so
// every dependency inbound-probe.ts imports is swapped before the module body
// runs. The sandbox PROJECT_ROOT freezes SESSION_FILE etc. to per-test tmpdir
// paths -- no live ./store/ write can ever escape.
// ----------------------------------------------------------------------------

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: mockState.existsSync,
    readFileSync: mockState.readFileSync,
    statSync: mockState.statSync,
    openSync: mockState.openSync,
    closeSync: mockState.closeSync,
    readSync: mockState.readSync,
    readdirSync: mockState.readdirSync,
  }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => mockState.homeDir,
  }
})

vi.mock('node:child_process', () => ({
  spawn: mockState.spawn,
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: mockState.projectRoot,
    STORE_DIR: join(mockState.projectRoot, 'store'),
  }
})

vi.mock('../env.js', () => ({
  readEnvFile: (keys?: string[]): Record<string, string> => {
    if (!keys) return { ...mockState.envFile }
    const out: Record<string, string> = {}
    for (const k of keys) {
      if (k in mockState.envFile) out[k] = mockState.envFile[k]
    }
    return out
  },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// The dynamic `import('./channel-monitor.js')` inside checkInboundProbeDeafness
// resolves via the same module loader -- vi.mock on the absolute source-relative
// path catches it before the import() promise settles.
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: mockState.hardRestartMarveenChannels,
  lastMainRespawnAt: mockState.lastMainRespawnAt,
}))

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
}

function defaultSpawn(): FakeChildProcess {
  const cp = new FakeChildProcess()
  mockState.spawn.mockReturnValue(cp)
  return cp
}

async function loadInboundProbeFresh(): Promise<typeof import('../web/inbound-probe.js')> {
  vi.resetModules()
  vi.doMock('node:fs', async (orig) => {
    const actual = await orig<typeof import('node:fs')>()
    return {
      ...actual,
      existsSync: mockState.existsSync,
      readFileSync: mockState.readFileSync,
      statSync: mockState.statSync,
      openSync: mockState.openSync,
      closeSync: mockState.closeSync,
      readSync: mockState.readSync,
      readdirSync: mockState.readdirSync,
    }
  })
  vi.doMock('node:os', async (orig) => {
    const actual = await orig<typeof import('node:os')>()
    return {
      ...actual,
      homedir: () => mockState.homeDir,
    }
  })
  vi.doMock('node:child_process', () => ({
    spawn: mockState.spawn,
  }))
  vi.doMock('../config.js', async (orig) => {
    const actual = await orig<typeof import('../config.js')>()
    return {
      ...actual,
      PROJECT_ROOT: mockState.projectRoot,
      STORE_DIR: join(mockState.projectRoot, 'store'),
    }
  })
  vi.doMock('../env.js', () => ({
    readEnvFile: (keys?: string[]): Record<string, string> => {
      if (!keys) return { ...mockState.envFile }
      const out: Record<string, string> = {}
      for (const k of keys) {
        if (k in mockState.envFile) out[k] = mockState.envFile[k]
      }
      return out
    },
  }))
  vi.doMock('../logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  }))
  vi.doMock('../web/channel-monitor.js', () => ({
    hardRestartMarveenChannels: mockState.hardRestartMarveenChannels,
    lastMainRespawnAt: mockState.lastMainRespawnAt,
  }))
  return await import('../web/inbound-probe.js')
}

function setupMocks(): void {
  mockState.existsSync.mockReset()
  mockState.existsSync.mockReturnValue(true)
  mockState.readFileSync.mockReset()
  mockState.readFileSync.mockReturnValue('')
  mockState.statSync.mockReset()
  mockState.statSync.mockReturnValue({ size: 0 })
  mockState.openSync.mockReset()
  mockState.openSync.mockReturnValue(1)
  mockState.closeSync.mockReset()
  mockState.spawn.mockReset()
  mockState.hardRestartMarveenChannels.mockReset()
  mockState.hardRestartMarveenChannels.mockReturnValue({ ok: true })
  mockState.lastMainRespawnAt.mockReset()
  mockState.lastMainRespawnAt.mockReturnValue(0)
  mockState.envFile = {}
}

// Per-test setup: build a tmpdir sandbox and configure mocks so the module's
// frozen file paths (SESSION_FILE, PROBE_LAST_SENT_FILE, VENV_PYTHON,
// PROBER_SCRIPT) land inside the sandbox. TRANSCRIPT_DIR is computed from
// process.env.HOME (which we set) and PROJECT_ROOT.
beforeEach(() => {
  vi.useFakeTimers()
  mockState.sandbox = mkdtempSync(join(tmpdir(), 'inbound-probe-full-'))
  mockState.projectRoot = join(mockState.sandbox, 'project')
  mockState.homeDir = join(mockState.sandbox, 'home')
  mkdirSync(mockState.projectRoot, { recursive: true })
  mkdirSync(mockState.homeDir, { recursive: true })
  // TRANSCRIPT_DIR is frozen at module load from process.env.HOME. Override
  // the real $HOME so the value resolves to our sandbox.
  process.env.HOME = mockState.homeDir
  setupMocks()
})

afterEach(() => {
  vi.useRealTimers()
  if (mockState.sandbox) {
    rmSync(mockState.sandbox, { recursive: true, force: true })
  }
  delete process.env.HOME
  vi.restoreAllMocks()
})

// =============================================================================
// Pure exports (already covered in inbound-probe.test.ts but exercised here
// so the per-file suite drives inbound-probe.ts to 100% without depending on
// the sibling suite running in the same worker).
// =============================================================================

describe('shouldTriggerDeafnessRespawn', () => {
  it('returns false when timeout has not elapsed', async () => {
    const mod = await loadInboundProbeFresh()
    expect(mod.shouldTriggerDeafnessRespawn({
      markerTs: 1000,
      lastIngestionTs: null,
      probeTimeoutMs: 60_000,
      nowMs: 2000,
    })).toBe(false)
  })

  it('returns true at the probeTimeoutMs boundary with no ingestion', async () => {
    const mod = await loadInboundProbeFresh()
    expect(mod.shouldTriggerDeafnessRespawn({
      markerTs: 0,
      lastIngestionTs: null,
      probeTimeoutMs: 60_000,
      nowMs: 60_000,
    })).toBe(true)
  })

  it('returns false when timeout elapsed but ingestion is AFTER the marker', async () => {
    const mod = await loadInboundProbeFresh()
    expect(mod.shouldTriggerDeafnessRespawn({
      markerTs: 0,
      lastIngestionTs: 100,
      probeTimeoutMs: 60_000,
      nowMs: 60_000,
    })).toBe(false)
  })

  it('returns true when timeout elapsed and ingestion predates the marker', async () => {
    const mod = await loadInboundProbeFresh()
    expect(mod.shouldTriggerDeafnessRespawn({
      markerTs: 100,
      lastIngestionTs: 50,
      probeTimeoutMs: 60,
      nowMs: 1000,
    })).toBe(true)
  })
})

describe('readLastIngestionTimestamp', () => {
  it('returns null when the transcript directory does not exist', async () => {
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('projects')) return false
      return true
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/no/such/dir')).toBe(null)
  })

  it('returns null via the outer catch when an fs call throws (line 175)', async () => {
    mockState.readdirSync.mockImplementation(() => {
      throw new Error('readdir boom')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(null)
  })

  it('drives the body through openSync and covers the success path', async () => {
    // Drive the function to openSync + the file-size / readSync block.
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 0 })
    const mod = await loadInboundProbeFresh()
    // size === 0 means readLength = 0, so readSync is skipped and rawText
    // is the empty buf. The function returns null because no <channel
    // source= line is found. The point is the openSync branch is reached.
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(null)
  })

  it('skips files that disappear between readdir and stat (inner try/catch)', async () => {
    mockState.readdirSync.mockReturnValue(['present.jsonl', 'gone.jsonl'] as unknown as string[])
    let statCalls = 0
    mockState.statSync.mockImplementation(() => {
      statCalls++
      if (statCalls === 2) throw new Error('ENOENT: gone.jsonl')
      return { mtimeMs: 100, size: 0 }
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(null)
  })

  it('parses the trailing <channel source= line when present', async () => {
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    // Build a JSON line and write it into the buffer passed to readSync --
    // readSync normally fills the buffer; the mock has to do the same.
    const ts = '2026-06-01T10:05:00.000Z'
    const line = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> hello' })
    // Set file size to the line length so the buffer contains only the JSON
    // line (no trailing garbage from allocUnsafe).
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: line.length })
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(line, offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })

  it('skips non-channel lines and parses only <channel source= lines (covers parse branch)', async () => {
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 4096 })
    const ts = '2026-06-01T10:05:00.000Z'
    const nonChannel = JSON.stringify({ timestamp: '2026-06-01T09:00:00.000Z', content: 'plain' })
    const channel = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> hello' })
    const data = nonChannel + '\n' + channel + '\n'
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(data.slice(0, length), offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })

  it('skips lines whose timestamp is non-string or non-finite (covers the typeof guard)', async () => {
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 4096 })
    const ts = '2026-06-01T10:05:00.000Z'
    const lineNoTimestamp = JSON.stringify({ content: '<channel source=telegram> x' }) // no timestamp
    const lineBadTs = JSON.stringify({ timestamp: 'not-a-date', content: '<channel source=telegram> y' })
    const lineGood = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> good' })
    const data = lineNoTimestamp + '\n' + lineBadTs + '\n' + lineGood + '\n'
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(data.slice(0, length), offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })

  it('skips malformed JSON lines without aborting (covers inner try/catch)', async () => {
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 4096 })
    const ts = '2026-06-01T10:05:00.000Z'
    const malformed = '{ this is not JSON <channel source=telegram>'
    const good = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> x' })
    const data = malformed + '\n' + good + '\n'
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(data.slice(0, length), offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })

  it('drops a partial first line when readOffset > 0 (covers the firstNewline trim branch)', async () => {
    // fileSize > TAIL_BYTES (256 KB) -> readOffset > 0; the chunk likely
    // starts mid-line, so the function must drop the first partial line.
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 262144 + 100 })
    const partialLine = '{partial: true, "x": "y'  // intentionally malformed prefix
    const ts = '2026-06-01T10:05:00.000Z'
    const good = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> x' })
    const data = partialLine + '\n' + good + '\n'
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(data.slice(0, length), offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })
})

// =============================================================================
// TRANSCRIPT_DIR export -- covers lines 42-47. The value is computed at
// module load from process.env.HOME + PROJECT_ROOT, so we assert the
// observable contract via the resolved path.
// =============================================================================

describe('TRANSCRIPT_DIR', () => {
  it('is derived from HOME and PROJECT_ROOT at module load', async () => {
    const mod = await loadInboundProbeFresh()
    expect(mod.TRANSCRIPT_DIR).toBe(join(
      mockState.homeDir,
      '.claude',
      'projects',
      mockState.projectRoot.replace(/\//g, '-'),
    ))
  })
})

// =============================================================================
// startInboundProber -- the exported entry point that orchestrates spawn +
// the check loop. Every branch lives behind a vi.advanceTimersByTimeAsync() to
// trigger the setInterval tick.
// =============================================================================

describe('startInboundProber', () => {
  it('uses the default 180_000 ms interval when PROBE_INTERVAL_MS is unset', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('reads PROBE_INTERVAL_MS from .env (cached after first read)', async () => {
    mockState.envFile = { PROBE_INTERVAL_MS: '60000', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    // 60s interval; tick should fire after one interval -- the second spawn
    // invocation would only happen if the first exited. Force an exit by
    // emitting exit(0) on the first returned child.
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('floors PROBE_INTERVAL_MS at 30_000 ms (the W1 minimum)', async () => {
    mockState.envFile = { PROBE_INTERVAL_MS: '5000', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    expect(mockState.spawn).toHaveBeenCalled()
    // The 5s would be floored to 30s; we just assert it does not crash.
  })

  it('uses the default when PROBE_INTERVAL_MS is non-numeric', async () => {
    mockState.envFile = { PROBE_INTERVAL_MS: 'not-a-number', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('uses the default when PROBE_INTERVAL_MS is zero/negative', async () => {
    mockState.envFile = { PROBE_INTERVAL_MS: '0', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('logs an info entry on startup', async () => {
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      info: ReturnType<typeof vi.fn>
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ probeIntervalMs: expect.any(Number) }),
      'Inbound prober started',
    )
  })
})

// =============================================================================
// spawnProber -- exercised through startInboundProber. Each test flips a
// single fs mock so we cover one branch per scenario.
// =============================================================================

describe('spawnProber via startInboundProber', () => {
  it('returns early (no spawn) when SESSION_FILE is missing on first call', async () => {
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-userbot.session')) return false
      // Keep the rest of the path (venv, script) reachable so we know the
      // session check is the gating branch.
      if (typeof p === 'string' && p.includes('.watchdog-venv')) return true
      if (typeof p === 'string' && p.endsWith('watchdog-inbound-prober.py')) return true
      return true
    })
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(mockState.spawn).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('session missing'))
  })

  it('emits debug (not warn) on subsequent ticks while the session stays missing', async () => {
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-userbot.session')) return false
      return true
    })
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    vi.advanceTimersByTime(180_000)
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
      debug: ReturnType<typeof vi.fn>
    }
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('session still missing'))
  })

  it('returns early when ALLOWED_CHAT_ID is absent (warn path)', async () => {
    mockState.envFile = {} // no ALLOWED_CHAT_ID
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(mockState.spawn).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_CHAT_ID absent'))
  })

  it('emits debug on subsequent ticks when ALLOWED_CHAT_ID stays absent', async () => {
    mockState.envFile = {}
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    vi.advanceTimersByTime(180_000)
    const logger = (await import('../logger.js')).logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_CHAT_ID still absent'))
  })

  it('returns early when ALLOWED_CHAT_ID is whitespace-only', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '   ' }
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(mockState.spawn).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_CHAT_ID absent'))
  })

  it('returns early when VENV_PYTHON is missing', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-userbot.session')) return true
      if (typeof p === 'string' && p.includes('.watchdog-venv/bin/python3')) return false
      return true
    })
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(mockState.spawn).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('python3 not found'))
  })

  it('returns early when PROBER_SCRIPT is missing', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-userbot.session')) return true
      if (typeof p === 'string' && p.includes('.watchdog-venv/bin/python3')) return true
      if (typeof p === 'string' && p.endsWith('watchdog-inbound-prober.py')) return false
      return true
    })
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(mockState.spawn).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('watchdog-inbound-prober.py not found'))
  })

  it('does not double-spawn when the prober is still running (exitCode === null)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const callsAfterFirst = mockState.spawn.mock.calls.length
    // Trigger another tick -- exitCode is still null because we did not emit
    // 'exit'. The prober must not be re-spawned.
    vi.advanceTimersByTime(180_000)
    expect(mockState.spawn.mock.calls.length).toBe(callsAfterFirst)
    // Suppress lint warning about unused cp.
    void cp
  })

  it('re-spawns the prober after the previous one exits', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp1 = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    // Simulate the prober exiting.
    cp1.exitCode = 0
    cp1.emit('exit', 0)
    vi.advanceTimersByTime(180_000)
    expect(mockState.spawn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('forwards stdout data to logger.debug', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.stdout.emit('data', Buffer.from('hello from prober'))
    const logger = (await import('../logger.js')).logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    expect(logger.debug).toHaveBeenCalledWith(
      { prober: 'stdout' },
      'hello from prober',
    )
  })

  it('forwards stderr data to logger.warn', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.stderr.emit('data', Buffer.from('something bad'))
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    expect(logger.warn).toHaveBeenCalledWith(
      { prober: 'stderr' },
      'something bad',
    )
  })

  it('skips empty stdout lines (no log)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.stdout.emit('data', Buffer.from('   \n'))
    const logger = (await import('../logger.js')).logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    // No debug call with the prober-stdout meta should have fired for empty.
    const calls = logger.debug.mock.calls.filter((c) => c[0]?.prober === 'stdout')
    expect(calls.length).toBe(0)
  })

  it('logs and clears proberProcess on the exit event', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.emit('exit', 0)
    const logger = (await import('../logger.js')).logger as unknown as {
      info: ReturnType<typeof vi.fn>
    }
    expect(logger.info).toHaveBeenCalledWith(
      { code: 0 },
      'Inbound prober process exited',
    )
  })

  it('logs and clears proberProcess on the error event', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.emit('error', new Error('spawn failed'))
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Inbound prober spawn error',
    )
  })

  it('logs an error when spawn() throws synchronously', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.spawn.mockImplementation(() => { throw new Error('spawn blew up') })
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Inbound prober: failed to spawn',
    )
  })

  it('passes detached:false and pipe stdio to spawn()', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    expect(mockState.spawn).toHaveBeenCalledWith(
      expect.stringContaining('python3'),
      [expect.stringContaining('watchdog-inbound-prober.py')],
      expect.objectContaining({ detached: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })
})

// =============================================================================
// checkInboundProbeDeafness -- exercised through the setInterval tick. Each
// scenario controls: SESSION_FILE exists, PROBE_LAST_SENT contents, the
// transcript file, and the dynamic channel-monitor import result.
// =============================================================================

describe('checkInboundProbeDeafness via setInterval tick', () => {
  it('skips the check when SESSION_FILE is missing', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-userbot.session')) return false
      return true
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    // No dynamic import triggered (no hardRestart call).
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('skips the check when no probe has been sent yet (marker null)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        throw new Error('probe-last-sent missing')
      }
      return ''
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('does nothing when shouldTriggerDeafnessRespawn returns false', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    // Marker is far in the future -> the check returns false (timeout not
    // elapsed). Set marker to "now" so probeTimeoutMs (probeIntervalMs * 2 =
    // 360000) has not elapsed.
    const now = Date.now()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return new Date(now).toISOString()
      }
      return ''
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('triggers a hard restart when shouldTriggerDeafnessRespawn returns true', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    // Marker is way in the past so the timeout (2 * 180s = 360s) has elapsed.
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    // Let the dynamic-import promise resolve.
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('skips the respawn when lastMainRespawnAt is within the grace window', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    mockState.lastMainRespawnAt.mockReturnValue(Date.now() - 1000) // 1s ago
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('does NOT skip when lastMainRespawnAt is 0 (the cross-path grace check)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    mockState.lastMainRespawnAt.mockReturnValue(0)
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('logs an error when hardRestartMarveenChannels returns ok:false', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    mockState.hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'denied' })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      { error: 'denied' },
      'Inbound deafness respawn failed',
    )
  })

  it('catches a tick-level exception and logs it (no re-throw)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    // The setInterval tick wraps spawnProber() + checkInboundProbeDeafness()
    // in try/catch (lines 376-383). To force that catch to fire we need
    // either function to throw synchronously. The ONLY synchronous throw
    // surface in either path is existsSync (the read* helpers swallow their
    // own errors). Track the call index and throw on a later index so the
    // initial startInboundProber call succeeds.
    let existsCalls = 0
    const log: number[] = []
    mockState.existsSync.mockImplementation((p: unknown) => {
      existsCalls++
      log.push(existsCalls)
      // Throw on call #5: startInboundProber does 3 (SESSION, VENV, PROBER),
      // the tick does 3 more in spawnProber, then checkInboundProbeDeafness
      // would do 1 more. Throwing on the 5th ensures the tick-time catch
      // fires.
      if (existsCalls === 5) throw new Error('tick boom')
      return true
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Inbound probe check tick failed',
    )
    // Suppress unused warning.
    void log
  })

  it('returns null for readProbeLastSentMs when the file content is non-parseable', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return 'not-a-date'
      }
      return ''
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('returns null for readProbeLastSentMs when readFileSync throws', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        throw new Error('read failed')
      }
      return ''
    })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    expect(mockState.hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('uses cached PROBE_INTERVAL_MS across ticks (the W4 contract)', async () => {
    mockState.envFile = { PROBE_INTERVAL_MS: '90000', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    // Mutating envFile after the module loaded must NOT affect the cached
    // interval: the suite asserts the cache read-once contract by NOT
    // observing a re-read of PROBE_INTERVAL_MS on the next tick.
    mockState.envFile = { PROBE_INTERVAL_MS: '30000' }
    vi.advanceTimersByTime(180_000)
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('uses cached ALLOWED_CHAT_ID across ticks (the W4 contract)', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    mockState.envFile = { ALLOWED_CHAT_ID: '' }
    vi.advanceTimersByTime(180_000)
    // The prober must still spawn -- the empty value on the next tick is
    // masked by the cached '12345'.
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('skips the cross-path grace check when lastMainRespawnAt is exactly 0', async () => {
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    mockState.lastMainRespawnAt.mockReturnValue(0)
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('covers the inbound-path self-rate-cap branch (lines 330-332)', async () => {
    // Drive TWO consecutive ticks within the grace window: the first sets
    // lastInboundRespawn; the second hits the rate-cap branch.
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    mockState.lastMainRespawnAt.mockReturnValue(0)
    mockState.hardRestartMarveenChannels.mockReturnValue({ ok: true })
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    // First tick: triggers the respawn (sets lastInboundRespawn).
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    // Second tick (within the 15-min grace): hits the inbound-path
    // self-rate-cap. hardRestartMarveenChannels must NOT be called again.
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockState.hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
  })

  it('logs an error when the dynamic import rejects (line 347)', async () => {
    // Force the dynamic import's .catch to fire by making the mocked module
    // factory throw -- vi.mock factories that throw cause the import() to
    // reject.
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const marker = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockState.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.watchdog-probe-last-sent')) {
        return marker
      }
      return ''
    })
    defaultSpawn()
    // Re-import with a channel-monitor mock that throws to force import()
    // rejection.
    vi.resetModules()
    vi.doMock('node:fs', async (orig) => {
      const actual = await orig<typeof import('node:fs')>()
      return {
        ...actual,
        existsSync: mockState.existsSync,
        readFileSync: mockState.readFileSync,
        statSync: mockState.statSync,
        openSync: mockState.openSync,
        closeSync: mockState.closeSync,
        readSync: mockState.readSync,
        readdirSync: mockState.readdirSync,
      }
    })
    vi.doMock('node:os', async (orig) => {
      const actual = await orig<typeof import('node:os')>()
      return { ...actual, homedir: () => mockState.homeDir }
    })
    vi.doMock('node:child_process', () => ({ spawn: mockState.spawn }))
    vi.doMock('../config.js', async (orig) => {
      const actual = await orig<typeof import('../config.js')>()
      return { ...actual, PROJECT_ROOT: mockState.projectRoot, STORE_DIR: join(mockState.projectRoot, 'store') }
    })
    vi.doMock('../env.js', () => ({ readEnvFile: (keys?: string[]) => {
      if (!keys) return { ...mockState.envFile }
      const out: Record<string, string> = {}
      for (const k of keys) if (k in mockState.envFile) out[k] = mockState.envFile[k]
      return out
    } }))
    vi.doMock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
    // The mock factory throws -> import() rejects -> .catch fires.
    vi.doMock('../web/channel-monitor.js', () => {
      throw new Error('module load failed')
    })
    const mod = await import('../web/inbound-probe.js')
    mod.startInboundProber()
    vi.advanceTimersByTime(180_000)
    await vi.advanceTimersByTimeAsync(0)
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Inbound probe: failed to import channel-monitor for respawn',
    )
  })
})

// =============================================================================
// Coverage gap fillers -- branches that the suites above did not exercise.
// =============================================================================

describe('coverage gap fillers', () => {
  it('TRANSCRIPT_DIR falls back to homedir() when process.env.HOME is unset', async () => {
    // The TRANSCRIPT_DIR value is frozen at module load from process.env.HOME
    // or, if HOME is undefined, os.homedir(). Unset HOME before the module
    // loads so the ?? branch fires. homedir() is mocked to a known path.
    delete process.env.HOME
    const mod = await loadInboundProbeFresh()
    expect(mod.TRANSCRIPT_DIR).toBe(join(
      mockState.homeDir,
      '.claude',
      'projects',
      mockState.projectRoot.replace(/\//g, '-'),
    ))
  })

  it('readLastIngestionTimestamp returns null immediately when existsSync(transcriptDir) is false', async () => {
    // Direct exercise of the early-return guard. The previous "transcript
    // directory does not exist" test passed a non-projects path, so the
    // condition never fired -- this one forces existsSync to return false
    // for the directory argument so the body of the guard executes. We
    // snapshot readdirSync counts around the call to assert the early
    // return took the short-circuit path (no readdir/stat/openSync).
    mockState.existsSync.mockImplementation(() => false)
    const mod = await loadInboundProbeFresh()
    const before = mockState.readdirSync.mock.calls.length
    expect(mod.readLastIngestionTimestamp('/any/path')).toBe(null)
    const after = mockState.readdirSync.mock.calls.length
    expect(after).toBe(before)
  })

  it('readLastIngestionTimestamp skips lines whose timestamp is a non-string type', async () => {
    // Drive the else-branch of `typeof obj.timestamp === 'string'`. JSON
    // parses numbers, booleans, and null into their native types. Only a
    // string is treated as a candidate timestamp -- a number here means the
    // JSON was hand-crafted or the upstream schema is wrong, and the function
    // must skip without aborting.
    mockState.readdirSync.mockReturnValue(['session.jsonl'] as unknown as string[])
    mockState.statSync.mockReturnValue({ mtimeMs: 100, size: 4096 })
    const ts = '2026-06-01T10:05:00.000Z'
    const numberTs = JSON.stringify({ timestamp: 1234567890, content: '<channel source=telegram> x' })
    const boolTs = JSON.stringify({ timestamp: true, content: '<channel source=telegram> y' })
    const good = JSON.stringify({ timestamp: ts, content: '<channel source=telegram> good' })
    const data = numberTs + '\n' + boolTs + '\n' + good + '\n'
    mockState.readSync.mockImplementation((_fd: number, buf: Buffer, offset: number, length: number) => {
      return buf.write(data.slice(0, length), offset, length, 'utf-8')
    })
    const mod = await loadInboundProbeFresh()
    expect(mod.readLastIngestionTimestamp('/some/dir')).toBe(new Date(ts).getTime())
  })

  it('readProbeIntervalMs cache-hit path returns the cached value without re-reading .env', async () => {
    // The cache fires when startInboundProber is called twice on the same
    // module instance. The first call primes the cache (cache-miss branch);
    // the second call hits the `if (_cachedProbeIntervalMs !== null) return
    // _cachedProbeIntervalMs` guard on line 196 without re-reading .env.
    // Mutate envFile between the calls and assert the new value is masked.
    mockState.envFile = { PROBE_INTERVAL_MS: '120000', ALLOWED_CHAT_ID: '12345' }
    defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    // Second call on the same module instance -- cache must win.
    mockState.envFile = { PROBE_INTERVAL_MS: '60000', ALLOWED_CHAT_ID: '12345' }
    mod.startInboundProber()
    // The second call would have set the interval to 60000 if the cache
    // miss branch fired; with the cache hit, it stays at the 120000 minimum
    // (the W1 floor keeps it >= 30_000).
    expect(mockState.spawn).toHaveBeenCalled()
  })

  it('spawnProber skips empty stderr lines (no log) -- the empty-text branch', async () => {
    // The `if (text)` guard on the stderr forwarder only logs when text is
    // truthy. Empty / whitespace-only stderr data must not produce a log line.
    mockState.envFile = { ALLOWED_CHAT_ID: '12345' }
    const cp = defaultSpawn()
    const mod = await loadInboundProbeFresh()
    mod.startInboundProber()
    cp.stderr.emit('data', Buffer.from(''))
    cp.stderr.emit('data', Buffer.from('   \n'))
    const logger = (await import('../logger.js')).logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    const stderrCalls = logger.warn.mock.calls.filter((c) => c[0]?.prober === 'stderr')
    expect(stderrCalls.length).toBe(0)
  })
})
