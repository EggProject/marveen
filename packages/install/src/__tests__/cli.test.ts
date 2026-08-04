import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { captureOutput } from './_helpers.js'

const calls = vi.hoisted(() => ({ list: [] as string[] }))

function fakeCommand(name: string, description: string): Command {
  return new Command(name).description(description).action(() => { calls.list.push(name) })
}

vi.mock('../commands/install.js', () => ({ installCommand: fakeCommand('install', 'Marveen teljes telepítése (alapértelmezett flow)') }))
vi.mock('../commands/uninstall.js', () => ({ uninstallCommand: fakeCommand('uninstall', 'Marveen telepítés eltávolítása') }))
vi.mock('../commands/status.js', () => ({ statusCommand: fakeCommand('status', 'Marveen szolgáltatás állapot megjelenítése') }))
vi.mock('../commands/doctor.js', () => ({ doctorCommand: fakeCommand('doctor', 'Marveen diagnosztikai ellenőrzések') }))
vi.mock('../commands/provider.js', () => ({ providerCommand: fakeCommand('provider', 'Provider konfiguráció újraválasztása és Vault push') }))
vi.mock('../commands/update.js', () => ({ updateCommand: fakeCommand('update', 'Marveen frissítése a legújabb verzióra') }))

class ExitSentinel extends Error {}

const REAL_ARGV = process.argv

beforeEach(() => {
  calls.list = []
  vi.resetModules()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSentinel(String(code)) }) as never)
})
afterEach(() => {
  process.argv = REAL_ARGV
  vi.restoreAllMocks()
})

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  process.argv = ['node', '/tmp/cli.js', ...args]
  let error: unknown
  const out = await captureOutput(async () => {
    try { await import('../cli.js') }
    catch (err) { error = err }
  })
  return { ...out, ...(error !== undefined ? { error } : {}) }
}

describe('cli routing', () => {
  it.each([
    ['install'],
    ['uninstall'],
    ['status'],
    ['doctor'],
    ['provider'],
    ['update'],
  ])('routes the %s subcommand to its action', async (name) => {
    const { error } = await runCli([name])
    expect(error).toBeUndefined()
    expect(calls.list).toEqual([name])
  })

  it('prints the banner before the subcommand runs', async () => {
    const { stdout } = await runCli(['status'])
    expect(stdout).toContain('Marveen telepítő')
    expect(stdout).toContain('AI fleet management rendszer')
  })

  it('switches the banner to English with --lang en', async () => {
    const { stdout } = await runCli(['--lang', 'en', 'status'])
    expect(stdout).toContain('Marveen installer')
    expect(stdout).toContain('AI fleet management system')
  })

  it('keeps Hungarian with an explicit --lang hu', async () => {
    const { stdout } = await runCli(['--lang', 'hu', 'doctor'])
    expect(stdout).toContain('Marveen telepítő')
  })

  it('ignores an unsupported --lang value', async () => {
    const { stdout } = await runCli(['--lang', 'de', 'doctor'])
    expect(stdout).toContain('Marveen telepítő')
    expect(calls.list).toEqual(['doctor'])
  })

  it('strips the ANSI codes with --no-color', async () => {
    const { stdout } = await runCli(['--no-color', 'status'])
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(stdout)).toBe(false)
  })

  it('keeps the ANSI codes by default', async () => {
    const { stdout } = await runCli(['status'])
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(stdout)).toBe(true)
  })
})

describe('cli help and version', () => {
  it('--segítség prints the Hungarian help', async () => {
    const { stdout, error } = await runCli(['--segítség'])
    expect(error).toBeInstanceOf(ExitSentinel)
    expect(stdout).toContain('Marveen telepítő')
    expect(stdout).toContain('Súgó megjelenítése')
    expect(stdout).toContain('Nyelv')
    expect(stdout).toContain('Színek kikapcsolása')
  })

  it('the help lists every subcommand with a Hungarian description', async () => {
    const { stdout } = await runCli(['-h'])
    expect(stdout).toContain('Marveen teljes telepítése')
    expect(stdout).toContain('Marveen telepítés eltávolítása')
    expect(stdout).toContain('Marveen szolgáltatás állapot megjelenítése')
    expect(stdout).toContain('Marveen diagnosztikai ellenőrzések')
    expect(stdout).toContain('Provider konfiguráció újraválasztása és Vault push')
    expect(stdout).toContain('Marveen frissítése a legújabb verzióra')
  })

  it('--version prints the package version', async () => {
    const { stdout, error } = await runCli(['--version'])
    expect(error).toBeInstanceOf(ExitSentinel)
    expect(stdout.trim()).toBe('1.28.1')
  })

  it('rejects an unknown subcommand', async () => {
    const { stderr, error } = await runCli(['nincsilyen'])
    expect(error).toBeInstanceOf(ExitSentinel)
    expect(stderr).toContain('nincsilyen')
    expect(calls.list).toEqual([])
  })
})
