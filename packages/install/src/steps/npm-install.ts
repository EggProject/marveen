// Dependency install step.
//
// Prefers bun (faster, cached, monorepo-aware). Falls back to npm ci
// when bun is missing -- the install lockfile should match either
// way because the workspace uses both lockfiles (bun.lock + a
// package-lock.json shim for npm-only CI).

import { join } from 'node:path'
import type { InstallerContext } from '../types.js'

export async function stepNpmInstall(ctx: InstallerContext): Promise<{ manager: 'bun' | 'npm' }> {
  const cwd = join(ctx.cwd, 'packages', 'marveen')
  if (await ctx.shell.which('bun')) {
    const result = await ctx.shell.exec('bun', ['install', '--frozen-lockfile'], { cwd, stdio: 'inherit' })
    if (result.exitCode !== 0) throw new Error(`Dependency installation failed: ${result.stderr || `exit code ${result.exitCode}`}`)
    return { manager: 'bun' }
  }
  const result = await ctx.shell.exec('npm', ['ci'], { cwd, stdio: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`Dependency installation failed: ${result.stderr || `exit code ${result.exitCode}`}`)
  return { manager: 'npm' }
}