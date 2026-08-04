import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { release } from 'node:os'
import { detectWsl, stepPrereq } from '../../steps/prereq.js'
import { captureOutput, makeCtx } from '../_helpers.js'

const procVersion = vi.hoisted(() => ({ value: 'Linux version 6.1.0 (gcc)' as string | Error }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (path: string, enc: string): Promise<string> => {
      if (path === '/proc/version') {
        if (procVersion.value instanceof Error) throw procVersion.value
        return procVersion.value
      }
      return actual.readFile(path, enc as BufferEncoding) as Promise<string>
    },
  }
})

const REAL_PLATFORM = process.platform

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => { procVersion.value = 'Linux version 6.1.0 (gcc)' })
afterEach(() => { setPlatform(REAL_PLATFORM) })

describe('steps/prereq detectWsl', () => {
  it('is false on a non-linux host', async () => {
    setPlatform('darwin')
    expect(await detectWsl()).toBe(false)
  })

  it('is false for a vanilla linux kernel', async () => {
    setPlatform('linux')
    expect(await detectWsl()).toBe(false)
  })

  it('is true when /proc/version mentions microsoft', async () => {
    setPlatform('linux')
    procVersion.value = 'Linux version 5.15.0-microsoft-standard-WSL2'
    expect(await detectWsl()).toBe(true)
  })

  it('is true when /proc/version mentions WSL', async () => {
    setPlatform('linux')
    procVersion.value = 'Linux version 5.15.0 (WSL)'
    expect(await detectWsl()).toBe(true)
  })

  it('is false when /proc/version is unreadable', async () => {
    setPlatform('linux')
    procVersion.value = new Error('ENOENT')
    expect(await detectWsl()).toBe(false)
  })
})

describe('steps/prereq stepPrereq', () => {
  it('reports the OS, the toolchain and updates the context', async () => {
    setPlatform('darwin')
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/x')
    const res = await stepPrereq(ctx)
    expect(res).toEqual({
      os: `darwin ${release()}`,
      isWsl: false,
      missingRequired: [],
      hasBun: true,
      hasClaude: true,
    })
    expect(ctx.bunInstalled).toBe(true)
    expect(ctx.claudeInstalled).toBe(true)
    expect(ctx.shell.which.mock.calls.map((c) => c[0])).toEqual(['node', 'npm', 'git', 'curl', 'bun', 'claude'])
  })

  it('records missing optional tools without failing', async () => {
    setPlatform('darwin')
    const ctx = makeCtx()
    ctx.shell.which.mockImplementation(async (name: string) => name === 'bun' || name === 'claude' ? null : '/usr/bin/x')
    const res = await stepPrereq(ctx)
    expect(res.hasBun).toBe(false)
    expect(res.hasClaude).toBe(false)
    expect(ctx.bunInstalled).toBe(false)
    expect(ctx.claudeInstalled).toBe(false)
  })

  it('throws when a required tool is missing', async () => {
    setPlatform('darwin')
    const ctx = makeCtx()
    ctx.shell.which.mockImplementation(async (name: string) => name === 'git' ? null : '/usr/bin/x')
    await expect(stepPrereq(ctx)).rejects.toThrow('Missing required tools: git')
  })

  it('lists every missing required tool', async () => {
    setPlatform('darwin')
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue(null)
    await expect(stepPrereq(ctx)).rejects.toThrow('Missing required tools: node, npm, git, curl')
  })

  it('warns on stderr when WSL is detected', async () => {
    setPlatform('linux')
    procVersion.value = 'Linux version 5.15.0-microsoft-standard-WSL2'
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/x')
    let res: Awaited<ReturnType<typeof stepPrereq>> | undefined
    const { stderr } = await captureOutput(async () => { res = await stepPrereq(ctx) })
    expect(stderr).toContain('WSL detected')
    expect(res?.isWsl).toBe(true)
  })
})
