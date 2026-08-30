// 100% coverage test for src/channel-coordinator/telegram-client.ts.
//
// The module is a thin Telegram Bot-API client. It has no project-internal
// imports (no config.js / no logger), so the only collaborators to control
// are the global `fetch` and the `setTimeout`/`clearTimeout` pair used for
// the AbortController read-timeout guard. The setup file in
// src/__tests__/setup/test-sandbox-setup.ts already redirects PROJECT_ROOT
// / STORE_DIR to a tmpdir via a vi.mock('../config.js', ...); that mock is
// harmless here because the SUT never reads config.
//
// Coverage scope (every branch in the SUT):
//   - ALLOWED_UPDATES constant
//   - TelegramApiError class shape (kind / message / retryAfterSec / name)
//   - displayName (covered indirectly via mapUpdate: no from, no username,
//     no first/last, full name)
//   - mapUpdate: each UpdateKind (message / edited_message / channel_post /
//     callback_query), each meta attachment (photo empty vs populated,
//     document, voice), from present vs absent, chat.title fallback,
//     caption vs text, date present vs absent, the unconditional return
//     null branch, and the callback_query with/without `message` sub-paths
//   - getUpdates: network throw (fetch reject AND fetch throw non-Error),
//     200 ok=true with result, 200 ok=true with no result, 200 ok=false
//     with and without description, 401 / 409 / 429 (with and without
//     retry_after) / 5xx / 400 / 403, non-JSON error body, clearTimeout
//     fired in finally, signal passed to fetch
//   - probeHighWater: network throw, 200 ok=true with empty result,
//     200 ok=true with single result, 200 ok=true with multiple results
//     (last-wins), 401 / 409 / 5xx, body must NOT include allowed_updates

import { describe, it, expect, vi, beforeEach, afterEach, test } from 'vitest'
import {
  ALLOWED_UPDATES,
  mapUpdate,
  getUpdates,
  probeHighWater,
  TelegramApiError,
  TelegramClient,
} from '../channel-coordinator/telegram-client.js'

// ---------------------------------------------------------------------------
// fetch + setTimeout helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit }
let lastFetchCall: FetchCall | null = null
let fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | null = null

const originalFetch = globalThis.fetch

