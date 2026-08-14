// 100% coverage test for src/web/channel-plugin-unlock.ts.
//
// The module schedules a post-respawn tmux unlock probe (fire-and-forget
// setTimeout after `tmux respawn-pane`) that checks `pgrep -P <claude_pid>
// bun`, gates on the idle footer signature, and -- when both gates pass --
// sends the /mcp + Up + Enter + Enter + Escape + Escape keystroke sequence
// to revive a Failed/disabled channel plugin. Coverage requires every
// branch of:
//
//   * module load (TMUX resolution via resolveFromPath)
//   * the module-level `pluginAbsentAt` Map (clearPluginAbsent,
//     wasPluginConfirmedAbsent, the private markPluginAbsent)
//   * getSessionClaudePid: list-panes success, malformed pid, list-panes throw
//   * hasBunChild: pgrep hit, pgrep miss, pgrep throws (exit 1 -> caught)
//   * isSessionReadyForUnlock: idle footer present, Resume-from-summary
//     modal present, Open System Settings modal present, footer missing,
//     capture-pane throws
//   * runUnlockProbe: no claude pid, bun present (healthy), pane not ready
//     with retry budget, pane not ready exhausted, pane ready -> fires
//     sendUnlockKeystrokes
//   * sendUnlockKeystrokes: happy path, capture-pane-after-/mcp throws,
//     provider NOT in /mcp list (markPluginAbsent + Escape), outer
//     keystroke throws
//   * schedulePluginUnlockAfterRespawn: logs and schedules the probe
//
// Sandbox: child_process.execFileSync is fully mocked; platform.js resolves
// tmux to a stable fake path so the TMUX module-level constant doesn't
// shell out to `which`; logger is mocked so assertions can target each
// branch's log call without touching pino-pretty. No real tmux / pgrep /
// network / fs state is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock installation (hoisted).
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

// resolveFromPath is the source of the TMUX module-level const. Stub it so
// the module load doesn't shell out to `which tmux` (which would also
// trigger the live-install guard via execSync).
vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
  tryResolveFromPath: (name: string) => `/usr/local/bin/${name}`,
  makeLazyBinResolver: (name: string) => () => `/usr/local/bin/${name}`,
}))

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}
vi.mock('../logger.js', () => ({ logger: mockLogger }))

// ---------------------------------------------------------------------------
// SUT import (after mocks).
// ---------------------------------------------------------------------------

const {
  schedulePluginUnlockAfterRespawn,
  clearPluginAbsent,
  wasPluginConfirmedAbsent,
} = await import('../web/channel-plugin-unlock.js')

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const FAKE_TMUX = '/usr/local/bin/tmux'
const FAKE_PGREP = '/usr/bin/pgrep'
const SESSION = 'marveen-channels'

/** Wire mockExecFileSync to the default scripted behaviour:
 *  - tmux list-panes -> valid pid
 *  - pgrep -P <pid> bun -> empty (no bun -> triggers the unlock path)
 *  - tmux capture-pane -> "bypass permissions on" (idle footer)
 *  - tmux send-keys -> "" (succeeds)
 *  - /bin/sleep -> "" (succeeds)
 *
 *  The opts accept Error values for `pgrep`, `readyPane`, and `postMcpPane`
 *  to exercise the corresponding throw branches without breaking the rest
 *  of the scripted flow. `throwOnSendKeys: true` makes every send-keys
 *  invocation throw, useful for the outer-catch + inner-Escape-swallow
 *  branches.
 *
 *  Tests that need a one-off override should prefer passing Error values
 *  here over calling mockImplementationOnce, because Once would fire on
 *  whichever call lands first (usually list-panes), not the call the test
 *  intended to override. */
