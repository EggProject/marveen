// voice-directive.ts coverage suite.
//
// The module under test reads three pieces of ambient state at CALL time:
//   - STORE_DIR / WEB_PORT (src/config.ts)  -- derived from the repo root, so
//     they are not redirectable via CLAUDECLAW_ENV_DIR; mocked with live
//     getters instead (notify.test.ts pattern).
//   - AGENTS_BASE_DIR (src/web/agent-config.ts) -- same reason.
//   - homedir() (node:os) -- mocked so the `~/.claude/channels/**` candidates
//     resolve inside an os.tmpdir() sandbox.
// Every filesystem path used here lives under os.tmpdir() via the
// setup/temp-sandbox.ts helpers, so the live-install gate stays satisfied.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

const state = vi.hoisted(() => ({
  storeDir: '',
  webPort: 3420,
  agentsBaseDir: '',
  home: '',
}))

vi.mock('../config.js', () => ({
  get STORE_DIR(): string {
    return state.storeDir
  },
  get WEB_PORT(): number {
    return state.webPort
  },
}))

vi.mock('../web/agent-config.js', () => ({
  get AGENTS_BASE_DIR(): string {
    return state.agentsBaseDir
  },
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: (): string => state.home }
})

import {
  resolveAgentChannelStateDir,
  inboundIsAudio,
  buildTtsDirective,
} from '../web/voice-directive.js'

// Every temp dir created by a test, cleaned up in afterEach.
let tempDirs: string[] = []

function track(dir: string): string {
  tempDirs.push(dir)
  return dir
}

/** Create `<dir>/.env` (and its parents) so the resolver's existsSync hits. */
function writeChannelEnv(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), 'BOT_TOKEN=x\n', 'utf-8')
}

beforeEach(() => {
  state.storeDir = track(mkTempStore('marveen-voice-store-'))
  state.agentsBaseDir = join(track(mkTempDir('marveen-voice-agents-')), 'agents')
  state.home = track(mkTempDir('marveen-voice-home-'))
  state.webPort = 3420
})

afterEach(() => {
  for (const dir of tempDirs) rmTempDir(dir)
  tempDirs = []
})

describe('resolveAgentChannelStateDir', () => {
  it('prefers the sub-agent own channel dir under AGENTS_BASE_DIR', () => {
    const own = join(state.agentsBaseDir, 'scout', '.claude', 'channels', 'telegram')
    writeChannelEnv(own)
    // Both lower-priority candidates also exist -- the first must still win.
    writeChannelEnv(join(state.home, '.claude', 'channels', 'telegram-scout'))
    writeChannelEnv(join(state.home, '.claude', 'channels', 'telegram'))

    expect(resolveAgentChannelStateDir('scout', 'telegram')).toBe(own)
  })

  it('falls back to the ~/.claude/channels/<provider>-<agentId> naming', () => {
    const perAgent = join(state.home, '.claude', 'channels', 'telegram-scout')
    writeChannelEnv(perAgent)
    writeChannelEnv(join(state.home, '.claude', 'channels', 'telegram'))

    expect(resolveAgentChannelStateDir('scout', 'telegram')).toBe(perAgent)
  })

  it('falls back to the global ~/.claude/channels/<provider> dir', () => {
    const global = join(state.home, '.claude', 'channels', 'telegram')
    writeChannelEnv(global)

    expect(resolveAgentChannelStateDir('scout', 'telegram')).toBe(global)
  })

  it('returns the global candidate even when no candidate has a .env', () => {
    // Directory exists but carries no .env -- still not a match.
    mkdirSync(join(state.home, '.claude', 'channels', 'telegram'), { recursive: true })

    expect(resolveAgentChannelStateDir('scout', 'telegram')).toBe(
      join(state.home, '.claude', 'channels', 'telegram'),
    )
  })

  it('keeps the provider out of the agent-scoped path segment order', () => {
    const own = join(state.agentsBaseDir, 'ghost', '.claude', 'channels', 'slack')
    writeChannelEnv(own)

    expect(resolveAgentChannelStateDir('ghost', 'slack')).toBe(own)
  })
})

