// Bun install step.
//
// Delegates to the active platform provider (apt-get/brew is the
// prereq, then `curl -fsSL https://bun.sh/install | bash`). The skip
// flag is set in the caller based on `which bun`, so this step only
// runs when bun is missing.

import type { InstallerContext } from '../types.js'

export interface BunInstallResult {
  installed: boolean
}

export async function stepBunInstall(ctx: InstallerContext): Promise<BunInstallResult> {
  if (await ctx.shell.which('bun')) {
    ctx.bunInstalled = true
    return { installed: false }
  }
  await ctx.platform.installBun()
  ctx.bunInstalled = Boolean(await ctx.shell.which('bun'))
  if (!ctx.bunInstalled) {
    throw new Error('bun install completed but binary is still not on PATH')
  }
  return { installed: true }
}