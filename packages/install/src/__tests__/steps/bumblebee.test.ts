import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { stepBumblebee } from '../../steps/bumblebee.js'
import { makeCtx, makeFs } from '../_helpers.js'

const DIR = join('/proj', 'seed-scheduled-tasks')
const CRON = join(DIR, 'bumblebee-hygiene-scan.cron')
const JSON_FILE = join(DIR, 'bumblebee-hygiene-scan.json')

describe('steps/bumblebee', () => {
  it('creates both seed files when the dir is empty', async () => {
    const ctx = makeCtx()
    const res = await stepBumblebee(ctx)
    expect(ctx.fs.ensureDir).toHaveBeenCalledWith(DIR)
    expect(res.created).toEqual([CRON, JSON_FILE])
    expect(res.existing).toEqual([])
    expect(ctx.fs.atomicWrite).toHaveBeenCalledTimes(2)
  })

  it('writes the cron line with mode 0644', async () => {
    const ctx = makeCtx()
    await stepBumblebee(ctx)
    expect(ctx.fs.atomicWrite).toHaveBeenNthCalledWith(
      1,
      CRON,
      '0 4 * * * /usr/bin/env bash -lc "node scripts/hygiene-scan.mjs"\n',
      0o644,
    )
  })

  it('writes the scheduled task descriptor as pretty JSON', async () => {
    const ctx = makeCtx()
    await stepBumblebee(ctx)
    const [, content, mode] = ctx.fs.atomicWrite.mock.calls[1]!
    expect(mode).toBe(0o644)
    expect(JSON.parse(String(content))).toEqual({
      taskId: 'bumblebee-hygiene-scan',
      description: 'Nightly hygiene scan (marveen)',
      command: 'node scripts/hygiene-scan.mjs',
      schedule: '0 4 * * *',
      tags: ['marveen', 'scheduled', 'hygiene'],
    })
    expect(String(content).endsWith('\n')).toBe(true)
  })

  it('leaves existing files untouched', async () => {
    const ctx = makeCtx({ fs: makeFs({ [CRON]: 'x', [JSON_FILE]: '{}' }) })
    const res = await stepBumblebee(ctx)
    expect(res.created).toEqual([])
    expect(res.existing).toEqual([CRON, JSON_FILE])
    expect(ctx.fs.atomicWrite).not.toHaveBeenCalled()
  })

  it('creates only the missing file', async () => {
    const ctx = makeCtx({ fs: makeFs({ [CRON]: 'x' }) })
    const res = await stepBumblebee(ctx)
    expect(res.existing).toEqual([CRON])
    expect(res.created).toEqual([JSON_FILE])
  })
})
