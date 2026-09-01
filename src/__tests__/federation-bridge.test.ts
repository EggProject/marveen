import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
} from '../web/federation/config.js'
import {
  sendFederatedMessage,
  isPeerInBackoff,
  resetPeerBackoff,
  logFedOut,
  _resetBackoffForTest,
  FEDERATION_REQUEST_TIMEOUT_MS,
  FEDERATION_MAX_CONTENT_BYTES,
} from '../web/federation/bridge.js'
import { logger } from '../logger.js'

// Spy on the shared pino logger so logFedOut can be verified without dragging
// in the real pino transport (which would buffer async writes and produce
// noisy output). Reset between tests so each one sees a clean call record.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const TMP = mkdtempSync(join(tmpdir(), 'fed-bridge-test-'))
const TOKEN = 'a'.repeat(64)
const IN_TOKEN = 'b'.repeat(64)
const NOW = 1_750_000_000_000

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

function enabledConfig(peerOverrides: Record<string, unknown> = {}): void {
  writeConfigFile({
    enabled: true,
    systemId: 'teodor',
    peers: [{ id: 'arthur', baseUrl: 'https://macbook.example', outboundToken: TOKEN, inboundToken: IN_TOKEN, ...peerOverrides }],
  })
}

const MSG = { id: 7, from_agent: 'teodor', to_agent: 'arthur/marketing', content: 'hello' }

function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  _setFederationStoreDirForTest(TMP)
  _resetBackoffForTest()
  rmSync(join(TMP, 'federation.json'), { force: true })
  reloadFederationForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('sendFederatedMessage -- terminal failures (no network)', () => {
  it('fails when federation is disabled', async () => {
    const r = await sendFederatedMessage(MSG, NOW, fetchReturning(202, {}))
    expect(r).toMatchObject({ kind: 'failed' })
  })

  it('fails on an invalid address and on an unknown peer', async () => {
    enabledConfig()
    expect(await sendFederatedMessage({ ...MSG, to_agent: 'a/b/c' }, NOW)).toMatchObject({ kind: 'failed' })
    expect(await sendFederatedMessage({ ...MSG, to_agent: 'nobody/x' }, NOW)).toMatchObject({ kind: 'failed' })
  })

  it('fails when the target system is the own system', async () => {
    enabledConfig()
    const r = await sendFederatedMessage({ ...MSG, to_agent: 'teodor/dev' }, NOW)
    expect(r).toMatchObject({ kind: 'failed' })
    if (r.kind === 'failed') expect(r.error).toContain('this system')
  })

  it('matches the target system case-insensitively (L1): uppercase prefix finds the peer / own system', async () => {
    enabledConfig()
    // Own-system guard folds case too.
    expect(await sendFederatedMessage({ ...MSG, to_agent: 'Teodor/dev' }, NOW)).toMatchObject({ kind: 'failed' })
    // Uppercase peer prefix (pre-normalization row) still finds 'arthur'.
    const r = await sendFederatedMessage({ ...MSG, to_agent: 'Arthur/marketing' }, NOW, fetchReturning(202, { id: 9 }))
    expect(r).toEqual({ kind: 'delivered', remoteId: '9' })
  })

  it('refuses to forward an already-qualified sender', async () => {
    enabledConfig()
    const r = await sendFederatedMessage({ ...MSG, from_agent: 'x/y' }, NOW, fetchReturning(202, {}))
    expect(r).toMatchObject({ kind: 'failed' })
  })

  it('fails terminally (no network attempt) while pairing is incomplete (empty outboundToken)', async () => {
    enabledConfig({ outboundToken: '' })
    let calls = 0
    const counting = vi.fn<typeof fetch>().mockImplementation(async () => { calls++; return new Response('{}', { status: 202 }) })
    const r = await sendFederatedMessage(MSG, NOW, counting)
    expect(r).toMatchObject({ kind: 'failed' })
    if (r.kind === 'failed') expect(r.error).toContain('Pairing incomplete')
    expect(calls).toBe(0)
  })

  it('fails oversized content terminally without a network attempt', async () => {
    enabledConfig()
    let calls = 0
    const counting = vi.fn<typeof fetch>().mockImplementation(async () => { calls++; return new Response('{}', { status: 202 }) })
    const r = await sendFederatedMessage({ ...MSG, content: 'x'.repeat(FEDERATION_MAX_CONTENT_BYTES + 1) }, NOW, counting)
    expect(r).toMatchObject({ kind: 'failed' })
    expect(calls).toBe(0)
  })
})

