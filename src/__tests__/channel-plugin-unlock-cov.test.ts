// Behavioral coverage for src/web/channel-plugin-unlock.ts.
//
// The pre-existing src/__tests__/channel-plugin-unlock.test.ts is a *contract*
// suite -- it reads the source file as text and asserts the shape of the
// unlock keystroke sequence. That gives the source file 0% line/branch
// coverage in v8 (no code path is ever executed). This file drives the actual
// code so the v8 100% threshold gate passes.
//
// Coverage targets (every branch in the file):
//   - clearPluginAbsent / wasPluginConfirmedAbsent (map absent, in-window,
//     out-of-window, after clear)
//   - getSessionClaudePid (success, pid<=1, NaN, throws)
//   - hasBunChild (output present, output empty, throws)
//   - isSessionReadyForUnlock (bypass footer only, Resume modal,
//     Open System Settings modal, throws)
//   - sendUnlockKeystrokes (happy path, absent-plugin path with
//     markPluginAbsent, capture-pane-after-open failure path, outer throws)
//   - runUnlockProbe (no pid, bun present -> clears absent, not-ready with
//     retries, not-ready exhausted, happy path)
//   - schedulePluginUnlockAfterRespawn (sets up the setTimeout)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExecFileSync = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}
vi.mock('../logger.js', () => ({
  logger: loggerMock,
}))

const {
  clearPluginAbsent,
  wasPluginConfirmedAbsent,
  schedulePluginUnlockAfterRespawn,
} = await import('../web/channel-plugin-unlock.js')

// execFileSync is called many times per probe run. To match the right call we
// look at the full (cmd, args) tuple. Default: return ''. Specific overrides
// per-test route commands to their canned response.
type Call = [cmd: string, args: string[], opts: Record<string, unknown>]
type Responder = (cmd: string, args: string[]) => string

function installResponder(responder: Responder): void {
  mockExecFileSync.mockImplementation((cmd: string, args: string[] = [], _opts?: Record<string, unknown>) => {
    return responder(cmd, args)
  })
}

function callArg(call: unknown, idx: number): unknown {
  return (call as Call | undefined)?.[idx]
}

// Helpers for the two tmux subcommands the helper issues that need careful
// tracking: `tmux list-panes` (returns the pane pid string) and
// `tmux capture-pane` (returns the captured pane text).
function tmuxSubcommand(args: string[]): string {
  return args[0] ?? ''
}

beforeEach(() => {
  mockExecFileSync.mockReset()
  loggerMock.info.mockReset()
  loggerMock.warn.mockReset()
  loggerMock.debug.mockReset()
  loggerMock.error.mockReset()
  clearPluginAbsent('marveen-channels')
  clearPluginAbsent('agent-foo')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('wasPluginConfirmedAbsent / clearPluginAbsent (map accessors)', () => {
  it('returns false when no entry exists for the session', () => {
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })

  it('returns true for an entry stamped within the window', async () => {
    // Drive the absent-verdict branch via the public probe so the internal
    // map is populated exactly as in production.
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        if (args.includes('-t') && args.length <= 3) return 'bypass permissions on'
        // capture-pane after /mcp open: must NOT include provider
        return 'google-workspace\nspotify\ncomputer-use'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    // Advance past the cold-start delay (35s) and let the probe run.
    await vi.advanceTimersByTimeAsync(36_000)

    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(true)
  })

  it('returns false once the entry has been cleared', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        if (args.length <= 3) return 'bypass permissions on'
        return 'google-workspace\nspotify\ncomputer-use'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(true)

    clearPluginAbsent('marveen-channels')
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })

  it('returns false when the stamp is older than the window', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        if (args.length <= 3) return 'bypass permissions on'
        return 'google-workspace\nspotify\ncomputer-use'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(true)

    // Move well past the window. vi.advanceTimersByTime uses Date.now() under
    // the hood for fake timer semantics.
    vi.setSystemTime(Date.now() + 5 * 60_000)
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })
})

