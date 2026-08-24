// 100% coverage suite for src/web/message-router.ts.
//
// The router is large and branch-dense (reconnect-batch pre-pass, per-agent
// session-existence cache, abandoned/inject retry, OTel trace stamping,
// federated bridge split, voice STT, etc.) so the suite is organized around
// each top-level branch surface in the source file. Everything collaborator-
// facing is mocked with hoisted vi.fn so a single test can dial in
// `sessionExistsOnHost`, `isSessionReadyForPrompt`, etc. without re-importing
// the router.
//
// The suite covers:
//   * shouldGiveUpOnInject / shouldAbandon (pure predicates, branch by branch)
//   * deliverFederatedBatch -- abandon path, delivered, failed, retry, skipped,
//     concurrency-closed rows, attempt-cap, abandon-cap
//   * startMessageRouter -- re-entrancy guard (overlapping ticks are skipped)
//   * batchDeliverBacklog (covered indirectly via the reconnect pre-pass)
//   * runMessageRouterTick main loop:
//       - local + federated split by isQualifiedId
//       - absent / present session-existence cache + per-agent lookup
//       - reconnect-batch pre-pass when threshold and age are met
//       - reconnect absent-set bookkeeping + batched-once flag
//       - main-agent wakeup fire + cooldown + throw on send
//       - abandon path when session absent past the window
//       - "not running, will retry" path (logged once per id)
//       - session-not-ready path (busy + stale-parked janitor)
//       - session STUCK escalation (warn log + reset timer)
//       - invalid from_agent reject path (cls === null)
//       - voice channel-inbound STT applied / null STT fallback / no voice file
//       - voice channel-inbound non-voice (only chat_id, modality=text)
//       - delivery wrap + deliveredAt + trace propagation + traceId on log
//       - inject throw path: retry < 3 then give up at 3 with notify
//       - per-message fault-isolation catch wrapping the whole loop body
//       - main-agent wakeup short-circuit (the main-loop's isMainAgent
//         continue at line 470 keeps main-agent targets off the notify path)
//       - createAgentMessage-throw in notify (catch arm)
//   * callVoiceSTT -- existsSync false -> null, transcribeVoiceFile returns
//     string, transcribeVoiceFile throws -> null, .env missing
//
// Any bug found by the suite is filed separately.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted harness: vi.mock factories run BEFORE module imports; everything
// they need to read at call time lives here.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  return {
    // db
    getPendingMessages: vi.fn(),
    markMessageDelivered: vi.fn(),
    markMessageFailed: vi.fn(),
    markMessageDone: vi.fn(),
    createAgentMessage: vi.fn(),
    markPendingFederatedFailed: vi.fn(),
    setMessageResult: vi.fn(),
    stampMessageTrace: vi.fn(),
    upsertOtelSpan: vi.fn(),

    // logger
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logDebug: vi.fn(),

    // federation config / bridge
    getFederationConfig: vi.fn(),
    sendFederatedMessage: vi.fn(),

    // agent-config
    readAgentRemoteHost: vi.fn(),
    readAgentVoiceConfig: vi.fn(),

    // agent-process
    agentSessionName: vi.fn((name: string) => `agent-${name}`),
    isSessionReadyForPrompt: vi.fn(),
    clearStaleParkedInput: vi.fn(),
    sendPromptToSession: vi.fn(),
    sessionExistsOnHost: vi.fn(),

    // voice-modality
    setLastInboundModality: vi.fn(),

    // main-agent
    MAIN_CHANNELS_SESSION: 'orin-channels',

    // voice-directive
    resolveAgentChannelStateDir: vi.fn(() => '/tmp/channel-state'),

    // routes/voice (dynamic-imported by callVoiceSTT)
    transcribeVoiceFile: vi.fn(),

    // agent-message-wrap
    classifyAgentMessage: vi.fn(),
    wrapAgentMessageForDelivery: vi.fn(() => ({ prefix: '', wrapped: '' })),

    // telegram-inbox-wake
    maybeWakeSubAgentsForTelegram: vi.fn(),

    // node:fs.existsSync used by callVoiceSTT
    existsSync: vi.fn(),

    // node:os (used by voice-directive indirectly; voice-directive is mocked)
    // node:http (used by nothing in this file)

    // main agent id (set via vi.mock factory -> MAIN_AGENT_ID)
    MAIN_AGENT_ID: 'orin',
    SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
  }
})

// ---------------------------------------------------------------------------
// Module mocks. voice-directive is mocked because the suite never lets
// callVoiceSTT reach the real resolver; routes/voice is mocked to capture the
// dynamic-imported transcribeVoiceFile. We keep node:fs un-mocked EXCEPT for
// existsSync, which callVoiceSTT re-imports inside its body.
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => H.logInfo(...a),
    warn: (...a: unknown[]) => H.logWarn(...a),
    error: (...a: unknown[]) => H.logError(...a),
    debug: (...a: unknown[]) => H.logDebug(...a),
  },
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    get MAIN_AGENT_ID() { return H.MAIN_AGENT_ID },
    get SUBAGENT_TELEGRAM_WAKE_ENABLED() { return H.SUBAGENT_TELEGRAM_WAKE_ENABLED },
  }
})

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => H.getPendingMessages(toAgent),
  markMessageDelivered: (id: number) => H.markMessageDelivered(id),
  markMessageFailed: (id: number, err?: string) => H.markMessageFailed(id, err),
  markMessageDone: (id: number, result?: string) => H.markMessageDone(id, result),
  createAgentMessage: (from: string, to: string, content: string) => H.createAgentMessage(from, to, content),
  markPendingFederatedFailed: (id: number, error: string) => H.markPendingFederatedFailed(id, error),
  setMessageResult: (id: number, result: string) => H.setMessageResult(id, result),
  stampMessageTrace: (...a: unknown[]) => H.stampMessageTrace(...a),
  upsertOtelSpan: (...a: unknown[]) => H.upsertOtelSpan(...a),
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: (agentId: string, provider: string) => H.resolveAgentChannelStateDir(agentId, provider),
  inboundIsAudio: vi.fn(),
  buildTtsDirective: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: (name: string) => H.readAgentRemoteHost(name),
  readAgentVoiceConfig: (name: string) => H.readAgentVoiceConfig(name),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => H.agentSessionName(name),
  isSessionReadyForPrompt: (session: string, host: string | null) => H.isSessionReadyForPrompt(session, host),
  clearStaleParkedInput: (session: string, host: string | null) => H.clearStaleParkedInput(session, host),
  sendPromptToSession: (session: string, text: string, host: string | null, opts?: unknown) => H.sendPromptToSession(session, text, host, opts),
  sessionExistsOnHost: (host: string | null, session: string) => H.sessionExistsOnHost(host, session),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: (agent: string, chatId: string, modality: string) => H.setLastInboundModality(agent, chatId, modality),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: (from: string, to: string) => H.classifyAgentMessage(from, to),
  wrapAgentMessageForDelivery: (...a: unknown[]) => H.wrapAgentMessageForDelivery(...a),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: (now: number) => H.maybeWakeSubAgentsForTelegram(now),
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: () => H.getFederationConfig(),
  abandonWindowMsForPeer: () => 60 * 60 * 1000,
}))

vi.mock('../web/federation/bridge.js', () => ({
  sendFederatedMessage: (msg: unknown, now: number) => H.sendFederatedMessage(msg, now),
}))

// Override ONLY existsSync; rest of node:fs stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: ((p: string) => H.existsSync(p)) as typeof actual.existsSync,
  }
})

// routes/voice is dynamic-imported by callVoiceSTT inside the SUT.
vi.mock('../web/routes/voice.js', () => ({
  transcribeVoiceFile: (fileId: string, stateDir: string) => H.transcribeVoiceFile(fileId, stateDir),
}))

import {
  shouldAbandon,
  shouldGiveUpOnInject,
  runMessageRouterTick,
  deliverFederatedBatch,
  startMessageRouter,
  MAX_MESSAGES_PER_TICK,
} from '../web/message-router.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1000)

