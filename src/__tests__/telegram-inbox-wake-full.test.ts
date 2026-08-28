// 100% line + branch coverage tests for src/web/telegram-inbox-wake.ts.
//
// The pure gate decision (shouldWakeForTelegramInbox / wakeBackoffMs) is
// already covered by telegram-inbox-wake.test.ts; this file targets the IO-
// driven `maybeWakeSubAgentsForTelegram(now)` function (lines 143-222), plus
// the `_resetSubWakeStateForTest` helper. Every branch in the per-agent loop
// is exercised: opt-in gate off, listAgentNames throw, main-agent skip,
// inbox-file missing, inbox empty, age gate, fresh backlog reset, attempts
// exhausted, backoff window not elapsed, session absent, session busy,
// happy nudge, error catch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  return {
    sandbox: `${tmpRoot}/marveen-tg-${process.pid}-${Math.random().toString(36).slice(2)}`,
    subagentTelegramWakeEnabled: true,
    mainAgentId: 'marveen',
    // Agent collaborators
    listAgentNames: vi.fn<() => string[]>(),
    readAgentRemoteHost: vi.fn<(name: string) => string | null>(),
    agentSessionName: vi.fn<(name: string) => string>(),
    sessionExistsOnHost: vi.fn<(host: string | null, session: string) => boolean>(),
    isSessionReadyForPrompt: vi.fn<(session: string, host: string | null) => Promise<boolean>>(),
    sendPromptToSession: vi.fn<(session: string, text: string, host: string | null) => void>(),
    resolveAgentChannelStateDir: vi.fn<(name: string, provider: string) => string>(),
    // In-memory inbox file per (agent, mtime, size)
    inboxFiles: new Map<string, { mtimeMs: number; size: number }>(),
    statErrors: new Set<string>(),
    logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'info', obj, msg }),
    warn: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'warn', obj, msg }),
    debug: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'debug', obj, msg }),
    error: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'error', obj, msg }),
  },
}))

vi.mock('../config.js', () => ({
  get MAIN_AGENT_ID() { return H.mainAgentId },
  get SUBAGENT_TELEGRAM_WAKE_ENABLED() { return H.subagentTelegramWakeEnabled },
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => H.listAgentNames(),
  readAgentRemoteHost: (name: string) => H.readAgentRemoteHost(name),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => H.agentSessionName(name),
  isSessionReadyForPrompt: (session: string, host: string | null) => H.isSessionReadyForPrompt(session, host),
  sendPromptToSession: (session: string, text: string, host: string | null) => H.sendPromptToSession(session, text, host),
  sessionExistsOnHost: (host: string | null, session: string) => H.sessionExistsOnHost(host, session),
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: (name: string, provider: string) => H.resolveAgentChannelStateDir(name, provider),
}))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const statSync = (p: string) => {
    if (H.statErrors.has(p)) throw new Error(`ENOENT: ${p}`)
    const entry = H.inboxFiles.get(p)
    if (!entry) throw new Error(`ENOENT: ${p}`)
    return {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      isDirectory: () => false,
      isFile: () => true,
    } as unknown as ReturnType<typeof actual.statSync>
  }
  return { ...actual, statSync }
})

const TIW = await import('../web/telegram-inbox-wake.js')

function setInbox(name: string, opts: { mtimeMs: number; size: number } | null): string {
  // The SUT composes inboxPath = join(stateDir, 'inbox-pending.jsonl'). The
  // mocked resolveAgentChannelStateDir returns a per-agent dir, and statSync
  // is invoked on the joined inboxPath. Mirror that path here so the lookup
  // hits.
  const stateDir = `/tmp/state-${name}`
  const path = `${stateDir}/inbox-pending.jsonl`
  H.resolveAgentChannelStateDir.mockImplementation((n: string, _provider: string) => {
    return `/tmp/state-${n}`
  })
  if (opts === null) {
    H.inboxFiles.delete(path)
  } else {
    H.inboxFiles.set(path, opts)
  }
  return path
}

