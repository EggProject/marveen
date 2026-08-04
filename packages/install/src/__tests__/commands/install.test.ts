import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureOutput, makeFs, makePlatform, makeShell } from '../_helpers.js'
import type { InstallerContext } from '../../types.js'

interface CapturedTask {
  title: string
  task: (ctx: InstallerContext) => unknown
  skip?: (ctx: InstallerContext) => string | false
  enable?: (ctx: InstallerContext) => boolean
  retry?: { tries: number }
}

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
  set: undefined as unknown as ReturnType<typeof vi.fn>,
  tasks: [] as Array<{ title: string; task: unknown; skip?: unknown; enable?: unknown; retry?: unknown }>,
  listrOptions: undefined as unknown,
  run: undefined as unknown as (ctx: InstallerContext) => Promise<unknown>,
  steps: {} as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('listr2', () => ({
  Listr: class {
    constructor(tasks: unknown[], options: unknown) {
      stubs.tasks = tasks as typeof stubs.tasks
      stubs.listrOptions = options
    }
    async run(ctx: InstallerContext): Promise<unknown> { return stubs.run(ctx) }
  },
}))
vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../shell/fs.js', () => ({ createFs: () => makeFs() }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))
vi.mock('../../state/conf.js', () => ({ createState: () => ({ set: stubs.set, get: () => 'skip' }) }))

function step(name: string, result: unknown = undefined): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve(result))
  stubs.steps[name] = fn
  return fn
}

vi.mock('../../steps/prereq.js', () => ({ stepPrereq: step('prereq') }))
vi.mock('../../steps/bun-install.js', () => ({ stepBunInstall: step('bun') }))
vi.mock('../../steps/claude-install.js', () => ({ stepClaudeInstall: step('claude') }))
vi.mock('../../steps/claude-auth.js', () => ({ stepClaudeAuth: step('claudeAuth') }))
vi.mock('../../steps/personal-info.js', () => ({ stepPersonalInfo: step('personal') }))
vi.mock('../../steps/npm-install.js', () => ({ stepNpmInstall: step('npmInstall') }))
vi.mock('../../steps/build.js', () => ({ stepBuild: step('build') }))
vi.mock('../../steps/provider-prompt.js', () => ({ stepProviderPrompt: step('provider', { mode: 'minimax' }) }))
vi.mock('../../steps/ollama-discovery.js', () => ({ stepOllamaDiscovery: step('ollama') }))
vi.mock('../../steps/vault-push.js', () => ({ stepVaultPush: step('vault') }))
vi.mock('../../steps/bumblebee.js', () => ({ stepBumblebee: step('bumblebee') }))
vi.mock('../../steps/summary.js', () => ({ stepSummary: step('summary') }))
vi.mock('../../steps/systemd.js', () => ({
  stepSystemd: step('systemd'),
  mainServiceSpec: () => ({ name: 'marveen', command: 'node dist/index.js' }),
  channelsServiceSpec: () => ({ name: 'marveen-channels', command: 'node dist/channels.js' }),
}))
vi.mock('../../steps/launchd.js', () => ({ stepLaunchd: step('launchd') }))

const { installCommand } = await import('../../commands/install.js')
const { initLocale } = await import('../../locale/index.js')

class ExitSentinel extends Error {}

const TITLES = [
  'Előfeltételek ellenőrzése',
  'Bun telepítése',
  'Claude Code telepítése',
  'Claude hitelesítés',
  'Személyes adatok',
  'Függőségek telepítése',
  'TypeScript build',
  'Provider választás',
  'Ollama felfedezés',
  'Vault push',
  'Rendszerszolgáltatás telepítése',
  'Bumblebee scheduled task',
  'Összefoglaló',
]

let lastCtx: InstallerContext | undefined

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  stubs.set = vi.fn()
  stubs.tasks = []
  lastCtx = undefined
  stubs.run = async (ctx) => { lastCtx = ctx; return ctx }
  for (const fn of Object.values(stubs.steps)) fn.mockClear()
  installCommand.setOptionValue('port', 8787)
  installCommand.setOptionValue('webPort', 3420)
  installCommand.setOptionValue('provider', undefined)
  installCommand.setOptionValue('nonInteractive', undefined)
  installCommand.setOptionValue('skipUpdate', undefined)
  initLocale('hu')
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSentinel(String(code)) }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

