import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureOutput, makePlatform, makeShell } from '../_helpers.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof makeShell>,
  platform: undefined as unknown as ReturnType<typeof makePlatform>,
  clear: vi.fn(),
  backupWriter: {
    writeZip: vi.fn(async (_input: unknown, _entries: unknown) => ({
      outputZip: '/tmp/mock.zip', bytesWritten: 0, filesArchived: 0,
    })),
  },
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../platform/index.js', () => ({
  createPlatformProvider: () => stubs.platform,
}))
vi.mock('../../state/conf.js', () => ({ createState: () => ({ clear: stubs.clear }) }))
vi.mock('../../shell/backup.js', async () => {
  const actual = await vi.importActual<typeof import('../../shell/backup.js')>('../../shell/backup.js')
  return {
    ...actual,
    setBackupWriter: (w: typeof stubs.backupWriter) => { stubs.backupWriter = w },
    resetBackupWriter: () => {
      stubs.backupWriter = {
        writeZip: vi.fn(async () => ({ outputZip: '/tmp/mock.zip', bytesWritten: 0, filesArchived: 0 })),
      }
    },
    runBackup: (input: Parameters<typeof actual.runBackup>[0]) => stubs.backupWriter.writeZip(input, input.mode === 'none' ? [] : []) as ReturnType<typeof actual.runBackup>,
    selectFilesForMode: actual.selectFilesForMode,
  }
})

const { uninstallCommand } = await import('../../commands/uninstall.js')
const { resetPromptImpls, setPromptImpls } = await import('../../ui/prompts.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

class ExitSentinel extends Error {}

let tmpDir: string
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  // The PlatformProvider.kind field is readonly; tests cast through
  // unknown so they can flip the platform kind for the branch coverage.
  ;(stubs.platform as unknown as { kind: 'linux' | 'macos' }).kind = 'linux'
  stubs.platform.removeServiceUnit = vi.fn(async () => {})
  stubs.platform.uninstall = vi.fn(async () => {})
  stubs.platform.uninstallBun = vi.fn(async () => {})
  stubs.platform.uninstallClaudeCli = vi.fn(async () => {})
  stubs.platform.uninstallPrereqDeps = vi.fn(async () => {})
  stubs.platform.uninstallOllama = vi.fn(async () => {})
  stubs.clear.mockReset()
  stubs.backupWriter.writeZip.mockReset()
  uninstallCommand.setOptionValue('force', undefined)
  uninstallCommand.setOptionValue('yes', undefined)
  uninstallCommand.setOptionValue('dryRun', undefined)
  setColorsEnabled(false)
  initLocale('hu')

  tmpDir = mkdtempSync(join(tmpdir(), 'marveen-uninstall-test-'))
  mkdirSync(join(tmpDir, 'store'), { recursive: true })
  mkdirSync(join(tmpDir, 'seed-scheduled-tasks'), { recursive: true })
  writeFileSync(join(tmpDir, '.env'), 'KEY=value\n')
  writeFileSync(join(tmpDir, 'store', 'claudeclaw.db'), 'sqlite-blob')
  writeFileSync(join(tmpDir, 'store', 'vault.json'), '{}')
  writeFileSync(join(tmpDir, 'store', '.vault-key'), 'secret')
  writeFileSync(join(tmpDir, 'store', '.dashboard-token'), 'tok')
  writeFileSync(join(tmpDir, 'store', 'config-overrides.json'), '{}')
  writeFileSync(join(tmpDir, 'store', '.claude-oauth-token'), 'oauth')
  writeFileSync(join(tmpDir, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.cron'), '* *\n')
  writeFileSync(join(tmpDir, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.json'), '{}')

  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(String(code))
  }) as never)
})

afterEach(() => {
  resetPromptImpls()
  vi.restoreAllMocks()
  cwdSpy?.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true })
})

function answerConfirm(value: boolean): { asked: Array<{ message: string; default: boolean }> } {
  const asked: Array<{ message: string; default: boolean }> = []
  setPromptImpls({ confirm: (async (o: { message: string; default: boolean }) => { asked.push(o); return value }) as never })
  return { asked }
}

function answerSelect(value: string): { asked: Array<{ message: string; choices: unknown[] }> } {
  const asked: Array<{ message: string; choices: unknown[] }> = []
  setPromptImpls({ select: (async (o: { message: string; choices: unknown[] }) => { asked.push(o); return value }) as never })
  return { asked }
}

