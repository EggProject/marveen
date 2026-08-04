// Prerequisite check: confirm the host runs a supported OS and has the
// minimum toolchain (node, npm, git, curl, bun if available).
//
// Detects WSL via /proc/version so the operator gets a clear warning
// when systemd --user would not work. The check is intentionally
// non-fatal for missing optional tools; only OS support and node/npm
// presence throw.

import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import type { InstallerContext } from '../types.js'

const REQUIRED_BINS = ['node', 'npm', 'git', 'curl'] as const

export interface PrereqResult {
  os: string
  isWsl: boolean
  missingRequired: string[]
  hasBun: boolean
  hasClaude: boolean
}

export async function stepPrereq(ctx: InstallerContext): Promise<PrereqResult> {
  const os = `${process.platform} ${release()}`
  const isWsl = await detectWsl()

  const missingRequired: string[] = []
  for (const bin of REQUIRED_BINS) {
    if (!(await ctx.shell.which(bin))) missingRequired.push(bin)
  }

  const hasBun = Boolean(await ctx.shell.which('bun'))
  const hasClaude = Boolean(await ctx.shell.which('claude'))

  ctx.bunInstalled = hasBun
  ctx.claudeInstalled = hasClaude

  if (isWsl) {
    process.stderr.write('WSL detected: systemd --user may not be available; service unit will be skipped\n')
  }
  if (missingRequired.length > 0) {
    throw new Error(`Missing required tools: ${missingRequired.join(', ')}`)
  }

  return { os, isWsl, missingRequired, hasBun, hasClaude }
}

export async function detectWsl(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    const version = await readFile('/proc/version', 'utf-8')
    return /microsoft|wsl/i.test(version)
  } catch {
    return false
  }
}