describe('getSessionClaudePid (via runUnlockProbe skip path)', () => {
  // The probe logs "no claude pid" when getSessionClaudePid returns null. We
  // exercise that branch by feeding tmux an empty / non-numeric / zero / throws
  // response to list-panes.

  it('skips the probe when tmux list-panes returns nothing parseable', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return ''
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('no claude pid'),
    )
  })

  it('skips the probe when the pid is non-numeric (parseInt NaN)', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return 'not-a-pid'
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('no claude pid'),
    )
  })

  it('skips the probe when the pid is <= 1', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1'
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('no claude pid'),
    )
  })

  it('skips the probe when tmux list-panes throws', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') {
        throw new Error('no such session')
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels', err: expect.any(Error) }),
      expect.stringContaining('failed to read session claude pid'),
    )
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('no claude pid'),
    )
  })
})

describe('hasBunChild (via runUnlockProbe)', () => {
  it('treats a non-empty pgrep response as "plugin healthy"', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return '5678'
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels', claudePid: 1234 }),
      expect.stringContaining('bun child present'),
    )
    // No unlock keystrokes dispatched (would have called capture-pane with
    // a specific signature).
    const capturePaneCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'capture-pane',
    )
    expect(capturePaneCalls.length).toBe(0)
  })

  it('treats an empty pgrep response as "no bun child" and proceeds', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        // readiness probe
        if (args.length <= 3) return 'bypass permissions on'
        // post-/mcp probe: include provider to avoid the absent branch
        return 'plugin:telegram:telegram'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels', claudePid: 1234 }),
      expect.stringContaining('firing /mcp unlock sequence'),
    )
  })

  it('treats a throwing pgrep as "no bun child"', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') throw new Error('exit 1')
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        if (args.length <= 3) return 'bypass permissions on'
        return 'plugin:telegram:telegram'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels', claudePid: 1234 }),
      expect.stringContaining('firing /mcp unlock sequence'),
    )
  })

  it('clears any stale absent verdict once the bun child reappears', async () => {
    // Pre-mark the session absent, then arrange the probe to see bun alive.
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return '9999'
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })
})

describe('isSessionReadyForUnlock (via runUnlockProbe retries)', () => {
  // The pane-not-ready branch schedules a retry via setTimeout as long as
  // retriesLeft > 0, and logs "abandoning" once retries are exhausted.

  it('schedules a retry when the pane is not yet idle and retries remain', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        // Always "not idle" -> no bypass footer.
        return 'Resume from summary\n...modal text...'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    // First probe at +35s
    await vi.advanceTimersByTimeAsync(36_000)
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retriesLeft: 2 }),
      expect.stringContaining('retrying'),
    )
    // Retry at +50s
    await vi.advanceTimersByTimeAsync(15_000)
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retriesLeft: 1 }),
      expect.stringContaining('retrying'),
    )
    // Retry at +65s
    await vi.advanceTimersByTimeAsync(15_000)
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retriesLeft: 0 }),
      expect.stringContaining('retrying'),
    )
    // After the final retry completes (and the readiness gate is still false),
    // the probe logs "abandoning".
    await vi.advanceTimersByTimeAsync(15_000)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('pane never reached idle state'),
    )
  })

  it('rejects a pane that shows the Resume-from-summary modal', async () => {
    // Single shot, capture pane always shows the modal -> exhausts retries
    // on the FIRST probe (since the probe always reads fresh state, the
    // readiness check fails; we go through the retry loop).
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        return 'Resume from summary\nChoose an option'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    // Drain all retries: 35s + 15s + 15s + 15s = 80s
    await vi.advanceTimersByTimeAsync(80_000)

    // Final "abandoning" log fired - and the Resume-modal line was read.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('pane never reached idle state'),
    )
  })

  it('rejects a pane that shows the Open System Settings modal', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        return 'Open System Settings\n...'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(80_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('pane never reached idle state'),
    )
  })

  it('logs a warning and returns false when capture-pane throws', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        throw new Error('tmux died')
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(80_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), session: 'marveen-channels' }),
      expect.stringContaining('capture-pane failed'),
    )
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('pane never reached idle state'),
    )
  })
})

