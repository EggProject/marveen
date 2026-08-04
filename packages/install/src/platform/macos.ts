// MacosProvider: brew + launchd plist under ~/Library/LaunchAgents.
//
// installPrerequisites runs `brew install curl git` (brew itself is
// assumed to be present; the previous macOS installer walked the
// operator through the official brew installer if missing -- that
// step is out of scope here). writeServiceUnit renders a plist from
// templates/launchd/com.marveen.plist.template, with the WorkingDir +
// ProgramArguments the launchd supervisor expects. enableAndStart uses
// `launchctl load -w` so the unit survives reboots and is started on
// the next login.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type {
  PlatformProvider,
  ServiceStatus,
  ServiceUnitSpec,
  ShellAdapter,
} from './types.js'
import { SERVICE_UNIT_NAMES } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TEMPLATES_DIR = join(__dirname, 'templates', 'launchd')

let templatesDir: string = DEFAULT_TEMPLATES_DIR

export function setMacosTemplatesDir(path: string): void {
  templatesDir = path
}

export function resetMacosTemplatesDir(): void {
  templatesDir = DEFAULT_TEMPLATES_DIR
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '')
}

function envPlist(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`)
    .join('\n')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function readTemplateAsync(name: string): Promise<string> {
  return await readFile(join(templatesDir, name), 'utf-8')
}

export class MacosProvider implements PlatformProvider {
  readonly kind = 'macos' as const
  private readonly shell: ShellAdapter

  constructor(shell: ShellAdapter) {
    this.shell = shell
  }

  async installPrerequisites(): Promise<void> {
    if (!(await this.shell.which('brew'))) {
      throw new Error('Homebrew is required on macOS but was not found on PATH')
    }
    await this.shell.exec('brew', ['install', 'curl', 'git'])
  }

  async installBun(): Promise<void> {
    await this.shell.run('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' })
  }

  async installClaudeCli(): Promise<void> {
    await this.shell.run('bunx @anthropic-ai/claude-code@latest --version', { stdio: 'inherit' })
  }

  serviceUnitPath(name: string): string {
    return join(homedir(), 'Library', 'LaunchAgents', `com.marveen.${name}.plist`)
  }

  async writeServiceUnit(spec: ServiceUnitSpec): Promise<{ path: string }> {
    const tpl = await readTemplateAsync('com.marveen.plist.template')
    const rendered = renderTemplate(tpl, {
      name: spec.name,
      command: spec.command,
      workingDirectory: spec.workingDirectory ?? homedir(),
      env: envPlist(spec.env),
    })
    const path = this.serviceUnitPath(spec.name)
    await this.shell.exec('mkdir', ['-p', join(homedir(), 'Library', 'LaunchAgents')])
    await this.shell.exec('sh', ['-c', `cat > ${path} <<'__MARVEEN_PLIST__'\n${rendered}\n__MARVEEN_PLIST__`])
    return { path }
  }

  async enableAndStart(name: string): Promise<void> {
    const path = this.serviceUnitPath(name)
    await this.shell.exec('launchctl', ['load', '-w', path])
  }

  async disableAndStop(name: string): Promise<void> {
    const path = this.serviceUnitPath(name)
    await this.shell.exec('launchctl', ['unload', '-w', path])
  }

  async readServiceStatus(name: string): Promise<ServiceStatus> {
    const res = await this.shell.exec('launchctl', ['list'])
    const needle = `com.marveen.${name}`
    const match = res.stdout.split('\n').find((line) => line.includes(needle))
    if (!match) return { name, state: 'inactive' }
    // launchctl list columns: PID Status Label. Status "-" means running
    // without a PID column on macOS Sonoma+; otherwise the digit/code in
    // column 2 maps to the exit status. We treat any row containing the
    // label as "active" -- the operator wants "is it loaded", not "is
    // it currently healthy".
    const cols = match.trim().split(/\s+/)
    const exit = cols[1]
    if (exit !== undefined && exit !== '-' && /^[0-9]+$/.test(exit) && exit !== '0') {
      return { name, state: 'failed' }
    }
    return { name, state: 'active' }
  }

  async uninstall(): Promise<void> {
    await this.disableAndStop(SERVICE_UNIT_NAMES.main)
    await this.disableAndStop(SERVICE_UNIT_NAMES.channels)
  }

  async removeServiceUnit(name: string): Promise<void> {
    await this.disableAndStop(name).catch(() => {})
    await this.shell.exec('rm', ['-f', this.serviceUnitPath(name)])
  }

  async uninstallPrereqDeps(_binaries: readonly string[]): Promise<void> {
    // Warning-only: brew uninstall of curl/git would also nuke system
    // packages other apps depend on. The uninstall command surfaces a
    // warning and leaves the choice to the operator.
  }

  async uninstallBun(): Promise<void> {
    // Warning-only: same as Linux, see Phase-5 audit decision.
  }

  async uninstallClaudeCli(): Promise<void> {
    // Warning-only on macOS too: the claude shim lives under ~/.bun
    // so its lifecycle is tied to bun's.
  }

  async uninstallOllama(): Promise<void> {
    // Warning-only by Phase-5 user decision: same as LinuxProvider.
    // The listr step title surfaces this in commands/uninstall.ts.
  }
}

export const MACOS_TEMPLATE_DIR_FALLBACK = DEFAULT_TEMPLATES_DIR