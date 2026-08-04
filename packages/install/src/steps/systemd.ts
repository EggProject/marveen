// systemd step wrapper. Delegates to the LinuxProvider's
// writeServiceUnit + enableAndStart. Kept as a separate step module
// so the install command's Listr2 task list reads naturally and so a
// future "user service vs system service" toggle has a single seam.

import type { InstallerContext } from '../types.js'
import { SERVICE_UNIT_NAMES, type ServiceUnitSpec } from '../platform/types.js'

export async function stepSystemd(ctx: InstallerContext, spec: ServiceUnitSpec): Promise<{ path: string }> {
  await ctx.platform.writeServiceUnit(spec)
  await ctx.platform.enableAndStart(spec.name)
  return { path: ctx.platform.serviceUnitPath(spec.name) }
}

export function mainServiceSpec(ctx: InstallerContext): ServiceUnitSpec {
  return {
    name: SERVICE_UNIT_NAMES.main,
    command: 'node dist/index.js',
    workingDirectory: ctx.cwd,
    env: {
      NODE_ENV: 'production',
      PORT: String(ctx.port),
      WEB_PORT: String(ctx.webPort),
    },
  }
}

export function channelsServiceSpec(ctx: InstallerContext): ServiceUnitSpec {
  return {
    name: SERVICE_UNIT_NAMES.channels,
    command: 'node dist/channels.js',
    workingDirectory: ctx.cwd,
    env: {
      NODE_ENV: 'production',
      WEB_PORT: String(ctx.webPort),
    },
  }
}