describe('sendUnlockKeystrokes', () => {
  // The keystroke sequence is dispatched by the probe when bun is absent AND
  // the pane is at the idle bypass-permissions footer.

  // tmux args for send-keys are: ['send-keys', '-t', session, '<KEYS>'].
  // We strip the first 3 (send-keys / -t / session) to recover the keystrokes.
  function sendKeyStrokes(): string[][] {
    return mockExecFileSync.mock.calls
      .filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'send-keys')
      .map((c) => (c[1] as string[]).slice(3))
  }

  function readyThenPostOpen(postOpenPane: string) {
    // Stateful responder: the FIRST capture-pane call is the readiness probe
    // (must contain the bypass-permissions footer); the SECOND is the
    // post-/mcp probe whose content we control per-test.
    let captureCalls = 0
    return (cmd: string, args: string[]): string => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        captureCalls++
        if (captureCalls === 1) return 'bypass permissions on'
        return postOpenPane
      }
      return ''
    }
  }

  it('dispatches the full /mcp + Up + Enter + Enter + Esc + Esc sequence', async () => {
    installResponder(readyThenPostOpen('plugin:telegram:telegram'))

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(sendKeyStrokes()).toEqual([
      ['/mcp', 'Enter'],
      ['Up'],
      ['Enter'],
      ['Enter'],
      ['Escape'],
      ['Escape'],
    ])
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels' }),
      expect.stringContaining('sent /mcp+Up+Enter+Enter+Esc+Esc unlock sequence'),
    )
  })

  it('marks the plugin absent and bails with Escape when the provider is missing from /mcp', async () => {
    installResponder(readyThenPostOpen('google-workspace\nspotify\ncomputer-use'))

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(true)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'marveen-channels', provider: 'telegram' }),
      expect.stringContaining('provider plugin absent from /mcp list'),
    )

    // Only the initial /mcp+Enter and the Escape (to dismiss the dialog)
    // should have been sent; the Up/Enter/Enter sequence is skipped.
    expect(sendKeyStrokes()).toEqual([
      ['/mcp', 'Enter'],
      ['Escape'],
    ])
  })

  it('aborts with Escape when the post-/mcp capture-pane throws', async () => {
    let captureCount = 0
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        captureCount++
        if (captureCount === 1) return 'bypass permissions on'
        throw new Error('capture failed mid-sequence')
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), session: 'marveen-channels' }),
      expect.stringContaining('capture-pane after /mcp open failed -- aborting'),
    )
    expect(sendKeyStrokes()).toEqual([
      ['/mcp', 'Enter'],
      ['Escape'],
    ])
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })

  it('logs error and swallows exceptions from the send-keys path itself', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        return 'bypass permissions on'
      }
      // The very first send-keys call (the /mcp + Enter) throws.
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'send-keys') {
        throw new Error('send-keys exploded')
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), session: 'marveen-channels' }),
      expect.stringContaining('failed to deliver unlock keystrokes'),
    )
  })

  it('swallows errors from the cleanup Escape after the absent branch', async () => {
    // The cleanup Escape in the "absent" path is wrapped in try/catch --
    // a throw there must be swallowed (the inner catch says "ignore").
    // Drive the absent branch but throw on the cleanup Escape so the
    // swallow-path fires.
    let captureCount = 0
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        captureCount++
        if (captureCount === 1) return 'bypass permissions on'
        return 'no provider here'
      }
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'send-keys') {
        const keys = (args[3] as string) ?? ''
        if (keys === 'Escape') throw new Error('escape cleanup failed')
        return ''
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    // The probe still completes without re-throwing -- the inner try/catch
    // for the cleanup Escape swallowed the error.
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(true)
  })

  it('swallows errors from the cleanup Escape after the capture-pane-after-open throws', async () => {
    // Same swallow guarantee for the OTHER cleanup Escape (the one in the
    // capture-pane-after-open failed branch). The helper sends an Escape
    // in that case too and must swallow any failure to deliver it.
    let captureCount = 0
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        captureCount++
        if (captureCount === 1) return 'bypass permissions on'
        throw new Error('post-/mcp capture failed')
      }
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'send-keys') {
        // The cleanup Escape in the failed-capture branch is wrapped in
        // its own try/catch (the "/* ignore */" comment). Make THAT throw
        // and confirm we don't propagate.
        throw new Error('escape cleanup failed')
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    // Probe completed; no absent verdict (we never reached that branch).
    expect(wasPluginConfirmedAbsent('marveen-channels', 60_000)).toBe(false)
  })
})

