import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureOutput, makeFs, makePlatform, makeShell } from '../_helpers.js'
import type { InstallerContext, ProviderChoice } from '../../types.js'
import type { VaultPushResult } from '../../steps/vault-push.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
  set: undefined as unknown as ReturnType<typeof vi.fn>,
  lastProvider: 'skip' as string,
  choice: { mode: 'minimax' } as ProviderChoice,
  push: { vaultOk: true, settingsOk: true, skipped: false } as VaultPushResult,
  contexts: [] as InstallerContext[],
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../shell/fs.js', () => ({ createFs: () => makeFs() }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))
vi.mock('../../state/conf.js', () => ({
  createState: () => ({ set: stubs.set, get: (key: string) => key === 'lastProvider' ? stubs.lastProvider : '' }),
}))
vi.mock('../../steps/provider-prompt.js', () => ({
  stepProviderPrompt: (ctx: InstallerContext) => {
    stubs.contexts.push(ctx)
    return Promise.resolve(stubs.choice)
  },
}))
vi.mock('../../steps/vault-push.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../steps/vault-push.js')>()
  return {
    describePushResult: actual.describePushResult,
    stepVaultPush: () => Promise.resolve(stubs.push),
  }
})

const { providerCommand } = await import('../../commands/provider.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  stubs.set = vi.fn()
  stubs.lastProvider = 'skip'
  stubs.choice = { mode: 'minimax' }
  stubs.push = { vaultOk: true, settingsOk: true, skipped: false }
  stubs.contexts = []
  providerCommand.setOptionValue('provider', undefined)
  providerCommand.setOptionValue('nonInteractive', undefined)
  providerCommand.setOptionValue('webPort', 3420)
  setColorsEnabled(false)
  initLocale('hu')
})
afterEach(() => { vi.restoreAllMocks() })

async function run(argv: string[] = []): Promise<string> {
  const { stdout } = await captureOutput(async () => { await providerCommand.parseAsync(argv, { from: 'user' }) })
  return stdout
}

describe('commands/provider', () => {
  it('re-runs the prompt, pushes to the vault and stores the provider', async () => {
    const out = await run()
    expect(stubs.contexts).toHaveLength(1)
    expect(stubs.set).toHaveBeenCalledWith('lastProvider', 'minimax')
    expect(out).toContain('Provider konfiguráció push-olva a Vault-ba')
    expect(out).toContain('Provider konfiguráció frissítve')
  })

  it('builds a context with the defaults and the injected adapters', async () => {
    await run()
    const ctx = stubs.contexts[0]!
    expect(ctx.port).toBe(8787)
    expect(ctx.webPort).toBe(3420)
    expect(ctx.lang).toBe('hu')
    expect(ctx.nonInteractive).toBe(false)
    expect(ctx.preSelectedProvider).toBeUndefined()
    expect(ctx.bunInstalled).toBe(true)
    expect(ctx.claudeInstalled).toBe(true)
    expect(ctx.dashboardToken).toBe('')
    expect(ctx.shell).toBe(stubs.shell)
    expect(ctx.platform).toBe(stubs.platform)
    expect(typeof ctx.fetch).toBe('function')
    expect(ctx.cwd).toBe(process.cwd())
  })

  it('forwards --provider, --non-interactive and --web-port', async () => {
    await run(['--provider', 'deepseek', '--non-interactive', '--web-port', '9999'])
    const ctx = stubs.contexts[0]!
    expect(ctx.preSelectedProvider).toBe('deepseek')
    expect(ctx.nonInteractive).toBe(true)
    expect(ctx.webPort).toBe(9999)
  })

  it('reuses the dashboard token when a provider is already configured', async () => {
    stubs.lastProvider = 'ollama'
    await run()
    expect(stubs.contexts[0]!.dashboardToken).toBe('reuse')
  })

  it('warns instead of confirming when the push failed', async () => {
    stubs.push = { vaultOk: false, settingsOk: true, skipped: false, reason: '401' }
    const out = await run()
    expect(out).toContain('Provider push sikertelen')
    expect(out).not.toContain('Provider konfiguráció frissítve')
  })

  it('reports "no change" for a skipped push', async () => {
    stubs.choice = { mode: 'skip' }
    stubs.push = { vaultOk: true, settingsOk: true, skipped: true }
    const out = await run()
    expect(out).toContain('Nincs változás')
    expect(out).not.toContain('Provider konfiguráció frissítve')
    expect(stubs.set).toHaveBeenCalledWith('lastProvider', 'skip')
  })

  it('falls back to a rejecting fetch when the runtime has none', async () => {
    const original = globalThis.fetch
    // @ts-expect-error -- simulating an ancient runtime without fetch
    delete globalThis.fetch
    try {
      await run()
    } finally {
      globalThis.fetch = original
    }
    await expect(stubs.contexts[0]!.fetch('http://x')).rejects.toThrow('fetch unavailable')
  })

  it('has a Hungarian description', () => {
    expect(providerCommand.description()).toBe('Provider konfiguráció újraválasztása és Vault push')
    expect(providerCommand.name()).toBe('provider')
  })
})