async function run(argv: string[] = []): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  let error: unknown
  const out = await captureOutput(async () => {
    try { await installCommand.parseAsync(argv, { from: 'user' }) }
    catch (err) { error = err }
  })
  return { ...out, ...(error !== undefined ? { error } : {}) }
}

function tasks(): CapturedTask[] {
  return stubs.tasks as unknown as CapturedTask[]
}

describe('commands/install task graph', () => {
  it('builds the full task list in the documented order', async () => {
    await run()
    expect(tasks().map((t) => t.title)).toEqual(TITLES)
  })

  it('runs the tasks sequentially and stops at the first error', async () => {
    await run()
    expect(stubs.listrOptions).toEqual({ concurrent: false, exitOnError: true })
  })

  it('wires each task to its step module', async () => {
    await run()
    const ctx = lastCtx!
    const list = tasks()
    await list[0]!.task(ctx)
    await list[1]!.task(ctx)
    await list[2]!.task(ctx)
    await list[3]!.task(ctx)
    await list[4]!.task(ctx)
    await list[5]!.task(ctx)
    await list[6]!.task(ctx)
    await list[8]!.task(ctx)
    await list[9]!.task(ctx)
    await list[11]!.task(ctx)
    await list[12]!.task(ctx)
    for (const name of ['prereq', 'bun', 'claude', 'claudeAuth', 'personal', 'npmInstall', 'build', 'ollama', 'vault', 'bumblebee', 'summary']) {
      expect(stubs.steps[name], name).toHaveBeenCalledWith(ctx)
    }
  })

  it('the provider task stores the choice on the context', async () => {
    await run()
    const ctx = lastCtx!
    await tasks()[7]!.task(ctx)
    expect(ctx.providerChoice).toEqual({ mode: 'minimax' })
  })

  it('skips the bun task when bun is already installed', async () => {
    await run()
    const skip = tasks()[1]!.skip!
    expect(skip({ bunInstalled: true } as InstallerContext)).toBe('már telepítve')
    expect(skip({ bunInstalled: false } as InstallerContext)).toBe(false)
  })

  it('skips the claude task when the CLI is already installed', async () => {
    await run()
    const skip = tasks()[2]!.skip!
    expect(skip({ claudeInstalled: true } as InstallerContext)).toBe('már telepítve')
    expect(skip({ claudeInstalled: false } as InstallerContext)).toBe(false)
  })

  it('retries the auth task three times', async () => {
    await run()
    expect(tasks()[3]!.retry).toEqual({ tries: 3 })
  })

  it('enables the ollama task only for the ollama provider', async () => {
    await run()
    const enable = tasks()[8]!.enable!
    expect(enable({ providerChoice: { mode: 'ollama' } } as InstallerContext)).toBe(true)
    expect(enable({ providerChoice: { mode: 'minimax' } } as InstallerContext)).toBe(false)
    expect(enable({} as InstallerContext)).toBe(false)
  })

  it('installs both systemd units on linux', async () => {
    await run()
    const ctx = lastCtx!
    await tasks()[10]!.task(ctx)
    expect(stubs.steps['systemd']).toHaveBeenNthCalledWith(1, ctx, { name: 'marveen', command: 'node dist/index.js' })
    expect(stubs.steps['systemd']).toHaveBeenNthCalledWith(2, ctx, { name: 'marveen-channels', command: 'node dist/channels.js' })
    expect(stubs.steps['launchd']).not.toHaveBeenCalled()
  })

  it('installs both launchd plists on macOS', async () => {
    stubs.platform = makePlatform('macos')
    await run()
    const ctx = lastCtx!
    await tasks()[10]!.task(ctx)
    expect(stubs.steps['launchd']).toHaveBeenCalledTimes(2)
    expect(stubs.steps['systemd']).not.toHaveBeenCalled()
  })
})

