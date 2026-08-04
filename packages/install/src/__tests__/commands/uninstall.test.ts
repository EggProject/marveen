import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureOutput, makePlatform, makeShell } from '../_helpers.js'

const stubs = vi.hoisted(() => ({
  shell: undefined as unknown as ReturnType<typeof import('../_helpers.js').makeShell>,
  platform: undefined as unknown as ReturnType<typeof import('../_helpers.js').makePlatform>,
  set: undefined as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../../shell/exec.js', () => ({ createShell: () => stubs.shell }))
vi.mock('../../platform/index.js', () => ({ createPlatformProvider: () => stubs.platform }))
vi.mock('../../state/conf.js', () => ({ createState: () => ({ set: stubs.set, get: () => 'skip' }) }))

const { uninstallCommand } = await import('../../commands/uninstall.js')
const { resetPromptImpls, setPromptImpls } = await import('../../ui/prompts.js')
const { setColorsEnabled } = await import('../../ui/theme.js')
const { initLocale } = await import('../../locale/index.js')

class ExitSentinel extends Error {}

beforeEach(() => {
  stubs.shell = makeShell()
  stubs.platform = makePlatform()
  stubs.set = vi.fn()
  uninstallCommand.setOptionValue('force', undefined)
  uninstallCommand.setOptionValue('yes', undefined)
  setColorsEnabled(false)
  initLocale('hu')
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSentinel(String(code)) }) as never)
})
afterEach(() => {
  resetPromptImpls()
  vi.restoreAllMocks()
})

function answerConfirm(value: boolean): { asked: Array<{ message: string; default: boolean }> } {
  const asked: Array<{ message: string; default: boolean }> = []
  setPromptImpls({ confirm: (async (o: { message: string; default: boolean }) => { asked.push(o); return value }) as never })
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
  it('asks for confirmation before removing anything', async () => {
    const { asked } = answerConfirm(true)
    const { stdout } = await run()
    expect(asked[0]).toEqual({ message: 'Biztosan törlöd a Marveen telepítést? (igen/nem)', default: false })
    expect(stubs.platform.uninstall).toHaveBeenCalledOnce()
    expect(stdout).toContain('Marveen eltávolítva')
  })

  it('cancels with exit code 130 when the operator declines', async () => {
    answerConfirm(false)
    const { stdout, error } = await run()
    expect(stdout).toContain('Megszakítva')
    expect(error).toBeInstanceOf(ExitSentinel)
    expect((error as Error).message).toBe('130')
    expect(stubs.platform.uninstall).not.toHaveBeenCalled()
  })

  it('--force skips the prompt', async () => {
    const { asked } = answerConfirm(false)
    await run(['--force'])
    expect(asked).toHaveLength(0)
    expect(stubs.platform.uninstall).toHaveBeenCalledOnce()
  })

  it('--yes skips the prompt', async () => {
    const { asked } = answerConfirm(false)
    await run(['--yes'])
    expect(asked).toHaveLength(0)
    expect(stubs.platform.uninstall).toHaveBeenCalledOnce()
  })

  it('records the uninstall timestamp and resets the provider', async () => {
    await run(['--force'])
    expect(stubs.set).toHaveBeenNthCalledWith(1, 'uninstalledAt', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(stubs.set).toHaveBeenNthCalledWith(2, 'lastProvider', 'skip')
  })

  it('reports a failing platform uninstall on stderr but still finishes', async () => {
    stubs.platform.uninstall.mockRejectedValue(new Error('systemctl missing'))
    const { stdout, stderr } = await run(['--force'])
    expect(stderr).toContain('Uninstall step failed: systemctl missing')
    expect(stdout).toContain('Marveen eltávolítva')
    expect(stubs.set).toHaveBeenCalledTimes(2)
  })

  it('has a Hungarian description', () => {
    expect(uninstallCommand.description()).toBe('Marveen telepítés eltávolítása')
    expect(uninstallCommand.name()).toBe('uninstall')
  })
})