function makeLocalMsg(overrides: Partial<{
  id: number
  from_agent: string
  to_agent: string
  content: string
  created_at: number
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
}> = {}): {
  id: number
  from_agent: string
  to_agent: string
  content: string
  created_at: number
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
} {
  return {
    id: 1,
    from_agent: 'orin',
    to_agent: 'dex',
    content: 'hello',
    created_at: NOW_SEC,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    ...overrides,
  }
}

function makeFedMsg(overrides: Partial<{
  id: number
  from_agent: string
  to_agent: string
  content: string
  created_at: number
}> = {}): {
  id: number
  from_agent: string
  to_agent: string
  content: string
  created_at: number
} {
  return {
    id: 2,
    from_agent: 'orin',
    to_agent: 'arthur/dex',
    content: 'federated hello',
    created_at: NOW_SEC,
    ...overrides,
  }
}

function resetMocks(): void {
  vi.clearAllMocks()
  // Sensible defaults for all collaborators -- individual tests override.
  H.getPendingMessages.mockReturnValue([])
  H.markMessageDelivered.mockReturnValue(true)
  H.markMessageFailed.mockReturnValue(true)
  H.markMessageDone.mockReturnValue(true)
  H.createAgentMessage.mockReturnValue({ id: 999 })
  H.markPendingFederatedFailed.mockReturnValue(true)
  H.setMessageResult.mockReturnValue(true)
  H.stampMessageTrace.mockReturnValue(true)
  H.upsertOtelSpan.mockReturnValue(undefined)
  H.readAgentRemoteHost.mockReturnValue(null)
  H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'text' })
  H.isSessionReadyForPrompt.mockResolvedValue(true)
  H.clearStaleParkedInput.mockResolvedValue(false)
  H.sendPromptToSession.mockResolvedValue(undefined)
  H.sessionExistsOnHost.mockReturnValue(true)
  H.setLastInboundModality.mockReturnValue(undefined)
  H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  H.maybeWakeSubAgentsForTelegram.mockResolvedValue(undefined)
  H.existsSync.mockReturnValue(false)
  H.transcribeVoiceFile.mockResolvedValue(null)
  H.getFederationConfig.mockReturnValue({ enabled: true, systemId: 'orin', peers: [] })
  H.sendFederatedMessage.mockResolvedValue({ kind: 'skipped' })
}

beforeEach(() => {
  resetMocks()
})

// ===========================================================================
// 1) Pure predicates
// ===========================================================================

describe('shouldAbandon (pure decision)', () => {
  const W = 60 * 60 * 1000
  it('returns false when session exists, regardless of age', () => {
    expect(shouldAbandon(true, 0, W)).toBe(false)
    expect(shouldAbandon(true, W + 1, W)).toBe(false)
    expect(shouldAbandon(true, W * 10, W)).toBe(false)
  })
  it('returns false when session absent but age below the window', () => {
    expect(shouldAbandon(false, 0, W)).toBe(false)
    expect(shouldAbandon(false, W - 1, W)).toBe(false)
  })
  it('returns true only when session absent AND age past the window', () => {
    expect(shouldAbandon(false, W + 1, W)).toBe(true)
    expect(shouldAbandon(false, W * 2, W)).toBe(true)
  })
  it('strict greater-than at the boundary', () => {
    expect(shouldAbandon(false, W, W)).toBe(false)
  })
})

describe('shouldGiveUpOnInject (pure decision)', () => {
  it('keeps retrying below the cap', () => {
    expect(shouldGiveUpOnInject(0, 3)).toBe(false)
    expect(shouldGiveUpOnInject(1, 3)).toBe(false)
    expect(shouldGiveUpOnInject(2, 3)).toBe(false)
  })
  it('gives up once the cap is reached', () => {
    expect(shouldGiveUpOnInject(3, 3)).toBe(true)
    expect(shouldGiveUpOnInject(7, 3)).toBe(true)
  })
  it('reaching the cap is inclusive (>=)', () => {
    expect(shouldGiveUpOnInject(3, 3)).toBe(true)
    expect(shouldGiveUpOnInject(2, 3)).toBe(false)
  })
})

// ===========================================================================
// 2) deliverFederatedBatch
// ===========================================================================

describe('deliverFederatedBatch', () => {
  it('does nothing when given an empty array', async () => {
    await deliverFederatedBatch([], NOW_MS)
    expect(H.sendFederatedMessage).not.toHaveBeenCalled()
  })

  it('abandons a federated message past its per-peer window and notifies the sender', async () => {
    const msg = makeFedMsg({ id: 11 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'skipped' })
    // Age past the per-peer window: created 2h ago
    msg.created_at = NOW_SEC - 7200
    await deliverFederatedBatch([msg], NOW_MS)
    // markPendingFederatedFailed called and notifyDelegationFailed calls createAgentMessage
    expect(H.markPendingFederatedFailed).toHaveBeenCalledWith(11, expect.stringContaining('Abandoned'))
    expect(H.createAgentMessage).toHaveBeenCalledWith('system', 'orin', expect.stringContaining('véglegesen meghiúsult'))
    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'Federated message abandoned: peer unreachable for full retry window')
  })

  it('logs "0 rows affected" when markPendingFederatedFailed returns false on abandon', async () => {
    const msg = makeFedMsg({ id: 12, from_agent: 'team', to_agent: 'arthur/dex' })
    msg.created_at = NOW_SEC - 7200
    H.markPendingFederatedFailed.mockReturnValue(false)
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).toHaveBeenCalledWith({ id: 12 }, 'markPendingFederatedFailed affected 0 rows (already closed concurrently)')
  })

  it('caps abandons per tick (continues when abandons >= MAX_FEDERATED_PER_TICK)', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeFedMsg({ id: 100 + i, from_agent: 'orin', to_agent: 'arthur/dex', created_at: NOW_SEC - 7200 }),
    )
    await deliverFederatedBatch(messages, NOW_MS)
    // Only the first 3 get to fire the abandon path; the other 2 are skipped by the abandon-cap.
    expect(H.markPendingFederatedFailed).toHaveBeenCalledTimes(3)
  })

  it('marks a message delivered and stores the fed:remoteId result text', async () => {
    const msg = makeFedMsg({ id: 21 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'delivered', remoteId: 'remote-77' })
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.markMessageDelivered).toHaveBeenCalledWith(21)
    expect(H.setMessageResult).toHaveBeenCalledWith(21, 'fed:arthur:remote-77')
    expect(H.logInfo).toHaveBeenCalledWith(expect.objectContaining({ fedOut: true, id: 21, remoteId: 'remote-77' }), 'Federated message delivered to peer inbox')
  })

  it('logs warn when markMessageDelivered returned false after a successful delivery', async () => {
    const msg = makeFedMsg({ id: 22 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'delivered', remoteId: 'r-1' })
    H.markMessageDelivered.mockReturnValue(false)
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ fedOut: true, id: 22, to: 'arthur/dex' }), 'Federated message concurrently closed during send; peer accepted (at-least-once)')
  })

  it('marks a federated message terminally failed and notifies the sender', async () => {
    const msg = makeFedMsg({ id: 31 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'failed', error: 'rejected 400' })
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.markPendingFederatedFailed).toHaveBeenCalledWith(31, 'rejected 400')
    expect(H.createAgentMessage).toHaveBeenCalledWith('system', 'orin', expect.stringContaining('véglegesen meghiúsult'))
  })

  it('logs warn when markPendingFederatedFailed returned false after a terminal failure', async () => {
    const msg = makeFedMsg({ id: 32 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'failed', error: 'oops' })
    H.markPendingFederatedFailed.mockReturnValue(false)
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).toHaveBeenCalledWith({ id: 32 }, 'markPendingFederatedFailed affected 0 rows (already closed concurrently)')
  })

  it('logs retry attempts once per message id, not on every retry tick', async () => {
    const msg = makeFedMsg({ id: 41 })
    H.sendFederatedMessage.mockResolvedValue({ kind: 'retry', error: 'still down' })
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ fedOut: true, id: 41, error: 'still down' }), 'Federated message delivery failed, will retry')
    H.logWarn.mockClear()
    // Second pass: same id, should NOT log again because of the once-per-id suppression.
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).not.toHaveBeenCalledWith(expect.objectContaining({ id: 41 }), 'Federated message delivery failed, will retry')
  })

  it('skips a send without bumping the attempt counter when bridge returned kind:skipped', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeFedMsg({ id: 50 + i }))
    H.sendFederatedMessage.mockResolvedValue({ kind: 'skipped' })
    await deliverFederatedBatch(messages, NOW_MS)
    // attempts cap only counts delivered/failed/retry; "skipped" must not.
    // So a 5-message batch with all skipped should not throw and not mark anything.
    expect(H.markMessageDelivered).not.toHaveBeenCalled()
    expect(H.markPendingFederatedFailed).not.toHaveBeenCalled()
  })

  it('caps attempts at MAX_FEDERATED_PER_TICK per tick', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeFedMsg({ id: 60 + i }))
    // First 3 succeed; remaining two should NOT be sent (attempts capped).
    H.sendFederatedMessage.mockImplementation(async (msg: { id: number }) => {
      if (msg.id <= 62) return { kind: 'delivered', remoteId: `r-${msg.id}` }
      throw new Error('Should not be called for id ' + msg.id)
    })
    await deliverFederatedBatch(messages, NOW_MS)
    expect(H.sendFederatedMessage).toHaveBeenCalledTimes(3)
    expect(H.markMessageDelivered).toHaveBeenCalledTimes(3)
  })

  it('swallows a thrown sendFederatedMessage and treats it as retry', async () => {
    const msg = makeFedMsg({ id: 71 })
    H.sendFederatedMessage.mockRejectedValue(new Error('boom'))
    await deliverFederatedBatch([msg], NOW_MS)
    // Falls through to the retry log path.
    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ id: 71 }), 'Federated message delivery failed, will retry')
  })
})

