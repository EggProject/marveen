// 100% coverage suite for src/web/routes/voice.ts.
//
// Every collaborator the route module touches is mocked:
//   - node:fs -- existsSync gates install/toolkit presence
//   - node:os -- homedir() pins the channel-state-dir roots to a sandbox
//   - node:child_process -- spawn is exercised by STT/TTS/install with
//     a minimal EventEmitter stub so runProc can drive 'data'/'close'
//   - ../db.js, ../config.js, ../web/channel-provider.js, ../web/telegram.js,
//     ../web/discord-group-bootstrap.js, ../logger.js (per task contract,
//     even though voice.ts only imports logger + config directly)
//   - ../web/agent-config.js (KNOWN_VOICE_MODELS, AGENTS_BASE_DIR, readAgentVoiceConfig)
//   - ../web/voice-modality.js (getLastInboundModality, setLastInboundModality)
//   - ../web/voice-directive.js (buildTtsDirective, resolveAgentChannelStateDir,
//     inboundIsAudio)
//   - ../web/http-helpers.js is REAL -- readBody/json stay genuine so the
//     JSON-path and error-path branches in the suite use the same plumbing
//     as production.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted harness: every vi.mock factory reads from this object so a test
// can re-point a collaborator without re-importing the module under test.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  // fs
  existsSync: vi.fn<(p: string) => boolean>(),
  // os
  home: '',
  // child_process.spawn
  spawn: vi.fn(),
  // config
  projectRoot: '',
  // agent-config
  agentsBaseDir: '',
  knownVoiceModels: new Set<string>(['hu_HU-imre-medium', 'hu_HU-anna-medium']),
  readAgentVoiceConfig: vi.fn(),
  // voice-modality
  getLastInboundModality: vi.fn(),
  setLastInboundModality: vi.fn(),
  // voice-directive
  buildTtsDirective: vi.fn(),
  resolveAgentChannelStateDir: vi.fn(),
  inboundIsAudio: vi.fn(),
  // logger
  logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
}))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, existsSync: (p: string) => H.existsSync(p) }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => H.home }
})

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => H.spawn(...args),
}))

vi.mock('../db.js', () => ({}))
vi.mock('../config.js', () => ({ get PROJECT_ROOT() { return H.projectRoot } }))
vi.mock('../web/channel-provider.js', () => ({}))
vi.mock('../web/telegram.js', () => ({}))
vi.mock('../web/discord-group-bootstrap.js', () => ({}))

vi.mock('../web/agent-config.js', () => ({
  get AGENTS_BASE_DIR() { return H.agentsBaseDir },
  get KNOWN_VOICE_MODELS() { return H.knownVoiceModels },
  readAgentVoiceConfig: (name: string) => H.readAgentVoiceConfig(name),
}))

vi.mock('../web/voice-modality.js', () => ({
  getLastInboundModality: (agent: string, chat: string) => H.getLastInboundModality(agent, chat),
  setLastInboundModality: (agent: string, chat: string, mod: string) => H.setLastInboundModality(agent, chat, mod),
}))

vi.mock('../web/voice-directive.js', () => ({
  buildTtsDirective: (opts: { chatId: string; stateDir: string; voiceModel: string }) => H.buildTtsDirective(opts),
  resolveAgentChannelStateDir: (agent: string, provider: string) => H.resolveAgentChannelStateDir(agent, provider),
  inboundIsAudio: (kind: string | null | undefined, fileId: string | null | undefined) => H.inboundIsAudio(kind, fileId),
}))

vi.mock('../logger.js', () => {
  const push = (level: string) => (obj: unknown, msg?: unknown) => {
    H.logs.push({ level, obj, msg })
  }
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') } }
})