function setFetchImpl(impl: (url: string, init: RequestInit) => Promise<Response>): void {
  fetchImpl = impl
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    lastFetchCall = { url, init }
    return fetchImpl!(url, init)
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

beforeEach(() => {
  lastFetchCall = null
  fetchImpl = null
  // default no-op fetch; tests override per-case
  setFetchImpl(async () => new Response('', { status: 200 }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

// ===========================================================================
// ALLOWED_UPDATES
// ===========================================================================

describe('ALLOWED_UPDATES', () => {
  it('exposes the documented Telegram allowed_updates whitelist', () => {
    expect(ALLOWED_UPDATES).toEqual(['message', 'edited_message', 'channel_post', 'callback_query'])
  })
})

// ===========================================================================
// TelegramApiError
// ===========================================================================

describe('TelegramApiError', () => {
  it('captures kind, message, and optional retryAfterSec on construction', () => {
    const e = new TelegramApiError('rate_limit', 'too many', 42)
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(TelegramApiError)
    expect(e.name).toBe('TelegramApiError')
    expect(e.kind).toBe('rate_limit')
    expect(e.message).toBe('too many')
    expect(e.retryAfterSec).toBe(42)
  })

  it('omits retryAfterSec when not provided (undefined on the instance)', () => {
    const e = new TelegramApiError('fatal', 'gone')
    expect(e.retryAfterSec).toBeUndefined()
  })
})

// ===========================================================================
// mapUpdate -- UpdateKind dispatch
// ===========================================================================

describe('mapUpdate', () => {
  // --- base message shape reused across the meta/photo/document/voice tests
  function baseMessage(overrides: Partial<{
    message_id: number
    date: number
    text: string
    caption: string
    chat: { id: number; username?: string; title?: string }
    from: { id: number; username?: string; first_name?: string; last_name?: string }
    photo: unknown[]
    document: { file_id: string; file_name?: string }
    voice: { file_id: string }
  }> = {}): NonNullable<ReturnType<typeof mapUpdate>> {
    return mapUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        text: 'hello',
        chat: { id: 100, title: 'group-title' },
        from: { id: 7, username: 'alice' },
        ...overrides,
      },
    })!
  }

  it('classifies a plain "message" update as kind=message', () => {
    const ev = baseMessage()
    expect(ev.kind).toBe('message')
    expect(ev.update_id).toBe(1)
    expect(ev.chat_id).toBe(100)
    expect(ev.user_id).toBe(7)
    expect(ev.username).toBe('alice')
    expect(ev.message_id).toBe(10)
    expect(ev.content).toBe('hello')
    expect(ev.tg_date).toBe(1_700_000_000)
    expect(ev.meta).toEqual({})
  })

  it('classifies an "edited_message" update as kind=edited_message', () => {
    const ev = mapUpdate({
      update_id: 2,
      edited_message: {
        message_id: 11,
        text: 'edit',
        chat: { id: 100 },
      },
    })!
    expect(ev.kind).toBe('edited_message')
    expect(ev.content).toBe('edit')
  })

  it('classifies a "channel_post" update as kind=channel_post', () => {
    const ev = mapUpdate({
      update_id: 3,
      channel_post: {
        message_id: 12,
        text: 'broadcast',
        chat: { id: -100, title: 'channel' },
      },
    })!
    expect(ev.kind).toBe('channel_post')
    expect(ev.chat_id).toBe(-100)
    expect(ev.username).toBe('channel') // falls back to chat.title
    expect(ev.user_id).toBeNull()
  })

  // --- photo meta flag -- three branches: absent, empty array, populated
  it('omits has_photo when the photo field is absent', () => {
    expect(baseMessage().meta).not.toHaveProperty('has_photo')
  })

  it('omits has_photo when photo is an empty array (length===0)', () => {
    const ev = baseMessage({ photo: [] })
    expect(ev.meta).not.toHaveProperty('has_photo')
  })

  it('sets has_photo=true when photo is a non-empty array', () => {
    const ev = baseMessage({ photo: [{ file_id: 'a' }, { file_id: 'b' }] })
    expect(ev.meta['has_photo']).toBe(true)
  })

  // --- document meta
  it('records document.file_id and document.file_name when present', () => {
    const ev = baseMessage({ document: { file_id: 'doc-1', file_name: 'plan.pdf' } })
    expect(ev.meta['document']).toEqual({ file_id: 'doc-1', file_name: 'plan.pdf' })
  })

  it('records document.file_id only when file_name is omitted (undefined branch)', () => {
    const ev = baseMessage({ document: { file_id: 'doc-2' } })
    expect(ev.meta['document']).toEqual({ file_id: 'doc-2', file_name: undefined })
  })

  // --- voice meta
  it('records voice.file_id when present', () => {
    const ev = baseMessage({ voice: { file_id: 'voice-1' } })
    expect(ev.meta['voice']).toEqual({ file_id: 'voice-1' })
  })

  // --- from / username / chat.title resolution
  it('uses displayName() username when from.username is set', () => {
    const ev = baseMessage({ from: { id: 7, username: 'alice' } })
    expect(ev.username).toBe('alice')
    expect(ev.user_id).toBe(7)
  })

  it('builds a full name from first_name + last_name when username is absent', () => {
    const ev = baseMessage({ from: { id: 7, first_name: 'Al', last_name: 'Ice' } })
    expect(ev.username).toBe('Al Ice')
    expect(ev.user_id).toBe(7)
  })

  it('falls back to String(id) when username and names are all empty', () => {
    const ev = baseMessage({ from: { id: 7 } })
    expect(ev.username).toBe('7')
    expect(ev.user_id).toBe(7)
  })

  it('treats empty first_name AND empty last_name as missing (String(id) fallback)', () => {
    // Both names are present but empty strings, so .filter(Boolean) drops both
    // and the join yields "" -- the || String(u.id) branch fires.
    const ev = baseMessage({ from: { id: 7, first_name: '', last_name: '' } })
    expect(ev.username).toBe('7')
  })

  it('omits the "from" record -- user_id is null and username falls back to chat.title', () => {
    const ev = mapUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 100, title: 'fallback-title' } },
    })!
    expect(ev.user_id).toBeNull()
    expect(ev.username).toBe('fallback-title')
  })

  it('omits the "from" record AND has no chat.title -- username is null', () => {
    const ev = mapUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 100 } },
    })!
    expect(ev.user_id).toBeNull()
    expect(ev.username).toBeNull()
  })

  it('uses displayName()=null even with chat.title absent (from present, no id-like string)', () => {
    // from is present with no username/names, so displayName() returns
    // String(id) which is truthy -> that wins over the nullish chat.title.
    const ev = mapUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 100 },
        from: { id: 9 },
      },
    })!
    expect(ev.username).toBe('9')
  })

  // --- content + tg_date
  it('prefers text over caption for content', () => {
    const ev = baseMessage({ text: 'T', caption: 'C' })
    expect(ev.content).toBe('T')
  })

  it('uses caption when text is absent (caption-only update, e.g. a photo message)', () => {
    const ev = baseMessage({ text: undefined, caption: 'A picture' })
    expect(ev.content).toBe('A picture')
  })

  it('returns content="" when both text and caption are absent', () => {
    const ev = baseMessage({ text: undefined, caption: undefined })
    expect(ev.content).toBe('')
  })

  it('uses null for tg_date when date is absent', () => {
    const ev = baseMessage({ date: undefined })
    expect(ev.tg_date).toBeNull()
  })

  // --- no message + no callback_query => returns null
  it('returns null when neither message nor callback_query is present', () => {
    expect(mapUpdate({ update_id: 1 })).toBeNull()
  })

  // --- callback_query branch
  it('normalizes a callback_query with from + message + data', () => {
    const ev = mapUpdate({
      update_id: 5,
      callback_query: {
        id: 'cq-1',
        data: 'press-yes',
        from: { id: 7, username: 'alice' },
        message: { message_id: 99, date: 1_700_000_001, chat: { id: 100 } },
      },
    })!
    expect(ev.kind).toBe('callback_query')
    expect(ev.update_id).toBe(5)
    expect(ev.chat_id).toBe(100)
    expect(ev.user_id).toBe(7)
    expect(ev.username).toBe('alice')
    expect(ev.message_id).toBe(99)
    expect(ev.content).toBe('press-yes')
    expect(ev.tg_date).toBe(1_700_000_001)
    expect(ev.meta).toEqual({ callback_query_id: 'cq-1' })
  })

  it('normalizes a callback_query without data (content is empty string)', () => {
    const ev = mapUpdate({
      update_id: 5,
      callback_query: {
        id: 'cq-2',
        from: { id: 7 },
      },
    })!
    expect(ev.content).toBe('')
    expect(ev.chat_id).toBeNull()
    expect(ev.message_id).toBeNull()
    expect(ev.tg_date).toBeNull()
    expect(ev.user_id).toBe(7)
    // from has no username/names -> displayName returns String(7)='7'
    expect(ev.username).toBe('7')
  })

  it('normalizes a callback_query with no "from" at all (user_id+username both null)', () => {
    const ev = mapUpdate({
      update_id: 5,
      callback_query: { id: 'cq-3' },
    })!
    expect(ev.user_id).toBeNull()
    expect(ev.username).toBeNull()
    expect(ev.chat_id).toBeNull()
    expect(ev.message_id).toBeNull()
    expect(ev.tg_date).toBeNull()
    expect(ev.content).toBe('')
  })

  it('normalizes a callback_query with message but no from (chat_id set, user_id null)', () => {
    const ev = mapUpdate({
      update_id: 5,
      callback_query: {
        id: 'cq-4',
        data: 'd',
        message: { message_id: 1, chat: { id: 200 } },
      },
    })!
    expect(ev.chat_id).toBe(200)
    expect(ev.message_id).toBe(1)
    expect(ev.user_id).toBeNull()
    expect(ev.username).toBeNull()
  })
})