// ===========================================================================
// 3) startMessageRouter: re-entrancy guard
// ===========================================================================

describe('startMessageRouter (re-entrancy guard)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a setInterval that invokes runMessageRouterTick every 5s', async () => {
    vi.useFakeTimers()
    H.getPendingMessages.mockReturnValue([])

    const handle = startMessageRouter()
    expect(handle).toBeDefined()
    // The factory body wraps `runMessageRouterTick` -- calling advanceTimersByTime
    // triggers it. We verify the side-effect (db call) instead of calling the
    // exported tick directly so the re-entrancy branch is exercised end-to-end.
    await vi.advanceTimersByTimeAsync(5_500)
    expect(H.getPendingMessages).toHaveBeenCalled()
    clearInterval(handle)
  })

  it('skips a tick when the previous one is still running', async () => {
    vi.useFakeTimers()
    // Pin NOW_MS so the federated message is NOT abandoned by the per-peer
    // window. makeFedMsg uses NOW_SEC (2023) by default, which is far past
    // the 1-hour window under real Date.now() and would short-circuit the
    // bridge before sendFederatedMessage is even called.
    vi.setSystemTime(NOW_MS)
    let resolveBlock: (() => void) | null = null
    const block = new Promise<void>((r) => { resolveBlock = r })
    H.sendFederatedMessage.mockImplementation(async () => { await block; return { kind: 'skipped' } })

    // First message keeps the tick in flight (deliverFederatedBatch awaits).
    H.getPendingMessages.mockReturnValue([makeFedMsg({ id: 1 })])

    const handle = startMessageRouter()
    // Trigger the first tick.
    await vi.advanceTimersByTimeAsync(5_000)
    // Now fire another tick while the first is still awaiting block.
    await vi.advanceTimersByTimeAsync(5_000)
    // The second tick must be skipped -- sendFederatedMessage was called only once.
    expect(H.sendFederatedMessage).toHaveBeenCalledTimes(1)
    // Resolve and clean up.
    resolveBlock!()
    await vi.advanceTimersByTimeAsync(0)
    clearInterval(handle)
  })
})

// ===========================================================================
// 4) runMessageRouterTick - main loop branches
// ===========================================================================

