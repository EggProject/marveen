// Type-level smoke test: the module is types-only, so this file exists
// to prove every exported type composes as documented. `expectTypeOf`
// runs at compile time; the runtime assertions keep vitest happy.

import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  FsAdapter,
  InstallerContext,
  PlatformProvider,
  ProviderChoice,
  ProviderMode,
  ServiceStatus,
  ServiceUnitSpec,
  ShellAdapter,
  ShellExecOptions,
  ShellResult,
} from '../types.js'
import { makeCtx } from './_helpers.js'

describe('types', () => {
  it('is a types-only module with no runtime surface', async () => {
    const mod = await import('../types.js')
    expect(Object.keys(mod)).toEqual([])
  })

  it('ProviderMode covers the six providers', () => {
    const modes: ProviderMode[] = ['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip']
    expect(modes).toHaveLength(6)
    expectTypeOf<ProviderMode>().toEqualTypeOf<'anthropic' | 'minimax' | 'deepseek' | 'openrouter' | 'ollama' | 'skip'>()
  })

  it('ProviderChoice only requires the mode', () => {
    const choice: ProviderChoice = { mode: 'skip' }
    expect(choice.mode).toBe('skip')
    expectTypeOf<ProviderChoice['vaultId']>().toEqualTypeOf<string | undefined>()
  })

  it('ServiceUnitSpec and ServiceStatus compose', () => {
    const spec: ServiceUnitSpec = { name: 'marveen', command: 'node dist/index.js' }
    const status: ServiceStatus = { name: spec.name, state: 'active' }
    expect(status.state).toBe('active')
    expectTypeOf<ServiceStatus['state']>().toEqualTypeOf<'active' | 'inactive' | 'failed' | 'unknown'>()
  })

  it('ShellResult / ShellExecOptions shapes', () => {
    const opts: ShellExecOptions = { cwd: '/tmp', stdio: 'pipe' }
    const res: ShellResult = { exitCode: 0, stdout: '', stderr: '' }
    expect(opts.cwd).toBe('/tmp')
    expect(res.exitCode).toBe(0)
  })

  it('InstallerContext wires the four adapters', () => {
    const ctx = makeCtx()
    expectTypeOf(ctx).toMatchTypeOf<InstallerContext>()
    expectTypeOf(ctx.shell).toMatchTypeOf<ShellAdapter>()
    expectTypeOf(ctx.fs).toMatchTypeOf<FsAdapter>()
    expectTypeOf(ctx.platform).toMatchTypeOf<PlatformProvider>()
    expect(ctx.platform.kind).toBe('linux')
  })
})
