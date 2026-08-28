// Supplemental coverage for the Telegram 409-Conflict probe.
//
// channel-conflict-probe.test.ts covers every response-shape branch, but it
// never lets the PROBE_TIMEOUT_MS guard fire. That leaves the abort callback
// passed to setTimeout unexecuted (v8: functions 50%, statements 94.44%).
// This file drives the one remaining path: fetch never settles, the 4s timer
// elapses, the AbortController tears the request down, and the probe reports
// a non-conflict outcome instead of hanging the monitor's poll loop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const warn = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { probeTelegramConflict } = await import('../web/channel-conflict-probe.js')

const originalFetch = globalThis.fetch

beforeEach(() => {
  warn.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

/**
 * fetch stand-in that never resolves on its own: it settles only when the
 * caller's AbortSignal fires, exactly like the real undici implementation.
 */
function hangingFetch(): { fetch: typeof fetch; signal: () => AbortSignal | undefined } {
  let captured: AbortSignal | undefined
  const impl = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      captured = init?.signal
      captured?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'))
      })
    })) as unknown as typeof fetch
  return { fetch: impl, signal: () => captured }
}

describe('probeTelegramConflict timeout guard', () => {
  it('aborts the in-flight request once PROBE_TIMEOUT_MS elapses', async () => {
    const { fetch: impl, signal } = hangingFetch()
    globalThis.fetch = impl

    const pending = probeTelegramConflict('test-token')

    // Nothing has fired yet: the probe is still waiting on the socket.
    await vi.advanceTimersByTimeAsync(3_999)
    expect(signal()?.aborted).toBe(false)

    // The 4s guard trips, running the abort callback registered by setTimeout.
    await vi.advanceTimersByTimeAsync(1)
    expect(signal()?.aborted).toBe(true)

    const result = await pending
    // A timeout is NOT evidence of an orphan poller, so it must not be
    // reported as conflicted - the operator would chase the wrong bug.
    expect(result).toEqual({ conflicted: false, status: 0, description: null })
  })

  it('logs the timeout so dashboard.log records why the probe gave up', async () => {
    const { fetch: impl } = hangingFetch()
    globalThis.fetch = impl

    const pending = probeTelegramConflict('test-token')
    await vi.advanceTimersByTimeAsync(4_000)
    await pending

    expect(warn).toHaveBeenCalledTimes(1)
    const [context, message] = warn.mock.calls[0] as [{ err: unknown }, string]
    expect(message).toBe('probeTelegramConflict: HTTP probe failed (network/timeout)')
    expect(context.err).toBeInstanceOf(DOMException)
  })

  it('clears the pending timer on the success path (no dangling handle)', async () => {
    // The finally block must cancel the guard, otherwise a fast probe would
    // still hold a 4s timer per call on the monitor's poll loop.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const result = await probeTelegramConflict('test-token')

    expect(result.status).toBe(200)
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    clearSpy.mockRestore()
  })
})