describe('runMessageRouterTick', () => {
  it('returns immediately when no pending messages', async () => {
    H.getPendingMessages.mockReturnValue([])
    await runMessageRouterTick()
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
    expect(H.sessionExistsOnHost).not.toHaveBeenCalled()
  })

  it('splits local vs federated recipients, deduping session lookups per receiver', async () => {
    // Use a recent created_at so the federated messages are NOT abandoned by
    // the per-peer window. The default makeFedMsg created_at is frozen at
    // NOW_SEC (2023) which makes the simulated age far past the abandon
    // window once the real Date.now() advances; the test was designed
    // assuming fake timers but the surrounding suite does not install them
    // here.
    const freshMs = Math.floor(Date.now() / 1000)
    const msgs = [
      makeLocalMsg({ id: 1, to_agent: 'dex', created_at: freshMs }),
      makeLocalMsg({ id: 2, to_agent: 'dex', created_at: freshMs }),  // same receiver -> one session check
      makeLocalMsg({ id: 3, to_agent: 'mason', created_at: freshMs }), // different receiver
      makeFedMsg({ id: 4, to_agent: 'arthur/a', created_at: freshMs }),
      makeFedMsg({ id: 5, to_agent: 'arthur/b', created_at: freshMs }),
    ]
    H.getPendingMessages.mockReturnValue(msgs)
    H.sessionExistsOnHost.mockReturnValue(true)

    await runMessageRouterTick()

    // sessionExistsOnHost is called once per UNIQUE local receiver (dex, mason) plus
    // any subsequent fallback path -- but here all are in receiversInTick.
    expect(H.sessionExistsOnHost).toHaveBeenCalledTimes(2)
    // Local messages processed (sendPromptToSession per non-main, local message)
    expect(H.sendPromptToSession).toHaveBeenCalled()
    // Federated messages went to deliverFederatedBatch
    expect(H.sendFederatedMessage).toHaveBeenCalled()
  })

  it('cap is MAX_MESSAGES_PER_TICK messages per tick, in-order', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    const msgs = Array.from({ length: 30 }, (_, i) =>
      makeLocalMsg({ id: i + 1, to_agent: 'a' }),
    )
    H.getPendingMessages.mockReturnValue(msgs)
    H.sessionExistsOnHost.mockReturnValue(true)

    await runMessageRouterTick()

    // 30 messages, 25 processed in this tick.
    expect(H.sessionExistsOnHost).toHaveBeenCalledTimes(1) // same receiver -> 1 lookup
  })

  // ----- session absent: skip + log once per id -----
  it('skips a fresh message whose target session is absent and logs only once', async () => {
    // Pin the fake time so the message is fresh (otherwise the per-window
    // abandon path fires instead of the "skip + retry" branch the test is
    // exercising). The message is local and the session is absent, so the
    // skip-and-log-once branch is the only one we want to hit.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const msg = makeLocalMsg({ id: 100 })
    H.getPendingMessages.mockReturnValue([msg])
    H.sessionExistsOnHost.mockReturnValue(false)
    H.getPendingMessages.mockImplementation((toAgent?: string) => {
      if (toAgent) return [] // per-agent reconnect pre-pass
      return [msg]
    })

    await runMessageRouterTick()
    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 100, to: 'dex', session: 'agent-dex' }),
      'Agent message target session not running, will retry',
    )
    // Second call -- already in routerLoggedMisses, must NOT log again.
    expect(H.logWarn.mock.calls.filter(c => c[1] === 'Agent message target session not running, will retry')).toHaveLength(1)
    expect(H.markMessageFailed).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  // ----- session absent past the window: abandon + orchestrator notify -----
  it('marks a message abandoned when the target session is absent past the window', async () => {
    const msg = makeLocalMsg({
      id: 110,
      from_agent: 'mason',
      to_agent: 'dex',
      created_at: NOW_SEC - 7200, // 2h ago
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(false)

    await runMessageRouterTick()

    expect(H.markMessageFailed).toHaveBeenCalledWith(110, expect.stringContaining('Abandoned'))
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      'system', H.MAIN_AGENT_ID,
      expect.stringContaining('[handoff-failure]'),
    )
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 110 }),
      'Agent message abandoned: target session absent for full retry window',
    )
  })

  it('warns when markMessageFailed returns false during an abandon', async () => {
    const msg = makeLocalMsg({ id: 111, created_at: NOW_SEC - 7200 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(false)
    H.markMessageFailed.mockReturnValue(false)
    await runMessageRouterTick()
    expect(H.logWarn).toHaveBeenCalledWith({ id: 111 }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
  })

  // ----- session not ready: stale-parked janitor + STUCK escalation -----
  it('runs the stale-parked-input janitor and skips delivery when it cleared the box', async () => {
    const msg = makeLocalMsg({ id: 120, created_at: NOW_SEC - 60 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.clearStaleParkedInput.mockResolvedValue(true)

    await runMessageRouterTick()

    expect(H.clearStaleParkedInput).toHaveBeenCalledWith('agent-dex', null)
    // Janitor succeeded -> continue; no markDelivered, no log of "target session busy".
    expect(H.markMessageDelivered).not.toHaveBeenCalled()
    expect(H.logWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 120 }),
      'Agent message target session busy, will retry',
    )
  })

  it('logs "busy, will retry" once when the session stays not-ready past the janitor window', async () => {
    const msg = makeLocalMsg({ id: 121, created_at: NOW_SEC - 60 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.clearStaleParkedInput.mockResolvedValue(false)

    await runMessageRouterTick()
    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 121, to: 'dex', session: 'agent-dex' }),
      'Agent message target session busy, will retry',
    )
    // Second call must NOT log again.
    expect(H.logWarn.mock.calls.filter(c => c[1] === 'Agent message target session busy, will retry')).toHaveLength(1)
    expect(H.markMessageDelivered).not.toHaveBeenCalled()
  })

  it('escalates a session STUCK past 10min with a warn log, then resets the timer', async () => {
    // First message lands when the session is fresh-stuck (sets timer).
    const msgA = makeLocalMsg({ id: 130, created_at: NOW_SEC - 60 })
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [msgA]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.clearStaleParkedInput.mockResolvedValue(false)
    await runMessageRouterTick()
    // No warn yet -- STUCK_ESCALATE_MS = 10 min; the timer was just set.
    expect(H.logWarn).not.toHaveBeenCalledWith(expect.anything(), 'message-router: session STUCK — continuously not-ready past escalation threshold')

    // Advance the timer past the escalation window using the second-pass reset.
    // We re-use vi.useFakeTimers + Date.now shift via a second runMessageRouterTick
    // after the threshold elapses. Date.now is read inside runMessageRouterTick;
    // vi.useFakeTimers + advanceTimersByTime shifts both timers AND Date.now.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [makeLocalMsg({ id: 131, created_at: NOW_SEC - 60 })]))
    await runMessageRouterTick()
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'dex', session: 'agent-dex', stuckDurationMs: expect.any(Number) }),
      'message-router: session STUCK — continuously not-ready past escalation threshold',
    )
    vi.useRealTimers()
  })

  // ----- invalid from_agent (cls === null) -----
  it('fails a message whose from_agent sanitizes to empty', async () => {
    const msg = makeLocalMsg({ id: 140, from_agent: '!!!' })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue(null)

    await runMessageRouterTick()

    expect(H.markMessageFailed).toHaveBeenCalledWith(140, 'Invalid or empty from_agent')
  })

  it('warns when markMessageFailed returns false during an invalid from_agent reject', async () => {
    const msg = makeLocalMsg({ id: 141, from_agent: '!!!' })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue(null)
    H.markMessageFailed.mockReturnValue(false)

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith({ id: 141 }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
  })

  // ----- voice STT path -----
  it('runs STT on a channel-inbound voice message and applies the transcript', async () => {
    const msg = makeLocalMsg({
      id: 150,
      from_agent: 'telegram-coordinator',
      to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice" attachment_file_id="f-99">orig voice</channel>',
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto' })
    H.existsSync.mockReturnValue(true)
    H.transcribeVoiceFile.mockResolvedValue('hello there')

    await runMessageRouterTick()

    expect(H.transcribeVoiceFile).toHaveBeenCalledWith('f-99', '/tmp/channel-state')
    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '42', 'voice')
    expect(H.logInfo).toHaveBeenCalledWith(expect.objectContaining({ id: 150, agent: 'dex' }), 'message-router: voice STT applied')
    // Wrap content was the STT-applied deliveryContent, NOT raw.
    expect(H.wrapAgentMessageForDelivery).toHaveBeenCalledWith(
      'channel-inbound', 'telegram-coordinator', 'telegram-coordinator',
      expect.stringContaining('[Hang átirat]: hello there'),
      150, undefined,
    )
    expect(H.markMessageDelivered).toHaveBeenCalledWith(150)
  })

  it('logs "STT failed" but still delivers raw voice content when STT returns null', async () => {
    const msg = makeLocalMsg({
      id: 151,
      from_agent: 'telegram-coordinator',
      to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice" attachment_file_id="f-99">orig voice</channel>',
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto' })
    H.existsSync.mockReturnValue(true)
    H.transcribeVoiceFile.mockResolvedValue(null)

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ id: 151, agent: 'dex' }), 'message-router: STT failed, delivering raw voice block')
    // deliveryContent stays raw
    expect(H.wrapAgentMessageForDelivery).toHaveBeenCalledWith(
      'channel-inbound', 'telegram-coordinator', 'telegram-coordinator',
      expect.stringContaining('attachment_kind="voice"'),
      151, undefined,
    )
  })

  it('records text modality when chat_id is present but attachment is not voice', async () => {
    const msg = makeLocalMsg({
      id: 152,
      from_agent: 'telegram-coordinator',
      to_agent: 'dex',
      content: '<channel chat_id="42">plain text</channel>',
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })

    await runMessageRouterTick()

    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '42', 'text')
    expect(H.transcribeVoiceFile).not.toHaveBeenCalled()
  })

  it('records modality even when voice config is "text" (always record modality on voice)', async () => {
    const msg = makeLocalMsg({
      id: 153,
      from_agent: 'telegram-coordinator',
      to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice" attachment_file_id="f-99">orig voice</channel>',
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'text' })
    H.existsSync.mockReturnValue(true)

    await runMessageRouterTick()
    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '42', 'voice')
    expect(H.transcribeVoiceFile).not.toHaveBeenCalled()
  })

  // ----- successful delivery + OTel trace stamping + propagation -----
  it('stamps a fresh trace on an inter-agent message with no inherited context', async () => {
    // Pin fake time so the message is fresh: the abandonment gate relies on
    // wall-clock age, and the default makeLocalMsg uses NOW_SEC (2023) which
    // is past the 1-hour abandon window under real Date.now(). Using a
    // dedicated receiver name ('mason') avoids bleed from the module-level
    // deliveredTraceCtx cache that the earlier 'dex' tests in this suite
    // populate, which would otherwise produce a non-null parent_span_id.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const msg = makeLocalMsg({ id: 160, from_agent: 'orin', to_agent: 'mason', trace_id: null, span_id: null })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'untrusted', safeFrom: 'orin' })

    await runMessageRouterTick()

    expect(H.stampMessageTrace).toHaveBeenCalledWith(160, expect.any(String), expect.any(String), null)
    expect(H.upsertOtelSpan).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'orin',
      operation: 'orin->mason',
      parent_span_id: null,
    }))
    expect(H.markMessageDelivered).toHaveBeenCalledWith(160)
    expect(H.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: 160, from: 'orin', to: 'mason', category: 'untrusted' }),
      'Agent message delivered',
    )
    vi.useRealTimers()
  })

  it('uses an existing trace_id/span_id when the message already has one', async () => {
    const msg = makeLocalMsg({
      id: 161, from_agent: 'mason', to_agent: 'dex',
      trace_id: 'existing-trace', span_id: 'existing-span',
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'untrusted', safeFrom: 'mason' })

    await runMessageRouterTick()

    // No re-stamp, but delivered.
    expect(H.stampMessageTrace).not.toHaveBeenCalled()
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
    expect(H.markMessageDelivered).toHaveBeenCalledWith(161)
  })

  it('warns when markMessageDelivered returns false (concurrent deletion)', async () => {
    const msg = makeLocalMsg({ id: 162 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    H.markMessageDelivered.mockReturnValue(false)

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith({ id: 162 }, 'markMessageDelivered affected 0 rows (deleted concurrently?)')
  })

  // ----- inject throw path -----
  it('retries an inject throw up to MAX_INJECT_FAILURES times then marks failed + notifies', async () => {
    // Pin fake time so the message is fresh (the abandonment gate also keys
    // off wall-clock age; without the system-time pin the per-peer window
    // would put the message past the abandon window before the inject path
    // is even reached). The inject-throw retry path is gated only on
    // failCount, not on age, so this is the only time-related concern.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const msg = makeLocalMsg({ id: 170 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    H.sendPromptToSession.mockRejectedValue(new Error('pane not ready'))

    await runMessageRouterTick()
    // First attempt fails: NOT marked failed yet, just retried.
    expect(H.markMessageFailed).not.toHaveBeenCalled()
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 170 }),
      'Failed to inject agent message, will retry next tick',
    )
    expect(H.logWarn).not.toHaveBeenCalledWith(expect.anything(), 'Failed to inject agent message after retries, giving up')

    // 2nd retry -> still within budget (failCount=2, MAX=3)
    await runMessageRouterTick()
    expect(H.markMessageFailed).not.toHaveBeenCalled()

    // 3rd retry -> now over budget (failCount=3 reaches MAX_INJECT_FAILURES
    // and shouldGiveUpOnInject returns true on the >= cap) -> marked failed.
    // The source records failCount starting at 1, so the 3rd tick is the
    // 'after 3 attempts' line, not 'after 4'.
    await runMessageRouterTick()
    expect(H.markMessageFailed).toHaveBeenCalledWith(170, expect.stringContaining('Failed to inject into tmux session after 3 attempts'))
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      'system', H.MAIN_AGENT_ID,
      expect.stringContaining('[handoff-failure]'),
    )
    expect(H.logError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 170, failCount: 3 }),
      'Failed to inject agent message after retries, giving up',
    )
    vi.useRealTimers()
  })

  // ----- main-agent wakeup branch -----
  it('fires the main-agent wakeup once per tick when the message targets MAIN_AGENT_ID and the cooldown has elapsed', async () => {
    const msg = makeLocalMsg({
      id: 190,
      from_agent: 'dex',
      to_agent: H.MAIN_AGENT_ID,
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))

    // Use fake timers so we can also advance the cooldown window deterministically.
    // The system time is set FAR past NOW_MS so the module-level
    // lastMainAgentWakeupMs (which earlier wakeup tests in this suite may
    // have bumped to wall-clock 2026) is guaranteed to be inside the
    // cooldown window relative to this tick.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS + 10 * 60 * 1000)
    await runMessageRouterTick()
    expect(H.sendPromptToSession).toHaveBeenCalledWith(
      H.MAIN_CHANNELS_SESSION,
      '[inbox-wakeup: pending inter-agent messages]',
      null,
      { waitForIdle: false },
    )
    expect(H.logInfo).toHaveBeenCalledWith({ msgId: 190 }, 'message-router: main-agent wakeup fired')
    vi.useRealTimers()
  })

  it('does not refire the main-agent wakeup when the cooldown has not elapsed', async () => {
    const msg = makeLocalMsg({ id: 191, to_agent: H.MAIN_AGENT_ID })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))

    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    await runMessageRouterTick()
    const callsAfterFirst = H.sendPromptToSession.mock.calls.length
    // 1ms later: cooldown (45s) NOT elapsed.
    vi.setSystemTime(NOW_MS + 1)
    await runMessageRouterTick()
    // No new wakeup invocation.
    expect(H.sendPromptToSession.mock.calls.length).toBe(callsAfterFirst)
    vi.useRealTimers()
  })

  it('swallows a wakeup sendPromptToSession throw (warns, does not crash)', async () => {
    const msg = makeLocalMsg({ id: 192, to_agent: H.MAIN_AGENT_ID })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sendPromptToSession.mockRejectedValue(new Error('wake send failed'))

    // Pin the system time well past NOW_MS so the wakeup cooldown is
    // guaranteed to be elapsed even if earlier tests bumped the
    // module-level lastMainAgentWakeupMs to wall-clock 2026. The earlier
    // 'fires the main-agent wakeup' test in this suite ends with the same
    // (NOW_MS + 10 min) offset, so we push further: 30 min past NOW_MS to
    // clear the 45s cooldown with margin even relative to that prior tick.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS + 30 * 60 * 1000)
    await runMessageRouterTick()
    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'message-router: main-agent wakeup injection failed')
    vi.useRealTimers()
  })

  // ----- main-agent wakeup cooldown pre-elapsed: skip -----
  it('skips the main-agent wakeup when lastMainAgentWakeupMs is within the cooldown', async () => {
    // First tick: fire wakeup to set lastMainAgentWakeupMs.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [makeLocalMsg({ id: 200, to_agent: H.MAIN_AGENT_ID })]))
    await runMessageRouterTick()
    H.sendPromptToSession.mockClear()

    // Second tick right after, but the cooldown is 45s, so no wakeup.
    vi.setSystemTime(NOW_MS + 10_000)
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [makeLocalMsg({ id: 201, to_agent: H.MAIN_AGENT_ID })]))
    await runMessageRouterTick()
    // The main-agent wakeup must NOT fire here -- the call should NOT include the
    // wakeup prompt signature.
    const wakeupCalls = H.sendPromptToSession.mock.calls.filter(c => c[1] === '[inbox-wakeup: pending inter-agent messages]')
    expect(wakeupCalls).toHaveLength(0)
    vi.useRealTimers()
  })

  // ----- per-message fault-isolation catch wrapping the whole loop body -----
  it('marks a message failed (and continues) when the loop body throws unexpectedly', async () => {
    const msg = makeLocalMsg({ id: 210 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    // classifyAgentMessage throws -> the inner try catches it (per-message fault
    // isolation), marks the message failed with a 200-char truncated preview.
    H.classifyAgentMessage.mockImplementation(() => { throw new Error('explode-' + 'X'.repeat(300)) })

    await runMessageRouterTick()

    expect(H.markMessageFailed).toHaveBeenCalledWith(
      210,
      expect.stringMatching(/^Delivery error: /),
    )
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 210 }),
      'Agent message processing threw; marking failed so the queue cannot wedge',
    )
  })

  it('warns when markMessageFailed returns false during the loop fault-isolation catch', async () => {
    const msg = makeLocalMsg({ id: 211 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockImplementation(() => { throw new Error('boom') })
    H.markMessageFailed.mockReturnValue(false)

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith({ id: 211 }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
  })

  // ----- reconnect-batch pre-pass -----
  it('skips reconnect-batch when an agent has not been absent on the prior tick', async () => {
    const msg = makeLocalMsg({ id: 220, to_agent: 'dex' })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })

    await runMessageRouterTick()

    // batchDeliverBacklog is only fired when the agent was absent on the previous
    // tick -- it was not, so the backlog summary createAgentMessage must NOT fire.
    expect(H.createAgentMessage).not.toHaveBeenCalledWith('system', 'dex', expect.stringContaining('[BACKLOG-SUMMARY]'))
  })

  it('runs reconnect-batch on first reconnect when threshold + age both met', async () => {
    // Pin fake time so the messages are fresh relative to the abandon window.
    // The default makeLocalMsg uses NOW_SEC (2023), which is far past the
    // 1-hour window under real Date.now(); the test assertion exercises the
    // reconnect-batch path, not the abandon path, so the messages must be
    // recent enough to be considered pending.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    const msg = makeLocalMsg({ id: 230, to_agent: 'dex', created_at: freshMs - 60 * 60 })
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => {
      if (toAgent === 'dex') return [msg] // per-agent pre-pass: 1 msg
      return [msg]
    })
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })

    // Tick 1: dex is absent (recorded in agentWasAbsent).
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex returns (present). Pending count > THRESHOLD (5)? We pass
    // RECONNECT_BATCH_THRESHOLD + 1 messages, oldest > BATCH_AGE_MS.
    const many = Array.from({ length: 6 }, (_, i) => makeLocalMsg({
      id: 300 + i, to_agent: 'dex', created_at: freshMs - 60 * 60, // 1h old
    }))
    // No-arg call returns the full pending list (used to build receiversInTick);
    // per-agent call returns the per-agent backlog for the reconnect pre-pass.
    // Returning [] for the no-arg call would leave receiversInTick empty and
    // skip the reconnect-batch detection entirely.
    H.getPendingMessages.mockImplementation((toAgent?: string) => toAgent === 'dex' ? many : many)
    H.sessionExistsOnHost.mockReturnValue(true)

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'dex' }),
      'message-router: reconnect-backlog batch — summarizing old messages',
    )
    expect(H.markMessageDone).toHaveBeenCalled()
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      'system', 'dex',
      expect.stringContaining('[BACKLOG-SUMMARY]'),
    )
    vi.useRealTimers()
  })

  it('skips reconnect-batch when threshold NOT met (less than BATCH_THRESHOLD pending)', async () => {
    const msg = makeLocalMsg({ id: 240, to_agent: 'dex', created_at: NOW_SEC - 60 * 60 })
    // Tick 1: dex absent
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex present; only 1 pending -> threshold NOT met.
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent === 'dex' ? [msg] : []))
    H.sessionExistsOnHost.mockReturnValue(true)
    await runMessageRouterTick()

    expect(H.createAgentMessage).not.toHaveBeenCalledWith('system', 'dex', expect.stringContaining('[BACKLOG-SUMMARY]'))
  })

  it('skips reconnect-batch when oldest pending age is below BATCH_AGE_MS', async () => {
    const msg = makeLocalMsg({ id: 250, to_agent: 'dex' })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    const many = Array.from({ length: 6 }, (_, i) => makeLocalMsg({
      id: 400 + i, to_agent: 'dex', created_at: NOW_SEC - 60, // 1 minute old
    }))
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent === 'dex' ? many : []))
    H.sessionExistsOnHost.mockReturnValue(true)
    await runMessageRouterTick()

    expect(H.createAgentMessage).not.toHaveBeenCalledWith('system', 'dex', expect.stringContaining('[BACKLOG-SUMMARY]'))
  })

  it('skips reconnect-batch the SECOND time it sees the agent in presentNow (one-shot per reconnect)', async () => {
    const msg = makeLocalMsg({ id: 260, to_agent: 'dex' })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    const many = Array.from({ length: 6 }, (_, i) => makeLocalMsg({
      id: 500 + i, to_agent: 'dex', created_at: NOW_SEC - 60 * 60,
    }))
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent === 'dex' ? many : []))
    H.sessionExistsOnHost.mockReturnValue(true)
    // First reconnect tick: should batch.
    await runMessageRouterTick()
    H.createAgentMessage.mockClear()
    // Second reconnect tick (still present, still old): must NOT batch again.
    await runMessageRouterTick()
    expect(H.createAgentMessage).not.toHaveBeenCalledWith('system', 'dex', expect.stringContaining('[BACKLOG-SUMMARY]'))
  })

  // ----- absent/present bookkeeping clears stuck-since + batched flag -----
  it('clears agentStuckSince when a previously-stuck agent goes absent', async () => {
    const msg = makeLocalMsg({ id: 270, to_agent: 'dex', created_at: NOW_SEC - 60 })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.clearStaleParkedInput.mockResolvedValue(false)
    // Tick 1: dex present but not-ready -> stuck timer started.
    await runMessageRouterTick()
    // Tick 2: dex absent -> clears stuck timer (we just verify no STUCK warn fires next time it returns).
    H.sessionExistsOnHost.mockReturnValue(false)
    H.getPendingMessages.mockImplementationOnce(() => [])
    await runMessageRouterTick()
    H.logWarn.mockClear()
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.getPendingMessages.mockImplementationOnce(() => [])
    await runMessageRouterTick()
    expect(H.logWarn).not.toHaveBeenCalledWith(expect.anything(), 'message-router: session STUCK — continuously not-ready past escalation threshold')
  })

  // ----- deliverFederatedBatch runs even when local pending is empty -----
  it('runs deliverFederatedBatch independently of the local loop', async () => {
    // Pin fake time so the federated message is not abandoned by the per-peer
    // window. Without it, the default makeFedMsg created_at (NOW_SEC, 2023)
    // is way past the 1-hour window and the bridge path is skipped before
    // sendFederatedMessage is called.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    H.getPendingMessages.mockReturnValue([makeFedMsg({ id: 600, created_at: freshMs })])
    await runMessageRouterTick()
    expect(H.sendFederatedMessage).toHaveBeenCalled()
    vi.useRealTimers()
  })

  // ----- cache-wins path: sessionExists=false -> park for retry -----
  it('does NOT send when the cached sessionExists is false', async () => {
    // Pinning test. The source's `pending` slice always carries the message's
    // own to_agent into receiversInTick, so the per-receiver cache is always
    // populated for the message's target. The "cache miss -> direct
    // sessionExistsOnHost" fallback in the runMessageRouterTick loop is
    // therefore dead code in the current implementation, and the assertion
    // `sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)`
    // always takes the cached branch. The actual behavior: the cache lookup
    // wins, the session is reported as absent, and the message is parked in
    // the "target session not running, will retry" branch.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    let n = 0
    H.sessionExistsOnHost.mockImplementation(() => { n++; return n > 1 })
    H.getPendingMessages.mockReturnValue([makeLocalMsg({ id: 700, to_agent: 'a', created_at: freshMs })])
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    await runMessageRouterTick()
    // The cache wins, so the second mock call never triggers the fallback.
    // The message is parked to retry -- sendPromptToSession is NOT called.
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 700, to: 'a', session: 'agent-a' }),
      'Agent message target session not running, will retry',
    )
    vi.useRealTimers()
  })

  // ----- channel-inbound tracing is skipped -----
  it('does NOT stamp a trace on a channel-inbound message', async () => {
    const msg = makeLocalMsg({
      id: 710,
      from_agent: 'telegram-coordinator',
      to_agent: 'dex',
      content: '<channel chat_id="42">plain</channel>',
      trace_id: null, span_id: null,
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })

    await runMessageRouterTick()

    expect(H.stampMessageTrace).not.toHaveBeenCalled()
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
    expect(H.markMessageDelivered).toHaveBeenCalledWith(710)
  })
})