describe('inboundIsAudio', () => {
  it('returns false when there is no attachment file id', () => {
    expect(inboundIsAudio('voice', null)).toBe(false)
    expect(inboundIsAudio('voice', undefined)).toBe(false)
    expect(inboundIsAudio('voice', '')).toBe(false)
  })

  it.each(['voice', 'audio', 'video_note'])('recognises the %s attachment kind', (kind) => {
    expect(inboundIsAudio(kind, 'file-1')).toBe(true)
  })

  it('normalises case and surrounding whitespace', () => {
    expect(inboundIsAudio('  VOICE  ', 'file-1')).toBe(true)
    expect(inboundIsAudio('Video_Note', 'file-1')).toBe(true)
  })

  it('treats non-audio attachment kinds as text (2026-07-29 PDF regression)', () => {
    expect(inboundIsAudio('document', 'file-1')).toBe(false)
    expect(inboundIsAudio('photo', 'file-1')).toBe(false)
    expect(inboundIsAudio('sticker', 'file-1')).toBe(false)
  })

  it('treats an absent kind as not audio', () => {
    expect(inboundIsAudio(null, 'file-1')).toBe(false)
    expect(inboundIsAudio(undefined, 'file-1')).toBe(false)
    expect(inboundIsAudio('', 'file-1')).toBe(false)
  })
})

describe('buildTtsDirective', () => {
  function writeToken(value: string): void {
    writeFileSync(join(state.storeDir, '.dashboard-token'), value, 'utf-8')
  }

  it('returns null when the dashboard token file does not exist', () => {
    expect(
      buildTtsDirective({ chatId: '123', stateDir: '/tmp/state', voiceModel: 'tts-1' }),
    ).toBeNull()
  })

  it('returns null when the token path cannot be read', () => {
    // A directory at the token path: existsSync passes, readFileSync throws
    // EISDIR -> the catch arm must swallow it.
    mkdirSync(join(state.storeDir, '.dashboard-token'), { recursive: true })

    expect(
      buildTtsDirective({ chatId: '123', stateDir: '/tmp/state', voiceModel: 'tts-1' }),
    ).toBeNull()
  })

  it('builds a curl block carrying the trimmed token, chat id, state dir and model', () => {
    writeToken('  secret-token\n')
    state.webPort = 4711

    const out = buildTtsDirective({
      chatId: 'chat-42',
      stateDir: '/tmp/channels/telegram',
      voiceModel: 'gpt-4o-mini-tts',
    })

    expect(out).not.toBeNull()
    const directive = out ?? ''
    expect(directive).toContain('[Hang válasz direktíva]')
    expect(directive).toContain(
      `jq -n --arg t "A_VÁLASZOD_SZÖVEGE" '{"text":$t,"chat_id":"chat-42","state_dir":"/tmp/channels/telegram","voice_model":"gpt-4o-mini-tts"}'`,
    )
    expect(directive).toContain('curl -s -X POST http://localhost:4711/api/voice/tts')
    expect(directive).toContain('-H "Authorization: Bearer secret-token"')
    expect(directive).toContain('Szöveges választ NE küldj')
    expect(directive.startsWith('\n\n')).toBe(true)
  })

  it('shell-escapes single quotes in the state dir', () => {
    writeToken('tok')

    const directive =
      buildTtsDirective({
        chatId: 'c1',
        stateDir: "/tmp/o'brien/channels",
        voiceModel: 'tts-1',
      }) ?? ''

    expect(directive).toContain(`"state_dir":"/tmp/o'\\''brien/channels"`)
    expect(directive).not.toContain(`"state_dir":"/tmp/o'brien/channels"`)
  })

  // PINNED DEFECT -- docs/needs-to-be-fix/voice-directive-json-quote-escape.md
  // The escape covers the shell layer only; a double quote (legal in a POSIX
  // path, so reachable via homedir()) passes through raw and breaks the JSON
  // literal that jq has to parse. Asserting the current output so the fix
  // flips this test.
  it('leaves a double quote in the state dir unescaped, emitting invalid JSON', () => {
    writeToken('tok')

    const directive =
      buildTtsDirective({
        chatId: 'c1',
        stateDir: '/tmp/a"b/channels',
        voiceModel: 'tts-1',
      }) ?? ''

    expect(directive).toContain(`"state_dir":"/tmp/a"b/channels"`)
  })
})
