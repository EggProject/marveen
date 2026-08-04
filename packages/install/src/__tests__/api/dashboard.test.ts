import { describe, it, expect, vi, afterEach } from 'vitest'
import { isUnauthorized, postSettings, postVault, waitForDashboardReady } from '../../api/dashboard.js'
import { makeFetch } from '../_helpers.js'

const BASE = 'http://127.0.0.1:3420'
const TOKEN = 'dash-token'

afterEach(() => { vi.restoreAllMocks() })

describe('api/dashboard waitForDashboardReady', () => {
  it('returns true on the first successful poll', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await waitForDashboardReady({ base: BASE, token: TOKEN, fetch: fn })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/api/settings`)
    expect(calls[0]!.init).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } })
  })

  it('strips a trailing slash from the base URL', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await waitForDashboardReady({ base: `${BASE}/`, token: TOKEN, fetch: fn })
    expect(calls[0]!.url).toBe(`${BASE}/api/settings`)
  })

  it('retries while the dashboard answers non-2xx', async () => {
    const { fn, calls } = makeFetch([{ status: 503 }, { status: 503 }, { ok: true }])
    expect(await waitForDashboardReady({
      base: BASE, token: TOKEN, fetch: fn, timeoutMs: 5_000, pollIntervalMs: 1,
    })).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('retries while fetch throws a network error', async () => {
    const { fn, calls } = makeFetch([new Error('ECONNREFUSED'), { ok: true }])
    expect(await waitForDashboardReady({
      base: BASE, token: TOKEN, fetch: fn, timeoutMs: 5_000, pollIntervalMs: 1,
    })).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('returns false when the deadline has already passed', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await waitForDashboardReady({ base: BASE, token: TOKEN, fetch: fn, timeoutMs: 0 })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('gives up after the timeout elapses', async () => {
    const { fn } = makeFetch([{ status: 500 }])
    expect(await waitForDashboardReady({
      base: BASE, token: TOKEN, fetch: fn, timeoutMs: 20, pollIntervalMs: 1,
    })).toBe(false)
  })

  it('falls back to the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    expect(await waitForDashboardReady({ base: BASE, token: TOKEN })).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('api/dashboard postVault', () => {
  const payload = { id: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', value: 'sk-ant-'.padEnd(30, 'x') }

  it('POSTs the vault payload with the bearer token', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await postVault(payload, { base: BASE, token: TOKEN, fetch: fn })).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${BASE}/api/vault`)
    expect(calls[0]!.init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
    })
  })

  it('strips a trailing slash from the base URL', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await postVault(payload, { base: `${BASE}/`, token: TOKEN, fetch: fn })
    expect(calls[0]!.url).toBe(`${BASE}/api/vault`)
  })

  it('rejects an invalid payload before any request', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    const res = await postVault({ id: 'lower case', label: 'l', value: 'v' }, { base: BASE, token: TOKEN, fetch: fn })
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ status: 0 })
    expect(calls).toHaveLength(0)
  })

  it('surfaces a 401 with the response body', async () => {
    const { fn } = makeFetch([{ status: 401, body: 'unauthorized' }])
    const res = await postVault(payload, { base: BASE, token: TOKEN, fetch: fn })
    expect(res).toEqual({ ok: false, status: 401, reason: 'unauthorized' })
    expect(isUnauthorized(res as { status: number })).toBe(true)
  })

  it('truncates a long error body to 256 characters', async () => {
    const { fn } = makeFetch([{ status: 500, body: 'x'.repeat(400) }])
    const res = await postVault(payload, { base: BASE, token: TOKEN, fetch: fn })
    expect(res).toMatchObject({ ok: false, status: 500 })
    expect((res as { reason: string }).reason).toHaveLength(256)
  })

  it('returns an empty reason when reading the body fails', async () => {
    const fn = (async () => ({
      ok: false,
      status: 500,
      text: async () => { throw new Error('stream closed') },
    })) as unknown as typeof fetch
    const res = await postVault(payload, { base: BASE, token: TOKEN, fetch: fn })
    expect(res).toEqual({ ok: false, status: 500, reason: '' })
  })

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    expect(await postVault(payload, { base: BASE, token: TOKEN })).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('api/dashboard postSettings', () => {
  it('POSTs the settings payload and defaults the actor to installer', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await postSettings({ key: 'OLLAMA_BASE_URL', value: 'http://x' }, { base: BASE, token: TOKEN, fetch: fn }))
      .toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${BASE}/api/settings`)
    expect(JSON.parse(String((calls[0]!.init as { body: string }).body))).toEqual({
      key: 'OLLAMA_BASE_URL', value: 'http://x', actor: 'installer',
    })
  })

  it('keeps an explicit installer actor', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await postSettings({ key: 'A', value: 'v', actor: 'installer' }, { base: `${BASE}/`, token: TOKEN, fetch: fn })
    expect(calls[0]!.url).toBe(`${BASE}/api/settings`)
  })

  it('rejects an invalid payload before any request', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    const res = await postSettings({ key: 'bad key', value: 'v' }, { base: BASE, token: TOKEN, fetch: fn })
    expect(res).toMatchObject({ ok: false, status: 0 })
    expect(calls).toHaveLength(0)
  })

  it('surfaces a non-2xx status with the body', async () => {
    const { fn } = makeFetch([{ status: 400, body: 'bad request' }])
    expect(await postSettings({ key: 'A', value: 'v' }, { base: BASE, token: TOKEN, fetch: fn }))
      .toEqual({ ok: false, status: 400, reason: 'bad request' })
  })

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    expect(await postSettings({ key: 'A', value: 'v' }, { base: BASE, token: TOKEN })).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('api/dashboard isUnauthorized', () => {
  it('is true only for 401', () => {
    expect(isUnauthorized({ status: 401 })).toBe(true)
    expect(isUnauthorized({ status: 403 })).toBe(false)
    expect(isUnauthorized({ status: 0 })).toBe(false)
  })
})