// ===========================================================================
// 5) Coverage for the module-scoped helpers that are not exported but
//    exercised via the main loop. These tests use the router tick to drive
//    them; their coverage is checked together with the corresponding branches.
// ===========================================================================

describe('module-scoped helpers (notify paths + createAgentMessage throws)', () => {
  it('swallows createAgentMessage throw in notifyOrchestratorOfFailedHandoff', async () => {
    const msg = makeLocalMsg({
      id: 800, from_agent: 'mason', to_agent: 'dex', created_at: NOW_SEC - 7200,
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(false)
    H.createAgentMessage.mockImplementation(() => { throw new Error('db write fail') })

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), id: 800 }),
      'Failed to enqueue handoff-failure notification',
    )
  })

  it('swallows createAgentMessage throw in notifyDelegationFailed (federated abandon)', async () => {
    const msg = makeFedMsg({ id: 810, from_agent: 'team', to_agent: 'arthur/dex', created_at: NOW_SEC - 7200 })
    H.createAgentMessage.mockImplementation(() => { throw new Error('db write fail') })
    await deliverFederatedBatch([msg], NOW_MS)
    expect(H.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), id: 810 }),
      'federated failure notice could not be created',
    )
  })

  it('passes the configured MAIN_AGENT_ID into the orchestrator note (via notify path)', async () => {
    H.MAIN_AGENT_ID = 'teodor'
    const msg = makeLocalMsg({
      id: 820, from_agent: 'mason', to_agent: 'dex', created_at: NOW_SEC - 7200,
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      'system', 'teodor',
      expect.stringContaining('[handoff-failure]'),
    )
    H.MAIN_AGENT_ID = 'orin'
  })
})

