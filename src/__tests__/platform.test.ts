import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Pinning cover for `detect()` in src/platform.ts. The module-level PLATFORM
// const is evaluated exactly once at import time, so the only way to observe
// each branch is to mutate process.platform / process.env['MARVEEN_ENV'] /
// DISPLAY-family vars BEFORE re-importing the module with vi.resetModules().
//
// Uncovered without these tests: lines 12-16 (linux branch with display
// detection + the non-darwin non-linux fallback) and the three paths of the
// `||` chain at line 10.

const mockExecSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => mockExistsSync(p) }
})

const savedPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
const savedArchDesc = Object.getOwnPropertyDescriptor(process, 'arch')
const savedMarveenEnv = process.env['MARVEEN_ENV']
const savedDisplay = process.env['DISPLAY']
const savedWayland = process.env['WAYLAND_DISPLAY']
const savedXdg = process.env['XDG_SESSION_TYPE']

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

function clearDetectInputs(): void {
  delete process.env['MARVEEN_ENV']
  delete process.env['DISPLAY']
  delete process.env['WAYLAND_DISPLAY']
  delete process.env['XDG_SESSION_TYPE']
}

async function importPlatformFresh(): Promise<typeof import('../platform.js')> {
  vi.resetModules()
  return await import('../platform.js')
}

beforeEach(() => {
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
  clearDetectInputs()
})

afterEach(() => {
  if (savedPlatformDesc) Object.defineProperty(process, 'platform', savedPlatformDesc)
  else delete (process as { platform?: NodeJS.Platform }).platform
  if (savedArchDesc) Object.defineProperty(process, 'arch', savedArchDesc)
  clearDetectInputs()
  if (savedMarveenEnv !== undefined) process.env['MARVEEN_ENV'] = savedMarveenEnv
  if (savedDisplay !== undefined) process.env['DISPLAY'] = savedDisplay
  if (savedWayland !== undefined) process.env['WAYLAND_DISPLAY'] = savedWayland
  if (savedXdg !== undefined) process.env['XDG_SESSION_TYPE'] = savedXdg
})

// ---------------------------------------------------------------------------
// detect() -- platform branching (the lines 11-16 block).
// ---------------------------------------------------------------------------

describe('detect() -- process.platform branches', () => {
  it('returns macos when process.platform is darwin', async () => {
    setPlatform('darwin')
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('macos')
  })

  it('returns linux-server when process.platform is linux and DISPLAY/WAYLAND/XDG are all unset', async () => {
    // The `linux-server` arm of the `hasDisplay ?` ternary (line 14 else).
    setPlatform('linux')
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-server')
  })

  it('returns linux-gui when process.platform is linux and DISPLAY is set', async () => {
    // The `linux-gui` arm of the `hasDisplay ?` ternary (line 14 then),
    // hit through the first operand of the DISPLAY-family `||` chain.
    setPlatform('linux')
    process.env['DISPLAY'] = ':0'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-gui')
  })

  it('returns linux-gui when process.platform is linux and WAYLAND_DISPLAY is set', async () => {
    // The `linux-gui` arm through the second operand of the DISPLAY-family `||`
    // chain (DISPLAY unset, WAYLAND_DISPLAY set).
    setPlatform('linux')
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-gui')
  })

  it('returns linux-gui when process.platform is linux and only XDG_SESSION_TYPE is set', async () => {
    // The `linux-gui` arm through the third operand of the DISPLAY-family `||`
    // chain (DISPLAY unset, WAYLAND_DISPLAY unset, XDG_SESSION_TYPE set).
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'wayland'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-gui')
  })

  it('returns linux-server when process.platform is win32 (the line 16 fallback)', async () => {
    // Non-darwin, non-linux -> falls through to `return 'linux-server'`.
    setPlatform('win32')
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-server')
  })
})

// ---------------------------------------------------------------------------
// detect() -- MARVEEN_ENV override (the `||` chain at line 10).
// ---------------------------------------------------------------------------

describe('detect() -- MARVEEN_ENV override', () => {
  it('honours MARVEEN_ENV=macos (first operand of the || chain)', async () => {
    setPlatform('linux')
    process.env['MARVEEN_ENV'] = 'macos'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('macos')
  })

  it('honours MARVEEN_ENV=linux-server (second operand)', async () => {
    setPlatform('darwin')
    process.env['MARVEEN_ENV'] = 'linux-server'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-server')
  })

  it('honours MARVEEN_ENV=linux-gui (third operand)', async () => {
    setPlatform('darwin')
    process.env['MARVEEN_ENV'] = 'linux-gui'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-gui')
  })

  it('ignores MARVEEN_ENV when it is not one of the three valid values (all three || operands false)', async () => {
    // The fourth branch shape: all three strict-equality checks fail, so the
    // chain short-circuits to false and detect() proceeds to platform branching.
    setPlatform('darwin')
    process.env['MARVEEN_ENV'] = 'solaris'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('macos')
  })

  it('ignores MARVEEN_ENV when it is set to the empty string', async () => {
    setPlatform('darwin')
    process.env['MARVEEN_ENV'] = ''
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('macos')
  })
})

// ---------------------------------------------------------------------------
// detect() -- XDG_SESSION_TYPE allowlist. Only x11 / wayland / mir prove a
// GUI display; tty and unspecified are headless. See
// docs/needs-to-be-fix/platform-xdg-session-type-tty-bug.md.
// ---------------------------------------------------------------------------

describe('detect() -- XDG_SESSION_TYPE allowlist', () => {
  it('treats XDG_SESSION_TYPE=tty as a headless server (not a GUI session)', async () => {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'tty'
    const { PLATFORM } = await importPlatformFresh()
    expect(PLATFORM).toBe('linux-server')
  })
})