// ===========================================================================
// getUpdates
// ===========================================================================

describe('getUpdates', () => {
  it('throws TelegramApiError(transient) when fetch itself rejects (network error)', async () => {
    setFetchImpl(async () => { throw new Error('ECONNRESET') })
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/network error: ECONNRESET/)
  })

  it('serializes a non-Error fetch rejection (String(err) fallback in the network error message)', async () => {
    setFetchImpl(async () => { throw 'string-throw' })
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/network error: string-throw/)
  })

  it('returns the result array on 200 ok=true with a populated result', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true, result: [{ update_id: 1 }] }))
    const out = await getUpdates('tok', 0, 25, 100)
    expect(out).toEqual([{ update_id: 1 }])
  })

  it('returns [] on 200 ok=true when result is missing (no result branch)', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true }))
    const out = await getUpdates('tok', 0, 25, 100)
    expect(out).toEqual([])
  })

  it('throws transient on 200 ok=false with description', async () => {
    setFetchImpl(async () => jsonResponse({ ok: false, description: 'slow down' }, 200))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('getUpdates ok=false: slow down')
  })

  it('throws transient on 200 ok=false WITHOUT description (unknown fallback)', async () => {
    setFetchImpl(async () => jsonResponse({ ok: false }, 200))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('getUpdates ok=false: unknown')
  })

  // --- error-code mirroring in the body. The SUT only inspects error_code
  //     when the HTTP layer returned a non-2xx. The 401/409/429/5xx tests
  //     below drive the catch-all body parser to cover error_code= branches.
  it('throws fatal on 401 (HTTP-status path -- body not parsed at all)', async () => {
    setFetchImpl(async () => jsonResponse('plain text', 401, 'text/plain'))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('401 unauthorized: HTTP 401')
  })

  it('throws fatal on 401 and uses body.description when present', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 401, description: 'Unauthorized (token revoked)',
    }, 401))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('401 unauthorized: Unauthorized (token revoked)')
  })

  it('throws conflict on 409', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request',
    }, 409))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('conflict')
    expect(err.message).toMatch(/409 conflict: Conflict: terminated/)
  })

  it('throws rate_limit on 429 with retry_after, attaching retryAfterSec', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 429, description: 'Too Many Requests',
      parameters: { retry_after: 7 },
    }, 429))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('rate_limit')
    expect(err.message).toBe('429 too many requests: Too Many Requests')
    expect(err.retryAfterSec).toBe(7)
  })

  it('throws rate_limit on 429 WITHOUT retry_after (parameters absent -> undefined)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 429, description: 'Too Many Requests',
    }, 429))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('rate_limit')
    expect(err.retryAfterSec).toBeUndefined()
  })

  it('throws transient on 5xx with the parsed description', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 502, description: 'Bad Gateway',
    }, 502))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('5xx: Bad Gateway')
  })

  it('throws transient on 5xx even with a non-JSON body (catch swallows parse error)', async () => {
    setFetchImpl(async () => jsonResponse('<html>502</html>', 502, 'text/html'))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('5xx: HTTP 502')
  })

  it('throws fatal "unexpected 400" on a 400 response (configuration bug, not transient)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 400, description: 'Bad Request: chat not found',
    }, 400))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('unexpected 400: Bad Request: chat not found')
  })

  it('throws fatal "unexpected 403" on a 403 (other 4xx -> fatal)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user',
    }, 403))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('unexpected 403: Forbidden: bot was blocked by the user')
  })

  it('falls back to HTTP status when the error body is non-JSON (non-5xx path)', async () => {
    // 401 + non-JSON body: the body parse throws, caught, description stays
    // "HTTP 401", and the 401 branch fires.
    setFetchImpl(async () => jsonResponse('not-json', 401, 'text/plain'))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('401 unauthorized: HTTP 401')
  })

  it('uses HTTP status as errorCode when body is JSON but has no error_code (typeof !== "number" branch)', async () => {
    // The body parser runs to completion (JSON succeeds), but the shape
    // carries no error_code and no description, so both `if`s fall through
    // without assigning. The HTTP status (401) wins as the errorCode.
    setFetchImpl(async () => jsonResponse({ ok: false, parameters: {} }, 401))
    const err = await getUpdates('tok', 0, 25, 100).catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('401 unauthorized: HTTP 401')
  })

  it('aborts the request via the AbortController when the long-poll timer elapses (setTimeout callback)', async () => {
    // Hanging fetch: never resolves on its own. The (timeout + 10) = 15s
    // guard must fire and the AbortController must tear the request down so
    // the poll loop can pick a backoff instead of hanging forever.
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        capturedSignal = init?.signal
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
      })) as unknown as (url: string, init: RequestInit) => Promise<Response>
    setFetchImpl(hangingFetch)
    // Attach .catch synchronously so the eventual rejection does not
    // surface as an unhandled rejection.
    const pending = getUpdates('tok', 0, 5, 100).catch((e) => e)
    // timeout=5 -> guard fires at (5+10)*1000=15000ms
    await vi.advanceTimersByTimeAsync(15_000)
    expect(capturedSignal?.aborted).toBe(true)
    const err = await pending
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/network error: This operation was aborted/)
  })

  it('passes an AbortSignal to fetch and the documented allowed_updates whitelist in the body', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true, result: [] }))
    await getUpdates('tok-1', 42, 25, 100)
    expect(lastFetchCall).not.toBeNull()
    expect(lastFetchCall!.url).toBe('https://api.telegram.org/bottok-1/getUpdates')
    expect(lastFetchCall!.init.method).toBe('POST')
    expect(lastFetchCall!.init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(lastFetchCall!.init.body as string)
    expect(body).toEqual({
      offset: 42,
      timeout: 25,
      limit: 100,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
    })
  })

  it('clears the abort timer in the finally block on the success path', async () => {
    // Spy on clearTimeout so we can assert the finally block ran. The
    // setTimeout callback never fires because the fetch resolves immediately,
    // but the finally still has to call clearTimeout.
    vi.useFakeTimers()
    setFetchImpl(async () => jsonResponse({ ok: true, result: [] }))
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await getUpdates('tok', 0, 25, 100)
    expect(clearSpy).toHaveBeenCalled()
    // No pending timer left over.
    expect(vi.getTimerCount()).toBe(0)
    clearSpy.mockRestore()
  })

  it('clears the abort timer in the finally block on the failure path', async () => {
    vi.useFakeTimers()
    setFetchImpl(async () => { throw new Error('boom') })
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await getUpdates('tok', 0, 25, 100).catch(() => undefined)
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    clearSpy.mockRestore()
  })
})