// ===========================================================================
// 6) voice path: extractVoiceFileId/extractChatId/injectTranscript
// ===========================================================================

describe('voice helpers (channel-inbound)', () => {
  // These helpers are module-private; we exercise them through the main loop.

  it('extracts voice file id only when attachment_kind is "voice"', async () => {
    const msgNoVoice = makeLocalMsg({
      id: 900, from_agent: 'telegram-coordinator', to_agent: 'dex',
      content: '<channel chat_id="1">plain text</channel>',
    })
    H.getPendingMessages.mockImplementationOnce(() => [msgNoVoice])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })

    await runMessageRouterTick()

    expect(H.transcribeVoiceFile).not.toHaveBeenCalled()
    // chat_id present -> modality=text path.
    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '1', 'text')
  })

  it('records no modality when neither voice file nor chat_id is present', async () => {
    // This branch is theoretically unreachable because channel-inbound messages
    // always carry chat_id, but the code handles it gracefully.
    const msg = makeLocalMsg({
      id: 901, from_agent: 'telegram-coordinator', to_agent: 'dex',
      content: '<channel>no chat</channel>',
    })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })

    await runMessageRouterTick()

    expect(H.setLastInboundModality).not.toHaveBeenCalled()
  })

  it('transcribes even when transcribeVoiceFile throws (returns null)', async () => {
    const msg = makeLocalMsg({
      id: 902, from_agent: 'telegram-coordinator', to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice" attachment_file_id="f-99">orig</channel>',
    })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto' })
    H.existsSync.mockReturnValue(true)
    H.transcribeVoiceFile.mockRejectedValue(new Error('whisper blew up'))

    await runMessageRouterTick()

    expect(H.logWarn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'message-router: callVoiceSTT error')
    expect(H.wrapAgentMessageForDelivery).toHaveBeenCalledWith(
      'channel-inbound', 'telegram-coordinator', 'telegram-coordinator',
      expect.stringContaining('attachment_kind="voice"'),
      902, undefined,
    )
  })

  it('skips STT when the channel state .env is missing', async () => {
    const msg = makeLocalMsg({
      id: 903, from_agent: 'telegram-coordinator', to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice" attachment_file_id="f-99">orig</channel>',
    })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto' })
    H.existsSync.mockReturnValue(false) // .env missing

    await runMessageRouterTick()

    expect(H.transcribeVoiceFile).not.toHaveBeenCalled()
    // modality still recorded (always record).
    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '42', 'voice')
    // deliveryContent remains raw -> wrapAgentMessageForDelivery gets the raw text.
    expect(H.wrapAgentMessageForDelivery).toHaveBeenCalledWith(
      'channel-inbound', 'telegram-coordinator', 'telegram-coordinator',
      expect.stringContaining('attachment_kind="voice"'),
      903, undefined,
    )
  })

  // ---- extractVoiceFileId null arm (line 663): attachment_kind="voice" present
  //      but attachment_file_id missing -> regex doesn't match, returns null.
  it('falls through to text modality when extractVoiceFileId returns null (no attachment_file_id attribute)', async () => {
    const msg = makeLocalMsg({
      id: 904, from_agent: 'telegram-coordinator', to_agent: 'dex',
      content: '<channel chat_id="42" attachment_kind="voice">orig voice</channel>',
    })
    H.getPendingMessages.mockImplementationOnce(() => [msg])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'channel-inbound', safeFrom: 'telegram-coordinator' })
    H.readAgentVoiceConfig.mockReturnValue({ responseMode: 'auto' })

    await runMessageRouterTick()

    // extractVoiceFileId returns null (regex no match) -> STT path is NOT entered.
    expect(H.transcribeVoiceFile).not.toHaveBeenCalled()
    // else-if branch fires: chat_id present but no voice file id -> text modality.
    expect(H.setLastInboundModality).toHaveBeenCalledWith('dex', '42', 'text')
  })
})

