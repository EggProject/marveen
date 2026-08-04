// Platform-agnostic service management contract. The interface lives
// here (not in types.ts) so the platform/ folder owns the full service
// management surface and the install steps depend only on this.
//
// The two implementations are LinuxProvider (systemd --user unit) and
// MacosProvider (launchd plist under ~/Library/LaunchAgents). Both must
// template their unit files from src/platform/templates/* and substitute
// the actual command/env at write time.

import type { ServiceUnitSpec, ServiceStatus } from '../types.js'

export type { ServiceUnitSpec, ServiceStatus }

export interface ServiceTemplate {
  /** Service identifier used in unit file names and platform commands. */
  readonly name: string
  /** Path to the template string before substitution. */
  readonly templatePath: string
}

export interface PlatformProvider {
  readonly kind: 'linux' | 'macos'
  installPrerequisites(): Promise<void>
  installBun(): Promise<void>
  installClaudeCli(): Promise<void>
  writeServiceUnit(spec: ServiceUnitSpec): Promise<{ path: string }>
  enableAndStart(name: string): Promise<void>
  disableAndStop(name: string): Promise<void>
  readServiceStatus(name: string): Promise<ServiceStatus>
  uninstall(): Promise<void>
  serviceUnitPath(name: string): string
}

export const SERVICE_UNIT_NAMES = {
  main: 'marveen',
  channels: 'marveen-channels',
} as const

export type ServiceUnitKey = keyof typeof SERVICE_UNIT_NAMES