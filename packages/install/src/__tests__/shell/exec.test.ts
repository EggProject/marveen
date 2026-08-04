import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createShell,
  defaultShell,
  resetExecaImpl,
  resetShellFactory,
  setExecaImpl,
  setShellFactory,
} from '../../shell/exec.js'

interface Call { file: string; args: readonly string[] | undefined; opts: Record<string, unknown> | undefined }

// Resolved before any hook runs, so the module-level shell factory (the
// one installed at import time) is exercised too.
const bootAdapter = createShell()

function fakeExeca(result: unknown | (() => unknown)): { calls: Call[] } {
  const calls: Call[] = []
  setExecaImpl(((file: string, args?: readonly string[], opts?: Record<string, unknown>) => {
    calls.push({ file, args, opts })
    const value = typeof result === 'function' ? (result as () => unknown)() : result
    if (value instanceof Error) return Promise.reject(value)
    return Promise.resolve(value)
  }) as never)
  return { calls }
}

afterEach(() => {
  resetExecaImpl()
  resetShellFactory()
  vi.restoreAllMocks()
})

describe('shell/exec exec()', () => {
  it('calls execa with the file, args and empty options', async () => {
    const { calls } = fakeExeca({ exitCode: 0, stdout: 'hi', stderr: '' })
    const res = await defaultShell.exec('node', ['--version'])
    expect(calls[0]).toEqual({ file: 'node', args: ['--version'], opts: {} })
    expect(res).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' })
  })

  it('maps cwd, env and stdio: pipe', async () => {
    const { calls } = fakeExeca({ exitCode: 0, stdout: '', stderr: '' })
    await defaultShell.exec('ls', [], { cwd: '/tmp', env: { A: 'b' }, stdio: 'pipe' })
    expect(calls[0]!.opts).toEqual({ cwd: '/tmp', env: { A: 'b' }, stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('maps stdio: inherit', async () => {
    const { calls } = fakeExeca({ exitCode: 0, stdout: '', stderr: '' })
    await defaultShell.exec('ls', [], { stdio: 'inherit' })
    expect(calls[0]!.opts).toEqual({ stdio: 'inherit' })
  })

  it('defaults a missing exitCode to 0 and non-string streams to empty', async () => {
    fakeExeca({ exitCode: null, stdout: Buffer.from('x'), stderr: undefined })
    expect(await defaultShell.exec('x')).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('converts a failed execa promise into a ShellResult', async () => {
    fakeExeca(Object.assign(new Error('fail'), { exitCode: 3, stdout: 'o', stderr: 'e' }))
    expect(await defaultShell.exec('x')).toEqual({ exitCode: 3, stdout: 'o', stderr: 'e' })
  })

  it('defaults the failure exit code to 1 and non-string streams to empty', async () => {
    fakeExeca(Object.assign(new Error('fail'), { exitCode: undefined, stdout: 1, stderr: 2 }))
    expect(await defaultShell.exec('x')).toEqual({ exitCode: 1, stdout: '', stderr: '' })
  })

  it('rethrows an error without an exitCode field', async () => {
    fakeExeca(new Error('spawn ENOENT'))
    await expect(defaultShell.exec('x')).rejects.toThrow('spawn ENOENT')
  })

  it('rethrows a non-object rejection', async () => {
    setExecaImpl((() => Promise.reject('nope')) as never)
    await expect(defaultShell.exec('x')).rejects.toBe('nope')
  })
})

describe('shell/exec run()', () => {
  it('runs a command string through the shell', async () => {
    const { calls } = fakeExeca({ exitCode: 0, stdout: 'ok', stderr: '' })
    const res = await defaultShell.run('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' })
    expect(calls[0]).toEqual({
      file: 'curl -fsSL https://bun.sh/install | bash',
      args: [],
      opts: { stdio: 'inherit', shell: true },
    })
    expect(res.exitCode).toBe(0)
  })

  it('converts a failed shell command into a ShellResult', async () => {
    fakeExeca(Object.assign(new Error('fail'), { exitCode: 127, stdout: 'a', stderr: 'b' }))
    expect(await defaultShell.run('nope')).toEqual({ exitCode: 127, stdout: 'a', stderr: 'b' })
  })

  it('defaults a failed shell command exit code to 1', async () => {
    fakeExeca(Object.assign(new Error('fail'), { exitCode: undefined, stdout: null, stderr: null }))
    expect(await defaultShell.run('nope')).toEqual({ exitCode: 1, stdout: '', stderr: '' })
  })

  it('rethrows an error without an exitCode field', async () => {
    fakeExeca(new Error('boom'))
    await expect(defaultShell.run('x')).rejects.toThrow('boom')
  })

  it('rethrows a non-object rejection', async () => {
    setExecaImpl((() => Promise.reject(42)) as never)
    await expect(defaultShell.run('x')).rejects.toBe(42)
  })
})

describe('shell/exec which()', () => {
  it('returns the first PATH hit', async () => {
    const { calls } = fakeExeca({ exitCode: 0, stdout: '/usr/bin/bun\n/opt/bun\n', stderr: '' })
    expect(await defaultShell.which('bun')).toBe('/usr/bin/bun')
    expect(calls[0]).toEqual({ file: 'which', args: ['bun'], opts: { reject: false } })
  })

  it('returns null when the binary is missing', async () => {
    fakeExeca({ exitCode: 1, stdout: '', stderr: '' })
    expect(await defaultShell.which('nope')).toBeNull()
  })

  it('returns null when stdout is not a string', async () => {
    fakeExeca({ exitCode: 0, stdout: Buffer.from('/usr/bin/bun'), stderr: '' })
    expect(await defaultShell.which('bun')).toBeNull()
  })

  it('returns null when stdout is blank', async () => {
    fakeExeca({ exitCode: 0, stdout: '   \n', stderr: '' })
    expect(await defaultShell.which('bun')).toBeNull()
  })
})

describe('shell/exec factory', () => {
  it('createShell returns the default adapter', () => {
    expect(bootAdapter).toBe(defaultShell)
    expect(createShell()).toBe(defaultShell)
  })

  it('setShellFactory swaps the adapter', () => {
    const fake = { exec: vi.fn(), run: vi.fn(), which: vi.fn() }
    setShellFactory(() => fake as never)
    expect(createShell()).toBe(fake)
  })

  it('resetShellFactory restores the default adapter', () => {
    setShellFactory(() => ({} as never))
    resetShellFactory()
    expect(createShell()).toBe(defaultShell)
  })

  it('resetExecaImpl restores the real execa binding', async () => {
    fakeExeca({ exitCode: 0, stdout: 'x', stderr: '' })
    resetExecaImpl()
    const res = await defaultShell.exec('node', ['--version'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/^v\d+\./)
  })
})
