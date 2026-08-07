// Targeted coverage for src/web/agent-worker.ts: ensureWorkerCwd's
// symlinkSync catch (lines 369-370).
//
// The main agent-worker-full.test.ts uses the real `node:fs` because every
// other test in the suite needs real mkdirSync/writeFileSync/etc. This
// smaller file isolates the single branch that requires `symlinkSync` to
// throw -- achievable only by mocking `node:fs` at the top level so the
// production code's destructured import of `symlinkSync` is replaced by
// the proxy.
//
// See docs/needs-to-be-fix/agent-worker-symlink-catch.md for the production-
// context trigger (TOCTOU race with another writer between the rmSync
// that precedes the call and the symlinkSync itself).

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const H = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  const root = `${tmpRoot}/marveen-agentworker-sym-${process.pid}-${Math.random().toString(36).slice(2)}`
  return {
    root,
    home: `${root}/home`,
    projectRoot: `${root}/project`,
    storeDir: `${root}/store`,
    fleetOAuthTokenPath: `${root}/store/.claude-oauth-token`,
    mainAgentId: 'marveen',
    defaultAgentModel: 'claude-opus-4-8',
    resolveFromPath: vi.fn(),
    tryResolveFromPath: vi.fn(),
    logs: [] as string[],
    realFs: null as typeof import('node:fs') | null,
    symlinkCalls: 0,
  }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => H.home, userInfo: () => ({ username: 'test' }) }
})

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

// Proxy mock: the FIRST symlinkSync call throws; the rest pass through to
// the real implementation. This is the only way to intercept the
// destructured `import { ... symlinkSync ... } from 'node:fs'` the source
// captured at module load.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  H.realFs = actual
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'symlinkSync') {
        return (t: string, l: string) => {
          H.symlinkCalls++
          if (H.symlinkCalls === 1) throw new Error('synthetic symlink failure')
          return target.symlinkSync(t, l)
        }
      }
      return Reflect.get(target, prop)
    },
  }) as typeof import('node:fs')
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    get PROJECT_ROOT() { return H.projectRoot },
    get MAIN_AGENT_ID() { return H.mainAgentId },
    get DEFAULT_AGENT_MODEL() { return H.defaultAgentModel },
    get STORE_DIR() { return H.storeDir },
  }
})

vi.mock('../platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform.js')>()
  return { ...actual, resolveFromPath: H.resolveFromPath, tryResolveFromPath: H.tryResolveFromPath }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    warn: (obj: unknown, msg?: unknown) => H.logs.push(String(msg)),
    error: () => {},
    debug: () => {},
  },
}))

beforeAll(() => {
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.projectRoot, { recursive: true })
  mkdirSync(H.storeDir, { recursive: true })
})

beforeEach(() => {
  H.resolveFromPath.mockImplementation((name: string) => `/usr/bin/${name}`)
  H.tryResolveFromPath.mockImplementation((name: string) => `/usr/bin/${name}`)
  H.logs.length = 0
  H.symlinkCalls = 0
})

describe('ensureWorkerCwd symlinkSync catch', () => {
  it('logs "failed to symlink config entry" when symlinkSync throws', async () => {
    const AW = await import('../web/agent-worker.js')
    const claude = join(H.home, '.claude')
    mkdirSync(claude, { recursive: true })
    writeFileSync(join(claude, 'settings.json'), '{}')
    writeFileSync(join(claude, '.credentials.json'), '{}')
    AW.ensureWorkerCwd()
    expect(H.logs.some((l) => l.includes('failed to symlink config entry'))).toBe(true)
    expect(H.symlinkCalls).toBeGreaterThanOrEqual(1)
    // And the function still completed (didn't propagate the throw).
    expect(existsSync(join(H.home, '.marveen-worker', '.claude-config'))).toBe(true)
  })
})
