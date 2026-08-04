// Vault push step.
//
// Mirrors the 19 bash test scenarios from installer-push-config.sh:
//   - happy path (vault + settings both 200)
//   - vault only (no base URL key)
//   - settings only (no vault value)
//   - 401 unauthorized (token rejected)
//   - network error (fetch throws)
//   - schema validation failure (invalid payload)
//   - skip mode (no provider credentials chosen)
//   - retry on first 5xx then 200
//   - non-OK response with body
//
// The step waits for the dashboard to be ready via waitForDashboardReady
// before any POST. Failures are NON-FATAL at the installer level:
// the operator can finish setup via the dashboard wizard.

import type { InstallerContext, ProviderChoice } from '../types.js'
import { postSettings, postVault, waitForDashboardReady, isUnauthorized } from '../api/dashboard.js'
import { t } from '../locale/index.js'

export interface VaultPushResult {
  vaultOk: boolean
  settingsOk: boolean
  skipped: boolean
  reason?: string
}

export async function stepVaultPush(ctx: InstallerContext): Promise<VaultPushResult> {
  const choice = ctx.providerChoice
  if (!choice || choice.mode === 'skip') {
    return { vaultOk: true, settingsOk: true, skipped: true }
  }
  return await pushProviderConfig(ctx, choice)
}

export async function pushProviderConfig(
  ctx: InstallerContext,
  choice: ProviderChoice,
): Promise<VaultPushResult> {
  const base = `http://127.0.0.1:${ctx.webPort}`
  const token = ctx.dashboardToken
  const ready = await waitForDashboardReady({ base, token, fetch: ctx.fetch, timeoutMs: 30_000 })
  if (!ready) {
    return { vaultOk: false, settingsOk: false, skipped: false, reason: 'dashboard-not-ready' }
  }

  let vaultOk = true
  let settingsOk = true
  let reason: string | undefined

  if (choice.vaultValue && choice.vaultId) {
    const res = await postVault({
      id: choice.vaultId,
      label: choice.vaultLabel ?? choice.vaultId,
      value: choice.vaultValue,
    }, { base, token, fetch: ctx.fetch })
    if (!res.ok) {
      vaultOk = false
      if (isUnauthorized(res)) reason = t('vault.push.unauthorized')
      else reason = res.reason
    }
  }

  if (choice.baseUrlKey && choice.baseUrlValue) {
    const res = await postSettings({
      key: choice.baseUrlKey,
      value: choice.baseUrlValue,
      actor: 'installer',
    }, { base, token, fetch: ctx.fetch })
    if (!res.ok) {
      settingsOk = false
      if (!reason && isUnauthorized(res)) reason = t('vault.push.unauthorized')
      else if (!reason) reason = res.reason
    }
  }

  return { vaultOk, settingsOk, skipped: false, ...(reason !== undefined ? { reason } : {}) }
}

export function describePushResult(res: VaultPushResult): string {
  if (res.skipped) return t('provider.update.no-change')
  if (res.vaultOk && res.settingsOk) return t('vault.push.ok')
  return `${t('vault.push.failed')}${res.reason ? ` (${res.reason})` : ''}`
}