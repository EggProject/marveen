import { describe, it, expect, vi, beforeEach } from 'vitest'
import { captureOutput, makePlatform, makeShell, shellResult } from '../_helpers.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
  lastProvider: 'skip' as string,
  dashboardReady: undefined as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))
vi.mock('../../state/conf.js', () => ({
  createState: () => ({ get: (key: string) => key === 'lastProvider' ? stubs.lastProvider : '' }),
}))
vi.mock('../../api/dashboard.js', () => ({
  waitForDashboardReady: (...args: unknown[]) => stubs.dashboardReady(...args),
}))

const { doctorCommand } = await import('../../commands/doctor.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  stubs.lastProvider = 'skip'
  stubs.dashboardReady = vi.fn(async () => true)
  setColorsEnabled(false)
  initLocale('hu')
})

async function run(argv: string[] = []): Promise<string> {
  const { stdout } = await captureOutput(async () => { await doctorCommand.parseAsync(argv, { from: 'user' }) })
  return stdout
}

describe('commands/doctor', () => {
  it('runs the seven checks in order', async () => {
    stubs.shell.exec.mockResolvedValue(shellResult({ stdout: 'v22.4.0\n' }))
    const out = await run()
    const order = ['OS verzió', 'Node verzió', 'Bun telepítve', 'Claude Code telepítve', 'Service állapot', 'Vault elérhető', 'Dashboard elérhető']
    let cursor = -1
    for (const label of order) {
      const at = out.indexOf(label)
      expect(at, label).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('prints the table header and the detail column', async () => {
    stubs.shell.exec.mockResolvedValue(shellResult({ stdout: 'v22.4.0\n' }))
    const out = await run()
    expect(out).toContain('Check')
    expect(out).toContain('Status')
    expect(out).toContain('Detail')
    expect(out).toContain('v22.4.0')
    expect(out).toContain('http://127.0.0.1:3420')
  })

  it('reports "missing" when node cannot be executed', async () => {
    stubs.shell.exec.mockRejectedValue(new Error('ENOENT'))
    const out = await run()
    expect(out).toContain('missing')
  })

  it('reports an unknown service state when the probe throws', async () => {
    stubs.platform.readServiceStatus.mockRejectedValue(new Error('no systemd'))
    const out = await run()
    expect(out).toContain('unknown')
  })

  it('skips the dashboard probe while no provider is configured', async () => {
    const out = await run()
    expect(stubs.dashboardReady).not.toHaveBeenCalled()
    expect(out).toContain('Dashboard elérhető')
    expect(out).toContain('HIBA')
  })

  it('probes the dashboard once a provider is configured', async () => {
    stubs.lastProvider = 'minimax'
    const out = await run()
    expect(stubs.dashboardReady).toHaveBeenCalledWith({ base: 'http://127.0.0.1:3420', token: 'probe', timeoutMs: 2000 })
    expect(out).toContain('minimax')
    expect(out).toContain('OK')
  })

  it('treats a failing dashboard probe as not ready', async () => {
    stubs.lastProvider = 'ollama'
    stubs.dashboardReady = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const out = await run()
    expect(out).toContain('HIBA')
  })

  it('honours an explicit --web-port', async () => {
    stubs.lastProvider = 'deepseek'
    const out = await run(['--web-port', '9999'])
    expect(stubs.dashboardReady).toHaveBeenCalledWith({ base: 'http://127.0.0.1:9999', token: 'probe', timeoutMs: 2000 })
    expect(out).toContain('http://127.0.0.1:9999')
  })

  it('has a Hungarian description', () => {
    expect(doctorCommand.description()).toBe('Marveen diagnosztikai ellenőrzések')
    expect(doctorCommand.name()).toBe('doctor')
  })
})
