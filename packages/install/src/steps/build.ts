// TypeScript build step for packages/marveen.
//
// Runs `bunx tsc` (or `npx tsc` fallback). The output goes to
// packages/marveen/dist and is consumed by the systemd unit's
// ExecStart. Strict mode failures bubble up; the install must not
// proceed with a half-built runtime.

import { join } from 'node:path'
import type { InstallerContext } from '../types.js'

export async function stepBuild(ctx: InstallerContext): Promise<{ manager: 'bun' | 'npm' }> {
  const cwd = join(ctx.cwd, 'packages', 'marveen')
  if (await ctx.shell.which('bun')) {
    const result = await ctx.shell.exec('bunx', ['tsc'], { cwd, stdio: 'inherit' })
    if (result.exitCode !== 0) throw new Error(`TypeScript build failed: ${result.stderr || `exit code ${result.exitCode}`}`)
    return { manager: 'bun' }
  }
  const result = await ctx.shell.exec('npx', ['tsc'], { cwd, stdio: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`TypeScript build failed: ${result.stderr || `exit code ${result.exitCode}`}`)
  return { manager: 'npm' }
}