describe('commands/install context', () => {
  it('uses the documented defaults', async () => {
    await run()
    const ctx = lastCtx!
    expect(ctx.port).toBe(8787)
    expect(ctx.webPort).toBe(3420)
    expect(ctx.nonInteractive).toBe(false)
    expect(ctx.skipUpdate).toBe(false)
    expect(ctx.preSelectedProvider).toBeUndefined()
    expect(ctx.bunInstalled).toBe(true)
    expect(ctx.claudeInstalled).toBe(true)
    expect(ctx.cwd).toBe(process.cwd())
    expect(ctx.platform).toBe(stubs.platform)
  })

  it('accepts --port, --web-port, --skip-update and --non-interactive', async () => {
    await run(['--port', '9000', '--web-port', '9001', '--skip-update', '--non-interactive'])
    const ctx = lastCtx!
    expect(ctx.port).toBe(9000)
    expect(ctx.webPort).toBe(9001)
    expect(ctx.skipUpdate).toBe(true)
    expect(ctx.nonInteractive).toBe(true)
  })

  it('rejects an out-of-range port', async () => {
    const { error } = await run(['--port', '70000'])
    expect((error as Error).message).toContain('Érvénytelen port: 70000')
  })

  it('rejects a non-numeric port', async () => {
    const { error } = await run(['--port', 'abc'])
    expect((error as Error).message).toContain('Érvénytelen port: abc')
  })

  it('rejects an out-of-range web port', async () => {
    const { error } = await run(['--web-port', '0'])
    expect((error as Error).message).toContain('Érvénytelen port: 0')
  })

  it('accepts a known --provider', async () => {
    await run(['--provider', 'ollama'])
    expect(lastCtx!.preSelectedProvider).toBe('ollama')
  })

  it('rejects an unknown --provider', async () => {
    const { error } = await run(['--provider', 'nincsilyen'])
    expect((error as Error).message).toBe('Ismeretlen provider: nincsilyen')
  })

  it('detects a missing bun and claude toolchain', async () => {
    stubs.shell.which.mockResolvedValue(null)
    await run()
    expect(lastCtx!.bunInstalled).toBe(false)
    expect(lastCtx!.claudeInstalled).toBe(false)
  })

  it('falls back to a rejecting fetch when the runtime has none', async () => {
    const original = globalThis.fetch
    // @ts-expect-error -- simulating an ancient runtime without fetch
    delete globalThis.fetch
    try { await run() } finally { globalThis.fetch = original }
    await expect(lastCtx!.fetch('http://x')).rejects.toThrow('fetch unavailable')
  })
})

describe('commands/install completion', () => {
  it('records the provider and the installed version', async () => {
    process.env['npm_package_version'] = '1.28.1'
    stubs.run = async (ctx) => { lastCtx = ctx; ctx.providerChoice = { mode: 'deepseek' }; return ctx }
    await run()
    expect(stubs.set).toHaveBeenNthCalledWith(1, 'lastProvider', 'deepseek')
    expect(stubs.set).toHaveBeenNthCalledWith(2, 'lastInstalledVersion', '1.28.1')
    delete process.env['npm_package_version']
  })

  it('records "unknown" when the package version is absent', async () => {
    delete process.env['npm_package_version']
    await run()
    expect(stubs.set).toHaveBeenCalledWith('lastInstalledVersion', 'unknown')
    expect(stubs.set).toHaveBeenCalledTimes(1)
  })

  it('exits with code 1 when a task fails', async () => {
    stubs.run = async () => { throw new Error('prereq failed') }
    const { stderr, error } = await run()
    expect(stderr).toContain('Install failed: prereq failed')
    expect(error).toBeInstanceOf(ExitSentinel)
    expect((error as Error).message).toBe('1')
    expect(stubs.set).not.toHaveBeenCalled()
  })

  it('has a Hungarian description', () => {
    expect(installCommand.description()).toBe('Marveen teljes telepítése (alapértelmezett flow)')
    expect(installCommand.name()).toBe('install')
  })
})
