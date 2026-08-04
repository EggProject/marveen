import { describe, it, expect, vi, beforeEach } from 'vitest'
import { release } from 'node:os'
import { captureOutput, makePlatform, makeShell, shellResult } from '../_helpers.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
  lastProvider: 'skip' as string,
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))
vi.mock('../../state/conf.js', () => ({
  createState: () => ({ get: (key: string) => key === 'lastProvider' ? stubs.lastProvider : '' }),
}))

const { statusCommand } = await import('../../commands/status.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  stubs.lastProvider = 'skip'
  setColorsEnabled(false)
  initLocale('hu')
})

async function run(): Promise<string> {
  const { stdout } = await captureOutput(async () => { await statusCommand.parseAsync([], { from: 'user' }) })
  return stdout
}

describe('commands/status', () => {
  it('renders the six status rows with a header', async () => {
    stubs.shell.exec.mockResolvedValue(shellResult({ stdout: 'v22.4.0\n' }))
    const out = await run()
    expect(out).toContain('Check')
    expect(out).toContain('Status')
    expect(out).toContain('Detail')
    expect(out).toContain('OS verzió')
    expect(out).toContain(`darwin ${release()}`.slice(0, 6))
    expect(out).toContain('Node verzió')
    expect(out).toContain('v22.4.0')
    expect(out).toContain('Bun telepítve')
    expect(out).toContain('Claude Code telepítve')
    expect(out).toContain('Service állapot')
    expect(out).toContain('Vault elérhető')
    expect(out).toContain('OK')
  })

  it('marks the toolchain rows as failed when the binaries are missing', async () => {
    stubs.shell.which.mockResolvedValue(null)
    stubs.shell.exec.mockResolvedValue(shellResult({ exitCode: 1 }))
    const out = await run()
    expect(out).toContain('HIBA')
  })

  it('survives a failing node --version call', async () => {
    stubs.shell.exec.mockRejectedValue(new Error('ENOENT'))
    const out = await run()
    expect(out).toContain('Node verzió')
    expect(out).toContain('HIBA')
  })

  it('marks the service row as failed when the unit is inactive', async () => {
    stubs.platform.readServiceStatus.mockResolvedValue({ name: 'marveen', state: 'inactive' })
    const out = await run()
    expect(out).toContain('inactive')
  })

  it('marks the vault row as OK once a provider was configured', async () => {
    stubs.lastProvider = 'minimax'
    const out = await run()
    expect(out).toContain('minimax')
  })

  it('has a Hungarian description', () => {
    expect(statusCommand.description()).toBe('Marveen szolgáltatás állapot megjelenítése')
    expect(statusCommand.name()).toBe('status')
  })
})
