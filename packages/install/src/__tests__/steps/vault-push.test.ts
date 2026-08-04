// TS port of the 19 shell scenarios from
// scripts/__tests__/installer-push-config.test.sh. The dashboard client
// is driven through the injected fetch on InstallerContext.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { describePushResult, pushProviderConfig, stepVaultPush } from '../../steps/vault-push.js'
import { initLocale } from '../../locale/index.js'
import { makeCtx, makeFetch } from '../_helpers.js'
import type { ProviderChoice } from '../../types.js'

const VAULT_CHOICE: ProviderChoice = {
  mode: 'minimax',
  vaultId: 'MINIMAX_API_KEY',
  vaultLabel: 'MiniMax API key',
  vaultValue: 'x'.repeat(24),
  baseUrlKey: 'MINIMAX_BASE_URL',
  baseUrlValue: 'https://api.minimax.io/anthropic',
}

beforeEach(() => { initLocale('hu') })

describe('steps/vault-push happy path', () => {
  // 1
  it('waits for the dashboard, then pushes vault + settings', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }, { ok: true }])
    const ctx = makeCtx({ fetch: fn, webPort: 3420, dashboardToken: 'tok', providerChoice: VAULT_CHOICE })
    expect(await stepVaultPush(ctx)).toEqual({ vaultOk: true, settingsOk: true, skipped: false })
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:3420/api/settings',
      'http://127.0.0.1:3420/api/vault',
      'http://127.0.0.1:3420/api/settings',
    ])
  })

  // 2
  it('sends the vault payload with the bearer token', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }, { ok: true }])
    const ctx = makeCtx({ fetch: fn, dashboardToken: 'tok' })
    await pushProviderConfig(ctx, VAULT_CHOICE)
    const init = calls[1]!.init as { headers: Record<string, string>; body: string }
    expect(init.headers['Authorization']).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({
      id: 'MINIMAX_API_KEY', label: 'MiniMax API key', value: 'x'.repeat(24),
    })
  })

  // 3
  it('sends the settings payload with the installer actor', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }, { ok: true }])
    await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(JSON.parse((calls[2]!.init as { body: string }).body)).toEqual({
      key: 'MINIMAX_BASE_URL', value: 'https://api.minimax.io/anthropic', actor: 'installer',
    })
  })

  // 4
  it('falls back to the vault id as the label', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }])
    await pushProviderConfig(makeCtx({ fetch: fn }), {
      mode: 'deepseek', vaultId: 'DEEPSEEK_API_KEY', vaultValue: 'y'.repeat(24),
    })
    expect(JSON.parse((calls[1]!.init as { body: string }).body).label).toBe('DEEPSEEK_API_KEY')
  })
})

describe('steps/vault-push partial payloads', () => {
  // 5
  it('vault only: no settings request is sent', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), {
      mode: 'anthropic', vaultId: 'ANTHROPIC_API_KEY', vaultLabel: 'k', vaultValue: 'z'.repeat(24),
    })
    expect(res).toEqual({ vaultOk: true, settingsOk: true, skipped: false })
    expect(calls).toHaveLength(2)
  })

  // 6
  it('settings only: no vault request is sent', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), {
      mode: 'ollama', baseUrlKey: 'OLLAMA_BASE_URL', baseUrlValue: 'http://localhost:11434',
    })
    expect(res).toEqual({ vaultOk: true, settingsOk: true, skipped: false })
    expect(calls[1]!.url).toContain('/api/settings')
    expect(calls).toHaveLength(2)
  })

  // 7
  it('a vault value without an id is not pushed', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await pushProviderConfig(makeCtx({ fetch: fn }), { mode: 'anthropic', vaultValue: 'q'.repeat(24) })
    expect(calls).toHaveLength(1)
  })

  // 8
  it('a base URL key without a value is not pushed', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await pushProviderConfig(makeCtx({ fetch: fn }), { mode: 'ollama', baseUrlKey: 'OLLAMA_BASE_URL' })
    expect(calls).toHaveLength(1)
  })

  // 9
  it('a choice with neither payload sends nothing but reports success', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await pushProviderConfig(makeCtx({ fetch: fn }), { mode: 'anthropic' }))
      .toEqual({ vaultOk: true, settingsOk: true, skipped: false })
    expect(calls).toHaveLength(1)
  })
})