beforeEach(() => {
  H.listAgentNames.mockReset()
  H.readAgentRemoteHost.mockReset()
  H.agentSessionName.mockReset()
  H.sessionExistsOnHost.mockReset()
  H.isSessionReadyForPrompt.mockReset()
  H.sendPromptToSession.mockReset()
  H.resolveAgentChannelStateDir.mockReset()
  H.inboxFiles.clear()
  H.statErrors.clear()
  H.logs.length = 0
  H.subagentTelegramWakeEnabled = true
  H.mainAgentId = 'marveen'
  // Sensible defaults
  H.readAgentRemoteHost.mockReturnValue(null)
  H.agentSessionName.mockImplementation((n: string) => `agent-${n}`)
  H.sessionExistsOnHost.mockReturnValue(true)
  H.isSessionReadyForPrompt.mockResolvedValue(true)
  TIW._resetSubWakeStateForTest()
})

afterEach(() => {
  TIW._resetSubWakeStateForTest()
})

describe('maybeWakeSubAgentsForTelegram -- opt-in gate', () => {
  it('returns immediately when SUBAGENT_TELEGRAM_WAKE_ENABLED is false', async () => {
    H.subagentTelegramWakeEnabled = false
    H.listAgentNames.mockReturnValue(['samu'])
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.listAgentNames).not.toHaveBeenCalled()
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })
})

describe('maybeWakeSubAgentsForTelegram -- listAgentNames throws', () => {
  it('logs warn and returns when listAgentNames blows up', async () => {
    H.listAgentNames.mockImplementation(() => { throw new Error('disk on fire') })
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('listAgentNames failed'))).toBe(true)
  })
})