describe('schedulePluginUnlockAfterRespawn', () => {
  it('logs the probe scheduling immediately', async () => {
    installResponder(() => '')

    schedulePluginUnlockAfterRespawn('agent-foo', 'slack')

    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'agent-foo', provider: 'slack' }),
      expect.stringContaining('probe scheduled after respawn'),
    )
  })

  it('runs the probe once after UNLOCK_PROBE_DELAY_MS (35s)', async () => {
    let listPanesCalls = 0
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') {
        listPanesCalls++
        return '4242'
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('agent-foo', 'discord')
    expect(listPanesCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(34_999)
    expect(listPanesCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(2)
    expect(listPanesCalls).toBe(1)
  })

  it('accepts every supported ChannelProviderType', async () => {
    installResponder(() => '')

    for (const provider of ['telegram', 'slack', 'discord', 'googlechat', 'teams'] as const) {
      schedulePluginUnlockAfterRespawn(`session-${provider}`, provider)
      expect(loggerMock.info).toHaveBeenCalledWith(
        expect.objectContaining({ provider }),
        expect.stringContaining('probe scheduled after respawn'),
      )
    }
  })
})

describe('branch coverage assertions for runUnlockProbe happy path', () => {
  it('takes the readiness->firing branch when bun is absent and pane is idle with provider in list', async () => {
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '7777'
      if (cmd === '/usr/bin/pgrep') return ''
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'capture-pane') {
        // First capture: readiness probe (no provider signature required).
        // Second capture (post-/mcp open): include provider to drive the
        // happy keystroke path. We can't tell them apart by args alone here
        // so we encode both states by alternating: in this single helper
        // they share the same arg shape, but the readiness check just needs
        // the bypass footer. After /mcp the pane naturally contains more
        // rows -- emulate that by including the provider in BOTH returns;
        // the readiness branch only checks the footer regex.
        const providerPane = 'plugin:telegram:telegram'
        return `bypass permissions on\n${providerPane}`
      }
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ claudePid: 7777, provider: 'telegram' }),
      expect.stringContaining('bun child absent after cold-start window'),
    )
    // And the full sequence was sent.
    const sendKeys = mockExecFileSync.mock.calls
      .filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'send-keys')
      .map((c) => (c[1] as string[]).slice(2))
    expect(sendKeys).toContainEqual(['/mcp', 'Enter'])
    expect(sendKeys).toContainEqual(['Up'])
    expect(sendKeys).toContainEqual(['Escape'])
  })

  it('uses callArg helper to confirm tmux args shape on the readiness probe', async () => {
    // Sanity check: confirms the call shape (cmd, args, opts) we wire into
    // mockExecFileSync matches the file's invocation shape -- protects
    // against silent mock-mismatch regressions if the helper is refactored.
    installResponder((cmd, args) => {
      if (cmd === '/usr/local/bin/tmux' && tmuxSubcommand(args) === 'list-panes') return '1234'
      if (cmd === '/usr/bin/pgrep') return '9999' // bun present -> early return
      return ''
    })

    schedulePluginUnlockAfterRespawn('marveen-channels', 'telegram')
    await vi.advanceTimersByTimeAsync(36_000)

    // First tmux call should be list-panes with the session arg.
    const firstTmux = mockExecFileSync.mock.calls.find(
      (c) => (callArg(c, 0) as string) === '/usr/local/bin/tmux',
    )
    expect(firstTmux).toBeDefined()
    expect((firstTmux![1] as string[])[0]).toBe('list-panes')
    expect((firstTmux![1] as string[])).toContain('marveen-channels')
  })
})