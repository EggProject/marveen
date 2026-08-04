// Bumblebee hygiene-scan scheduled task installer.
//
// Touches the two seed files under seed-scheduled-tasks/bumblebee-...
// that the runtime schedules. The install step creates them in the
// project's scheduled-tasks dir when missing, so a fresh checkout has
// the cron entry on the first run. The shell-level wiring (cron /
// launchd) is the runtime's responsibility, not the installer's.

import { join } from 'node:path'
import type { InstallerContext } from '../types.js'

const SEED_FILES = ['bumblebee-hygiene-scan.cron', 'bumblebee-hygiene-scan.json'] as const

export interface BumblebeeResult {
  created: string[]
  existing: string[]
}

export async function stepBumblebee(ctx: InstallerContext): Promise<BumblebeeResult> {
  const targetDir = join(ctx.cwd, 'seed-scheduled-tasks')
  await ctx.fs.ensureDir(targetDir)
  const created: string[] = []
  const existing: string[] = []

  for (const name of SEED_FILES) {
    const path = join(targetDir, name)
    if (await ctx.fs.exists(path)) {
      existing.push(path)
      continue
    }
    const content = name.endsWith('.cron')
      ? '0 4 * * * /usr/bin/env bash -lc "node scripts/hygiene-scan.mjs"\n'
      : JSON.stringify({
          taskId: 'bumblebee-hygiene-scan',
          description: 'Nightly hygiene scan (marveen)',
          command: 'node scripts/hygiene-scan.mjs',
          schedule: '0 4 * * *',
          tags: ['marveen', 'scheduled', 'hygiene'],
        }, null, 2) + '\n'
    await ctx.fs.atomicWrite(path, content, 0o644)
    created.push(path)
  }

  return { created, existing }
}