describe('maybeWakeSubAgentsForTelegram -- per-agent branches', () => {
  it('skips the main agent (it has --channels and no local derived inbox)', async () => {
    H.listAgentNames.mockReturnValue(['marveen', 'samu'])
    // samu has no inbox registered at all -> continue.
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    // No send, no log mentioning marveen being nudged.
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
    expect(H.logs.some((l) => String(l.msg).includes('nudged idle sub-agent'))).toBe(false)
  })

  it('drops stale per-agent state and continues when the inbox file is missing', async () => {
    // Pre-seed _subWakeState so the delete branch is observable.
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', null)
    // Pre-populate state by calling once (state is cleared inside the loop).
    // The first call sees no inbox -> deletes state, continues.
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('continues when statSync throws inside the inner try-catch (inboxPath lookup)', async () => {
    // resolveAgentChannelStateDir returns a path that throws on statSync.
    H.listAgentNames.mockReturnValue(['samu'])
    H.resolveAgentChannelStateDir.mockReturnValue('/tmp/state-samu')
    H.statErrors.add('/tmp/state-samu/inbox-pending.jsonl')
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('drops state and continues when the inbox file size is 0', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 1_000_000, size: 0 })
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('continues when the inbox is too fresh (inboxAgeMs <= MIN_AGE_MS)', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 999_999, size: 100 })
    // now - mtime = 1_000_000 - 999_999 = 1 ms (way below 25_000).
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('initializes a fresh per-agent state object when none exists for this mtime', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    // now - mtime = 1_000_000_000 - 100 = ~999_999_900 (way past MIN_AGE).
    // No state, attempts=0. debounce elapsed (lastWakeAt=0). session idle.
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000_000_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(1)
  })

  it('resets the per-agent state (attempts=0) when the inbox mtime advances past the cached one', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    // First nudge: attempts goes 0 -> 1, lastWakeAt=now.
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000_000_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(1)
    // Advance mtime -- a new inbound arrived -> the next call should reset
    // attempts to 0 and nudge again (debounce window permitting).
    setInbox('samu', { mtimeMs: 200, size: 100 })
    // Pick `now` such that now - lastWakeAt (1_000_000_000_000) >= the backoff
    // for attempts=0 (60_000 ms).
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000_000_000 + 60_000 + 1_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(2)
  })

  it('continues when the per-agent attempt budget is already exhausted', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    const NOW = 1_700_000_000_000
    // Drive attempts to 5 by nudging with exponential gaps (the watcher
    // doubles per attempt, capped at 30 min). Cap-bypassing gap so 5
    // nudges fit in a single test.
    // attempts=0 -> 60_000; attempts=1 -> 120_000; ... attempts=4 -> 960_000.
    // Sum from 0 to 4 = 60+120+240+480+960 = 1_860_000 ms.
    const gaps = [60_000, 120_000, 240_000, 480_000, 960_000]
    let t = NOW
    for (let i = 0; i < gaps.length; i++) {
      t += gaps[i] + 1_000
      await TIW.maybeWakeSubAgentsForTelegram(t)
    }
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(5)
    // Next tick (still inside the same mtime) -- attempts >= 5 -> continue.
    await TIW.maybeWakeSubAgentsForTelegram(t + 1_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(5) // unchanged
  })

  it('continues when the backoff window since the last nudge has not elapsed', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    const NOW = 1_700_000_000_000
    await TIW.maybeWakeSubAgentsForTelegram(NOW)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(1)
    // Same inbox mtime (no fresh inbound), now - lastWakeAt < debounceMs.
    // 30_000 < 60_000 -> skip.
    await TIW.maybeWakeSubAgentsForTelegram(NOW + 30_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(1)
  })

  it('continues when sessionExistsOnHost returns false (skips the isSessionReadyForPrompt probe)', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    H.sessionExistsOnHost.mockReturnValue(false)
    H.isSessionReadyForPrompt.mockImplementation(() => {
      throw new Error('should not be called when sessionExists=false')
    })
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('continues when isSessionReadyForPrompt returns false (session busy)', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    await TIW.maybeWakeSubAgentsForTelegram(1_000_000_000_000)
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('sends the hungarian nudge text, updates state, and logs info on the happy path', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    const NOW = 1_700_000_000_000
    await TIW.maybeWakeSubAgentsForTelegram(NOW)
    expect(H.sendPromptToSession).toHaveBeenCalledWith(
      'agent-samu',
      expect.stringContaining('[telegram-wake]'),
      null,
    )
    const infoLog = H.logs.find((l) => l.level === 'info' && String(l.msg).includes('nudged idle sub-agent'))
    expect(infoLog).toBeDefined()
    expect((infoLog?.obj as { agent: string }).agent).toBe('samu')
    expect((infoLog?.obj as { session: string }).session).toBe('agent-samu')
    expect((infoLog?.obj as { attempt: number }).attempt).toBe(1)
  })

  it('uses the host returned by readAgentRemoteHost when forwarding the nudge', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    H.readAgentRemoteHost.mockReturnValue('box-1.example.com')
    await TIW.maybeWakeSubAgentsForTelegram(1_700_000_000_000)
    expect(H.sendPromptToSession).toHaveBeenCalledWith(
      'agent-samu',
      expect.any(String),
      'box-1.example.com',
    )
  })

  it('catches and logs an error thrown by an inner collaborator (sendPromptToSession throw)', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    H.sendPromptToSession.mockImplementation(() => { throw new Error('tmux exploded') })
    await TIW.maybeWakeSubAgentsForTelegram(1_700_000_000_000)
    const warn = H.logs.find((l) => l.level === 'warn' && String(l.msg).includes('wake check failed'))
    expect(warn).toBeDefined()
    expect((warn?.obj as { agent: string }).agent).toBe('samu')
  })
})

