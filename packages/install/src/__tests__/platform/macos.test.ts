import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  MacosProvider,
  MACOS_TEMPLATE_DIR_FALLBACK,
  resetMacosTemplatesDir,
  setMacosTemplatesDir,
} from '../../platform/macos.js'
import { makeShell, shellResult, type FakeShell } from '../_helpers.js'

let shell: FakeShell
let provider: MacosProvider

beforeEach(() => {
  shell = makeShell()
  provider = new MacosProvider(shell)
})
afterEach(() => { resetMacosTemplatesDir() })

describe('platform/macos prerequisites', () => {
  it('kind is macos', () => {
    expect(provider.kind).toBe('macos')
  })

  it('installs curl and git via brew', async () => {
    await provider.installPrerequisites()
    expect(shell.exec).toHaveBeenCalledWith('brew', ['install', 'curl', 'git'])
  })

  it('throws when brew is missing', async () => {
    shell.which.mockResolvedValue(null)
    await expect(provider.installPrerequisites()).rejects.toThrow('Homebrew is required on macOS but was not found on PATH')
    expect(shell.exec).not.toHaveBeenCalled()
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

describe('platform/macos plist rendering', () => {
  it('serviceUnitPath points at ~/Library/LaunchAgents', () => {
    expect(provider.serviceUnitPath('marveen'))
      .toBe(join(homedir(), 'Library', 'LaunchAgents', 'com.marveen.marveen.plist'))
  })

  it('renders label, command, workdir and env entries', async () => {
    const res = await provider.writeServiceUnit({
      name: 'marveen',
      command: 'node dist/index.js',
      workingDirectory: '/srv/marveen',
      env: { NODE_ENV: 'production', PORT: '8787' },
    })
    expect(res.path).toBe(provider.serviceUnitPath('marveen'))
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain('<string>com.marveen.marveen</string>')
    expect(written).toContain('<string>node dist/index.js</string>')
    expect(written).toContain('<string>/srv/marveen</string>')
    expect(written).toContain('<key>NODE_ENV</key>')
    expect(written).toContain('<string>production</string>')
    expect(written).toContain('<key>PORT</key>')
    expect(shell.exec.mock.calls[0]).toEqual(['mkdir', ['-p', join(homedir(), 'Library', 'LaunchAgents')]])
  })

  it('defaults the working directory to the home dir and the env block to empty', async () => {
    await provider.writeServiceUnit({ name: 'marveen-channels', command: 'node dist/channels.js' })
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain(`<string>${homedir()}</string>`)
    expect(written).toContain('<key>EnvironmentVariables</key>')
    expect(written).not.toContain('<key>NODE_ENV</key>')
  })

  it('escapes XML metacharacters in env keys and values', async () => {
    await provider.writeServiceUnit({
      name: 'marveen',
      command: 'node x',
      env: { 'A&B': '<v>"q"' },
    })
    const written = String(shell.exec.mock.calls[1]![1][1])
    expect(written).toContain('<key>A&amp;B</key>')
    expect(written).toContain('<string>&lt;v&gt;&quot;q&quot;</string>')
  })

  it('substitutes an empty string for unknown template placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marveen-plist-'))
    try {
      await writeFile(join(dir, 'com.marveen.plist.template'), 'X={{command}} Y={{nincsilyen}}', 'utf-8')
      setMacosTemplatesDir(dir)
      await provider.writeServiceUnit({ name: 'marveen', command: 'node x' })
      expect(String(shell.exec.mock.calls[1]![1][1])).toContain('X=node x Y=\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resetMacosTemplatesDir restores the bundled template dir', async () => {
    setMacosTemplatesDir('/nincs/ilyen')
    resetMacosTemplatesDir()
    await provider.writeServiceUnit({ name: 'marveen', command: 'node x' })
    expect(String(shell.exec.mock.calls[1]![1][1])).toContain('<plist version="1.0">')
    expect(MACOS_TEMPLATE_DIR_FALLBACK).toContain(join('templates', 'launchd'))
  })
})

describe('platform/macos launchctl', () => {
  it('enableAndStart loads the plist', async () => {
    await provider.enableAndStart('marveen')
    expect(shell.exec).toHaveBeenCalledWith('launchctl', ['load', '-w', provider.serviceUnitPath('marveen')])
  })

  it('disableAndStop unloads the plist', async () => {
    await provider.disableAndStop('marveen')
    expect(shell.exec).toHaveBeenCalledWith('launchctl', ['unload', '-w', provider.serviceUnitPath('marveen')])
  })

  it('reports inactive when the label is not listed', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: '123\t0\tcom.apple.something\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'inactive' })
  })

  it('reports active for a running job with a dash status', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: '4711\t-\tcom.marveen.marveen\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'active' })
  })

  it('reports active for a clean exit status', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: '-\t0\tcom.marveen.marveen\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'active' })
  })

  it('reports failed for a non-zero exit status', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: '-\t78\tcom.marveen.marveen\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'failed' })
  })

  it('reports active when the status column is not numeric', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: '- x com.marveen.marveen\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'active' })
  })

  it('reports active when the row has no status column', async () => {
    shell.exec.mockResolvedValue(shellResult({ stdout: 'com.marveen.marveen\n' }))
    expect(await provider.readServiceStatus('marveen')).toEqual({ name: 'marveen', state: 'active' })
  })

  it('uninstall unloads both plists', async () => {
    await provider.uninstall()
    expect(shell.exec.mock.calls).toEqual([
      ['launchctl', ['unload', '-w', provider.serviceUnitPath('marveen')]],
      ['launchctl', ['unload', '-w', provider.serviceUnitPath('marveen-channels')]],
    ])
  })
})
