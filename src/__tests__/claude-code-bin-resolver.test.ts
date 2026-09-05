// Coverage tests for the ClaudeCodeBinResolver class extracted from the
// agent.ts closure in F.7. Pins the resolver closure's behaviour (CLAUDE_CODE_BIN
// env verbatim, linux libc variant path on disk, early-return on darwin/win32),
// the parent's memoisation contract (cached until invalidate()), and the
// 5th-test inverse pin: a later env change without invalidate() MUST NOT be
// observed (i.e. removing the parent's `cached === null` short-circuit would
// fail this assertion).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:child_process + node:fs.existsSync. The config.ts import pulls in
// existsSync(store/config-overrides.json) at module-load time, so the import
// alone advances the existsSync call count. Use a call-count delta (the
// agent-run-paths.test.ts:620-627 pattern) for any "no I/O cost" assertion
// rather than a `not.toHaveBeenCalled()` pin, which would always trip.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn() }
})

const mockExecSync = vi.mocked((await import('node:child_process')).execSync)
const mockExistsSync = vi.fn<(p: string) => boolean>()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: mockExistsSync }
})

let originalPlatform: NodeJS.Platform
let originalArch: string
let originalEnv: NodeJS.ProcessEnv

beforeEach(() => {
  vi.resetModules()
  originalPlatform = process.platform
  originalArch = process.arch
  originalEnv = { ...process.env }
  // CLAUDE_CODE_BIN is this project's own production override (read at
  // src/agent.ts:95); the sibling suite guards the same way at
  // agent-run-paths.test.ts:76. Without this delete, 2 of the 5 tests fail
  // on any machine that exports the variable (e.g. shell profile / deploy
  // unit): the glibc test gets /usr/local/bin/claude and fails the toMatch,
  // the darwin test gets /usr/local/bin/claude and fails toBeUndefined.
  delete process.env.CLAUDE_CODE_BIN
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
  process.env = originalEnv
})

function setPlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

describe('ClaudeCodeBinResolver', () => {
  it('returns CLAUDE_CODE_BIN env path verbatim and skips execSync', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/opt/override/claude'
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const existsCallsAfterImport = mockExistsSync.mock.calls.length
    const resolver = new ClaudeCodeBinResolver()
    expect(resolver.resolve()).toBe('/opt/override/claude')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExistsSync.mock.calls.length).toBe(existsCallsAfterImport)
  })

  it('returns the glibc variant path when the binary exists on disk', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('ldd (Debian GLIBC 2.36) 2.36\n')
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('claude-agent-sdk-linux-x64/claude'),
    )
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const resolver = new ClaudeCodeBinResolver()
    const result = resolver.resolve()
    // Pins that execSync was actually consulted (not a constant-return stub):
    // without this assertion, removing detectLinuxLibc() would still pass.
    expect(mockExecSync).toHaveBeenCalledWith('ldd --version 2>&1', expect.objectContaining({ encoding: 'utf-8' }))
    expect(result).toBeDefined()
    expect(result).toMatch(/claude-agent-sdk-linux-x64\/claude$/)
  })

  it('returns undefined on darwin without consulting execSync', async () => {
    setPlatform('darwin', 'arm64')
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const resolver = new ClaudeCodeBinResolver()
    expect(resolver.resolve()).toBeUndefined()
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('invalidate() drops the memoised path so the next call re-resolves', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/first/claude'
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const resolver = new ClaudeCodeBinResolver()
    expect(resolver.resolve()).toBe('/first/claude')
    resolver.invalidate()
    process.env.CLAUDE_CODE_BIN = '/second/claude'
    expect(resolver.resolve()).toBe('/second/claude')
  })

  it('memoises the resolved path: a later env change is NOT observed without invalidate()', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/first/claude'
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const resolver = new ClaudeCodeBinResolver()
    expect(resolver.resolve()).toBe('/first/claude')
    process.env.CLAUDE_CODE_BIN = '/second/claude'
    expect(resolver.resolve()).toBe('/first/claude')
  })

  it('instance name has the literal type "claude" -- per F.7 spec test (b)', async () => {
    // TS-level pin: if a future refactor widens LazyBin's TName from 'claude'
    // to string, the next line becomes a compile error, surfacing the type
    // distinctness regression without needing a separate `tsc --noEmit` step.
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const r = new ClaudeCodeBinResolver()
    const literalName: 'claude' = r.name
    expect(literalName).toBe('claude')
  })

  it('memoises the "tried and absent" undefined -- not re-resolved on subsequent calls', async () => {
    // Pins the parent's `cached === null` sentinel check: for
    // TResolved = string | undefined, an undefined result must NOT collide
    // with the "not yet resolved" sentinel, otherwise every subsequent
    // resolve() would re-invoke the resolver (and re-pay the I/O cost).
    //
    // Regression vector: the eslint prefer-nullish-coalescing rule applied
    // to src/platform.ts:95 would rewrite
    //   if (this.cached === null) this.cached = this.resolver(this.name)
    // to
    //   this.cached ??= this.resolver(this.name)
    // which is UNSAFE for `string | undefined`: after a first resolve() that
    // returns undefined, `??=` would overwrite the memoised undefined on
    // every subsequent call (since `undefined ??= x` assigns x). The test
    // below would fail under that mutation.
    //
    // Setup note: the ClaudeCodeBinResolver SHORT-CIRCUITS to `return undefined`
    // on non-linux at src/agent.ts:96 BEFORE touching execSync or existsSync.
    // To actually exercise the I/O path (and therefore the memoisation
    // sentinel), the test must run on linux/x64 with both execSync and
    // existsSync mocked to return "binary absent" (libc detected but path
    // missing).
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('ldd (Debian GLIBC 2.36) 2.36\n')
    mockExistsSync.mockReturnValue(false)
    const { ClaudeCodeBinResolver } = await import('../agent.js')
    const resolver = new ClaudeCodeBinResolver()
    expect(resolver.resolve()).toBeUndefined()
    // After the first call returned undefined, the resolver must NOT be
    // re-invoked on the next call. execSync is the only side-effecting call
    // here; if its call count is still 1 after two resolve()s, the parent's
    // `cached === null` guard is intact (undefined was memoised, not
    // confused with "not yet resolved").
    const execCallsAfterFirst = mockExecSync.mock.calls.length
    expect(resolver.resolve()).toBeUndefined()
    expect(mockExecSync.mock.calls.length).toBe(execCallsAfterFirst)
  })
})