// Imported AFTER every mock is registered.
const { tryHandleVoice, transcribeVoiceFile } = await import('../web/routes/voice.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------
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
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(opts: { body?: unknown } = {}): http.IncomingMessage {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

function mkCtx(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string } = {},
): { ctx: RouteContext; res: MockRes } {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}${opts.query ? `?${opts.query}` : ''}`)
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url,
  }
  return { ctx, res }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string } = {},
): Promise<{ res: MockRes; ctx: RouteContext; handled: boolean; json: () => Record<string, unknown> }> {
  const { ctx, res } = mkCtx(method, path, opts)
  const handled = await tryHandleVoice(ctx)
  return { res, ctx, handled, json: () => JSON.parse(res.body || '{}') }
}

// ---------------------------------------------------------------------------
// Fake child_process.spawn -- runProc registers `proc.on('close', ...)` and
// `proc.stdout.on('data', ...)` on the returned child. We build one combined
// EventEmitter and attach .stdout/.stderr/.stdin/.kill onto it so a single
// `proc` object satisfies every accessor runProc touches.
// ---------------------------------------------------------------------------
interface FakeChild extends EventEmitter {
  stdin: { write: (data: string, enc: string) => void; end: () => void }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig: string) => void
}

function makeFakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.kill = vi.fn()
  return proc
}

function nextSpawn(): { fake: FakeChild; finish: (code: number | null, stdout?: string, stderr?: string) => void } {
  const fake = makeFakeChild()
  H.spawn.mockReturnValueOnce(fake)
  // runProc closes the promise when 'close' fires.
  const finish = (code: number | null, stdout = '', stderr = ''): void => {
    if (stdout) fake.stdout.emit('data', Buffer.from(stdout))
    if (stderr) fake.stderr.emit('data', Buffer.from(stderr))
    fake.emit('close', code)
  }
  return { fake, finish }
}

// ---------------------------------------------------------------------------
// Per-test sandbox under tmpdir() so the live-install guard stays satisfied.
// ---------------------------------------------------------------------------
let SANDBOX = ''
function freshSandbox(): void {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true })
  SANDBOX = mkdtempSync(join(tmpdir(), 'routes-voice-'))
}

// Common safe state_dir paths used in the suite -- isSafeStateDir() only
// accepts dirs under CHANNELS_BASE (homedir()/.claude/channels) or
// AGENTS_BASE_DIR/<name>/.claude/channels/<provider>.
function safeChannelsDir(): string {
  return join(H.home, '.claude', 'channels', 'telegram')
}

function safeAgentChannelDir(name = 'samu'): string {
  return join(H.agentsBaseDir, name, '.claude', 'channels', 'telegram')
}

function onnxPath(model: string): string {
  return join(H.home, '.local', 'share', 'marveen-voice', 'voices', `${model}.onnx`)
}

function venvPy(): string {
  return join(H.home, '.local', 'share', 'marveen-voice', 'venv', 'bin', 'python')
}
function vtoolsPy(): string {
  return join(H.home, '.local', 'share', 'marveen-voice', '_vtools.py')
}

beforeEach(() => {
  vi.clearAllMocks()
  H.logs.length = 0
  freshSandbox()
  H.home = join(SANDBOX, 'home')
  H.projectRoot = join(SANDBOX, 'project')
  H.agentsBaseDir = join(H.projectRoot, 'agents')
  H.existsSync.mockReturnValue(false)
  H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto', voiceModel: 'hu_HU-imre-medium' })
  H.resolveAgentChannelStateDir.mockReturnValue(safeChannelsDir())
  H.inboundIsAudio.mockReturnValue(true)
  H.buildTtsDirective.mockReturnValue('DIRECTIVE')
  H.getLastInboundModality.mockReturnValue(null)
  H.setLastInboundModality.mockReturnValue(undefined)
  H.knownVoiceModels = new Set(['hu_HU-imre-medium', 'hu_HU-anna-medium'])
})

// ---------------------------------------------------------------------------
// Dispatcher: returns false for paths it does not own
// ---------------------------------------------------------------------------
describe('tryHandleVoice dispatcher', () => {
  it('returns false for a path it does not handle', async () => {
    const { handled } = await call('GET', '/api/agents')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /api/voice/directive
// ---------------------------------------------------------------------------
describe('GET /api/voice/directive', () => {
  it('400 on missing agent id', async () => {
    const { res, json, handled } = await call('GET', '/api/voice/directive', { query: 'chat=123' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent' })
  })

  it('400 on invalid agent id', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=bad!id&chat=123' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent' })
  })

  it('400 on missing chat id', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('400 on non-numeric chat id', async () => {
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=abc' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('returns {directive:null, transcript:null} when responseMode is text (no STT)', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'text', voiceModel: 'hu_HU-imre-medium' })
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=voice' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    expect(H.spawn).not.toHaveBeenCalled()
    expect(H.buildTtsDirective).not.toHaveBeenCalled()
  })

  it('returns directive in voice mode even when there is no inbound audio', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' })
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42' })
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.directive).toBe('DIRECTIVE')
    expect(body.transcript).toBeNull()
    expect(H.buildTtsDirective).toHaveBeenCalled()
  })

  it('in auto mode skips the directive when inbound was NOT audio', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto', voiceModel: 'hu_HU-imre-medium' })
    H.inboundIsAudio.mockReturnValue(false)
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=document' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    expect(H.buildTtsDirective).not.toHaveBeenCalled()
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('in auto mode skips when file is present but fails SAFE_FILE_ID_RE', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto', voiceModel: 'hu_HU-imre-medium' })
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=tooshort&kind=voice' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ directive: null, transcript: null })
    expect(H.buildTtsDirective).not.toHaveBeenCalled()
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('uses the default voice model when voiceCfg.voiceModel is undefined', async () => {
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: undefined as unknown as string })
    const { json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42' })
    expect(json().directive).toBe('DIRECTIVE')
    expect(H.buildTtsDirective).toHaveBeenCalledWith(expect.objectContaining({ voiceModel: 'hu_HU-imre-medium' }))
  })

  it('returns directive + transcript when STT succeeds (auto, audio inbound)', async () => {
    H.existsSync.mockImplementation(() => true) // isVoiceInstalled()
    const { finish } = nextSpawn()
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=voice' })
    finish(0, '  transcript text  \n')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.directive).toBe('DIRECTIVE')
    expect(body.transcript).toBe('transcript text')
  })

  it('logs a warning and returns transcript=null when STT exits non-zero', async () => {
    H.existsSync.mockImplementation(() => true)
    const { finish } = nextSpawn()
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=voice' })
    finish(1, '', 'whisper oops')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.transcript).toBeNull()
    expect(body.directive).toBe('DIRECTIVE')
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('STT failed'))).toBe(true)
  })

  it('returns transcript=null when STT stdout is empty (whitespace)', async () => {
    H.existsSync.mockImplementation(() => true)
    const { finish } = nextSpawn()
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=voice' })
    finish(0, '   \n')
    await Promise.resolve()
    const body = json()
    expect(body.transcript).toBeNull()
    expect(body.directive).toBe('DIRECTIVE')
  })

  it('skips STT when voice toolkit is not installed (transcript=null, directive still set in voice mode)', async () => {
    H.existsSync.mockReturnValue(false)
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' })
    const { res, json } = await call('GET', '/api/voice/directive', { query: 'agent=marveen&chat=42&file=ABCDEFGHIJKLMNOPQRSTUV&kind=voice' })
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.directive).toBe('DIRECTIVE')
    expect(body.transcript).toBeNull()
    expect(H.spawn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /api/voice/modality
// ---------------------------------------------------------------------------
describe('GET /api/voice/modality', () => {
  it('400 when agent is missing', async () => {
    const { res, json } = await call('GET', '/api/voice/modality', { query: 'chat=42' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent and chat required' })
  })

  it('400 when chat is missing', async () => {
    const { res, json } = await call('GET', '/api/voice/modality', { query: 'agent=marveen' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent and chat required' })
  })

  it('returns the stored modality', async () => {
    H.getLastInboundModality.mockReturnValue('voice')
    const { json } = await call('GET', '/api/voice/modality', { query: 'agent=marveen&chat=42' })
    expect(json()).toEqual({ modality: 'voice' })
    expect(H.getLastInboundModality).toHaveBeenCalledWith('marveen', '42')
  })

  it('returns null when no modality has been recorded', async () => {
    H.getLastInboundModality.mockReturnValue(null)
    const { json } = await call('GET', '/api/voice/modality', { query: 'agent=marveen&chat=42' })
    expect(json()).toEqual({ modality: null })
  })
})

// ---------------------------------------------------------------------------
// /api/voice/modality/set
// ---------------------------------------------------------------------------
describe('POST /api/voice/modality/set', () => {
  it('400 on invalid JSON', async () => {
    // Stream a literal non-JSON body to bypass JSON.stringify helper.
    const req = Readable.from([Buffer.from('not-json')]) as unknown as http.IncomingMessage
    ;(req as unknown as Record<string, unknown>).headers = {}
    const res = mkRes()
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/voice/modality/set',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/voice/modality/set'),
    }
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' })
  })

  it('400 on missing agent_id', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { chat_id: '42', modality: 'voice' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent_id' })
  })

  it('400 on invalid agent_id characters', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'bad id', chat_id: '42', modality: 'voice' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent_id' })
  })

  it('400 on missing chat_id', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'marveen', modality: 'voice' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('400 on non-numeric chat_id', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'marveen', chat_id: 'abc', modality: 'voice' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('400 on invalid modality value', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'marveen', chat_id: '42', modality: 'image' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'modality must be voice or text' })
  })

  it('accepts modality=voice and stores it', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'marveen', chat_id: '42', modality: 'voice' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '42', 'voice')
  })

  it('accepts modality=text and stores it', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: { agent_id: 'marveen', chat_id: '42', modality: 'text' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '42', 'text')
  })

  it('trims whitespace from each string field', async () => {
    const { res } = await call('POST', '/api/voice/modality/set', { body: { agent_id: '  marveen  ', chat_id: '  42  ', modality: '  voice  ' } })
    expect(res.statusCode).toBe(200)
    expect(H.setLastInboundModality).toHaveBeenCalledWith('marveen', '42', 'voice')
  })

  it('treats absent fields as empty strings (empty agent_id)', async () => {
    const { res, json } = await call('POST', '/api/voice/modality/set', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent_id' })
  })
})

// ---------------------------------------------------------------------------
// /api/voice/status
// ---------------------------------------------------------------------------
describe('GET /api/voice/status', () => {
  it('reports installed=false and an empty voice list when the toolkit is missing', async () => {
    H.existsSync.mockReturnValue(false)
    const { res, json } = await call('GET', '/api/voice/status')
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.installed).toBe(false)
    expect(body.voices).toEqual([])
    expect(typeof body.voiceDir).toBe('string')
  })

  it('reports installed=true and only the onnx models that exist on disk', async () => {
    // isVoiceInstalled() => existsSync(VENV_PY) && existsSync(VTOOLS_PY)
    H.existsSync.mockImplementation((p: string) => p === venvPy() || p === vtoolsPy())
    const { res, json } = await call('GET', '/api/voice/status')
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.installed).toBe(true)
    expect(body.voices).toEqual([])
  })

  it('lists the bundled voices whose .onnx files exist', async () => {
    // Only the imre model is on disk; the anna model is not.
    const existing = new Set<string>([venvPy(), vtoolsPy(), onnxPath('hu_HU-imre-medium')])
    H.existsSync.mockImplementation((p: string) => existing.has(p))
    const { json } = await call('GET', '/api/voice/status')
    const body = json()
    expect(body.installed).toBe(true)
    expect(body.voices).toEqual(['hu_HU-imre-medium'])
  })
})

// ---------------------------------------------------------------------------
// /api/voice/stt
// ---------------------------------------------------------------------------
describe('POST /api/voice/stt', () => {
  it('503 when the voice toolkit is not installed', async () => {
    H.existsSync.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(503)
    expect(json()).toEqual({ error: 'Voice toolkit not installed' })
  })

  it('400 on invalid JSON', async () => {
    H.existsSync.mockReturnValue(true) // toolkit present, so we reach JSON parse
    const req = Readable.from([Buffer.from('oops{')]) as unknown as http.IncomingMessage
    ;(req as unknown as Record<string, unknown>).headers = {}
    const res = mkRes()
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/voice/stt',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/voice/stt'),
    }
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' })
  })

  it('400 on unsafe file_id', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'short', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid file_id' })
  })

  it('400 on unsafe state_dir (contains ".."', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: `${H.home}/.claude/channels/../escape` } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('transcribes successfully when whisper exits 0', async () => {
    H.existsSync.mockReturnValue(true)
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: safeChannelsDir() } })
    finish(0, '  hello world  \n')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ transcript: 'hello world' })
    expect(H.spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['transcribe', 'ABCDEFGHIJKLMNOPQRSTUV', safeChannelsDir()]), { shell: false })
  })

  it('returns 500 + warn when transcribeVoiceFile returns null (whisper failed)', async () => {
    H.existsSync.mockReturnValue(true)
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: safeChannelsDir() } })
    finish(1, '', 'whisper oops')
    await Promise.resolve()
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'STT failed' })
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('/api/voice/stt'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// /api/voice/tts
// ---------------------------------------------------------------------------
describe('POST /api/voice/tts', () => {
  it('503 when the voice toolkit is not installed', async () => {
    H.existsSync.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(503)
    expect(json()).toEqual({ error: 'Voice toolkit not installed' })
  })

  it('400 on invalid JSON', async () => {
    H.existsSync.mockReturnValue(true)
    const req = Readable.from([Buffer.from('not-json')]) as unknown as http.IncomingMessage
    ;(req as unknown as Record<string, unknown>).headers = {}
    const res = mkRes()
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/voice/tts',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/voice/tts'),
    }
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' })
  })

  it('400 when text is empty', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: '   ', chat_id: '42', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'text required' })
  })

  it('400 on non-numeric chat_id', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: 'abc', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid chat_id' })
  })

  it('400 on unsafe state_dir', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: `${H.home}/.claude/channels/../escape` } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('400 when voice_model is not in KNOWN_VOICE_MODELS', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', voice_model: 'unknown', chat_id: '42', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Unknown or missing voice model: unknown' })
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('400 when onnx file does not exist on disk (model known but missing)', async () => {
    H.existsSync.mockReturnValue(true) // every other check passes
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', voice_model: 'hu_HU-anna-medium', chat_id: '42', state_dir: safeChannelsDir() } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Unknown or missing voice model: hu_HU-anna-medium' })
  })

  it('defaults the voice_model to hu_HU-imre-medium when missing', async () => {
    H.existsSync.mockImplementation((p: string) => p === onnxPath('hu_HU-imre-medium'))
    const { finish } = nextSpawn()
    const { json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: safeChannelsDir() } })
    finish(0, 'ok=True id=12345')
    await Promise.resolve()
    expect(json()).toEqual({ ok: true, message_id: 12345 })
    expect(H.spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([onnxPath('hu_HU-imre-medium'), safeChannelsDir(), '42', 'hi']), { shell: false })
  })

  it('coerces numeric chat_id to string before checking', async () => {
    H.existsSync.mockImplementation((p: string) => p === onnxPath('hu_HU-imre-medium'))
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: 42, state_dir: safeChannelsDir() } })
    finish(0, 'ok=True id=7')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message_id: 7 })
  })

  it('returns 500 + warn when the piper/sendVoice subprocess fails', async () => {
    H.existsSync.mockImplementation((p: string) => p === onnxPath('hu_HU-imre-medium'))
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: safeChannelsDir() } })
    finish(1, '', 'piper error')
    await Promise.resolve()
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'TTS failed', detail: 'piper error' })
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('piper/sendVoice'))).toBe(true)
  })

  it('decodes ok=False and message_id=null from the subprocess stdout', async () => {
    H.existsSync.mockImplementation((p: string) => p === onnxPath('hu_HU-imre-medium'))
    const { finish } = nextSpawn()
    const { json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: safeChannelsDir() } })
    finish(0, 'ok=False id=None')
    await Promise.resolve()
    expect(json()).toEqual({ ok: false, message_id: null })
  })

  it('defaults message_id=null when stdout has no id= token', async () => {
    H.existsSync.mockImplementation((p: string) => p === onnxPath('hu_HU-imre-medium'))
    const { finish } = nextSpawn()
    const { json } = await call('POST', '/api/voice/tts', { body: { text: 'hi', chat_id: '42', state_dir: safeChannelsDir() } })
    finish(0, 'something else entirely')
    await Promise.resolve()
    expect(json()).toEqual({ ok: false, message_id: null })
  })
})

// ---------------------------------------------------------------------------
// /api/voice/install
// ---------------------------------------------------------------------------
describe('POST /api/voice/install', () => {
  it('returns alreadyInstalled when the toolkit is already installed', async () => {
    H.existsSync.mockImplementation((p: string) => p === venvPy() || p === vtoolsPy())
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, alreadyInstalled: true })
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('returns needsSudo + sudoCommand when the system dep probe reports MISSING', async () => {
    // Toolkit missing => existsSync false everywhere; the dep probe spawn will
    // return a non-OK body.
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/install')
    finish(0, 'something\nMISSING')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ needsSudo: true })
    expect((json() as { sudoCommand: string }).sudoCommand).toContain('sudo apt-get install')
  })

  it('returns alreadyRunning when _installInProgress is already set', async () => {
    installSinks.length = 0
    // First install: deps present, fires spawn detached.
    H.spawn.mockImplementationOnce(() => makeFakeChild()) // dep probe
      .mockImplementationOnce(() => {
        const fake = makeFakeChild()
        installSinks.push((code) => fake.emit('close', code))
        return fake
      })
    const first = call('POST', '/api/voice/install')
    // Resolve the dep probe by emitting 'close' on its child
    H.spawn.mock.results[0].value.emit('close', 0)
    // Emit OK stdout before close
    H.spawn.mock.results[0].value.stdout.emit('data', Buffer.from('OK\n'))
    await first
    // Toolkit still not installed (the install-voice.sh script would do that
    // in real life; here we don't fire it), but _installInProgress is set.
    // Second call must hit the alreadyRunning branch.
    const { res, json } = await call('POST', '/api/voice/install')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, started: true, alreadyRunning: true })
    // Clean up: flip _installInProgress back to false by emitting 'close' on
    // the detached child.
    installSinks.forEach((fn) => fn(0))
    installSinks.length = 0
  })

  it('fires a detached install-voice.sh spawn when deps are present (deps probe OK)', async () => {
    installSinks.length = 0
    H.spawn.mockImplementationOnce(() => makeFakeChild()) // dep probe
      .mockImplementationOnce(() => {
        const fake = makeFakeChild()
        installSinks.push((code) => fake.emit('close', code))
        return fake
      })
    const callPromise = call('POST', '/api/voice/install')
    // Drive the dep probe to OK
    const probe = H.spawn.mock.results[0].value
    probe.stdout.emit('data', Buffer.from('OK\n'))
    probe.emit('close', 0)
    await Promise.resolve()
    await callPromise
    expect(H.spawn).toHaveBeenCalledTimes(2)
    // The detached spawn used bash + install-voice.sh with detached + SKIP_SYSTEM_DEPS
    const detachedCall = H.spawn.mock.calls[1]
    expect(detachedCall[0]).toBe('bash')
    expect(detachedCall[1]).toEqual([join(H.projectRoot, 'scripts', 'install-voice.sh')])
    expect(detachedCall[2]).toMatchObject({ detached: true, shell: false, stdio: 'ignore' })
    expect(detachedCall[2].env.SKIP_SYSTEM_DEPS).toBe('1')
    // Bring _installInProgress back to false so other tests start clean.
    installSinks.forEach((fn) => fn(0))
    installSinks.length = 0
  })

  it('emits a warn log when the install-voice.sh child errors', async () => {
    installSinks.length = 0
    installErrSinks.length = 0
    H.spawn.mockImplementationOnce(() => makeFakeChild()) // dep probe
      .mockImplementationOnce(() => {
        const fake = makeFakeChild()
        installSinks.push((code) => fake.emit('close', code))
        installErrSinks.push((err) => fake.emit('error', err))
        return fake
      })
    const callPromise = call('POST', '/api/voice/install')
    const probe = H.spawn.mock.results[0].value
    probe.stdout.emit('data', Buffer.from('OK\n'))
    probe.emit('close', 0)
    await Promise.resolve()
    await callPromise
    // Emit an error on the detached child -- it should flip _installInProgress
    // back to false and log a warn.
    installErrSinks.forEach((fn) => fn(new Error('spawn failed')))
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('/api/voice/install: spawn error'))).toBe(true)
    installSinks.length = 0
    installErrSinks.length = 0
  })

  it('logs info when the install-voice.sh child exits zero and warn on non-zero', async () => {
    installSinks.length = 0
    H.spawn.mockImplementationOnce(() => makeFakeChild())
      .mockImplementationOnce(() => {
        const fake = makeFakeChild()
        installSinks.push((code) => fake.emit('close', code))
        return fake
      })
    const callPromise = call('POST', '/api/voice/install')
    const probe = H.spawn.mock.results[0].value
    probe.stdout.emit('data', Buffer.from('OK\n'))
    probe.emit('close', 0)
    await Promise.resolve()
    await callPromise
    installSinks.forEach((fn) => fn(0))
    await Promise.resolve()
    expect(H.logs.some((l) => l.level === 'info' && String(l.msg).includes('install-voice.sh completed successfully'))).toBe(true)
    // Now flip the flag again and trigger a non-zero close.
    installSinks.length = 0
    H.spawn.mockImplementationOnce(() => makeFakeChild()) // new dep probe
      .mockImplementationOnce(() => {
        const fake = makeFakeChild()
        installSinks.push((code) => fake.emit('close', code))
        return fake
      })
    const callPromise2 = call('POST', '/api/voice/install')
    const probe2 = H.spawn.mock.results[H.spawn.mock.results.length - 2].value
    probe2.stdout.emit('data', Buffer.from('OK\n'))
    probe2.emit('close', 0)
    await Promise.resolve()
    await callPromise2
    installSinks.forEach((fn) => fn(2))
    await Promise.resolve()
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('install-voice.sh exited non-zero'))).toBe(true)
    installSinks.length = 0
  })
})

// Per-test sinks to manually fire close/error on the detached install child
// across test boundaries (the install-voice.sh spawn is detached so it never
// fires on its own).
const installSinks: Array<(code: number | null) => void> = []
const installErrSinks: Array<(err: Error) => void> = []

// ---------------------------------------------------------------------------
// transcribeVoiceFile (exported, called by the /api/voice/stt route and the
// router tick -- the router must never self-HTTP per the comment in voice.ts).
// ---------------------------------------------------------------------------
describe('transcribeVoiceFile (exported helper)', () => {
  it('returns null when the voice toolkit is not installed', async () => {
    H.existsSync.mockReturnValue(false)
    const out = await transcribeVoiceFile('ABCDEFGHIJKLMNOPQRSTUV', safeChannelsDir())
    expect(out).toBeNull()
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('returns null when the file_id fails the SAFE_FILE_ID_RE guard', async () => {
    H.existsSync.mockReturnValue(true)
    const out = await transcribeVoiceFile('short', safeChannelsDir())
    expect(out).toBeNull()
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('returns null when the state_dir fails isSafeStateDir', async () => {
    H.existsSync.mockReturnValue(true)
    const out = await transcribeVoiceFile('ABCDEFGHIJKLMNOPQRSTUV', `${H.home}/.claude/channels/../escape`)
    expect(out).toBeNull()
    expect(H.spawn).not.toHaveBeenCalled()
  })

  it('returns the trimmed transcript on whisper exit 0', async () => {
    H.existsSync.mockReturnValue(true)
    const { finish } = nextSpawn()
    const p = transcribeVoiceFile('ABCDEFGHIJKLMNOPQRSTUV', safeChannelsDir())
    finish(0, '  hello there  \n')
    const out = await p
    expect(out).toBe('hello there')
  })

  it('returns null on whisper exit non-zero and emits a warn log', async () => {
    H.existsSync.mockReturnValue(true)
    const { finish } = nextSpawn()
    const p = transcribeVoiceFile('ABCDEFGHIJKLMNOPQRSTUV', safeChannelsDir())
    finish(1, '', 'whisper error message longer than 200 chars would be truncated, but here we just take 200 chars')
    const out = await p
    expect(out).toBeNull()
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('transcribeVoiceFile: whisper failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isSafeStateDir (internal helper exercised via state-dir validation)
// ---------------------------------------------------------------------------
describe('isSafeStateDir (internal) -- exercised via state_dir validation', () => {
  it('rejects a state_dir containing ".." (defence in depth)', async () => {
    H.existsSync.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: `${H.home}/.claude/channels/../escape` } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('rejects a state_dir with no .env file present', async () => {
    H.existsSync.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: '/tmp/some-random-dir' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('accepts a CHANNELS_BASE-rooted dir with .env present', async () => {
    H.existsSync.mockImplementation((p: string) => p.endsWith('/.env'))
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: safeChannelsDir() } })
    finish(0, 'ok\n')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ transcript: 'ok' })
  })

  it('accepts an AGENTS_BASE_DIR-rooted dir matching <name>/.claude/channels/<provider>', async () => {
    H.existsSync.mockImplementation((p: string) => p.endsWith('/.env'))
    const { finish } = nextSpawn()
    const stateDir = safeAgentChannelDir('samu')
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: stateDir } })
    finish(0, 'ok\n')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ transcript: 'ok' })
  })

  it('rejects an AGENTS_BASE_DIR-rooted dir with an unsafe nested path', async () => {
    H.existsSync.mockImplementation((p: string) => p.endsWith('/.env'))
    const stateDir = join(H.agentsBaseDir, 'samu', 'evil')
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: stateDir } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('rejects an AGENTS_BASE_DIR-rooted dir whose agent name segment has a forbidden char', async () => {
    H.existsSync.mockImplementation((p: string) => p.endsWith('/.env'))
    const stateDir = join(H.agentsBaseDir, 'bad name', '.claude', 'channels', 'telegram')
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: stateDir } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid state_dir' })
  })

  it('strips a trailing slash before validating', async () => {
    H.existsSync.mockImplementation((p: string) => p.endsWith('/.env'))
    const { finish } = nextSpawn()
    const { res, json } = await call('POST', '/api/voice/stt', { body: { file_id: 'ABCDEFGHIJKLMNOPQRSTUV', state_dir: `${safeChannelsDir()}/` } })
    finish(0, 'ok\n')
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ transcript: 'ok' })
  })
})