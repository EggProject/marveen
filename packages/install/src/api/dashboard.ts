// Dashboard HTTP client.
//
// waitForDashboardReady polls /api/settings until it returns 2xx or the
// timeout elapses. The installer MUST wait before posting credentials
// because the dashboard creates the bearer token on first listener
// bind. postVault / postSettings are thin wrappers that translate a
// non-2xx response into a typed error so the install step can branch on
// 401 vs network failure vs schema mismatch.

import type { VaultRequestInput, SettingsRequestInput } from './schema.js'
import { VaultRequest, SettingsRequest } from './schema.js'

export interface DashboardOptions {
  base: string
  token: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
}

type FetchFn = typeof fetch

function pickFetch(f?: FetchFn): FetchFn {
  return f ?? globalThis.fetch.bind(globalThis)
}

export async function waitForDashboardReady(opts: DashboardOptions): Promise<boolean> {
  const f = pickFetch(opts.fetch)
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  const interval = opts.pollIntervalMs ?? 1_000
  const url = `${opts.base.replace(/\/$/, '')}/api/settings`
  while (Date.now() < deadline) {
    try {
      const res = await f(url, { headers: { Authorization: `Bearer ${opts.token}` } })
      if (res.ok) return true
    } catch {
      // network error -> retry until deadline
    }
    await sleep(interval)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function postVault(
  payload: VaultRequestInput,
  opts: { base: string; token: string; fetch?: typeof fetch },
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const parsed = VaultRequest.safeParse(payload)
  if (!parsed.success) {
    return { ok: false, status: 0, reason: parsed.error.message }
  }
  const f = pickFetch(opts.fetch)
  const res = await f(`${opts.base.replace(/\/$/, '')}/api/vault`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(parsed.data),
  })
  if (res.ok) return { ok: true }
  return { ok: false, status: res.status, reason: await safeText(res) }
}

export async function postSettings(
  payload: SettingsRequestInput,
  opts: { base: string; token: string; fetch?: typeof fetch },
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const parsed = SettingsRequest.safeParse({ ...payload, actor: payload.actor ?? 'installer' })
  if (!parsed.success) {
    return { ok: false, status: 0, reason: parsed.error.message }
  }
  const f = pickFetch(opts.fetch)
  const res = await f(`${opts.base.replace(/\/$/, '')}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(parsed.data),
  })
  if (res.ok) return { ok: true }
  return { ok: false, status: res.status, reason: await safeText(res) }
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.length > 256 ? text.slice(0, 256) : text
  } catch {
    return ''
  }
}

export function isUnauthorized(result: { status: number }): boolean {
  return result.status === 401
}