// ===========================================================================
// probeHighWater
// ===========================================================================

describe('probeHighWater', () => {
  it('throws TelegramApiError(transient) when fetch rejects (network error)', async () => {
    setFetchImpl(async () => { throw new Error('ENETUNREACH') })
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/high-water probe network error: ENETUNREACH/)
  })

  it('serializes a non-Error fetch rejection (String(err) fallback in the network error message)', async () => {
    // The catch uses `err instanceof Error ? err.message : String(err)`. A
    // non-Error rejection (e.g. a thrown string) must still produce a useful
    // error string, otherwise the operator only sees "high-water probe
    // network error: undefined" in dashboard.log.
    setFetchImpl(async () => { throw 'string-throw' })
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/high-water probe network error: string-throw/)
  })

  it('returns null when the server answers with an empty result array (no pending updates)', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true, result: [] }))
    expect(await probeHighWater('tok')).toBeNull()
  })

  it('returns the update_id of the single result (only-row case)', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true, result: [{ update_id: 4242 }] }))
    expect(await probeHighWater('tok')).toBe(4242)
  })

  it('returns the LAST update_id when the server returns multiple results (queue tail semantics)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: true,
      result: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
    }))
    expect(await probeHighWater('tok')).toBe(12)
  })

  it('returns null when the body has no result key (result is undefined)', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true }))
    expect(await probeHighWater('tok')).toBeNull()
  })

  it('throws fatal on 401 from the probe', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 401, description: 'Unauthorized',
    }, 401))
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err.kind).toBe('fatal')
    expect(err.message).toBe('401 unauthorized (high-water probe)')
  })

  it('throws conflict on 409 from the probe (another poller holds the token)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request',
    }, 409))
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err.kind).toBe('conflict')
    expect(err.message).toBe('409 conflict (high-water probe)')
  })

  it('throws transient on 5xx from the probe', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 500, description: 'Internal Server Error',
    }, 500))
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('high-water probe HTTP 500')
  })

  it('throws transient on 4xx that is neither 401 nor 409 (catch-all else branch)', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false, error_code: 400, description: 'Bad Request',
    }, 400))
    const err = await probeHighWater('tok').catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.message).toBe('high-water probe HTTP 400')
  })

  it('passes the documented probe-only body (offset=-1, limit=1, timeout=0, NO allowed_updates)', async () => {
    // Telegram REMEMBERS the last allowed_updates passed, so the probe must
    // deliberately omit the whitelist -- a regression here could silently
    // narrow the native plugin's poll on the very first seed call.
    setFetchImpl(async () => jsonResponse({ ok: true, result: [] }))
    await probeHighWater('tok-2')
    expect(lastFetchCall).not.toBeNull()
    expect(lastFetchCall!.url).toBe('https://api.telegram.org/bottok-2/getUpdates')
    const body = JSON.parse(lastFetchCall!.init.body as string)
    expect(body).toEqual({ offset: -1, limit: 1, timeout: 0 })
    expect(body).not.toHaveProperty('allowed_updates')
  })

  it('clears the abort timer in the finally block on the success path', async () => {
    vi.useFakeTimers()
    setFetchImpl(async () => jsonResponse({ ok: true, result: [] }))
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await probeHighWater('tok')
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    clearSpy.mockRestore()
  })

  it('clears the abort timer in the finally block on the failure path', async () => {
    vi.useFakeTimers()
    setFetchImpl(async () => { throw new Error('boom') })
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await probeHighWater('tok').catch(() => undefined)
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    clearSpy.mockRestore()
  })

  it('aborts the request via the AbortController after 10s (probe timeout guard)', async () => {
    // The probe uses a 10s hard guard (vs getUpdates's timeout+10). A
    // hanging probe must be torn down so a wedged socket never holds the
    // monitor's poll loop hostage.
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        capturedSignal = init?.signal
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
      })) as unknown as (url: string, init: RequestInit) => Promise<Response>
    setFetchImpl(hangingFetch)
    // Attach .catch synchronously so the eventual rejection does not
    // surface as an unhandled rejection.
    const pending = probeHighWater('tok').catch((e) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(capturedSignal?.aborted).toBe(true)
    const err = await pending
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(err.kind).toBe('transient')
    expect(err.message).toMatch(/high-water probe network error: This operation was aborted/)
  })

  it('throws transient on 200 OK with ok: false and a description', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false,
      description: 'Bad Request: bad webhook',
      result: [{ update_id: 99999 }],
    }, 200))
    const result = await probeHighWater('tok').catch((e) => e)
    expect(result).toBeInstanceOf(TelegramApiError)
    expect((result as TelegramApiError).kind).toBe('transient')
    expect((result as TelegramApiError).message).toMatch(/high-water probe ok=false: Bad Request: bad webhook/)
  })

  it('falls back to "unknown" when ok: false omits description', async () => {
    setFetchImpl(async () => jsonResponse({
      ok: false,
      result: [],
    }, 200))
    const result = await probeHighWater('tok').catch((e) => e)
    expect(result).toBeInstanceOf(TelegramApiError)
    expect((result as TelegramApiError).kind).toBe('transient')
    expect((result as TelegramApiError).message).toMatch(/high-water probe ok=false: unknown/)
  })
})

describe('TelegramClient class form', () => {
  test('class methods produce identical results to free functions', () => {
    const client = new TelegramClient()

    // mapUpdate: class method delegates to free function (covers 1 branch)
    const rawUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        text: 'hello',
        chat: { id: 100 },
        from: { id: 1, username: 'alice' },
        date: 1700000000,
      },
    }
    expect(client.mapUpdate(rawUpdate)).toEqual(mapUpdate(rawUpdate))
    expect(client.mapUpdate(rawUpdate)).not.toBeNull()
  })

  test('class getUpdates delegates to free function', async () => {
    const client = new TelegramClient()
    // The free-function test suite already exercises every branch via the
    // free functions. This test confirms the class wrapper resolves to
    // the same code path.
    setFetchImpl(() => Promise.resolve(jsonResponse({ ok: true, result: [] })))
    const result = await client.getUpdates('test-token', 0, 0, 1)
    expect(result).toEqual([])
  })

  test('class probeHighWater delegates to free function', async () => {
    const client = new TelegramClient()
    setFetchImpl(() => Promise.resolve(jsonResponse({ ok: true, result: [] })))
    const result = await client.probeHighWater('test-token')
    expect(result).toBeNull()
  })
})
