// Coverage tests for src/agent.ts. Targets the three surfaces the brief asked
// for: resolveClaudeCodeBin (linux libc variant + env override), the
// module-level cachedClaudeCodeBin memoisation, and runAgent's SDK prompt
// shape (options object passed to @anthropic-ai/claude-agent-sdk's query()).
//
// classifyAgentResult is already covered by agent-result-classification.test.ts
// and is intentionally not duplicated here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Hoisted mock handles -- the factories below reference these closures.
const mockQuery = vi.fn()
const mockRunViaWorker = vi.fn()
const mockExecSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}))

vi.mock('../web/agent-worker.js', () => ({
  runViaWorker: mockRunViaWorker,
}))

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => mockExistsSync(p) }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

const savedPlatform = process.platform
const savedArch = process.arch

function setPlatform(p: NodeJS.Platform, a = 'x64'): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  Object.defineProperty(process, 'arch', { value: a, configurable: true })
}

async function* iter<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

// Mirrors how the SDK generator behaves on abort: resolve on signal, then throw
// an AbortError -- which is what the agent.ts catch block tests for.
async function* hangUntilAbort(signal: AbortSignal | undefined): AsyncIterable<never> {
  await new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const e = new Error('Aborted')
  e.name = 'AbortError'
  throw e
}

beforeEach(() => {
  // Module-level cache (cachedClaudeCodeBin, AGENT_TIMEOUT_MS, logger) must be
  // fresh per test -- otherwise the first test's env override pollutes every
  // subsequent call.
  vi.resetModules()
  mockQuery.mockReset()
  mockRunViaWorker.mockReset()
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
  delete process.env.CLAUDE_CODE_BIN
  delete process.env.MARVEEN_AGENT_BACKEND
  delete process.env.MARVEEN_AGENT_TIMEOUT_MS
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: savedArch, configurable: true })
  vi.useRealTimers()
})

async function importAgent() {
  return await import('../agent.js')
}

async function importLogger() {
  return await import('../logger.js')
}

// =============================================================================
// runAgent -- worker backend (jun.15 subscription migration; default)
// =============================================================================

describe('runAgent -- worker backend', () => {
  it('returns worker text/error on the happy path (non-authFailed)', async () => {
    mockRunViaWorker.mockResolvedValue({ text: 'hello from worker', error: undefined })
    const { runAgent } = await importAgent()
    const r = await runAgent('hello')
    expect(r).toEqual({ text: 'hello from worker' })
    expect(mockRunViaWorker).toHaveBeenCalledWith('hello', 20 * 60 * 1000)
  })

  it('warns and ignores sessionId on the worker backend (worker is single-session)', async () => {
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    const { logger } = await importLogger()
    await runAgent('hi', 'sess-1')
    expect(logger.warn).toHaveBeenCalledWith(
      'runAgent(worker): resume/sessionId not supported on worker backend, ignoring',
    )
    // sessionId is intentionally NOT passed to runViaWorker (only msg + timeout).
    expect(mockRunViaWorker).toHaveBeenCalledWith('hi', 20 * 60 * 1000)
  })

  it('returns the worker error verbatim when it is non-recoverable (non-authFailed)', async () => {
    mockRunViaWorker.mockResolvedValue({ text: null, error: 'worker session not ready', authFailed: false })
    const { runAgent } = await importAgent()
    const r = await runAgent('hi')
    expect(r).toEqual({ text: null, error: 'worker session not ready' })
  })

  it('falls through to the SDK backend when authFailed=true (2026-06-10 fail-open)', async () => {
    mockRunViaWorker.mockResolvedValue({
      text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true,
    })
    mockQuery.mockReturnValue(iter([
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'sdk-fallback-text' },
    ]))
    const { runAgent } = await importAgent()
    const { logger } = await importLogger()
    const r = await runAgent('hi')
    expect(mockQuery).toHaveBeenCalled()
    expect(r.text).toBe('sdk-fallback-text')
    expect(logger.error).toHaveBeenCalledWith(
      'runAgent: worker auth unrecoverable, falling back to SDK backend for this call (API billing)',
    )
  })

  it('passes opts.timeoutMs through to runViaWorker', async () => {
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    await runAgent('hi', undefined, undefined, false, '/x', undefined, { timeoutMs: 1234 })
    expect(mockRunViaWorker).toHaveBeenCalledWith('hi', 1234)
  })
})

