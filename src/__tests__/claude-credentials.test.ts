// 100% coverage suite for src/web/claude-credentials.ts.
//
// The SUT has one exported function, readClaudeCodeOauthJson(), which:
//   - short-circuits to null off macOS (`process.platform !== 'darwin'`),
//   - on macOS, calls `/usr/bin/security find-generic-password ...` and
//     returns the trimmed stdout,
//   - on any thrown error, logs a warning and returns null.
//
// We mock `node:os` (for userInfo) and `node:child_process` (for
// execFileSync). process.platform is mutated per-test via
// `Object.defineProperty` -- the same idiom used by heartbeat.test.ts and
// onboarding-routes.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks. `vi.mock` factories are hoisted by Vitest before any
// top-level import, so any reference inside them must also be hoisted --
// vi.hoisted() puts the spies in a scope the factory closure can see.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(..._args: unknown[]) => string | Buffer>(() => ''),
  warn: vi.fn(),
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: () => ({ username: 'tester', uid: 1000, gid: 1000, shell: '/bin/false', homedir: '/tmp/fake-home' }),
  }
})

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.warn,
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// Import SUT AFTER every mock is registered.
const { readClaudeCodeOauthJson } = await import('../web/claude-credentials.js')

// ---------------------------------------------------------------------------
// Platform mutation. process.platform is a getter, so we cannot assign
// directly. Define a fresh data-property descriptor per test and restore
// the original on teardown.
// ---------------------------------------------------------------------------

const ORIGINAL_PLATFORM = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  mocks.execFileSync.mockReset().mockReturnValue('')
  mocks.warn.mockReset()
})

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
})

// ---------------------------------------------------------------------------
// Non-darwin branch: the function must return null BEFORE touching
// child_process or os, so we assert that execFileSync is never called.
// ---------------------------------------------------------------------------

describe('readClaudeCodeOauthJson -- non-darwin short-circuit', () => {
  it('returns null on linux without calling execFileSync', () => {
    setPlatform('linux')
    const result = readClaudeCodeOauthJson()
    expect(result).toBeNull()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('returns null on win32 without calling execFileSync', () => {
    setPlatform('win32')
    const result = readClaudeCodeOauthJson()
    expect(result).toBeNull()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Darwin + success branch: execFileSync returns the JSON payload.
// ---------------------------------------------------------------------------

describe('readClaudeCodeOauthJson -- darwin happy path', () => {
  beforeEach(() => {
    setPlatform('darwin')
  })

  it('returns the trimmed JSON payload from the security binary', () => {
    const payload = '{"claudeAiOauth":{"accessToken":"abc","refreshToken":"xyz"}}'
    mocks.execFileSync.mockReturnValueOnce(payload)
    const result = readClaudeCodeOauthJson()
    expect(result).toBe(payload)
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace from the security output before returning', () => {
    const payload = '   {"claudeAiOauth":{}}   '
    mocks.execFileSync.mockReturnValueOnce(payload)
    const result = readClaudeCodeOauthJson()
    expect(result).toBe('{"claudeAiOauth":{}}')
  })

  it('returns null when the trimmed payload is the empty string', () => {
    // The `return out || null` branch: an empty keychain value is treated as
    // "no credential" rather than an empty-string truthy result.
    mocks.execFileSync.mockReturnValueOnce('   \n\n')
    const result = readClaudeCodeOauthJson()
    expect(result).toBeNull()
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
  })

  it('invokes security with the expected arguments', () => {
    mocks.execFileSync.mockReturnValueOnce('{"x":1}')
    readClaudeCodeOauthJson()
    const [bin, args, opts] = mocks.execFileSync.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(bin).toBe('/usr/bin/security')
    expect(args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'tester', '-w'])
    // Encoding and stdio are the values the SUT passes; asserting them pins
    // the contract that downstream callers (the worker writer) rely on.
    expect(opts).toMatchObject({
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
  })
})

// ---------------------------------------------------------------------------
// Darwin + exec throws branch: catch block returns null and logs a warning.
// ---------------------------------------------------------------------------

describe('readClaudeCodeOauthJson -- darwin error path', () => {
  beforeEach(() => {
    setPlatform('darwin')
  })

  it('returns null and logs a warning when execFileSync throws', () => {
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.')
    })
    const result = readClaudeCodeOauthJson()
    expect(result).toBeNull()
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    const warnMsg = mocks.warn.mock.calls[0]?.[0]
    expect(typeof warnMsg).toBe('string')
    expect(warnMsg as string).toMatch(/failed to read Claude Code credentials from Keychain/)
  })

  it('does NOT include the thrown error in the log call (no echo of lookup key)', () => {
    // The SUT comment: "Not logging err: some macOS auth errors echo a
    // fragment of the lookup key." This pins the contract that the worker
    // never leaks a partial keychain fragment into operator logs.
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('item not found')
    })
    readClaudeCodeOauthJson()
    // Only one argument was passed to warn (the message string).
    expect(mocks.warn.mock.calls[0]).toHaveLength(1)
  })

  it('swallows non-Error throws too (a string thrown is still caught)', () => {
    mocks.execFileSync.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string thrown'
    })
    const result = readClaudeCodeOauthJson()
    expect(result).toBeNull()
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})