describe('steps/vault-push failures', () => {
  // 10
  it('reports dashboard-not-ready when the readiness probe never passes', async () => {
    vi.useFakeTimers()
    const { fn, calls } = makeFetch([{ status: 503 }])
    const ctx = makeCtx({ fetch: fn, providerChoice: VAULT_CHOICE })
    const pending = stepVaultPush(ctx)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await pending).toEqual({
      vaultOk: false, settingsOk: false, skipped: false, reason: 'dashboard-not-ready',
    })
    expect(calls.every((c) => c.url.endsWith('/api/settings'))).toBe(true)
    vi.useRealTimers()
  })

  // 11
  it('maps a 401 on the vault push to the unauthorized message', async () => {
    const { fn } = makeFetch([{ ok: true }, { status: 401, body: 'nope' }, { ok: true }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(res).toEqual({
      vaultOk: false, settingsOk: true, skipped: false, reason: 'Dashboard token érvénytelen (401)',
    })
  })

  // 12
  it('surfaces the response body for a non-401 vault failure', async () => {
    const { fn } = makeFetch([{ ok: true }, { status: 500, body: 'boom' }, { ok: true }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(res).toMatchObject({ vaultOk: false, settingsOk: true, reason: 'boom' })
  })

  // 13
  it('maps a 401 on the settings push to the unauthorized message', async () => {
    const { fn } = makeFetch([{ ok: true }, { ok: true }, { status: 401, body: 'nope' }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(res).toEqual({
      vaultOk: true, settingsOk: false, skipped: false, reason: 'Dashboard token érvénytelen (401)',
    })
  })

  // 14
  it('surfaces the response body for a non-401 settings failure', async () => {
    const { fn } = makeFetch([{ ok: true }, { ok: true }, { status: 422, body: 'invalid key' }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(res).toMatchObject({ vaultOk: true, settingsOk: false, reason: 'invalid key' })
  })

  // 15
  it('keeps the first failure reason when both pushes fail', async () => {
    const { fn } = makeFetch([{ ok: true }, { status: 500, body: 'vault down' }, { status: 401, body: 'nope' }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), VAULT_CHOICE)
    expect(res).toEqual({ vaultOk: false, settingsOk: false, skipped: false, reason: 'vault down' })
  })

  // 16
  it('rejects a schema-invalid vault id without sending it', async () => {
    const { fn, calls } = makeFetch([{ ok: true }, { ok: true }])
    const res = await pushProviderConfig(makeCtx({ fetch: fn }), {
      mode: 'minimax', vaultId: 'lower case id', vaultValue: 'v'.repeat(24),
    })
    expect(res.vaultOk).toBe(false)
    expect(typeof res.reason).toBe('string')
    expect(calls).toHaveLength(1)
  })
})

describe('steps/vault-push skip handling', () => {
  // 17
  it('skips when no provider was chosen', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await stepVaultPush(makeCtx({ fetch: fn }))).toEqual({ vaultOk: true, settingsOk: true, skipped: true })
    expect(calls).toHaveLength(0)
  })

  // 18
  it('skips when the provider mode is skip', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    const ctx = makeCtx({ fetch: fn, providerChoice: { mode: 'skip' } })
    expect(await stepVaultPush(ctx)).toEqual({ vaultOk: true, settingsOk: true, skipped: true })
    expect(calls).toHaveLength(0)
  })
})

describe('steps/vault-push describePushResult', () => {
  // 19
  it('describes every outcome', () => {
    expect(describePushResult({ vaultOk: true, settingsOk: true, skipped: true })).toBe('Nincs változás')
    expect(describePushResult({ vaultOk: true, settingsOk: true, skipped: false }))
      .toBe('Provider konfiguráció push-olva a Vault-ba')
    expect(describePushResult({ vaultOk: false, settingsOk: true, skipped: false, reason: '401' }))
      .toBe('Provider push sikertelen -- a dashboard Beállítások oldalon javítható (401)')
    expect(describePushResult({ vaultOk: true, settingsOk: false, skipped: false }))
      .toBe('Provider push sikertelen -- a dashboard Beállítások oldalon javítható')
  })

  it('follows the active locale', () => {
    initLocale('en')
    expect(describePushResult({ vaultOk: true, settingsOk: true, skipped: false }))
      .toBe('Provider configuration pushed to the Vault')
    initLocale('hu')
  })
})