describe('sendFederatedMessage -- wire behaviour', () => {
  it('delivers on 202 and returns the remote id', async () => {
    enabledConfig()
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const f = vi.fn<typeof fetch>().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(JSON.stringify({ id: 456 }), { status: 202 })
    })
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toEqual({ kind: 'delivered', remoteId: '456' })
    expect(seenUrl).toBe('https://macbook.example/api/federation/inbox')
    const body = JSON.parse(String(seenInit?.body))
    expect(body).toMatchObject({ federationVersion: 1, from: 'teodor/teodor', to: 'marketing', content: 'hello', ref: '7' })
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('treats 4xx as terminal and does NOT back the peer off (a rejection is an answer)', async () => {
    enabledConfig()
    const r = await sendFederatedMessage(MSG, NOW, fetchReturning(404, { error: 'Unknown recipient' }))
    expect(r).toMatchObject({ kind: 'failed' })
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(false)
  })

  it('treats 401 as RETRYABLE with backoff (token rotation must not burn the queue)', async () => {
    enabledConfig()
    const r = await sendFederatedMessage(MSG, NOW, fetchReturning(401, { error: 'Unauthorized' }))
    expect(r).toMatchObject({ kind: 'retry' })
    if (r.kind === 'retry') expect(r.error).toContain('401')
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(true)
  })

  it('treats 5xx as retryable and backs the peer off', async () => {
    enabledConfig()
    const r = await sendFederatedMessage(MSG, NOW, fetchReturning(503, {}))
    expect(r).toMatchObject({ kind: 'retry' })
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(true)
  })

  it('treats network errors as retryable with backoff', async () => {
    enabledConfig()
    const f = vi.fn<typeof fetch>().mockImplementation(async () => { throw new Error('ECONNREFUSED') })
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toMatchObject({ kind: 'retry' })
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(true)
  })
})

describe('per-peer backoff (circuit breaker)', () => {
  it('skips without a network attempt while backing off, then retries after the window', async () => {
    enabledConfig()
    let calls = 0
    const failing = vi.fn<typeof fetch>().mockImplementation(async () => { calls++; return new Response('', { status: 500 }) })

    await sendFederatedMessage(MSG, NOW, failing) // 1st failure -> 10s backoff
    expect(calls).toBe(1)

    const during = await sendFederatedMessage(MSG, NOW + 5_000, failing)
    expect(during).toEqual({ kind: 'skipped' })
    expect(calls).toBe(1) // no attempt made

    const after = await sendFederatedMessage(MSG, NOW + 11_000, failing)
    expect(after).toMatchObject({ kind: 'retry' })
    expect(calls).toBe(2)
  })

  it('backoff grows exponentially and clears on success', async () => {
    enabledConfig()
    const failing = fetchReturning(500, {})
    await sendFederatedMessage(MSG, NOW, failing)             // failures=1 -> +10s
    await sendFederatedMessage(MSG, NOW + 11_000, failing)    // failures=2 -> +20s
    expect(isPeerInBackoff('arthur', NOW + 11_000 + 15_000)).toBe(true)
    expect(isPeerInBackoff('arthur', NOW + 11_000 + 21_000)).toBe(false)

    await sendFederatedMessage(MSG, NOW + 40_000, fetchReturning(202, { id: 1 }))
    expect(isPeerInBackoff('arthur', NOW + 40_001)).toBe(false)
  })
})

