// Platform factory: dispatch on process.platform to the right
// PlatformProvider. Linux and macOS are the only supported targets;
// Windows is out of scope (the previous installer shipped a .ps1
// variant but the bun workspace removes it).

import type { PlatformProvider } from './types.js'
import { LinuxProvider } from './linux.js'
import { MacosProvider } from './macos.js'
import type { ShellAdapter } from '../types.js'
import { t } from '../locale/index.js'

export function createPlatformProvider(shell: ShellAdapter): PlatformProvider {
  if (process.platform === 'linux') return new LinuxProvider(shell)
  if (process.platform === 'darwin') return new MacosProvider(shell)
  throw new Error(t('error.not-supported', process.platform))
}

export { LinuxProvider } from './linux.js'
export { MacosProvider } from './macos.js'
export type { PlatformProvider } from './types.js'