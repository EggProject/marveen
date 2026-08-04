import { describe, it, expect } from 'vitest'
import { channelsServiceSpec, mainServiceSpec, stepSystemd } from '../../steps/systemd.js'
import { makeCtx } from '../_helpers.js'

describe('steps/systemd', () => {
  it('writes the unit, enables it and returns the unit path', async () => {
    const ctx = makeCtx()
    const spec = mainServiceSpec(ctx)
    expect(await stepSystemd(ctx, spec)).toEqual({ path: '/units/marveen' })
    expect(ctx.platform.writeServiceUnit).toHaveBeenCalledWith(spec)
    expect(ctx.platform.enableAndStart).toHaveBeenCalledWith('marveen')
    expect(ctx.platform.serviceUnitPath).toHaveBeenCalledWith('marveen')
  })

  it('propagates a write failure before enabling', async () => {
    const ctx = makeCtx()
    ctx.platform.writeServiceUnit.mockRejectedValue(new Error('EACCES'))
    await expect(stepSystemd(ctx, mainServiceSpec(ctx))).rejects.toThrow('EACCES')
    expect(ctx.platform.enableAndStart).not.toHaveBeenCalled()
  })

  it('mainServiceSpec carries the runtime command, cwd and ports', () => {
    const ctx = makeCtx({ port: 1234, webPort: 5678, cwd: '/srv/marveen' })
    expect(mainServiceSpec(ctx)).toEqual({
      name: 'marveen',
      command: 'node dist/index.js',
      workingDirectory: '/srv/marveen/packages/marveen',
      env: { NODE_ENV: 'production', PORT: '1234', WEB_PORT: '5678' },
    })
  })

  it('channelsServiceSpec carries the channels command and web port', () => {
    const ctx = makeCtx({ webPort: 5678, cwd: '/srv/marveen' })
    expect(channelsServiceSpec(ctx)).toEqual({
      name: 'marveen-channels',
      command: 'node dist/channels.js',
      workingDirectory: '/srv/marveen/packages/marveen',
      env: { NODE_ENV: 'production', WEB_PORT: '5678' },
    })
  })
})