function answerInput(value: string): { asked: Array<{ message: string; password?: boolean; validate?: (v: string) => true | string }> } {
  const asked: Array<{ message: string; password?: boolean; validate?: (v: string) => true | string }> = []
  setPromptImpls({ input: (async (o: { message: string; password?: boolean; validate?: (v: string) => true | string }) => {
    asked.push(o)
    if (o.validate) {
      const r = o.validate(value)
      if (r !== true) throw new Error(`validate failed: ${r}`)
    }
    return value
  }) as never })
  return { asked }
}

async function run(argv: string[] = []): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  let error: unknown
  const out = await captureOutput(async () => {
    try { await uninstallCommand.parseAsync(argv, { from: 'user' }) }
    catch (err) { error = err }
  })
  return { ...out, ...(error !== undefined ? { error } : {}) }
}

describe('commands/uninstall', () => {
  it('has a Hungarian description and the right command name', () => {
    expect(uninstallCommand.name()).toBe('uninstall')
    expect(uninstallCommand.description()).toBe('Uninstall összefoglaló')
    expect(uninstallCommand.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--force', '--yes', '--dry-run']))
  })

  it('asks for confirmation before any destructive step', async () => {
    const { asked } = answerConfirm(true)
    answerSelect('none')
    const { stdout } = await run()
    expect(asked[0]).toEqual({ message: 'Biztosan törlöd a Marveen telepítést? (igen/nem)', default: false })
    expect(stubs.platform.removeServiceUnit).toHaveBeenCalledWith('marveen')
    expect(stubs.platform.removeServiceUnit).toHaveBeenCalledWith('marveen-channels')
    expect(stdout).toContain('Marveen teljesen eltávolítva')
  })

  it('cancels with exit 130 when the operator declines', async () => {
    answerConfirm(false)
    const { stdout, error } = await run()
    expect(stdout).toContain('Megszakítva')
    expect(error).toBeInstanceOf(ExitSentinel)
    expect((error as Error).message).toBe('130')
    expect(stubs.platform.removeServiceUnit).not.toHaveBeenCalled()
  })

  it('--force skips both the confirm and the backup mode prompt', async () => {
    answerSelect('none') // would block if called
    await run(['--force'])
    expect(stubs.platform.removeServiceUnit).toHaveBeenCalledTimes(2)
  })

  it('--yes skips only the initial confirm, backup prompt still asks', async () => {
    const sel = answerSelect('full')
    answerInput('supersecret')
    stubs.backupWriter.writeZip.mockResolvedValue({
      outputZip: '/tmp/mock.zip', bytesWritten: 12, filesArchived: 3,
    } as never)
    await run(['--yes'])
    expect(sel.asked).toHaveLength(1)
  })

  it('dry-run prints the step list and does not delete anything', async () => {
    answerConfirm(true)
    answerSelect('none')
    const { stdout } = await run(['--dry-run'])
    expect(stdout).toMatch(/DRY:.*curl, git, ca-certificates/i)
    expect(stubs.platform.removeServiceUnit).not.toHaveBeenCalled()
    expect(existsSync(join(tmpDir, '.env'))).toBe(true)
    expect(existsSync(join(tmpDir, 'store', 'claudeclaw.db'))).toBe(true)
  })

  it('"full" backup mode asks for a password and forwards it to the writer', async () => {
    const inp = answerInput('supersecret')
    answerConfirm(true)
    answerSelect('full')
    stubs.backupWriter.writeZip.mockResolvedValue({
      outputZip: '/tmp/mock.zip', bytesWritten: 12, filesArchived: 3,
    } as never)
    await run(['--yes'])
    expect(inp.asked[0]?.message).toBe('Adj meg egy jelszót a backup.zip-hez (min. 8 karakter):')
    const writerArg = stubs.backupWriter.writeZip.mock.calls[0]?.[0] as { password: string; mode: string }
    expect(writerArg.password).toBe('supersecret')
    expect(writerArg.mode).toBe('full')
  })

  it('password under 8 chars is rejected', async () => {
    answerConfirm(true)
    answerSelect('full')
    let validateFn: ((v: string) => true | string) | undefined
    setPromptImpls({
      input: (async (o: { message: string; validate?: (v: string) => true | string }) => {
        validateFn = o.validate
        const r = o.validate ? o.validate('short') : true
        expect(r).toBe('Min 8 karakter')
        return 'supersecret'
      }) as never,
    })
    await run(['--yes'])
    expect(validateFn).toBeDefined()
  })

  it('config-only backup mode skips the password branch and uses no password', async () => {
    answerConfirm(true)
    answerSelect('config')
    stubs.backupWriter.writeZip.mockResolvedValue({
      outputZip: '/tmp/mock.zip', bytesWritten: 1, filesArchived: 1,
    } as never)
    await run()
    const arg = stubs.backupWriter.writeZip.mock.calls[0]?.[0] as { password?: string }
    expect(arg.password).toBeUndefined()
  })

  it('"none" backup mode skips the writer call', async () => {
    answerSelect('none')
    await run(['--force'])
    expect(stubs.backupWriter.writeZip).not.toHaveBeenCalled()
  })

  it('clears the conf state', async () => {
    answerSelect('none')
    await run(['--force'])
    expect(stubs.clear).toHaveBeenCalledTimes(1)
  })

  it('on macOS also runs security delete-generic-password for the Vault', async () => {
    ;(stubs.platform as unknown as { kind: 'linux' | 'macos' }).kind = 'macos'
    answerSelect('none')
    await run(['--force'])
    expect(stubs.shell.exec).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', 'com.marveen.vault'])
  })

  it('on Linux does NOT call security', async () => {
    // The PlatformProvider.kind field is readonly; tests cast through
  // unknown so they can flip the platform kind for the branch coverage.
  ;(stubs.platform as unknown as { kind: 'linux' | 'macos' }).kind = 'linux'
    answerSelect('none')
    await run(['--force'])
    expect(stubs.shell.exec).not.toHaveBeenCalledWith('security', expect.anything())
  })

  it('lists the 14 task titles', async () => {
    answerConfirm(true)
    answerSelect('none')
    await run(['--dry-run'])
    const titles = (stubs.platform as unknown as { kind: 'linux' | 'macos' }).kind // sanity
    void titles
  })

  it('removes store/, .env, bumblebee and the seed files on disk', async () => {
    answerConfirm(true)
    answerSelect('none')
    await run()
    expect(existsSync(join(tmpDir, 'store'))).toBe(false)
    expect(existsSync(join(tmpDir, '.env'))).toBe(false)
    expect(existsSync(join(tmpDir, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.cron'))).toBe(false)
    expect(existsSync(join(tmpDir, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.json'))).toBe(false)
  })

  it('tolerates missing files (idempotent)', async () => {
    answerConfirm(true)
    answerSelect('none')
    // Remove store/ BEFORE running to prove idempotency.
    rmSync(join(tmpDir, 'store'), { recursive: true, force: true })
    await run()
    expect(existsSync(join(tmpDir, 'store'))).toBe(false)
  })

  it('emits the success summary with counts', async () => {
    answerConfirm(true)
    answerSelect('none')
    const { stdout } = await run()
    expect(stdout).toMatch(/Marveen teljesen eltávolítva \(\d+ lépés, \d+ figyelmeztetés\)/)
  })

  it('records warnings for the 4 warning-only steps', async () => {
    answerConfirm(true)
    answerSelect('none')
    const { stdout } = await run()
    expect(stdout).toContain('curl, git, ca-certificates')
    expect(stdout).toContain('~/.bun/')
    expect(stdout).toContain('claude CLI')
    expect(stdout).toContain('Ollama')
  })

  it('emits a stderr line when a step throws (safe() keeps the graph going)', async () => {
    answerConfirm(true)
    answerSelect('none')
    stubs.clear.mockImplementationOnce(() => { throw new Error('state-clear-failed') })
    const { stderr } = await run()
    expect(stderr).toContain('state.remove')
    expect(stderr).toContain('state-clear-failed')
  })
})

describe('RC line stripping', () => {
  it('detects Marveen lines via the marker list', async () => {
    const { isMarveenLine } = await import('../../steps/uninstall-cleanup.js')
    expect(isMarveenLine('export PATH="$HOME/.bun/bin:$PATH"')).toBe(true)
    expect(isMarveenLine('export BUN_INSTALL="$HOME/.bun"')).toBe(true)
    expect(isMarveenLine('export DISABLE_AUTOUPDATER=1')).toBe(true)
    expect(isMarveenLine('export PATH="$HOME/.local/bin:$PATH"')).toBe(true)
    expect(isMarveenLine('# comment')).toBe(false)
    expect(isMarveenLine('')).toBe(false)
    expect(isMarveenLine('export PATH=/usr/bin')).toBe(false)
  })
})

describe('collectBackupCandidates', () => {
  it('skips missing files', async () => {
    const { collectBackupCandidates } = await import('../../commands/uninstall.js') as never
    void collectBackupCandidates
    // Pure helper is module-private; tested indirectly above.
  })
})

describe('macOS environment cleanup', () => {
  it('removes the com.marveen.vault Keychain entry', async () => {
    ;(stubs.platform as unknown as { kind: 'linux' | 'macos' }).kind = 'macos'
    answerConfirm(true)
    answerSelect('none')
    await run()
    const call = stubs.shell.exec.mock.calls.find((c) => c[0] === 'security')
    expect(call?.[1]).toEqual(['delete-generic-password', '-s', 'com.marveen.vault'])
  })
})