function setDefaultTmux(opts: {
  listPanes?: string
  pgrep?: string | Error
  readyPane?: string | Error
  postMcpPane?: string | Error
  throwOnSendKeys?: boolean
  throwOnSendKeysAfter?: (cmd: string, args: unknown[]) => boolean
} = {}): void {
  // The ready-pane vs post-/mcp-pane distinction: sendUnlockKeystrokes calls
  // capture-pane twice in the happy path -- once via isSessionReadyForUnlock
  // (must contain "bypass permissions on") and once after the /mcp Enter
  // (must contain the provider name). The default routes the first call to
  // readyPane and the second to postMcpPane.
  let captureCount = 0
  mockExecFileSync.mockImplementation((cmd: string, args: unknown[]) => {
    if (typeof cmd !== 'string' || !Array.isArray(args)) return ''
    if (cmd === FAKE_TMUX && args[0] === 'list-panes') {
      return opts.listPanes ?? '4242\n'
    }
    if (cmd === FAKE_PGREP) {
      if (opts.pgrep instanceof Error) throw opts.pgrep
      return opts.pgrep ?? ''
    }
    if (cmd === FAKE_TMUX && args[0] === 'capture-pane') {
      captureCount += 1
      const isReadyPaneCall = captureCount === 1
      const response = isReadyPaneCall ? opts.readyPane : opts.postMcpPane
      if (response instanceof Error) throw response
      if (response !== undefined) return response
      return isReadyPaneCall
        ? 'bypass permissions on\n'
        : 'plugin:telegram:telegram\n'
    }
    if (cmd === FAKE_TMUX && args[0] === 'send-keys') {
      if (opts.throwOnSendKeysAfter && opts.throwOnSendKeysAfter(cmd, args)) {
        throw new Error('mock send-keys throw')
      }
      if (opts.throwOnSendKeys) throw new Error('mock send-keys throw')
      return ''
    }
    // /bin/sleep + any other utility
    return ''
  })
}

/** Filter mockExecFileSync calls down to the kind we care about. */
function callsFor(argsHead: string): Array<{ cmd: string; args: unknown[] }> {
  return mockExecFileSync.mock.calls
    .filter((c): c is [string, unknown[]] => Array.isArray(c[1]))
    .map(([cmd, args]) => ({ cmd, args }))
    .filter(({ args }) => args[0] === argsHead)
}