describe('constants', () => {
  it('keeps the request timeout a few seconds (tick-holding bound)', () => {
    expect(FEDERATION_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })
})

describe('resetPeerBackoff (production lifecycle reset)', () => {
  it('with no argument clears every backing-off peer', async () => {
    enabledConfig()
    const failing = fetchReturning(500, {})
    await sendFederatedMessage(MSG, NOW, failing)
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(true)
    resetPeerBackoff()
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(false)
  })

  it('with a peerId clears only that peer, leaving others untouched', async () => {
    enabledConfig()
    // Second peer so we can verify isolation.
    writeConfigFile({
      enabled: true,
      systemId: 'teodor',
      peers: [
        { id: 'arthur', baseUrl: 'https://macbook.example', outboundToken: TOKEN, inboundToken: IN_TOKEN },
        { id: 'beatrice', baseUrl: 'https://laptop.example', outboundToken: 'c'.repeat(64), inboundToken: 'd'.repeat(64) },
      ],
    })
    const failing = fetchReturning(500, {})
    await sendFederatedMessage(MSG, NOW, failing)
    await sendFederatedMessage({ ...MSG, to_agent: 'beatrice/ops' }, NOW, failing)
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(true)
    expect(isPeerInBackoff('beatrice', NOW + 1)).toBe(true)
    resetPeerBackoff('arthur')
    expect(isPeerInBackoff('arthur', NOW + 1)).toBe(false)
    expect(isPeerInBackoff('beatrice', NOW + 1)).toBe(true)
  })
})

describe('logFedOut (structured-log helper)', () => {
  it('emits an info record tagged with fedOut:true and the user-supplied fields + msg', () => {
    vi.mocked(logger.info).mockClear()
    logFedOut({ peer: 'arthur', remoteId: '42' }, 'federation delivery')
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      { fedOut: true, peer: 'arthur', remoteId: '42' },
      'federation delivery',
    )
  })
})

describe('sendFederatedMessage -- body parsing edges (covers remaining branches)', () => {
  it('delivers with remoteId="" when the 2xx body is non-JSON (catch branch)', async () => {
    enabledConfig()
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response('not json at all', { status: 202 }))
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toEqual({ kind: 'delivered', remoteId: '' })
  })

  it('delivers with remoteId="" when the JSON has no id field (?? branch)', async () => {
    enabledConfig()
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ status: 'queued' }), { status: 202 }))
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toEqual({ kind: 'delivered', remoteId: '' })
  })

  it('truncates the long invalid address in the failure error (truncate default 80)', async () => {
    enabledConfig()
    // 90-char garbage system segment + slash + agent; parseQualifiedId returns
    // null because the system segment fails the SEGMENT_RE whitelist. The
    // failure path passes it through truncate(..., 80).
    const longSeg = 'x'.repeat(90)
    const r = await sendFederatedMessage({ ...MSG, to_agent: `${longSeg}/agent` }, NOW, fetchReturning(202, {}))
    expect(r).toMatchObject({ kind: 'failed' })
    if (r.kind === 'failed') {
      // The error must carry the truncated form, never the full 90+ chars.
      expect(r.error).toContain('…')
      expect(r.error).not.toContain(longSeg)
    }
  })

  it('truncates a long 4xx body in the failure error (truncate default 300)', async () => {
    enabledConfig()
    const longBody = 'y'.repeat(500)
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response(longBody, { status: 400 }))
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toMatchObject({ kind: 'failed' })
    if (r.kind === 'failed') {
      expect(r.error).toContain('…')
      expect(r.error).not.toContain(longBody)
    }
  })

  it('truncates a long 5xx body in the retry error (truncate default 300)', async () => {
    enabledConfig()
    const longBody = 'z'.repeat(500)
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response(longBody, { status: 502 }))
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toMatchObject({ kind: 'retry' })
    if (r.kind === 'retry') {
      expect(r.error).toContain('…')
      expect(r.error).not.toContain(longBody)
    }
  })

  it('truncates a long network-error message in the retry error (truncate default 300)', async () => {
    enabledConfig()
    const longMsg = 'e'.repeat(500)
    const f = vi.fn<typeof fetch>().mockImplementation(async () => { throw new Error(longMsg) })
    const r = await sendFederatedMessage(MSG, NOW, f)
    expect(r).toMatchObject({ kind: 'retry' })
    if (r.kind === 'retry') {
      expect(r.error).toContain('…')
      expect(r.error).not.toContain(longMsg)
    }
  })
})
