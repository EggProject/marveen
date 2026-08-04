import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { stepBuild } from '../../steps/build.js'
import { makeCtx } from '../_helpers.js'

describe('steps/build', () => {
  it('runs bunx tsc in packages/marveen when bun is present', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/bun')
    expect(await stepBuild(ctx)).toEqual({ manager: 'bun' })
    expect(ctx.shell.which).toHaveBeenCalledWith('bun')
    expect(ctx.shell.exec).toHaveBeenCalledWith('bunx', ['tsc'], {
      cwd: join('/proj', 'packages', 'marveen'),
      stdio: 'inherit',
    })
  })

  it('falls back to npx tsc when bun is missing', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue(null)
    expect(await stepBuild(ctx)).toEqual({ manager: 'npm' })
    expect(ctx.shell.exec).toHaveBeenCalledWith('npx', ['tsc'], {
      cwd: join('/proj', 'packages', 'marveen'),
      stdio: 'inherit',
    })
  })

  it('propagates a build failure', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/bun')
    ctx.shell.exec.mockRejectedValue(new Error('tsc failed'))
    await expect(stepBuild(ctx)).rejects.toThrow('tsc failed')
  })
})