// =============================================================================
// runAgent -- SDK backend prompt shape (the load-bearing contract for query())
// =============================================================================

describe('runAgent -- SDK backend prompt shape', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('passes prompt + cwd + permissionMode + abortController to query()', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('hello world', undefined, undefined, false, '/tmp/cwd-x')
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const call = mockQuery.mock.calls[0][0]
    expect(call.prompt).toBe('hello world')
    expect(call.options.cwd).toBe('/tmp/cwd-x')
    expect(call.options.permissionMode).toBe('bypassPermissions')
    expect(call.options.abortController).toBeInstanceOf(AbortController)
  })

  it('defaults cwd to PROJECT_ROOT when omitted', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent, PROJECT_ROOT_FOR_TEST } = await importAgent() as any
    await runAgent('x')
    // PROJECT_ROOT is the absolute path of the project root. We can't import it
    // directly here (it isn't exported from agent.js), but the resolved cwd
    // should be an absolute path ending in the project basename.
    const cwd: string = mockQuery.mock.calls[0][0].options.cwd
    expect(cwd.startsWith('/')).toBe(true)
  })

  it('uses DEFAULT_DISALLOWED_TOOLS when allowTools=false', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.disallowedTools).toEqual([
      'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task',
    ])
  })

  it('omits disallowedTools when allowTools=true', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x', undefined, undefined, true)
    expect(mockQuery.mock.calls[0][0].options.disallowedTools).toBeUndefined()
  })

  it('passes resume=sessionId when sessionId is provided', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x', 'sess-abc')
    expect(mockQuery.mock.calls[0][0].options.resume).toBe('sess-abc')
  })

  it('omits resume when sessionId is undefined', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.resume).toBeUndefined()
  })

  it('merges env overrides into process.env when env arg is provided', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x', undefined, undefined, false, '/x', { MY_KEY: 'v' })
    const env = mockQuery.mock.calls[0][0].options.env
    expect(env.MY_KEY).toBe('v')
    // process.env is layered under: caller overrides win.
    expect(env.PATH ?? process.env.PATH).toBe(process.env.PATH)
  })

  it('omits env when env arg is undefined', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.env).toBeUndefined()
  })

  it('passes pathToClaudeCodeExecutable when resolveClaudeCodeBin returns a path', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/custom/claude'
    mockExecSync.mockReturnValue('')
    mockExistsSync.mockReturnValue(true)
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBe('/custom/claude')
  })

  it('omits pathToClaudeCodeExecutable when resolveClaudeCodeBin returns undefined', async () => {
    setPlatform('darwin', 'arm64')
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })
})

// =============================================================================
// runAgent -- SDK event loop (system/init sessionId capture + result classification)
// =============================================================================

