import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  LinuxProvider,
  TEMPLATE_DIR_FALLBACK,
  resetLinuxTemplatesDir,
  setLinuxTemplatesDir,
} from '../../platform/linux.js'
import { makeShell, shellResult, type FakeShell } from '../_helpers.js'

let shell: FakeShell
let provider: LinuxProvider

beforeEach(() => {
  shell = makeShell()
  provider = new LinuxProvider(shell)
})
afterEach(() => { resetLinuxTemplatesDir() })

function whichOnly(...found: string[]): void {
  shell.which.mockImplementation(async (name: string) => found.includes(name) ? `/usr/bin/${name}` : null)
}

describe('platform/linux prerequisites', () => {
  it('kind is linux', () => {
    expect(provider.kind).toBe('linux')
  })

  it('uses apt-get when available', async () => {
    whichOnly('apt-get')
    await provider.installPrerequisites()
    expect(shell.exec.mock.calls).toEqual([
      ['sudo', ['apt-get', 'update']],
      ['sudo', ['apt-get', 'install', '-y', 'curl', 'git', 'ca-certificates']],
    ])
  })

  it('falls back to dnf', async () => {
    whichOnly('dnf')
    await provider.installPrerequisites()
    expect(shell.exec.mock.calls).toEqual([
      ['sudo', ['dnf', 'install', '-y', 'curl', 'git', 'ca-certificates']],
    ])
  })

  it('falls back to yum', async () => {
    whichOnly('yum')
    await provider.installPrerequisites()
    expect(shell.exec.mock.calls).toEqual([
      ['sudo', ['yum', 'install', '-y', 'curl', 'git', 'ca-certificates']],
    ])
  })

  it('throws when no package manager is present', async () => {
    whichOnly()
    await expect(provider.installPrerequisites()).rejects.toThrow('Neither apt-get, dnf nor yum found on PATH')
  })

  it('installBun runs the canonical curl|bash installer', async () => {
    await provider.installBun()
    expect(shell.run).toHaveBeenCalledWith('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' })
  })

  it('installClaudeCli runs bunx', async () => {
    await provider.installClaudeCli()
    expect(shell.run).toHaveBeenCalledWith('bunx @anthropic-ai/claude-code@latest --version', { stdio: 'inherit' })
  })
})

describe('platform/linux service units', () => {
  it('serviceUnitPath points at the user systemd dir', () => {
    expect(provider.serviceUnitPath('marveen')).toBe(join(homedir(), '.config', 'systemd', 'user', 'marveen.service'))
  })

  it('renders the main unit template with command, workdir and env', async () => {
    const res = await provider.writeServiceUnit({
      name: 'marveen',
      command: 'node dist/index.js',
      workingDirectory: '/srv/marveen',
      env: { NODE_ENV: 'production', ENV_FILE: '/srv/marveen/.env' },
    })
    expect(res.path).toBe(provider.serviceUnitPath('marveen'))
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain('Description=Marveen dashboard service')
    expect(written).toContain('WorkingDirectory=/srv/marveen')
    expect(written).toContain('ExecStart=node dist/index.js')
    expect(written).toContain('Environment=NODE_ENV=production ENV_FILE=/srv/marveen/.env')
    expect(written).toContain('EnvironmentFile=-/srv/marveen/.env')
    expect(shell.exec.mock.calls[0]).toEqual(['mkdir', ['-p', join(homedir(), '.config', 'systemd', 'user')]])
  })

  it('renders the channels unit template for any other unit name', async () => {
    const res = await provider.writeServiceUnit({ name: 'marveen-channels', command: 'node dist/channels.js' })
    expect(res.path).toContain('marveen-channels.service')
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain('Description=Marveen channels bridge')
    expect(written).toContain('WorkingDirectory=/tmp')
    expect(written).toContain('Environment=\n')
  })

  it('leaves the EnvironmentFile empty when no ENV_FILE is set', async () => {
    await provider.writeServiceUnit({ name: 'marveen', command: 'node x', env: { PORT: '8787' } })
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain('EnvironmentFile=-\n')
    expect(written).toContain('Environment=PORT=8787')
  })

  it('substitutes an empty string for unknown template placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marveen-tpl-'))
    try {
      await writeFile(join(dir, 'marveen.service.template'), 'X={{command}} Y={{nincsilyen}}', 'utf-8')
      setLinuxTemplatesDir(dir)
      await provider.writeServiceUnit({ name: 'marveen', command: 'node x' })
      expect(String(shell.exec.mock.calls[1]![1][1])).toContain('X=node x Y=\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resetLinuxTemplatesDir restores the bundled template dir', async () => {
    setLinuxTemplatesDir('/nincs/ilyen')
    resetLinuxTemplatesDir()
    await provider.writeServiceUnit({ name: 'marveen', command: 'node x' })
    expect(String(shell.exec.mock.calls[1]![1][1])).toContain('Description=Marveen dashboard service')
    expect(TEMPLATE_DIR_FALLBACK).toContain(join('templates', 'systemd'))
  })
})

describe('platform/linux systemctl', () => {
  it('enableAndStart reloads then enables the unit', async () => {
    await provider.enableAndStart('marveen')
    expect(shell.exec.mock.calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'marveen.service']],
    ])
  })

  it('disableAndStop disables the unit', async () => {
    await provider.disableAndStop('marveen')
    expect(shell.exec).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'marveen.service'])
  })

  it.each([
    ['active\n', 'active'],
    ['inactive\n', 'inactive'],
    ['failed\n', 'failed'],
    ['activating\n', 'unknown'],
  ])('maps is-active %s to %s', async (stdout, state) => {
    shell.exec.mockResolvedValue(shellResult({ stdout }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state })
  })

  it('uninstall disables both units', async () => {
    await provider.uninstall()
    expect(shell.exec.mock.calls).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'marveen.service']],
      ['systemctl', ['--user', 'disable', '--now', 'marveen-channels.service']],
    ])
  })
})
