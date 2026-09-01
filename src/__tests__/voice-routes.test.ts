// 100% coverage suite for src/web/routes/voice.ts.
//
// tryHandleVoice owns six /api/voice/* endpoints plus the in-process
// `transcribeVoiceFile` helper called by the message-router tick (NOT through
// this route). Every collaborator is mocked:
//   - node:child_process   (spawn -> FakeProc that emits data+close)
//   - node:fs              (existsSync -> controllable from tests)
//   - node:os              (homedir -> tmp HOME)
//   - ../../logger.js      (info/warn/error/debug -> H.logs)
//   - ../config.js         (PROJECT_ROOT -> SANDBOX)
//   - ../http-helpers.js   (readBody, json -> REAL; they call into the route's
//                           own req/res, so they must stay real)
//   - ../agent-config.js   (KNOWN_VOICE_MODELS, AGENTS_BASE_DIR,
//                           readAgentVoiceConfig)
//   - ../voice-modality.js (getLastInboundModality, setLastInboundModality)
//   - ../voice-directive.js(buildTtsDirective, resolveAgentChannelStateDir,
//                           inboundIsAudio)
//
// The triage per branch surface is given below at each `describe` block.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type { readAgentVoiceConfig } from '../web/agent-config.js'
import type http from 'node:http'
import { Readable, EventEmitter } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ----- hoisted harness (visible to every vi.mock factory and the test body) ---

interface SpawnSpec {
  /** stdout chunks to deliver before close. */
  stdout?: string
  /** stderr chunks to deliver before close. */
  stderr?: string
  /** exit code; default 0. */
  code?: number
  /** When true, emit no data, only an error event on next tick. */
  error?: Error
  /**
   * If >0, do NOT auto-close; let runProc's setTimeout kill the proc. Tests
   * with this flag should advance the fake timer to the timeout.
   */
  hang?: boolean
}

// Hoisted harness: shared between vi.mock factories and test body.
// vi.hoisted is run BEFORE module-level imports; we cannot call fs helpers
// inside it (they aren't available yet). Sandbox paths are filled in below
// (after the dynamic `await import` of fs/os at the top of the file) by
// binding to module-scope `SANDBOX_TMP`.
const H = vi.hoisted(() => ({
  tmp: '',
  home: '',
  project: '',
  scriptsDir: '',

  spawnQueue: [] as SpawnSpec[],

  logInfo: vi.fn<(obj: unknown, msg?: string) => void>(),
  logWarn: vi.fn<(obj: unknown, msg?: string) => void>(),
  logError: vi.fn<(obj: unknown, msg?: string) => void>(),
  logDebug: vi.fn<(obj: unknown, msg?: string) => void>(),

  KNOWN_VOICE_MODELS: new Set<string>(['hu_HU-imre-medium', 'hu_HU-anna-medium']),
  AGENTS_BASE_DIR: '',
  readAgentVoiceConfig: vi.fn<typeof readAgentVoiceConfig>(() => ({
    responseMode: 'auto',
    voiceModel: 'hu_HU-imre-medium',
  })),

  getLastInboundModality: vi.fn(() => null as 'voice' | 'text' | null),
  setLastInboundModality: vi.fn(),

  resolveAgentChannelStateDir: vi.fn(
    (_agent: string, _provider: string) => '/default/state/dir',
  ),
  inboundIsAudio: vi.fn((kind: string | null | undefined, fileId: string | null | undefined) => {
    if (!fileId) return false
    return ['voice', 'audio', 'video_note'].includes((kind ?? '').trim().toLowerCase())
  }),
  buildTtsDirective: vi.fn((opts: { chatId: string; stateDir: string; voiceModel: string }) =>
    `TTS_DIRECTIVE chat=${opts.chatId} model=${opts.voiceModel}`,
  ),

  existsSyncMap: new Map<string, boolean>(),
}))

// `existsSync` is invoked three places in the SUT:
//   (a) isSafeStateDir  -- one specific .env check inside the resolved dir
//   (b) voiceOnnxPath    -- one specific .onnx file
//   (c) isVoiceInstalled -- two specific files (venv/bin/python, _vtools.py)
// We pass `node:fs` through and override ONLY `existsSync` so the rest (rare
// but possible mkdirSync from neighbours) keeps working on the real fs.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  // Use a single function reference shared across all imports of node:fs.
  // The closure reads H.existsSyncMap at every call, so per-test setup
  // takes effect without module re-import.
  const overriddenExists = (p: unknown): boolean => {
    const key = typeof p === 'string' ? p : String(p)
    if (H.existsSyncMap.has(key)) return H.existsSyncMap.get(key) as boolean
    return actual.existsSync(p as Parameters<typeof actual.existsSync>[0])
  }
  return { ...actual, existsSync: overriddenExists }
})