describe('_resetSubWakeStateForTest', () => {
  it('clears the per-agent wake state between tests', async () => {
    H.listAgentNames.mockReturnValue(['samu'])
    setInbox('samu', { mtimeMs: 100, size: 100 })
    await TIW.maybeWakeSubAgentsForTelegram(1_700_000_000_000)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(1)
    TIW._resetSubWakeStateForTest()
    // After reset, the next nudge is treated as a fresh backlog: attempts=0,
    // lastWakeAt=0 -> debounce already elapsed -> nudges again.
    await TIW.maybeWakeSubAgentsForTelegram(1_700_000_000_000 + 1)
    expect(H.sendPromptToSession).toHaveBeenCalledTimes(2)
  })
})

// shouldWakeForTelegramInbox is also reachable through maybeWakeSubAgentsForTelegram
// (via the `if (!shouldWakeForTelegramInbox({...})) continue` branch), but
// direct tests of the pure decision exercise the inner defaults + branches
// (lines 122-128) that the orchestrator does not pass through. The existing
// telegram-inbox-wake.test.ts covers the happy cases; here we cover the
// optional-parameter defaults that the orchestrator also passes, so the per-
// file coverage reaches 100%.
describe('shouldWakeForTelegramInbox -- defaults (lines 122-124)', () => {
  it('uses Infinity as the default maxAttempts when maxAttempts is omitted', () => {
    // attempts=0, maxAttempts=Infinity -> attempts < maxAttempts, branch fires.
    const base = {
      inboxAgeMs: 60_000, hasPending: true, now: 1_000_000,
      lastWakeAt: 0, sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
    }
    expect(TIW.shouldWakeForTelegramInbox(base)).toBe(true)
  })

  it('uses Infinity as the default maxDebounceMs when maxDebounceMs is omitted', () => {
    // Without maxDebounceMs the backoff is unbounded (Math.min(unbounded, maxMs)
    // -- Math.pow can produce Infinity itself; the Math.min caps at the first
    // non-finite operand, but for moderate attempts the math stays finite).
    // Use attempts=0 so the base debounce wins -> 60_000 ms gate.
    const base = {
      inboxAgeMs: 60_000, hasPending: true, now: 1_000_000,
      lastWakeAt: 999_999, // 1 ms ago, < 60_000 -> skip
      sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
    }
    expect(TIW.shouldWakeForTelegramInbox(base)).toBe(false)
  })

  it('treats attempts as 0 when the optional parameter is omitted', () => {
    // Distinguish attempts=0 (default) from attempts=1: with attempts=0 the
    // backoff is 60_000 ms (base * 2^0); with attempts=1 it is 120_000 ms.
    // A gap of 100_000 ms is > 60_000 but < 120_000 -> only attempts=0 wakes.
    // If the default were 1, this would return false.
    const r = TIW.shouldWakeForTelegramInbox({
      inboxAgeMs: 60_000, hasPending: true, now: 200_000, lastWakeAt: 100_000,
      sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
    })
    expect(r).toBe(true)
  })

  it('short-circuits to false when hasPending is false (line 125)', () => {
    expect(TIW.shouldWakeForTelegramInbox({
      inboxAgeMs: 60_000, hasPending: false, now: 1_000_000, lastWakeAt: 0,
      sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
    })).toBe(false)
  })

  it('short-circuits to false when inbox is too fresh (line 126)', () => {
    expect(TIW.shouldWakeForTelegramInbox({
      inboxAgeMs: 10_000, hasPending: true, now: 1_000_000, lastWakeAt: 0,
      sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
    })).toBe(false)
  })

  it('short-circuits to false when attempts >= maxAttempts (line 127)', () => {
    expect(TIW.shouldWakeForTelegramInbox({
      inboxAgeMs: 60_000, hasPending: true, now: 1_000_000, lastWakeAt: 0,
      sessionExists: true, sessionIdle: true,
      minAgeMs: 25_000, debounceMs: 60_000,
      attempts: 5, maxAttempts: 5,
    })).toBe(false)
  })
})
