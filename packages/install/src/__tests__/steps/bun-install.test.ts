import { describe, it, expect } from 'vitest'
import { stepBunInstall } from '../../steps/bun-install.js'
import { makeCtx } from '../_helpers.js'

describe('steps/bun-install', () => {
  it('skips the install when bun is already on PATH', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/bin/bun')
    expect(await stepBunInstall(ctx)).toEqual({ installed: false })
    expect(ctx.platform.installBun).not.toHaveBeenCalled()
    expect(ctx.bunInstalled).toBe(true)
  })

  it('runs the curl|bash installer when bun is missing', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValueOnce(null).mockResolvedValueOnce('/root/.bun/bin/bun')
    expect(await stepBunInstall(ctx)).toEqual({ installed: true })
    expect(ctx.platform.installBun).toHaveBeenCalledOnce()
    expect(ctx.bunInstalled).toBe(true)
  })

  it('throws when bun is still missing after the install', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue(null)
    await expect(stepBunInstall(ctx)).rejects.toThrow('bun install completed but binary is still not on PATH')
    expect(ctx.bunInstalled).toBe(false)
  })
})