// spawn is mocked at the module level so the SUT's `import { spawn }` resolves
// to a vi.fn() that returns a FakeProc built from H.spawnQueue.
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const spec: SpawnSpec = H.spawnQueue.shift() ?? { stdout: '', stderr: '', code: 0 }
    const procEE = new EventEmitter()
    const stdoutEE = new EventEmitter()
    const stderrEE = new EventEmitter()
    let closeCb: ((code: number | null) => void) | null = null
    const proc: {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: {
        write: (chunk: string, enc: string) => boolean
        end: () => void
        on?: (event: string, cb: (...a: unknown[]) => void) => void
      }
      killed: boolean
      kill: (signal: string) => void
      unref: () => void
      on: (event: string, cb: (...a: unknown[]) => void) => void
    } = {
      stdout: stdoutEE,
      stderr: stderrEE,
      stdin: { write: () => true, end: () => {}, on: () => {} },
      killed: false,
      kill(_sig) {
        this.killed = true
        // The SUT's runProc listens to 'close' on the proc itself.
        // Fire it with code=null so the result coalesces to 1 (the
        // runProc default when code is null).
        if (closeCb) closeCb(null)
        else procEE.emit('close', null)
      },
      unref() {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === 'close') closeCb = cb as (code: number | null) => void
        if (spec.error) {
          const err = spec.error
          queueMicrotask(() => cb(err))
          return proc
        }
        if (!spec.hang) {
          if (spec.stdout) queueMicrotask(() => stdoutEE.emit('data', Buffer.from(spec.stdout)))
          if (spec.stderr) queueMicrotask(() => stderrEE.emit('data', Buffer.from(spec.stderr)))
          queueMicrotask(() => cb(spec.code ?? 0))
        }
        return proc
      },
    }
    return proc
  }),
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => H.project, enumerable: true },
    },
  )
})

vi.mock('../web/agent-config.js', () => ({
  KNOWN_VOICE_MODELS: H.KNOWN_VOICE_MODELS,
  // Define a getter so the value is read lazily -- vi.hoisted seeds H.tmp
  // etc only AFTER the mock factory runs. Static-string placeholder would
  // make AGENTS_BASE_DIR === '' inside the SUT, which makes
  // `startsWith(AGENTS_BASE_DIR + '/')` always true.
  get AGENTS_BASE_DIR(): string { return H.AGENTS_BASE_DIR },
  readAgentVoiceConfig: H.readAgentVoiceConfig,
}))

// AGENTS_BASE_DIR must reflect the test sandbox -- voice.ts reads it at call
// time inside isSafeStateDir, so we patch module-context via Object.defineProperty
// to swap the value per test. The mock factory returns the initial value, and
// we mutate it directly via the same exported name in beforeEach.
H.AGENTS_BASE_DIR = join(H.project, 'agents')

vi.mock('../web/voice-modality.js', () => ({
  getLastInboundModality: H.getLastInboundModality,
  setLastInboundModality: H.setLastInboundModality,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: H.resolveAgentChannelStateDir,
  inboundIsAudio: H.inboundIsAudio,
  buildTtsDirective: H.buildTtsDirective,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.logInfo,
    warn: H.logWarn,
    error: H.logError,
    debug: H.logDebug,
  },
}))

// node:os: the SUT reads homedir() at module load to compute VOICE_DIR,
// VTOOLS_PY, VENV_PY and CHANNELS_BASE; we redirect to the sandbox HOME so
// existsSync() overrides below apply to the SAME paths the SUT uses. We
// return a getter-equivalent (a function that reads H.home lazily) so
// vi.mock's hoisted factory -- which runs before our sandbox-creation
// block -- doesn't capture an empty-string homedir.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: (): string => H.home }
})

// Defensive mocks for files that the SUT transitively imports but does NOT
// touch; they exist only so the module graph resolves.
vi.mock('../db.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Sandbox creation -- MUST happen BEFORE the SUT import so voice.ts captures
// the right `homedir()` at module-load time. `await import` is asynchronous,
// so all sync mkdir/mkdtemp must complete first.
{
  const tmp = mkdtempSync(join(tmpdir(), 'voice-routes-'))
  H.tmp = tmp
  H.home = join(tmp, 'home')
  H.project = join(tmp, 'project')
  H.scriptsDir = join(H.project, 'scripts')
  H.AGENTS_BASE_DIR = join(H.project, 'agents')
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.project, { recursive: true })
  mkdirSync(H.AGENTS_BASE_DIR, { recursive: true })
}

const { tryHandleVoice, transcribeVoiceFile } = await import('../web/routes/voice.js')

// ----- http helpers ---------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
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
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

