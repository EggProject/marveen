import { describe, it, expect } from 'vitest'
import { stepClaudeInstall } from '../../steps/claude-install.js'
import { makeCtx } from '../_helpers.js'

describe('steps/claude-install', () => {
  it('delegates to the platform provider and records the result', async () => {
    const ctx = makeCtx()
    ctx.shell.which.mockResolvedValue('/usr/local/bin/claude')
    await stepClaudeInstall(ctx)
    expect(ctx.platform.installClaudeCli).toHaveBeenCalledOnce()
    expect(ctx.shell.which).toHaveBeenCalledWith('claude')
    expect(ctx.claudeInstalled).toBe(true)
  })

  it('fails when the binary is still absent after installation', async () => {
    const ctx = makeCtx({ claudeInstalled: true })
    ctx.shell.which.mockResolvedValue(null)
    await expect(stepClaudeInstall(ctx)).rejects.toThrow('claude executable is not on PATH')
    expect(ctx.claudeInstalled).toBe(false)
  })

  it('propagates an install failure', async () => {
    const ctx = makeCtx()
    ctx.platform.installClaudeCli.mockRejectedValue(new Error('bunx failed'))
    await expect(stepClaudeInstall(ctx)).rejects.toThrow('bunx failed')
  })
})
