import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { stepNpmInstall } from '../../steps/npm-install.js'
import { makeCtx } from '../_helpers.js'

const CWD = join('/proj', 'packages', 'marveen')

describe('steps/npm-install', () => {
  it('runs bun install --frozen-lockfile in packages/marveen', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/bun')
    expect(await stepNpmInstall(ctx)).toEqual({ manager: 'bun' })
    expect(ctx.shell.exec).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], { cwd: CWD, stdio: 'inherit' })
  })

  it('falls back to npm ci when bun is missing', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue(null)
    expect(await stepNpmInstall(ctx)).toEqual({ manager: 'npm' })
    expect(ctx.shell.exec).toHaveBeenCalledWith('npm', ['ci'], { cwd: CWD, stdio: 'inherit' })
  })

  it('propagates an install failure', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue(null)
    ctx.shell.exec.mockRejectedValue(new Error('lockfile mismatch'))
    await expect(stepNpmInstall(ctx)).rejects.toThrow('lockfile mismatch')
  })
})