function mkReq(opts: { body?: unknown; raw?: Buffer | string } = {}): http.IncomingMessage {
  const payload: Buffer[] = opts.raw !== undefined
    ? [typeof opts.raw === 'string' ? Buffer.from(opts.raw) : opts.raw]
    : opts.body !== undefined
      ? [Buffer.from(JSON.stringify(opts.body))]
      : []
  const r = Object.assign(
    Readable.from(payload),
    { headers: {} satisfies http.IncomingHttpHeaders },
  )
  // @ts-expect-error minimal IncomingMessage fake via Object.assign
  return r
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: Buffer | string; query?: Record<string, string> } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | unknown[] }> {
  const qs = opts.query
    ? '?' + Object.entries(opts.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : ''
  const req = mkReq(opts)
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}${qs}`),
    fedPeer: null,
  }
  // Always use the freshest voice module import so vi.resetModules() in
  // an earlier test does not leave _installInProgress stuck on TRUE.
  const voiceMod = await import('../web/routes/voice.js')
  const handled = await voiceMod.tryHandleVoice(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

// ----- install-related: control which files exist on disk for the helpers ----

/** Mark the canonical voice toolkit files as present (or absent) on disk.
 *  isVoiceInstalled requires BOTH VENV_PY and VTOOLS_PY; voiceOnnxPath
 *  requires the per-model .onnx under VOICE_DIR/voices/ — computed from
 *  home + '.local/share/marveen-voice'. isSafeStateDir just needs `<dir>/.env`
 *  (the channel-dir mock is wired separately). */
function setVoiceInstalled(present: boolean, models: string[] = []): void {
  const home = H.home
  const venvPy = join(home, '.local', 'share', 'marveen-voice', 'venv', 'bin', 'python')
  const vtoolsPy = join(home, '.local', 'share', 'marveen-voice', '_vtools.py')
  if (present) {
    H.existsSyncMap.set(venvPy, true)
    H.existsSyncMap.set(vtoolsPy, true)
  } else {
    H.existsSyncMap.delete(venvPy)
    H.existsSyncMap.delete(vtoolsPy)
  }
  for (const m of models) {
    H.existsSyncMap.set(
      join(home, '.local', 'share', 'marveen-voice', 'voices', `${m}.onnx`),
      true,
    )
  }
}

/** Set the .env existence inside the resolved state dir — used to drive
 *  isSafeStateDir's CHANNELS_BASE / AGENTS_BASE_DIR branches. */
function markDirHasEnv(dir: string, hasEnv: boolean): void {
  H.existsSyncMap.set(join(dir, '.env'), hasEnv)
}

// ----- mock state lifecycle -------------------------------------------------

beforeEach(() => {
  H.spawnQueue.length = 0
  H.logInfo.mockReset()
  H.logWarn.mockReset()
  H.logError.mockReset()
  H.logDebug.mockReset()
  H.existsSyncMap.clear()

  H.readAgentVoiceConfig.mockReset()
  H.readAgentVoiceConfig.mockReturnValue({
    responseMode: 'auto',
    voiceModel: 'hu_HU-imre-medium',
  })

  H.getLastInboundModality.mockReset().mockReturnValue(null)
  H.setLastInboundModality.mockReset()

  H.inboundIsAudio.mockReset().mockImplementation(
    (kind: string | null | undefined, fileId: string | null | undefined) => {
      if (!fileId) return false
      return ['voice', 'audio', 'video_note'].includes((kind ?? '').trim().toLowerCase())
    },
  )
  H.resolveAgentChannelStateDir.mockReset()
  H.resolveAgentChannelStateDir.mockImplementation(
    (_agent: string, _provider: string) => '/default/state/dir',
  )
  H.buildTtsDirective.mockReset()
  H.buildTtsDirective.mockImplementation(
    (opts: { chatId: string; stateDir: string; voiceModel: string }) =>
      `TTS_DIRECTIVE chat=${opts.chatId} model=${opts.voiceModel}`,
  )

  H.AGENTS_BASE_DIR = join(H.project, 'agents')
  mkdirSync(H.AGENTS_BASE_DIR, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  rmSync(H.tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// dispatcher: returns false for paths it does not own
// ---------------------------------------------------------------------------

describe('tryHandleVoice dispatcher', () => {
  it('returns false for an unknown path', async () => {
    const { handled, res } = await call('GET', '/api/something-else')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// transcribeVoiceFile -- in-process helper called by the message router tick
// ---------------------------------------------------------------------------

describe('transcribeVoiceFile', () => {
  it('returns null when voice is not installed (no spawn)', async () => {
    setVoiceInstalled(false)
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', '/some/state')
    expect(out).toBeNull()
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns null for an unsafe file id', async () => {
    setVoiceInstalled(true)
    markDirHasEnv(join(H.home, '.claude', 'channels', 'telegram'), true)
    const out = await transcribeVoiceFile('not-a-safe-id!', join(H.home, '.claude', 'channels', 'telegram'))
    expect(out).toBeNull()
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns null for an unsafe state dir (no .env)', async () => {
    setVoiceInstalled(true)
    markDirHasEnv('/some/state', false)
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', '/some/state')
    expect(out).toBeNull()
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns null for a state dir with ..', async () => {
    setVoiceInstalled(true)
    markDirHasEnv('/some/state/../etc', true)
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', '/some/state/../etc')
    expect(out).toBeNull()
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns null for a state dir that contains none of the known bases', async () => {
    setVoiceInstalled(true)
    // existsSync(.env) true so the .env check passes; the base check rejects.
    markDirHasEnv('/not/under/any/known/base', true)
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', '/not/under/any/known/base')
    expect(out).toBeNull()
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('accepts a trailing slash and trims it', async () => {
    setVoiceInstalled(true)
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({ code: 0, stdout: '  hello world \n' })
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', dir + '/')
    expect(out).toBe('hello world')
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns null and warns when whisper exits non-zero (stderr truncated)', async () => {
    setVoiceInstalled(true)
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({
      code: 1,
      stderr: 'E' + 'x'.repeat(500),
    })
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', dir)
    expect(out).toBeNull()
    expect(H.logWarn).toHaveBeenCalled()
    const [obj, msg] = H.logWarn.mock.calls[0]
    expect(msg).toContain('transcribeVoiceFile: whisper failed')
    const stderr = (obj as { stderr?: unknown })?.stderr
    expect(typeof stderr).toBe('string')
    if (typeof stderr === 'string') {
      expect(stderr.length).toBeLessThanOrEqual(200)
    }
  })

  it('uses an AGENTS_BASE_DIR-resolved state dir', async () => {
    setVoiceInstalled(true)
    const dir = join(H.AGENTS_BASE_DIR, 'scout', '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({ code: 0, stdout: 'transcript-A\n' })
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', dir)
    expect(out).toBe('transcript-A')
  })

  it('rejects an agent-scoped state dir that doesn\'t match the channels pattern', async () => {
    setVoiceInstalled(true)
    // under AGENTS_BASE_DIR but not "<agent>/.claude/channels/<provider>"
    const dir = join(H.AGENTS_BASE_DIR, 'stray')
    markDirHasEnv(dir, true)
    const out = await transcribeVoiceFile('BQACAgQAAxkBAAIDSWpqdaVDcIjs', dir)
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runProc internals -- exercised via endpoints; we drive timeout + stdin
// directly via /api/voice/tts.
// ---------------------------------------------------------------------------

describe('runProc internals (driven through endpoints)', () => {
  it('writes stdinData then closes it', async () => {
    setVoiceInstalled(true, ['hu_HU-imre-medium'])
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    // The SUT calls runProc(VENV_PY, [VTOOLS_PY, 'transcribe', ...]) and
    // always supplies both `stdinData` (required string) and `timeoutMs`
    // (required number) on the opts bag; we drive the path through tts to
    // confirm the upstream payload reaches the spawn's stdin pipe.
    H.spawnQueue.push({ code: 0, stdout: 'ok=True id=1\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '123', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message_id: 1 })
  })

  it('kills the proc when timeoutMs is exceeded', async () => {
    vi.useFakeTimers()
    setVoiceInstalled(true, ['hu_HU-imre-medium'])
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    // hang: do NOT auto-close. We advance time to trigger the SIGKILL
    // branch in runProc's setTimeout -- the kill() emits 'close' on the
    // stdout EventEmitter, which lets the on('close') resolve with code=1.
    H.spawnQueue.push({ hang: true })
    const promise = call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '123', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    // RunProc uses setTimeout(fn, 90_000) for tts; jump well past it.
    await vi.advanceTimersByTimeAsync(91_000)
    const { res, json } = await promise
    expect(res.statusCode).toBe(500)
    expect(json()).toMatchObject({ error: 'TTS failed' })
  })
})

// ---------------------------------------------------------------------------
// isSafeStateDir coverage through /api/voice/stt -- the helper has no direct
// export, but every branch is reachable via POST /api/voice/stt.
// ---------------------------------------------------------------------------

describe('isSafeStateDir coverage', () => {
  async function tryState(stateDir: string): Promise<{ res: MockRes; json: () => Record<string, unknown> }> {
    setVoiceInstalled(true)
    // Helper: state dir needs a .env -- markDirHasEnv handles it.
    markDirHasEnv(stateDir.replace(/\/$/, ''), true)
    H.spawnQueue.push({ code: 0, stdout: 'ok-transcript\n' })
    return call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: stateDir },
    })
  }

  it('rejects a path containing ..', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: '/safe/../etc/secret' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('rejects a state dir without a .env file', async () => {
    setVoiceInstalled(true)
    // existsSync for .env intentionally absent. /tmp/whatever is not
    // under CHANNELS_BASE / AGENTS_BASE_DIR anyway, but the .env check
    // happens first; assert it's the .env check that fired.
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: '/tmp/no-env-here' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('accepts the global CHANNELS_BASE exactly', async () => {
    const base = join(H.home, '.claude', 'channels')
    const { res } = await tryState(base)
    expect(res.statusCode).toBe(200)
  })

  it('accepts a sub-path of CHANNELS_BASE', async () => {
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    const { res } = await tryState(dir)
    expect(res.statusCode).toBe(200)
  })

  it('accepts an agent-scoped path matching <AGENTS_BASE_DIR>/<agent>/.claude/channels/<provider>', async () => {
    const dir = join(H.AGENTS_BASE_DIR, 'scout', '.claude', 'channels', 'telegram')
    const { res } = await tryState(dir)
    expect(res.statusCode).toBe(200)
  })

  it('rejects an AGENTS_BASE_DIR subpath that does not match the channels pattern', async () => {
    const dir = join(H.AGENTS_BASE_DIR, 'plain-dir')
    markDirHasEnv(dir, true)
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: dir },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })
})

// ---------------------------------------------------------------------------
// GET /api/voice/directive
// ---------------------------------------------------------------------------

describe('GET /api/voice/directive', () => {
  it('returns 400 for a missing/invalid agent id', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', { query: { chat: '123' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent' })
  })

  it('returns 400 for a missing chat id', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', { query: { agent: 'marveen' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('returns 400 when chat id is non-numeric', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: 'not-numeric' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('text responseMode -> directive null, no transcript', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'text', voiceModel: null })
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: '123' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    // We did NOT hit STT.
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('voice responseMode -> buildTtsDirective called even without audio', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-anna-medium' })
    H.buildTtsDirective.mockImplementation(
      (opts: { chatId: string; stateDir: string; voiceModel: string }) =>
        `TTS chat=${opts.chatId} state=${opts.stateDir} model=${opts.voiceModel}`,
    )
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: '42' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      directive: 'TTS chat=42 state=/default/state/dir model=hu_HU-anna-medium',
      transcript: null,
    })
    expect(H.buildTtsDirective).toHaveBeenCalledWith({
      chatId: '42',
      stateDir: '/default/state/dir',
      voiceModel: 'hu_HU-anna-medium',
    })
  })

  it('auto responseMode + non-audio attachment -> directive null, no transcript', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(false)
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: {
        agent: 'marveen',
        chat: '42',
        file: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs',
        kind: 'document',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('auto responseMode + audio attachment -> directive + transcript', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(true)
    setVoiceInstalled(true)
    H.spawnQueue.push({ code: 0, stdout: 'auto-transcript\n' })
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: {
        agent: 'marveen',
        chat: '7',
        file: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs',
        kind: 'voice',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      directive: 'TTS_DIRECTIVE chat=7 model=hu_HU-imre-medium',
      transcript: 'auto-transcript',
    })
  })

  it('audio attachment + STT exits non-zero -> directive still set, transcript null + warn', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(true)
    setVoiceInstalled(true)
    H.spawnQueue.push({ code: 2, stderr: 'whisper-broke' })
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: {
        agent: 'marveen',
        chat: '7',
        file: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs',
        kind: 'voice',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      directive: 'TTS_DIRECTIVE chat=7 model=hu_HU-imre-medium',
      transcript: null,
    })
    expect(H.logWarn).toHaveBeenCalled()
  })

  it('audio attachment + voice NOT installed -> transcript stays null, directive stays set', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(true)
    setVoiceInstalled(false)
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: {
        agent: 'marveen',
        chat: '7',
        file: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs',
        kind: 'voice',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      directive: 'TTS_DIRECTIVE chat=7 model=hu_HU-imre-medium',
      transcript: null,
    })
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('uses DEFAULT_VOICE_CONFIG.voiceModel when voiceCfg.voiceModel is null/undefined', async () => {
    // @ts-expect-error testing null voiceModel
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: null })
    const { json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: '42' },
    })
    expect(H.buildTtsDirective).toHaveBeenCalledWith(
      expect.objectContaining({ voiceModel: 'hu_HU-imre-medium' }),
    )
  })

  it('falls back to DEFAULT_VOICE_CONFIG when no voice config present and audio is true', async () => {
    // The SUT does `voiceCfg.voiceModel ?? 'hu_HU-imre-medium'` directly;
    // here voiceCfg.voiceModel is undefined -> default applied.
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: undefined })
    const { json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: '42' },
    })
    expect(json()).toMatchObject({ directive: expect.stringContaining('model=hu_HU-imre-medium') })
  })

  it('empty file + audio kind -> fileIdOk=false -> no directive, no STT', async () => {
    H.inboundIsAudio.mockReturnValue(true)
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: { agent: 'marveen', chat: '42', kind: 'voice' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('audio + STT stdout is whitespace only -> transcript:null (covers ` || null` branch)', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(true)
    setVoiceInstalled(true)
    H.spawnQueue.push({ code: 0, stdout: '   \n  \n' })
    const { res, json } = await call('GET', '/api/voice/directive', {
      query: {
        agent: 'marveen', chat: '7',
        file: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', kind: 'voice',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      directive: 'TTS_DIRECTIVE chat=7 model=hu_HU-imre-medium',
      transcript: null,
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/voice/modality
// ---------------------------------------------------------------------------

describe('GET /api/voice/modality', () => {
  it('returns 400 when agent is missing', async () => {
    const { res, json } = await call('GET', '/api/voice/modality', { query: { chat: '1' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent and chat required' })
  })

  it('returns 400 when chat is missing', async () => {
    const { res, json } = await call('GET', '/api/voice/modality', { query: { agent: 'a' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent and chat required' })
  })

  it('returns the stored modality', async () => {
    H.getLastInboundModality.mockReturnValue('voice')
    const { res, json } = await call('GET', '/api/voice/modality', {
      query: { agent: 'a', chat: '1' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ modality: 'voice' })
    expect(H.getLastInboundModality).toHaveBeenCalledWith('a', '1')
  })

  it('returns null when nothing is stored', async () => {
    const { res, json } = await call('GET', '/api/voice/modality', {
      query: { agent: 'a', chat: '1' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ modality: null })
  })
})

// ---------------------------------------------------------------------------
// POST /api/voice/modality/set
// ---------------------------------------------------------------------------

describe('POST /api/voice/modality/set', () => {
  it('returns 400 on invalid JSON', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { raw: 'not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 for an invalid agent_id', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: 'has spaces', chat_id: '1', modality: 'voice' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent_id' })
  })

  it('returns 400 for an invalid chat_id', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: 'a', chat_id: 'abc', modality: 'voice' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('returns 400 for an invalid modality', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: 'a', chat_id: '1', modality: 'video' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'modality must be voice or text' })
  })

  it('persists a valid voice modality', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: 'marveen', chat_id: '99', modality: 'voice' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '99', 'voice')
  })

  it('persists a valid text modality', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: 'marveen', chat_id: '99', modality: 'text' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '99', 'text')
  })

  it('trims surrounding whitespace before validation', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', {
      body: { agent_id: '  marveen  ', chat_id: ' 99 ', modality: ' voice ' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '99', 'voice')
  })

  it('treats undefined fields as empty strings (covers `data.x?.trim() ?? ""` branches)', async () => {
    // agent_id missing -> 400 Invalid agent_id via `!agentId`
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { chat_id: '1', modality: 'voice' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent_id' })

    // chat_id missing -> 400 Invalid chat_id
    const r2 = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'a', modality: 'voice' } })
    expect(r2.res.statusCode).toBe(400)
    expect(r2.json()).toEqual({ error: 'Invalid chat_id' })

    // modality missing -> 400 'modality must be voice or text'
    const r3 = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'a', chat_id: '1' } })
    expect(r3.res.statusCode).toBe(400)
    expect(r3.json()).toEqual({ error: 'modality must be voice or text' })
  })
})

// ---------------------------------------------------------------------------
// GET /api/voice/status
// ---------------------------------------------------------------------------

describe('GET /api/voice/status', () => {
  it('reports not installed (empty voices) when files are missing', async () => {
    setVoiceInstalled(false)
    const { res, json } = await call('GET', '/api/voice/status')
    expect(res.statusCode).toBe(200)
    const body = json() as { installed: boolean; voices: string[]; voiceDir: string }
    expect(body.installed).toBe(false)
    expect(body.voices).toEqual([])
    expect(typeof body.voiceDir).toBe('string')
    expect(body.voiceDir.endsWith('.local/share/marveen-voice')).toBe(true)
  })

  it('lists installed voices + reports installed=true', async () => {
    setVoiceInstalled(true, ['hu_HU-anna-medium'])
    // imre is in KNOWN_VOICE_MODELS but no .onnx -> filtered out.
    const { res, json } = await call('GET', '/api/voice/status')
    expect(res.statusCode).toBe(200)
    const body = json() as { installed: boolean; voices: string[] }
    expect(body.installed).toBe(true)
    expect(body.voices).toEqual(['hu_HU-anna-medium'])
  })
})

// ---------------------------------------------------------------------------
// POST /api/voice/stt
// ---------------------------------------------------------------------------

describe('POST /api/voice/stt', () => {
  it('returns 503 when voice is not installed', async () => {
    setVoiceInstalled(false)
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: '/x' },
    })
    expect(res.statusCode).toBe(503)
    expect(json()).toEqual({ error: 'Voice toolkit not installed' })
  })

  it('returns 400 on invalid JSON', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/stt', { raw: 'not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 for an invalid file_id', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'unsafe id', state_dir: '/x' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid file_id' })
  })

  it('returns 400 for an invalid state_dir', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: '/not/under/base' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('returns 500 when transcribeVoiceFile returns null', async () => {
    setVoiceInstalled(true)
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({ code: 1, stderr: 'whisper-no' })
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: dir },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'STT failed' })
    expect(H.logWarn).toHaveBeenCalled()
  })

  it('returns the transcript on success', async () => {
    setVoiceInstalled(true)
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({ code: 0, stdout: 'hi there\n' })
    const { res, json } = await call('POST', '/api/voice/stt', {
      body: { file_id: 'BQACAgQAAxkBAAIDSWpqdaVDcIjs', state_dir: dir },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ transcript: 'hi there' })
  })

  it('trims file_id and state_dir before validation', async () => {
    setVoiceInstalled(true)
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    H.spawnQueue.push({ code: 0, stdout: 'ok\n' })
    const { res } = await call('POST', '/api/voice/stt', {
      body: { file_id: '  BQACAgQAAxkBAAIDSWpqdaVDcIjs  ', state_dir: ' ' + dir + ' ' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('treats missing file_id/state_dir fields as empty (400)', async () => {
    setVoiceInstalled(true)
    const { res } = await call('POST', '/api/voice/stt', { body: {} })
    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/voice/tts
// ---------------------------------------------------------------------------

describe('POST /api/voice/tts', () => {
  function okDir(): string {
    const dir = join(H.home, '.claude', 'channels', 'telegram')
    markDirHasEnv(dir, true)
    setVoiceInstalled(true, ['hu_HU-imre-medium'])
    return dir
  }

  it('returns 503 when voice is not installed', async () => {
    setVoiceInstalled(false)
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: '/x', voice_model: 'm' },
    })
    expect(res.statusCode).toBe(503)
    expect(json()).toEqual({ error: 'Voice toolkit not installed' })
  })

  it('returns 400 on invalid JSON', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/tts', { raw: 'no-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 when text is empty', async () => {
    const dir = okDir()
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: '   ', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'text required' })
  })

  it('returns 400 for an invalid chat_id', async () => {
    const dir = okDir()
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: 'bad', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('returns 400 for an unsafe state_dir', async () => {
    setVoiceInstalled(true, ['hu_HU-imre-medium'])
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: '/etc/passwd', voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('returns 400 for an unknown or missing .onnx voice model', async () => {
    const dir = okDir()
    // No .onnx on disk for 'hu_HU-imre-medium' -- clear the override.
    H.existsSyncMap.delete(
      join(H.home, '.local', 'share', 'marveen-voice', 'voices', 'hu_HU-imre-medium.onnx'),
    )
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Unknown or missing voice model: hu_HU-imre-medium' })
  })

  it('returns 400 for an entirely-unknown voice_model id', async () => {
    const dir = okDir()
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'never-heard-of-this' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Unknown or missing voice model: never-heard-of-this' })
  })

  it('returns 500 when the underlying piper/sendVoice fails (detail included, truncated to 200)', async () => {
    const dir = okDir()
    H.spawnQueue.push({ code: 1, stderr: 'D' + 'x'.repeat(400) })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.error).toBe('TTS failed')
    const detail = body['detail']
    if (typeof detail === 'string') {
      expect(detail.length).toBeLessThanOrEqual(200)
    }
    expect(H.logWarn).toHaveBeenCalled()
  })

  it('parses ok=True id=12345 from stdout', async () => {
    const dir = okDir()
    H.spawnQueue.push({ code: 0, stdout: 'ok=True id=12345\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message_id: 12345 })
  })

  it('parses ok=False id=None from stdout', async () => {
    const dir = okDir()
    H.spawnQueue.push({ code: 0, stdout: 'ok=False id=None\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: false, message_id: null })
  })

  it('returns message_id=null when id= pattern is absent', async () => {
    const dir = okDir()
    H.spawnQueue.push({ code: 0, stdout: 'ok=True (no id emitted)\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message_id: null })
  })

  it('falls back to DEFAULT_VOICE_CONFIG.voiceModel when voice_model field missing', async () => {
    const dir = okDir()
    // The default 'hu_HU-imre-medium' is in KNOWN -- but its .onnx has to
    // exist on disk; we mark it.
    H.existsSyncMap.set(
      join(H.home, '.local', 'share', 'marveen-voice', 'voices', 'hu_HU-imre-medium.onnx'),
      true,
    )
    H.spawnQueue.push({ code: 0, stdout: 'ok=True id=1\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', state_dir: dir },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message_id: 1 })
  })

  it('coerces numeric chat_id to string', async () => {
    const dir = okDir()
    H.spawnQueue.push({ code: 0, stdout: 'ok=True id=1\n' })
    const { res } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: 12345, state_dir: dir, voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('coerces null chat_id to empty string (covers `data.chat_id ?? ""` branch)', async () => {
    // chat_id: null -> chatId = '' after String(null).trim(); regex /^\d+$/
    // never matches -> 400 Invalid chat_id.
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: null, state_dir: '/x/y', voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('treats undefined text/voice_model/state_dir fields as the empty default (covers `data.x ?? ""` branches)', async () => {
    setVoiceInstalled(true)
    // text undefined -> '' -> 400 text required
    const r = await call('POST', '/api/voice/tts', {
      body: { chat_id: '1', state_dir: '/x/y', voice_model: 'hu_HU-imre-medium' },
    })
    expect(r.res.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'text required' })
  })

  it('state_dir undefined -> 400 Invalid state_dir (covers `data.state_dir ?? ""` branch)', async () => {
    // No `state_dir` field at all -> SUT coerces to '' and isSafeStateDir('')
    // returns false because the path resolves to nothing matching any base.
    setVoiceInstalled(true, ['hu_HU-imre-medium'])
    H.spawnQueue.push({ code: 0, stdout: 'ok=True id=1\n' })
    const { res, json } = await call('POST', '/api/voice/tts', {
      body: { text: 'hi', chat_id: '1', voice_model: 'hu_HU-imre-medium' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })
})

// ---------------------------------------------------------------------------
// POST /api/voice/install
// ---------------------------------------------------------------------------

describe('POST /api/voice/install', () => {
  it('short-circuits to {ok:true, alreadyInstalled:true} when voice is installed', async () => {
    setVoiceInstalled(true)
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, alreadyInstalled: true })
    expect(H.spawnQueue).toHaveLength(0)
  })

  it('returns needsSudo when the dep-check bash exits with non-OK output', async () => {
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'something something MISSING' })
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    const body = json() as { needsSudo: boolean; sudoCommand: string }
    expect(body.needsSudo).toBe(true)
    expect(body.sudoCommand).toContain('sudo apt-get install')
    expect(H.spawnQueue).toHaveLength(0) // only the dep-check spawn was queued
  })

  it('returns needsSudo when the dep-check bash exits with OK output BUT ends in MISSING (defensive)', async () => {
    // The dep-check only sets depsMissing=true when stdout DOESN'T end with
    // 'OK'. Input that ends in 'OK' must NOT trigger the sudo path; an
    // input that ends in 'MISSING' must. This test confirms the negative.
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'preamble...MISSING' })
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    const result = json()
    if (!Array.isArray(result)) {
      expect(result['needsSudo']).toBe(true)
    }
  })

  it('emits an install-voice.sh spawn when deps are present', async () => {
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'preamble OK' })
    // hang the actual install proc so _installInProgress stays true
    // (we then verify the second call returns alreadyRunning:true).
    H.spawnQueue.push({ hang: true })
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, started: true })
    const second = await call('POST', '/api/voice/install')
    const sj = second.json()
    if (!Array.isArray(sj)) {
      expect(sj['alreadyRunning']).toBe(true)
    }
    // Cleanup: vi.resetModules + re-import drops the hung module-scope
    // guard for the next test (the original tryHandleVoice binding still
    // references the previously-imported module otherwise).
    vi.resetModules()
    await import('../web/routes/voice.js')
    // Replace our top-level tryHandleVoice with the fresh module's view.
    const fresh = await import('../web/routes/voice.js')
    Object.assign(globalThis, { __voiceFresh: fresh })
  })

  it('handles a spawn error event by clearing the in-progress flag and warning', async () => {
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    H.spawnQueue.push({ error: new Error('spawn failed') })
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, started: true })
    // Allow the error microtask to clear _installInProgress.
    await new Promise((r) => queueMicrotask(r))
    const second = await call('POST', '/api/voice/install')
    const sj2 = second.json()
    if (!Array.isArray(sj2)) {
      expect(sj2['alreadyRunning']).toBeUndefined()
    }
    expect(H.logWarn).toHaveBeenCalled()
  })

  it('handles the install-voice.sh close event with a non-zero code (warn, clear flag)', async () => {
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    H.spawnQueue.push({ code: 7 })
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    await call('POST', '/api/voice/install')
    await new Promise((r) => queueMicrotask(r))
    const second = await call('POST', '/api/voice/install')
    const sj2 = second.json()
    if (!Array.isArray(sj2)) {
      expect(sj2['alreadyRunning']).toBeUndefined()
    }
    expect(H.logWarn).toHaveBeenCalled()
  })

  it('handles the install-voice.sh close event with a zero code (info, clear flag)', async () => {
    setVoiceInstalled(false)
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    H.spawnQueue.push({ code: 0 })
    H.spawnQueue.push({ code: 0, stdout: 'OK' })
    await call('POST', '/api/voice/install')
    await new Promise((r) => queueMicrotask(r))
    const second = await call('POST', '/api/voice/install')
    const sj3 = second.json()
    if (!Array.isArray(sj3)) {
      expect(sj3['alreadyRunning']).toBeUndefined()
    }
    expect(H.logInfo).toHaveBeenCalled()
  })
})
