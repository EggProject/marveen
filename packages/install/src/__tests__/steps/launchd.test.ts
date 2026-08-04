import { describe, it, expect } from 'vitest'
import { channelsServiceSpec, mainServiceSpec, stepLaunchd } from '../../steps/launchd.js'
import { makeCtx, makePlatform } from '../_helpers.js'

describe('steps/launchd', () => {
  it('writes the plist, loads it and returns the plist path', async () => {
    const ctx = makeCtx({ platform: makePlatform('macos') })
    const spec = mainServiceSpec(ctx)
    expect(await stepLaunchd(ctx, spec)).toEqual({ path: '/units/marveen' })
    expect(ctx.platform.writeServiceUnit).toHaveBeenCalledWith(spec)
    expect(ctx.platform.enableAndStart).toHaveBeenCalledWith('marveen')
    expect(ctx.platform.serviceUnitPath).toHaveBeenCalledWith('marveen')
  })

  it('propagates a launchctl load failure', async () => {
    const ctx = makeCtx({ platform: makePlatform('macos') })
    ctx.platform.enableAndStart.mockRejectedValue(new Error('Load failed: 5: Input/output error'))
    await expect(stepLaunchd(ctx, channelsServiceSpec(ctx))).rejects.toThrow('Load failed')
  })

  it('mainServiceSpec carries the runtime command, cwd and ports', () => {
    const ctx = makeCtx({ port: 1234, webPort: 5678, cwd: '/Users/op/marveen' })
    expect(mainServiceSpec(ctx)).toEqual({
      name: 'marveen',
      command: 'node dist/index.js',
      workingDirectory: '/Users/op/marveen',
      env: { NODE_ENV: 'production', PORT: '1234', WEB_PORT: '5678' },
    })
  })

  it('channelsServiceSpec carries the channels command and web port', () => {
    const ctx = makeCtx({ webPort: 5678, cwd: '/Users/op/marveen' })
    expect(channelsServiceSpec(ctx)).toEqual({
      name: 'marveen-channels',
      command: 'node dist/channels.js',
      workingDirectory: '/Users/op/marveen',
      env: { NODE_ENV: 'production', WEB_PORT: '5678' },
    })
  })
})
