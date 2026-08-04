// Shared TypeScript types for the installer.
//
// ProviderChoice describes the operator's install-time selection. The
// installer collects it from the prompt wizard and hands it to the vault
// push step. ServiceUnitSpec/ServiceStatus describe the platform-provider
// service interface. InstallerContext is the mutable state Listr2 threads
// between install tasks; every step reads/writes a slice of it.

export type ProviderMode =
  | 'anthropic'
  | 'minimax'
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'skip'

export interface ProviderChoice {
  mode: ProviderMode
  vaultId?: string
  vaultLabel?: string
  vaultValue?: string
  baseUrlKey?: string
  baseUrlValue?: string
}

export interface InstallerContext {
  port: number
  webPort: number
  lang: 'hu' | 'en'
  nonInteractive: boolean
  skipUpdate: boolean
  preSelectedProvider?: ProviderMode
  bunInstalled: boolean
  claudeInstalled: boolean
  botName: string
  brandName: string
  ownerName: string
  dashboardToken: string
  providerChoice?: ProviderChoice
  ollamaUrl: string
  ollamaSkip: boolean
  ollamaInstall: boolean
  platform: PlatformProvider
  shell: ShellAdapter
  fs: FsAdapter
  fetch: typeof fetch
  cwd: string
}

export interface ServiceUnitSpec {
  name: string
  command: string
  env?: Record<string, string>
  workingDirectory?: string
  user?: string
}

export interface ServiceStatus {
  name: string
  state: 'active' | 'inactive' | 'failed' | 'unknown'
  pid?: number
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

export interface ShellAdapter {
  exec(file: string, args?: readonly string[], opts?: ShellExecOptions): Promise<ShellResult>
  run(cmd: string, opts?: ShellExecOptions): Promise<ShellResult>
  which(name: string): Promise<string | null>
}

export interface ShellExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdio?: 'inherit' | 'pipe'
  shell?: boolean
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface FsAdapter {
  atomicWrite(path: string, content: string, mode?: number): Promise<void>
  ensureDir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}