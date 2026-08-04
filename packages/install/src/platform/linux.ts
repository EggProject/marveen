// LinuxProvider: apt/dnf/yum package detection + systemd --user units.
//
// installPrerequisites detects the available package manager from
// `which` and runs the matching `install -y` command. installBun runs
// the canonical curl|bash installer. writeServiceUnit reads a template
// from templates/systemd/, substitutes {{command}}/{{env}}/etc., and
// drops the file under ~/.config/systemd/user/. enableAndStart uses
// systemctl --user (XDG_RUNTIME_DIR-bound) so the unit lives in the
// operator's session and survives across reboots through linger.

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
const DEFAULT_TEMPLATES_DIR = join(__dirname, 'templates', 'systemd')

let templatesDir: string = DEFAULT_TEMPLATES_DIR

export function setLinuxTemplatesDir(path: string): void {
  templatesDir = path
}

export function resetLinuxTemplatesDir(): void {
  templatesDir = DEFAULT_TEMPLATES_DIR
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '')
}

function envString(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')
}

async function readTemplateAsync(name: string): Promise<string> {
  return await readFile(join(templatesDir, name), 'utf-8')
}

export class LinuxProvider implements PlatformProvider {
  readonly kind = 'linux' as const
  private readonly shell: ShellAdapter

  constructor(shell: ShellAdapter) {
    this.shell = shell
  }

  async installPrerequisites(): Promise<void> {
    if (await this.shell.which('apt-get')) {
      await this.shell.exec('sudo', ['apt-get', 'update'])
      await this.shell.exec('sudo', ['apt-get', 'install', '-y', 'curl', 'git', 'ca-certificates'])
      return
    }
    if (await this.shell.which('dnf')) {
      await this.shell.exec('sudo', ['dnf', 'install', '-y', 'curl', 'git', 'ca-certificates'])
      return
    }
    if (await this.shell.which('yum')) {
      await this.shell.exec('sudo', ['yum', 'install', '-y', 'curl', 'git', 'ca-certificates'])
      return
    }
    throw new Error('Neither apt-get, dnf nor yum found on PATH')
  }

  async installBun(): Promise<void> {
    await this.shell.run('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' })
  }

  async installClaudeCli(): Promise<void> {
    await this.shell.run('bunx @anthropic-ai/claude-code@latest --version', { stdio: 'inherit' })
  }

  serviceUnitPath(name: string): string {
    return join(homedir(), '.config', 'systemd', 'user', `${name}.service`)
  }

  async writeServiceUnit(spec: ServiceUnitSpec): Promise<{ path: string }> {
    const templateName = spec.name === SERVICE_UNIT_NAMES.main
      ? 'marveen.service.template'
      : 'marveen-channels.service.template'
    const tpl = await readTemplateAsync(templateName)
    const rendered = renderTemplate(tpl, {
      workingDirectory: spec.workingDirectory ?? '/tmp',
      command: spec.command,
      env: envString(spec.env),
      envFile: spec.env?.['ENV_FILE'] ?? '',
    })
    const path = this.serviceUnitPath(spec.name)
    await this.shell.exec('mkdir', ['-p', join(homedir(), '.config', 'systemd', 'user')])
    await this.shell.exec('sh', ['-c', `cat > ${path} <<'__MARVEEN_UNIT__'\n${rendered}\n__MARVEEN_UNIT__`])
    return { path }
  }

  async enableAndStart(name: string): Promise<void> {
    await this.shell.exec('systemctl', ['--user', 'daemon-reload'])
    await this.shell.exec('systemctl', ['--user', 'enable', '--now', `${name}.service`])
  }

  async disableAndStop(name: string): Promise<void> {
    await this.shell.exec('systemctl', ['--user', 'disable', '--now', `${name}.service`])
  }

  async readServiceStatus(name: string): Promise<ServiceStatus> {
    const res = await this.shell.exec('systemctl', ['--user', 'is-active', `${name}.service`])
    return { name, state: mapSystemdState(res.stdout.trim()) }
  }

  async uninstall(): Promise<void> {
    await this.disableAndStop(SERVICE_UNIT_NAMES.main)
    await this.disableAndStop(SERVICE_UNIT_NAMES.channels)
  }
}

function mapSystemdState(raw: string): ServiceStatus['state'] {
  if (raw === 'active') return 'active'
  if (raw === 'inactive') return 'inactive'
  if (raw === 'failed') return 'failed'
  return 'unknown'
}

export const TEMPLATE_DIR_FALLBACK = DEFAULT_TEMPLATES_DIR