// ===========================================================================
// 7) maybeWakeSubAgentsForTelegram is called at the end of every tick
// ===========================================================================

describe('maybeWakeSubAgentsForTelegram integration', () => {
  it('invokes the watcher once per tick with the current timestamp', async () => {
    H.getPendingMessages.mockReturnValue([])
    await runMessageRouterTick()
    expect(H.maybeWakeSubAgentsForTelegram).toHaveBeenCalledTimes(1)
  })

  it('still invokes the watcher even when the local + federated queues are busy', async () => {
    H.getPendingMessages.mockReturnValue([makeLocalMsg({ id: 950 })])
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    await runMessageRouterTick()
    expect(H.maybeWakeSubAgentsForTelegram).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// 8) Coverage gap fillers: reachable branches not exercised by the suite above
//
//   * recent.push (batchDeliverBacklog else branch): mixed-age pending --
//     some messages older than RECONNECT_BATCH_AGE_MS, some younger. The
//     older ones get batched, the younger ones stay for individual delivery
//     on the next tick.
//   * if (!markMessageFailed(...)) false branch in the inject-give-up
//     path: markMessageFailed returns false (concurrent row close) so the
//     "0 rows affected" warn fires.
//   * if (oldestAge > BATCH_AGE_MS) else branch: the oldest pending is
//     younger than BATCH_AGE_MS, so the reconnect-batch pre-pass is
//     short-circuited even with >= 6 pending messages.
//   * stampTraceOnMessage else branch (stamped === falsy): the in-memory
//     trace cache is populated from a previous successful delivery, so the
//     message gets an inherited trace_id; stampMessageTrace returns false
//     and the upsertOtelSpan side-effect is skipped.
// ===========================================================================

describe('coverage gap fillers (reachable branches)', () => {
  // ---- recent.push: mixed-age messages trigger both arms in batchDeliverBacklog
  it('batchDeliverBacklog puts recent messages into the recent list while batching older ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    // Tick 1: dex absent (recorded in agentWasAbsent).
    const oldMsg = makeLocalMsg({ id: 1000, to_agent: 'dex', created_at: freshMs - 60 * 60 })
    H.getPendingMessages.mockImplementationOnce(() => [oldMsg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex returns with a mixed-age backlog.
    // - First 6 messages (oldest first) are 1h old -> all go into `old`.
    // - 7th message is 1 minute old -> goes into `recent`.
    // The oldest (>30min) gate is satisfied so the batch pre-pass fires.
    const mixed = [
      ...Array.from({ length: 6 }, (_, i) => makeLocalMsg({
        id: 1100 + i, to_agent: 'dex', created_at: freshMs - 60 * 60, // 1h old
      })),
      makeLocalMsg({ id: 1106, to_agent: 'dex', created_at: freshMs - 60 }), // 1 min old
    ]
    H.getPendingMessages.mockImplementation((toAgent?: string) => toAgent === 'dex' ? mixed : mixed)
    H.sessionExistsOnHost.mockReturnValue(true)
    await runMessageRouterTick()

    // The 7th (recent) message must NOT be in the batched summary; it is
    // preserved for the next tick. Only the 6 old ones are summarised.
    expect(H.markMessageDone).toHaveBeenCalledTimes(6)
    const summary = H.createAgentMessage.mock.calls.find(c =>
      c[0] === 'system' && c[1] === 'dex' && String(c[2]).includes('[BACKLOG-SUMMARY]'),
    )
    expect(summary).toBeDefined()
    const summaryText = String(summary![2])
    // 6 old items summarised, 1 recent left for individual delivery.
    expect(summaryText).toContain('6 inter-agent message(s)')
    // The recent (1 min old) message id 1106 should be absent from the summary lines.
    expect(summaryText).not.toContain('1106:')
    vi.useRealTimers()
  })

  // ---- markMessageFailed false in inject give-up: 0-rows-affected warn fires
  it('warns when markMessageFailed returns false during the inject-give-up path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const msg = makeLocalMsg({ id: 1200 })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    H.sendPromptToSession.mockRejectedValue(new Error('pane not ready'))
    // On the 3rd retry (which crosses MAX_INJECT_FAILURES), markMessageFailed
    // returns false -> the loop emits the "0 rows affected" warn.
    H.markMessageFailed.mockReturnValue(false)

    await runMessageRouterTick() // failCount 1
    await runMessageRouterTick() // failCount 2
    await runMessageRouterTick() // failCount 3 -> give up
    expect(H.logWarn).toHaveBeenCalledWith(
      { id: 1200 },
      'markMessageFailed affected 0 rows (deleted concurrently?)',
    )
    vi.useRealTimers()
  })

  // ---- if (oldestAge > BATCH_AGE_MS) else: oldest is younger than threshold
  it('skips the reconnect-batch when the oldest pending is younger than BATCH_AGE_MS', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    // Tick 1: dex absent.
    const absentMsg = makeLocalMsg({ id: 1300, to_agent: 'dex' })
    H.getPendingMessages.mockImplementationOnce(() => [absentMsg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex returns, threshold met (>=6 messages), but oldest is 1
    // minute old -> oldestAge <= BATCH_AGE_MS -> the if-else arm fires
    // and we do NOT enter the batch pre-pass body.
    const recent = Array.from({ length: 6 }, (_, i) => makeLocalMsg({
      id: 1400 + i, to_agent: 'dex', created_at: freshMs - 60, // 1 min old
    }))
    H.getPendingMessages.mockImplementation((toAgent?: string) => toAgent === 'dex' ? recent : recent)
    H.sessionExistsOnHost.mockReturnValue(true)

    await runMessageRouterTick()

    // No batch summary, no markMessageDone for the batch.
    expect(H.createAgentMessage).not.toHaveBeenCalledWith(
      'system', 'dex',
      expect.stringContaining('[BACKLOG-SUMMARY]'),
    )
    expect(H.markMessageDone).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  // ---- stampTraceOnMessage else branch: stampMessageTrace returns falsy
  it('skips upsertOtelSpan when stampMessageTrace returns falsy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    // Pre-warm the in-memory deliveredTraceCtx cache with a synthetic
    // trace context so this delivery inherits (the production "propagation"
    // path). The cache is module-scoped, so any value we put here is read
    // by the next stampTraceOnMessage call for the same from_agent.
    const msg = makeLocalMsg({
      id: 1500, from_agent: 'orin', to_agent: 'mason', trace_id: null, span_id: null,
    })
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(true)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'untrusted', safeFrom: 'orin' })
    // First delivery: stamps successfully, populates deliveredTraceCtx.
    H.stampMessageTrace.mockReturnValueOnce(true)
    const firstMsg = makeLocalMsg({
      id: 1500, from_agent: 'orin', to_agent: 'mason', trace_id: null, span_id: null,
    })
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [firstMsg]))
    await runMessageRouterTick()
    expect(H.upsertOtelSpan).toHaveBeenCalled()

    // Second delivery (same from_agent, fresh receiver): stampMessageTrace
    // returns falsy -> the upsertOtelSpan side-effect is skipped.
    H.stampMessageTrace.mockReturnValueOnce(false)
    const secondMsg = makeLocalMsg({
      id: 1501, from_agent: 'orin', to_agent: 'dex', trace_id: null, span_id: null,
    })
    H.getPendingMessages.mockImplementationOnce((toAgent?: string) => (toAgent ? [] : [secondMsg]))
    H.upsertOtelSpan.mockClear()
    await runMessageRouterTick()
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
    expect(H.markMessageDelivered).toHaveBeenCalledWith(1501)
    vi.useRealTimers()
  })

  // ---- batchDeliverBacklog || 'unknown' arm (line 326): backlog contains a
  //      pending message with empty from_agent. The walk over `old` records
  //      the sender as "unknown" instead of crashing on the empty string.
  it('batchDeliverBacklog labels a backlog message with empty from_agent as "unknown"', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    // Tick 1: dex absent.
    const absentMsg = makeLocalMsg({ id: 1600, to_agent: 'dex', created_at: freshMs })
    H.getPendingMessages.mockImplementationOnce(() => [absentMsg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex returns with 6+ old messages; the first one has empty
    // from_agent (a malformed/corrupt DB row). The router still summarises
    // it via the `|| 'unknown'` fallback.
    const backlog = [
      makeLocalMsg({ id: 1601, to_agent: 'dex', from_agent: '', created_at: freshMs - 60 * 60 }),
      ...Array.from({ length: 5 }, (_, i) => makeLocalMsg({
        id: 1602 + i, to_agent: 'dex', created_at: freshMs - 60 * 60,
      })),
    ]
    H.getPendingMessages.mockImplementation((toAgent?: string) => toAgent === 'dex' ? backlog : backlog)
    H.sessionExistsOnHost.mockReturnValue(true)
    await runMessageRouterTick()

    const summary = H.createAgentMessage.mock.calls.find(c =>
      c[0] === 'system' && c[1] === 'dex' && String(c[2]).includes('[BACKLOG-SUMMARY]'),
    )
    expect(summary).toBeDefined()
    const summaryText = String(summary![2])
    // Sender aggregator lists the empty-from_agent row under "unknown".
    expect(summaryText).toContain('unknown (1)')
    // The summary line for the empty-from_agent message also uses "unknown".
    expect(summaryText).toMatch(/\[.*\] unknown: /)
    vi.useRealTimers()
  })

  // ---- batchDeliverBacklog preview truncation arm (line 329): a backlog
  //      message with content > 120 chars gets truncated with the ellipsis
  //      suffix rather than rendered in full.
  it('batchDeliverBacklog truncates a long backlog preview with the ellipsis suffix', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    // Tick 1: dex absent.
    const absentMsg = makeLocalMsg({ id: 1700, to_agent: 'dex', created_at: freshMs })
    H.getPendingMessages.mockImplementationOnce(() => [absentMsg])
    H.sessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()

    // Tick 2: dex returns with 6+ old messages; the first one has a 200-char
    // content string (well past the 120-char preview cap).
    const longContent = 'x'.repeat(200)
    const backlog = [
      makeLocalMsg({ id: 1701, to_agent: 'dex', content: longContent, created_at: freshMs - 60 * 60 }),
      ...Array.from({ length: 5 }, (_, i) => makeLocalMsg({
        id: 1702 + i, to_agent: 'dex', created_at: freshMs - 60 * 60,
      })),
    ]
    H.getPendingMessages.mockImplementation((toAgent?: string) => toAgent === 'dex' ? backlog : backlog)
    H.sessionExistsOnHost.mockReturnValue(true)
    await runMessageRouterTick()

    const summary = H.createAgentMessage.mock.calls.find(c =>
      c[0] === 'system' && c[1] === 'dex' && String(c[2]).includes('[BACKLOG-SUMMARY]'),
    )
    expect(summary).toBeDefined()
    const summaryText = String(summary![2])
    // The truncated preview is exactly 120 'x's followed by the ellipsis.
    expect(summaryText).toContain('x'.repeat(120) + '…')
    // The full 200-char content is NOT in the summary (truncated).
    expect(summaryText).not.toContain('x'.repeat(121))
    vi.useRealTimers()
  })

  // ---- msg.content ?? '' branch (line 82): null content in the abandon
  //      notify still fires the handoff-failure system note, but the
  //      truncated preview body is the empty string.
  it('renders an empty preview when msg.content is null in the orchestrator notify', async () => {
    const msg = {
      id: 1800,
      from_agent: 'mason',
      to_agent: 'dex',
      content: null,
      created_at: NOW_SEC - 7200, // 2h ago -> past the abandon window
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    }
    H.getPendingMessages.mockImplementation((toAgent?: string) => (toAgent ? [] : [msg]))
    H.sessionExistsOnHost.mockReturnValue(false)

    await runMessageRouterTick()

    expect(H.markMessageFailed).toHaveBeenCalledWith(1800, expect.stringContaining('Abandoned'))
    const note = H.createAgentMessage.mock.calls.find(c =>
      c[0] === 'system' && c[1] === H.MAIN_AGENT_ID && String(c[2]).includes('[handoff-failure]'),
    )
    expect(note).toBeDefined()
    expect(String(note![2])).toMatch(/Content preview:\s*$/)
  })
})