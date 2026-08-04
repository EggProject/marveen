import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureOutput, makePlatform, makeShell, shellResult } from '../_helpers.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))

const { updateCommand } = await import('../../commands/update.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

class ExitSentinel extends Error {}

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  updateCommand.setOptionValue('branch', 'feature-develop')
  updateCommand.setOptionValue('webPort', 3420)
  setColorsEnabled(false)
  initLocale('hu')
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSentinel(String(code)) }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

async function run(argv: string[] = []): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  let error: unknown
  const out = await captureOutput(async () => {
    try { await updateCommand.parseAsync(argv, { from: 'user' }) }
    catch (err) { error = err }
  })
  return { ...out, ...(error !== undefined ? { error } : {}) }
}

describe('commands/update', () => {
  it('runs git pull, bun install, bunx tsc and restarts the unit', async () => {
    const { stdout } = await run()
    expect(stubs.shell.exec.mock.calls).toEqual([
      ['git', ['pull', '--ff-only', 'origin', 'feature-develop']],
      ['bun', ['install', '--frozen-lockfile']],
      ['bunx', ['tsc'], { cwd: 'packages/marveen' }],
      ['systemctl', ['--user', 'restart', 'marveen.service']],
    ])
    expect(stdout).toContain('Frissítés keresése')
    expect(stdout).toContain('Frissítés alkalmazása (install)')
    expect(stdout).toContain('Frissítés alkalmazása (build)')
    expect(stdout).toContain('Nincs elérhető frissítés')
  })

  it('honours an explicit --branch', async () => {
    await run(['--branch', 'main'])
    expect(stubs.shell.exec.mock.calls[0]).toEqual(['git', ['pull', '--ff-only', 'origin', 'main']])
  })

  it('falls back to npm ci and npx tsc without bun', async () => {
    stubs.shell.which.mockResolvedValue(null)
    const { stdout } = await run()
    expect(stubs.shell.exec.mock.calls[1]).toEqual(['npm', ['ci']])
    expect(stubs.shell.exec.mock.calls[2]).toEqual(['npx', ['tsc'], { cwd: 'packages/marveen' }])
    expect(stdout).toContain('npm')
  })

  it('kickstarts the launchd job on macOS', async () => {
    stubs.platform = makePlatform('macos')
    await run()
    expect(stubs.shell.exec.mock.calls[3]).toEqual([
      'launchctl', ['kickstart', '-k', 'gui/$(id -u)/com.marveen.marveen'],
    ])
  })

  it('ignores a failing systemd restart', async () => {
    stubs.shell.exec.mockImplementation(async (file: string) => {
      if (file === 'systemctl') throw new Error('no session bus')
      return shellResult()
    })
    const { stdout } = await run()
    expect(stdout).toContain('Nincs elérhető frissítés')
  })

  it('ignores a failing launchctl kickstart', async () => {
    stubs.platform = makePlatform('macos')
    stubs.shell.exec.mockImplementation(async (file: string) => {
      if (file === 'launchctl') throw new Error('Could not find service')
      return shellResult()
    })
    const { stdout } = await run()
    expect(stdout).toContain('Nincs elérhető frissítés')
  })

  it('aborts with exit code 1 when git pull fails', async () => {
    stubs.shell.exec.mockImplementation(async (file: string) => {
      if (file === 'git') return shellResult({ exitCode: 1, stderr: 'fatal: not a fast-forward\nabort' })
      return shellResult()
    })
    const { stdout, stderr, error } = await run()
    expect(stdout).toContain('fatal: not a fast-forward')
    expect(stdout).toContain('HIBA')
    expect(stderr).toContain('Visszaállás a korábbi verzióra')
    expect(error).toBeInstanceOf(ExitSentinel)
    expect((error as Error).message).toBe('1')
  })

  it('falls back to stdout when git pull reports nothing on stderr', async () => {
    stubs.shell.exec.mockImplementation(async (file: string) => {
      if (file === 'git') return shellResult({ stdout: 'Already up to date.\n' })
      return shellResult()
    })
    const { stdout } = await run()
    expect(stdout).toContain('Already up to date.')
  })

  it('marks a failing install and build step as HIBA', async () => {
    stubs.shell.exec.mockImplementation(async (file: string) => {
      if (file === 'git') return shellResult()
      return shellResult({ exitCode: 2 })
    })
    const { stdout } = await run()
    expect(stdout).toContain('HIBA')
  })

  it('has a Hungarian description', () => {
    expect(updateCommand.description()).toBe('Marveen frissítése a legújabb verzióra')
    expect(updateCommand.name()).toBe('update')
  })
})
