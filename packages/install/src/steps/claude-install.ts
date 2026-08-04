// Claude Code install step.
//
// Uses `bunx @anthropic-ai/claude-code@latest` (or npx fallback when
// bun is unavailable). The shell adapter runs the command with
// stdio: 'inherit' so the operator sees the installer's progress
// directly. The step is idempotent: re-running it just refreshes the
// install.

import type { InstallerContext } from '../types.js'

export async function stepClaudeInstall(ctx: InstallerContext): Promise<void> {
  await ctx.platform.installClaudeCli()
  ctx.claudeInstalled = Boolean(await ctx.shell.which('claude'))
}