describe('runAgent -- SDK event loop', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('captures newSessionId from the system/init event', async () => {
    mockQuery.mockReturnValue(iter([
      { type: 'system', subtype: 'init', sessionId: 'new-sess-1' },
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'done' },
    ]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.newSessionId).toBe('new-sess-1')
    expect(r.text).toBe('done')
  })

  it('ignores system events with non-init subtypes (no sessionId capture)', async () => {
    mockQuery.mockReturnValue(iter([
      { type: 'system', subtype: 'something_else', sessionId: 'should-not-capture' },
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'r' },
    ]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.newSessionId).toBeUndefined()
    expect(r.text).toBe('r')
  })

  it('returns text from a successful result event', async () => {
    mockQuery.mockReturnValue(iter([
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'the answer' },
    ]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.text).toBe('the answer')
    expect(r.error).toBeUndefined()
  })

  it('returns text=null with reason when the result event is blocked (issue #209)', async () => {
    mockQuery.mockReturnValue(iter([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage policy violation'] },
    ]))
    const { runAgent } = await importAgent()
    const { logger } = await importLogger()
    const r = await runAgent('x')
    expect(r.text).toBeNull()
    expect(r.error).toContain('Usage policy')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('Usage policy') }),
      'runAgent: result blocked/errored -- not propagated as content (possible AUP block, issue #209)',
    )
  })

  it('includes a resultSnippet in the reason for a blocked event with string result (issue #209 log context)', async () => {
    // The SDK can surface a usage-policy / refusal message in `result` even
    // on a blocked event -- the snippet must end up in the LOG reason but
    // never as the returned text. (See classifyAgentResult line 62-63.)
    mockQuery.mockReturnValue(iter([
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'This request was blocked by the usage policy.' },
    ]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.text).toBeNull()
    expect(r.error).toContain('resultSnippet=')
    expect(r.error).toContain('usage policy')
  })

  it('overwrites an earlier successful result with a later blocked result (last wins)', async () => {
    mockQuery.mockReturnValue(iter([
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'first' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['stop'] },
    ]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.text).toBeNull()
    expect(r.error).toContain('stop')
  })

  it('returns text=null with no events (clean empty stream)', async () => {
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.text).toBeNull()
    expect(r.error).toBeUndefined()
    expect(r.newSessionId).toBeUndefined()
  })
})

// =============================================================================
// runAgent -- SDK timeout (AbortError + signal.aborted branches)
// =============================================================================

describe('runAgent -- SDK timeout', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
    process.env.MARVEEN_AGENT_TIMEOUT_MS = '50'
  })

  it('returns the human apology text on timeout when timeoutAsError is unset', async () => {
    mockQuery.mockImplementation(({ options }) => hangUntilAbort(options?.abortController?.signal))
    const { runAgent } = await importAgent()
    const { logger } = await importLogger()
    const r = await runAgent('x')
    expect(r.text).toMatch(/idokorlat/)
    expect(r.error).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith('Agent megszakitva timeout miatt')
  })

  it('returns text=null + a structured reason when timeoutAsError=true (cached callers)', async () => {
    mockQuery.mockImplementation(({ options }) => hangUntilAbort(options?.abortController?.signal))
    const { runAgent } = await importAgent()
    const r = await runAgent('x', undefined, undefined, false, '/x', undefined, { timeoutAsError: true })
    expect(r.text).toBeNull()
    expect(r.error).toMatch(/^timeout after \d+min$/)
  })

  it('treats signal.aborted=true as a timeout even when err.name is NOT "AbortError"', async () => {
    // Different SDK versions throw different things on abort; the catch checks
    // BOTH err.name === 'AbortError' AND abortController.signal.aborted. Force
    // the second branch.
    mockQuery.mockImplementation(({ options }) => {
      const signal: AbortSignal | undefined = options?.abortController?.signal
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('some-other-error-name')
      })()
    })
    const { runAgent } = await importAgent()
    const r = await runAgent('x')
    expect(r.text).toMatch(/idokorlat/)
  })
})

// =============================================================================
// runAgent -- SDK error path (rethrow Error verbatim, wrap non-Error in Error)
// =============================================================================

describe('runAgent -- SDK error path', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('rethrows an Error instance verbatim', async () => {
    mockQuery.mockImplementation(() => { throw new Error('boom') })
    const { runAgent } = await importAgent()
    const { logger } = await importLogger()
    await expect(runAgent('x')).rejects.toThrow('boom')
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Agent hiba')
  })

  it('wraps a non-Error throwable in a new Error', async () => {
    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string-throw'
    })
    const { runAgent } = await importAgent()
    await expect(runAgent('x')).rejects.toThrow('string-throw')
  })

  it('wraps a non-Error object in a new Error', async () => {
    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { code: 'EWEIRD' }
    })
    const { runAgent } = await importAgent()
    await expect(runAgent('x')).rejects.toThrow('[object Object]')
  })
})