/** Send-keys invocations flattened to a list of [session, key...] tuples. */
function sendKeysArgs(): Array<{ session: string; keys: string[] }> {
  const out: Array<{ session: string; keys: string[] }> = []
  for (const { args } of callsFor('send-keys')) {
    // tmux send-keys -t <session> <key...>
    if (args[1] === '-t' && typeof args[2] === 'string') {
      out.push({ session: args[2], keys: args.slice(3).map(String) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Test lifecycle: reset mocks + module-level state between tests.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // The pluginAbsentAt Map is module-level state; clear it so prior tests'
  // verdicts don't leak. clearPluginAbsent is the public hook for this.
  clearPluginAbsent('marveen-channels')
  clearPluginAbsent('agent-samu')
})

afterEach(() => {
  // Defensive: if a test used fake timers but failed before restoring them,
  // the next suite would see stuck timers. vi.useRealTimers is idempotent.
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// clearPluginAbsent / wasPluginConfirmedAbsent -- exported Map accessors.
// ---------------------------------------------------------------------------

describe('clearPluginAbsent / wasPluginConfirmedAbsent', () => {
  it('wasPluginConfirmedAbsent returns false when no entry exists', () => {
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })

  it('clearPluginAbsent is a safe no-op when the entry is absent', () => {
    expect(() => clearPluginAbsent('never-seen')).not.toThrow()
    expect(wasPluginConfirmedAbsent('never-seen', 60_000)).toBe(false)
  })

  it('marks the session absent via the unlock probe absent branch and reports it within the window', async () => {
    // Drive the probe end-to-end: bun absent, pane ready, provider NOT in
    // /mcp list -> the inner branch calls markPluginAbsent.
    setDefaultTmux({
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'google-workspace\nspotify\ncomputer-use\n', // no telegram
    })

    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      // Run all pending timers (setTimeout from the schedule + the probe body).
      await vi.runAllTimersAsync()
    } finally {
      vi.useRealTimers()
    }

    // markPluginAbsent should have stamped the session as absent.
    expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
    // The Escape-after-absent send-keys path is the only post-condition we
    // care about for branch coverage; it must have fired exactly once.
    const escapeCalls = sendKeysArgs().filter((s) => s.keys[0] === 'Escape')
    expect(escapeCalls.length).toBe(1)
  })

  it('wasPluginConfirmedAbsent returns false when the stamp is older than the window', async () => {
    // Drive the probe to record an absent verdict with a known timestamp.
    // The post-/mcp pane must NOT contain the provider name 'telegram' so
    // the absent branch fires.
    setDefaultTmux({
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'google-workspace\nspotify\ncomputer-use\n',
    })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
      // Advance the system clock well past the 60s window so the gap is
      // unambiguously outside it.
      vi.setSystemTime(1_000 + 5 * 60_000)
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearPluginAbsent removes a previously recorded absent verdict', async () => {
    setDefaultTmux({
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'google-workspace\nspotify\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
      clearPluginAbsent(SESSION)
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// getSessionClaudePid -- indirectly via the bun-absent / pane-ready path
// that needs a valid pid. The malformed and throw branches are covered
// separately by intercepting the list-panes call.
// ---------------------------------------------------------------------------

describe('getSessionClaudePid branches (indirect)', () => {
  it('treats an empty list-panes output as no pid (parseInt("") is NaN -> null)', async () => {
    setDefaultTmux({
      listPanes: '',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'no telegram here',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      // No claude pid -> runUnlockProbe logs "no claude pid" and bails.
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: no claude pid; skipping unlock probe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a non-numeric list-panes payload as no pid', async () => {
    setDefaultTmux({
      listPanes: 'not-a-pid\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'no telegram here',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: no claude pid; skipping unlock probe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a list-panes throw as no pid and logs the warning', async () => {
    setDefaultTmux({
      listPanes: '4242\n', // not used; we'll override below
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'no telegram here',
    })
    mockExecFileSync.mockImplementationOnce((cmd: string, args: unknown[]) => {
      if (cmd === FAKE_TMUX && Array.isArray(args) && args[0] === 'list-panes') {
        throw new Error('tmux died')
      }
      return ''
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: no claude pid; skipping unlock probe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a list-panes pid <= 1 as no usable pid', async () => {
    setDefaultTmux({
      listPanes: '1\n', // pid=1, fails the `pid > 1` gate
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'google-workspace\nspotify\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: no claude pid; skipping unlock probe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts the first line of a multi-line list-panes payload', async () => {
    // Multiple panes exist; we only want the first one's pid. With pid in
    // place and the rest of the response scripted as default, we expect the
    // unlock sequence to fire (so list-panes -> pgrep -> capture -> /mcp
    // -> capture -> Up -> Enter -> Enter -> Esc -> Esc).
    setDefaultTmux({
      listPanes: '9999\n8888\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      const keys = sk.flatMap((s) => s.keys)
      expect(keys).toContain('/mcp')
      expect(keys).toContain('Up')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// hasBunChild branches (indirect).
// ---------------------------------------------------------------------------

describe('hasBunChild branches (indirect)', () => {
  it('treats a bun child present as the plugin-healthy path and skips unlock keystrokes', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '4243\n', // bun child present
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      // No /mcp open if the probe retired early.
      expect(sk.flatMap((s) => s.keys)).not.toContain('/mcp')
      const infoCalls = mockLogger.info.mock.calls.map((c) => String(c[1]))
      expect(infoCalls).toContain('channel-plugin-unlock: bun child present, plugin healthy - no unlock needed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a pgrep throw (e.g. exit 1) as "no bun child" and proceeds to the pane gate', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: new Error('pgrep exit 1: no matches'),
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      expect(sk.flatMap((s) => s.keys)).toContain('/mcp')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// isSessionReadyForUnlock branches (indirect, via retry/give-up behavior).
// ---------------------------------------------------------------------------

describe('isSessionReadyForUnlock branches (indirect)', () => {
  it('refuses to fire when the pane shows the Resume-from-summary modal on top of an otherwise-idle footer', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      // Footer present + Resume modal visible. The modal guard (line 151)
      // must reject BEFORE the unlock keystrokes fire -- a modal here means
      // the keystrokes would land in the wrong context.
      readyPane: 'Resume from summary\nbypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      // UNLOCK_PROBE_DELAY_MS = 35_000 + UNLOCK_PROBE_RETRY_DELAY_MS * 2
      // = 35_000 + 15_000 + 15_000 = 65_000 to drain every retry.
      await vi.advanceTimersByTimeAsync(35_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      // No keystrokes should have been delivered -- the modal guard kept the
      // pane out of the "ready for unlock" branch.
      const sk = sendKeysArgs()
      expect(sk.flatMap((s) => s.keys)).not.toContain('/mcp')
      // The retrying branch fired (at least once) before the exhausted branch.
      const infoCalls = mockLogger.info.mock.calls.map((c) => String(c[1]))
      expect(infoCalls).toContain('channel-plugin-unlock: pane not idle yet, retrying')
      // Final abandonment log.
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: pane never reached idle state, abandoning')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to fire when the pane shows the macOS Open System Settings modal', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'Open System Settings\nbypass permissions on\n', // modal overrides footer gate
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.advanceTimersByTimeAsync(35_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      const sk = sendKeysArgs()
      expect(sk.flatMap((s) => s.keys)).not.toContain('/mcp')
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: pane never reached idle state, abandoning')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to fire when the pane is missing the idle footer entirely', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'random prompt text with no footer\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.advanceTimersByTimeAsync(35_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      const sk = sendKeysArgs()
      expect(sk.flatMap((s) => s.keys)).not.toContain('/mcp')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a capture-pane throw as not-ready (warns + gives up after retries)', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: new Error('tmux capture failed'),
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.advanceTimersByTimeAsync(35_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      const sk = sendKeysArgs()
      expect(sk.flatMap((s) => s.keys)).not.toContain('/mcp')
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: pane never reached idle state, abandoning')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats the post-/mcp capture-pane throw as a warn+Escape+return and never sends Up/Enter', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: new Error('capture-pane failed post-/mcp'),
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      // /mcp was sent (paired with Enter in one send-keys call), then
      // capture-pane failed, then Escape was sent. Up / Enter-after-Up /
      // second Enter / second Escape must NOT have been sent.
      const keys = sk.flatMap((s) => s.keys)
      expect(keys).toContain('/mcp')
      expect(keys).not.toContain('Up')
      // Exactly one Enter (the /mcp bundle Enter), not two.
      expect(keys.filter((k) => k === 'Enter').length).toBe(1)
      // Exactly one Escape (the cleanup).
      expect(keys.filter((k) => k === 'Escape').length).toBe(1)
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: capture-pane after /mcp open failed -- aborting')
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows the Escape throw inside the capture-pane-after-/mcp catch', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: new Error('capture-pane failed'),
      // Only throw on send-keys calls AFTER the /mcp open, so the /mcp
      // send-keys itself succeeds and we reach the inner catch.
      throwOnSendKeysAfter: (_cmd, args) => Array.isArray(args) && !args.includes('/mcp'),
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      // The function returned cleanly (no error propagated, no outer catch
      // logger.error).
      const errorCalls = mockLogger.error.mock.calls.map((c) => String(c[1]))
      expect(errorCalls).not.toContain('channel-plugin-unlock: failed to deliver unlock keystrokes')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// sendUnlockKeystrokes happy path + absent branch.
// ---------------------------------------------------------------------------

describe('sendUnlockKeystrokes branches', () => {
  it('fires the full /mcp + Up + Enter + Enter + Escape + Escape sequence when the provider is in the /mcp list', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      const keys = sk.flatMap((s) => s.keys)
      // /mcp is paired with Enter in one send-keys call (so the flat list
      // shows them adjacent), then Up, Enter, Enter, Escape, Escape each in
      // their own send-keys call. Exact full sequence:
      expect(keys).toEqual(['/mcp', 'Enter', 'Up', 'Enter', 'Enter', 'Escape', 'Escape'])
      // All send-keys targets the same session.
      for (const call of sk) {
        expect(call.session).toBe(SESSION)
      }
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: sent /mcp+Up+Enter+Enter+Esc+Esc unlock sequence')
      // /mcp was paired with Enter in the same send-keys invocation.
      const mcpCall = sk.find((s) => s.keys.includes('/mcp'))
      expect(mcpCall?.keys).toEqual(['/mcp', 'Enter'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the plugin absent and swallows the Escape throw when the provider is missing from /mcp', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      // Provider is "telegram"; the pane must not contain the word
      // "telegram" so the absent branch fires.
      postMcpPane: 'google-workspace\nspotify\ncomputer-use\n',
      // Only throw on send-keys calls AFTER the /mcp open, so the /mcp
      // send-keys itself succeeds and the absent branch's Escape (line 190)
      // and any other Escape attempts propagate silently through the
      // inner `catch { /* ignore */ }`.
      throwOnSendKeysAfter: (_cmd, args) => Array.isArray(args) && !args.includes('/mcp'),
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      // markPluginAbsent fired -> verdict reported.
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
      const warnCalls = mockLogger.warn.mock.calls.map((c) => String(c[1]))
      expect(warnCalls).toContain('channel-plugin-unlock: provider plugin absent from /mcp list -- skipping unlock (plugin never loaded, not recoverable via /mcp)')
      // The absent branch returned silently -- no outer catch error log.
      const errorCalls = mockLogger.error.mock.calls.map((c) => String(c[1]))
      expect(errorCalls).not.toContain('channel-plugin-unlock: failed to deliver unlock keystrokes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a keystroke throw after the /mcp open as a caught failure with logger.error', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
      throwOnSendKeysAfter: (_cmd, args) => Array.isArray(args) && !args.includes('/mcp'),
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      const errorCalls = mockLogger.error.mock.calls.map((c) => String(c[1]))
      expect(errorCalls).toContain('channel-plugin-unlock: failed to deliver unlock keystrokes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a slack provider name in the post-/mcp pane as a hit (targets plugin:slack-channel)', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:slack-channel:marveen-marketplace\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'slack')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      const keys = sk.flatMap((s) => s.keys)
      expect(keys).toContain('Up')
      expect(keys).toContain('Enter')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// schedulePluginUnlockAfterRespawn: the entry point.
// ---------------------------------------------------------------------------

describe('schedulePluginUnlockAfterRespawn', () => {
  it('logs the schedule info and dispatches runUnlockProbe after the cold-start delay', async () => {
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '', // bun absent -> idle pane required
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      // The schedule-side log fires immediately (line 292).
      const infoCalls = mockLogger.info.mock.calls.map((c) => String(c[1]))
      expect(infoCalls).toContain('channel-plugin-unlock: probe scheduled after respawn')
      // The probe body has NOT yet run -- not enough time has passed.
      const skBefore = sendKeysArgs()
      expect(skBefore.flatMap((s) => s.keys)).not.toContain('/mcp')
      // Advance past the cold-start window. The probe runs and fires /mcp.
      await vi.advanceTimersByTimeAsync(35_000)
      const skAfter = sendKeysArgs()
      expect(skAfter.flatMap((s) => s.keys)).toContain('/mcp')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires a previously absent verdict when the probe observes a healthy plugin', async () => {
    // First, drive the absent branch to stamp the verdict. The post-/mcp
    // pane must not contain the provider name 'telegram' so the absent
    // branch fires (a naive 'no telegram' would still match because
    // 'telegram' is a substring).
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'google-workspace\nspotify\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }

    // Now a second probe (fresh setTimeout) sees the bun child present and
    // must clear the verdict.
    setDefaultTmux({
      listPanes: '4242\n',
      pgrep: '4243\n', // bun present -> healthy
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:telegram:telegram\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn(SESSION, 'telegram')
      await vi.runAllTimersAsync()
      expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(false)
      const infoCalls = mockLogger.info.mock.calls.map((c) => String(c[1]))
      expect(infoCalls).toContain('channel-plugin-unlock: bun child present, plugin healthy - no unlock needed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules a fresh probe for the discord provider without leaking timers between calls', async () => {
    setDefaultTmux({
      listPanes: '1234\n',
      pgrep: '',
      readyPane: 'bypass permissions on\n',
      postMcpPane: 'plugin:discord:discord\n',
    })
    vi.useFakeTimers()
    try {
      schedulePluginUnlockAfterRespawn('agent-discord', 'discord')
      await vi.runAllTimersAsync()
      const sk = sendKeysArgs()
      const keys = sk.flatMap((s) => s.keys)
      expect(keys).toContain('/mcp')
      // The session under test was agent-discord, not the default marveen.
      for (const call of sk) {
        expect(call.session).toBe('agent-discord')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
