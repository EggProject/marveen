// Pinned coverage test for the readFileSync catch in ensureDefaultScheduledTasks
// (src/web/agent-scaffold.ts line ~711). The non-task-config.json branch falls
// back to copyFileSync when the read or the template substitution throws. We
// can't easily trigger that on a developer machine without root (chmod 000
// blocks both read AND copy), so we mock node:fs.readFileSync to throw on the
// SKILL.md path and let the surrounding copyFileSync still run on the real fs.
//
// Kept in its own file because the vi.mock('node:fs') is hoisted and applies
// to every test in the module -- including tests that do not need the mock.
// Putting this case alone keeps the mock scope tight and the failure surface
// obvious if the production code path changes.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'sched-tasks-catch-'))
const HOME = join(SANDBOX, 'home')
mkdirSync(HOME, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })

const SKILL_PATH = join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md')

vi.mock('../config.js', () => ({
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: join(SANDBOX, 'store'),
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'main',
  BOT_NAME: 'MainBot',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  APP_TZ: 'UTC',
  DASHBOARD_PUBLIC_URL: '',
  DEFAULT_AGENT_MODEL: 'claude-sonnet-5',
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content),
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'X', error: undefined })),
}))

vi.mock('../channel-provider.js', () => ({
  ChannelEnv: vi.fn(function ChannelEnvMock() {
    return {
      stateDirFor: () => '/dev/null',
      readTokenFor: vi.fn<() => string | null>(() => null),
      getToken: vi.fn(() => ''),
      getChatId: vi.fn(() => ''),
    }
  }),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME, tmpdir: actual.tmpdir }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: ((p: string | URL, enc?: string) => {
      if (typeof p === 'string' && p === SKILL_PATH) throw new Error('forced')
      return actual.readFileSync(p as string, enc as BufferEncoding)
    }) as typeof actual.readFileSync,
  }
})

const scaffold = await import('../web/agent-scaffold.js')

describe('ensureDefaultScheduledTasks: non-task-config catch branch', () => {
  it('falls back to copyFileSync when the readFileSync on a non-task-config file throws', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    writeFileSync(SKILL_PATH, 'normal content')

    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
    const dest = join(HOME, '.claude', 'scheduled-tasks', 'task1', 'SKILL.md')
    expect(existsSync(dest)).toBe(true)
  })
})