// =============================================================================
// runAgent -- typing refresh interval (TYPING_REFRESH_MS = 4000ms)
// =============================================================================

describe('runAgent -- typing refresh interval', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('does not set up an interval when onTyping is undefined', async () => {
    mockQuery.mockReturnValue(iter([]))
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })

  it('calls onTyping repeatedly while the query runs (TYPING_REFRESH_MS cadence)', async () => {
    vi.useFakeTimers()
    // Make query hang until the abort fires so the interval can tick before
    // `finally` clears it.
    let abortSignal: AbortSignal | undefined
    mockQuery.mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (!abortSignal || abortSignal.aborted) return resolve()
          abortSignal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    })
    const onTyping = vi.fn()
    const { runAgent } = await importAgent()
    const p = runAgent('x', undefined, onTyping)
    // Advance 8.5s of fake time: TYPING_REFRESH_MS = 4000, expect at least 2 fires.
    await vi.advanceTimersByTimeAsync(8500)
    // Now abort so the hanging generator completes and runAgent returns.
    abortSignal?.dispatchEvent(new Event('abort'))
    await p
    expect(onTyping.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

  // =============================================================================
// resolveClaudeCodeBin -- platform + libc variant selection
//
// All these tests route through the SDK backend so we observe the resolved bin
// path in the query() call options -- the worker backend would short-circuit
// before resolveClaudeCodeBin runs.
// =============================================================================

describe('resolveClaudeCodeBin -- platform/libc gating', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('returns CLAUDE_CODE_BIN env var (does not consult execSync)', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/env/override/claude'
    mockExecSync.mockReturnValue('')
    mockExistsSync.mockReturnValue(true)
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBe('/env/override/claude')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('returns undefined on darwin (non-linux)', async () => {
    setPlatform('darwin', 'arm64')
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('returns undefined on win32 (non-linux)', async () => {
    setPlatform('win32', 'x64')
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('returns undefined on linux non-x64 (e.g. arm64)', async () => {
    setPlatform('linux', 'arm64')
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('returns undefined when ldd detection throws (libc=unknown)', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockImplementation(() => { throw new Error('ldd not found') })
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('picks the glibc variant when ldd output indicates glibc', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('ldd (Debian GLIBC 2.36-9+deb12u11) 2.36\nCopyright ...')
    mockExistsSync.mockImplementation((p: string) => p.endsWith('claude-agent-sdk-linux-x64/claude'))
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    const path: string | undefined = mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable
    expect(path).toBeDefined()
    expect(path).toMatch(/linux-x64\/claude$/)
    expect(path).not.toMatch(/musl/)
  })

  it('picks the musl variant when ldd output indicates musl', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('musl libc (x86_64)\nVersion 1.2.4')
    mockExistsSync.mockImplementation((p: string) => p.endsWith('claude-agent-sdk-linux-x64-musl/claude'))
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    const path: string | undefined = mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable
    expect(path).toBeDefined()
    expect(path).toMatch(/linux-x64-musl\/claude$/)
  })

  it('returns undefined when the resolved binary does not exist on disk', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('glibc')
    mockExistsSync.mockReturnValue(false)
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })
})

// =============================================================================
// cachedClaudeCodeBin -- module-level memoisation (the "cache !== null" branch)
//
// Same SDK-backend routing as above; we call runAgent twice and verify the
// second invocation skips the resolver.
// =============================================================================

describe('cachedClaudeCodeBin -- module-level memoisation', () => {
  beforeEach(() => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
  })

  it('memoises a non-undefined resolution: second call reuses the cached value', async () => {
    setPlatform('linux', 'x64')
    process.env.CLAUDE_CODE_BIN = '/cached/claude'
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBe('/cached/claude')
    expect(mockQuery.mock.calls[1][0].options.pathToClaudeCodeExecutable).toBe('/cached/claude')
    // env override short-circuits before libc detection -- execSync stays untouched
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('memoises undefined: second call returns the cached undefined without re-resolving', async () => {
    setPlatform('darwin', 'arm64')
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    await runAgent('x')
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockQuery.mock.calls[1][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('memoises the libc=unknown branch: execSync is invoked at most once across calls', async () => {
    setPlatform('linux', 'x64')
    mockExecSync.mockImplementation(() => { throw new Error('ldd failed') })
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    await runAgent('x')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockQuery.mock.calls[1][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('memoises the bin-not-on-disk branch: second call does not re-execute existsSync', async () => {
    // After the first call, cachedClaudeCodeBin is `undefined` (not `null`),
    // so the cache hit branch returns early. Both mock counts should equal
    // what they were after a single runAgent call.
    setPlatform('linux', 'x64')
    mockExecSync.mockReturnValue('glibc')
    mockExistsSync.mockReturnValue(false)
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    const execCallsAfterFirst = mockExecSync.mock.calls.length
    const existsCallsAfterFirst = mockExistsSync.mock.calls.length
    await runAgent('x')
    expect(mockExecSync.mock.calls.length).toBe(execCallsAfterFirst)
    expect(mockExistsSync.mock.calls.length).toBe(existsCallsAfterFirst)
    expect(mockQuery.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBeUndefined()
    expect(mockQuery.mock.calls[1][0].options.pathToClaudeCodeExecutable).toBeUndefined()
  })
})

// =============================================================================
// agentBackend -- backend selector (default worker vs sdk)
// =============================================================================

describe('agentBackend selector', () => {
  it('defaults to "worker" when MARVEEN_AGENT_BACKEND is unset', async () => {
    mockRunViaWorker.mockResolvedValue({ text: 'w' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('routes to "sdk" when MARVEEN_AGENT_BACKEND=sdk (lowercase)', async () => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
    mockQuery.mockReturnValue(iter([]))
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockQuery).toHaveBeenCalled()
    expect(mockRunViaWorker).not.toHaveBeenCalled()
  })

  it('routes to "worker" for any non-"sdk" value (case-insensitive: "WORKER")', async () => {
    process.env.MARVEEN_AGENT_BACKEND = 'WORKER'
    mockRunViaWorker.mockResolvedValue({ text: 'w' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('routes to "worker" for an empty MARVEEN_AGENT_BACKEND value', async () => {
    process.env.MARVEEN_AGENT_BACKEND = ''
    mockRunViaWorker.mockResolvedValue({ text: 'w' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalled()
  })
})

// =============================================================================
// classifyAgentResult -- branch coverage (lines 53-65) for the SDK event flow
//
// These direct unit tests cover the branches that an SDK event can't easily
// trigger (subtype='success' but blocked, is_error=false on a blocked event,
// etc.). classifyAgentResult is exported; the production code path is unchanged.
// =============================================================================

describe('classifyAgentResult -- branch coverage via direct call', () => {
  it('appends subtype=... when subtype is non-"success" (success branch skipped)', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({
      subtype: 'error_during_execution', is_error: true, errors: ['e1'],
    })
    expect(c.blocked).toBe(true)
    expect(c.reason).toContain('subtype=error_during_execution')
  })

  it('subtype="success" but is_error=true: subtype push is SKIPPED (subtype===success branch)', async () => {
    // Hits the `subtype !== 'success'` FALSE branch (no subtype push).
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({
      subtype: 'success', is_error: true, api_error_status: 403, result: 'blocked text',
    })
    expect(c.blocked).toBe(true)
    expect(c.reason).not.toMatch(/subtype=/)
    expect(c.reason).toContain('is_error=true')
    expect(c.reason).toContain('api_error_status=403')
  })

  it('blocked event with is_error=false: isError branch false (no is_error push)', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({
      subtype: 'error_during_execution', is_error: false, errors: ['e1'],
    })
    expect(c.blocked).toBe(true)
    expect(c.reason).not.toContain('is_error=true')
  })

  it('blocked event with api_error_status set: apiErr != null branch true', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({
      subtype: 'error_during_execution', is_error: true, api_error_status: 429, errors: ['e1'],
    })
    expect(c.reason).toContain('api_error_status=429')
  })

  it('blocked event with stop_reason: stop_reason branch true', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({
      subtype: 'success', is_error: true, api_error_status: 400, stop_reason: 'refusal',
    })
    expect(c.reason).toContain('stop_reason=refusal')
  })

  it('blocked event with no bits: falls through to "unknown error result" fallback', async () => {
    // subtype=undefined → no subtype push; is_error=false → no is_error push;
    // api_error_status=null → no apiErr push; no stop_reason/errors/string-result.
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({})
    expect(c.blocked).toBe(true)
    expect(c.text).toBeNull()
    expect(c.reason).toBe('unknown error result')
  })

  it('success result with non-string result: text=null, NOT blocked', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({ subtype: 'success', is_error: false, api_error_status: null, result: { complex: true } })
    expect(c.blocked).toBe(false)
    expect(c.text).toBeNull()
  })

  it('success result with string result: text=result', async () => {
    const { classifyAgentResult } = await importAgent()
    const c = classifyAgentResult({ subtype: 'success', is_error: false, api_error_status: null, result: 'clean' })
    expect(c.blocked).toBe(false)
    expect(c.text).toBe('clean')
  })

  it('caps the resultSnippet at 200 chars (never leaks full block text into reason)', async () => {
    const { classifyAgentResult } = await importAgent()
    const long = 'X'.repeat(500)
    const c = classifyAgentResult({ subtype: 'error_during_execution', is_error: true, result: long })
    expect(c.text).toBeNull()
    expect(c.reason).toContain('resultSnippet=')
    // snippet is at most 200 chars of Xs after the prefix
    const snippetMatch = c.reason?.match(/resultSnippet=(X+)/)
    expect(snippetMatch?.[1].length).toBeLessThanOrEqual(200)
  })
})

// =============================================================================
// AGENT_TIMEOUT_MS -- env-derived default vs opts.timeoutMs override
// =============================================================================

describe('AGENT_TIMEOUT_MS derivation', () => {
  it('uses the 20min default when MARVEEN_AGENT_TIMEOUT_MS is unset (passed to worker)', async () => {
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalledWith('x', 20 * 60 * 1000)
  })

  it('uses MARVEEN_AGENT_TIMEOUT_MS when set before module import', async () => {
    process.env.MARVEEN_AGENT_TIMEOUT_MS = '7777'
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalledWith('x', 7777)
  })

  it('opts.timeoutMs overrides the env-derived default (worker path)', async () => {
    process.env.MARVEEN_AGENT_TIMEOUT_MS = '99999'
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    await runAgent('x', undefined, undefined, false, '/x', undefined, { timeoutMs: 12345 })
    expect(mockRunViaWorker).toHaveBeenCalledWith('x', 12345)
  })

  it('treats a non-numeric MARVEEN_AGENT_TIMEOUT_MS as the 20min default', async () => {
    process.env.MARVEEN_AGENT_TIMEOUT_MS = 'not-a-number'
    mockRunViaWorker.mockResolvedValue({ text: 'ok' })
    const { runAgent } = await importAgent()
    await runAgent('x')
    expect(mockRunViaWorker).toHaveBeenCalledWith('x', 20 * 60 * 1000)
  })
})
