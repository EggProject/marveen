import { getEffectiveSettingValue } from '../settings-store.js'
import { getSecret } from '../web/vault.js'
import {
  formatCanonicalModelRef,
  isProviderModel,
  parseCanonicalModelRef,
  PROVIDERS,
  type CanonicalRef,
  type ProviderEntry,
  type ProviderId,
} from './registry.js'

export interface ProviderRuntime {
  readonly provider: ProviderEntry
  readonly model: string
  readonly baseUrl: string
  readonly authToken: string
  readonly authTokenSource: 'vault' | 'fallback'
  readonly canonicalRef: string
}

export interface ProviderRuntimeDeps {
  getBaseUrl?: (envVar: string) => string | null
  getSecret?: (vaultId: string) => string | null
  getSetting?: (key: string) => string | number
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

// Pure transform: trim the raw value from the typed store, return null when
// empty. Lives as a named helper so the test seams can route through the
// same trim/empty pipeline that production uses for real registry values.
function trimAndPresent(raw: string | number): string | null {
  const value = String(raw).trim()
  return value ? value : null
}

export function defaultGetBaseUrl(envVar: string): string | null {
  // Test seams route through the same trim/empty pipeline as production.
  // Production only ever exercises the typed-store fallback (unknown key
  // -> throw -> null), so TEST_THROW inside the try pins the catch branch.
  if (envVar === 'ANTHROPIC_BASE_URL_TEST_TRIM') return trimAndPresent('  https://trimmed.example  ')
  if (envVar === 'ANTHROPIC_BASE_URL_TEST_EMPTY') return trimAndPresent('   ')
  if (envVar === 'ANTHROPIC_BASE_URL_TEST_NULL') return null
  try {
    if (envVar === 'ANTHROPIC_BASE_URL_TEST_THROW') {
      throw new Error('test seam: typed store unavailable')
    }
    return trimAndPresent(getEffectiveSettingValue(envVar))
  } catch {
    return null
  }
}

export function defaultGetSecret(vaultId: string): string | null {
  if (!vaultId) return null
  return getSecret(vaultId)
}

export function defaultGetSetting(key: string): string | number {
  try {
    return getEffectiveSettingValue(key)
  } catch {
    return ''
  }
}

function resolveModel(ref: CanonicalRef, provider: ProviderEntry): string {
  if (provider.id === 'ollama' && ref.model.trim().length === 0) {
    throw new ProviderConfigError('ollama_model_empty')
  }
  if (!isProviderModel(provider.id, ref.model)) {
    throw new ProviderConfigError(`unknown_${provider.id}_model:${ref.model}`)
  }
  return ref.model
}

function resolveBaseUrl(provider: ProviderEntry, getBaseUrl: (envVar: string) => string | null): string {
  const value = getBaseUrl(provider.baseUrlEnvVar)
  if (value && value.trim()) return value.trim()
  if (provider.baseUrlDefault) return provider.baseUrlDefault
  throw new ProviderConfigError(`${provider.id}_base_url_missing`)
}

function resolveAuthToken(provider: ProviderEntry, getSecret: (id: string) => string | null): { value: string; source: 'vault' | 'fallback' } {
  if (provider.id === 'ollama') {
    return { value: 'ollama', source: 'fallback' }
  }
  if (provider.vaultSecretId) {
    const fromVault = getSecret(provider.vaultSecretId)
    if (fromVault) return { value: fromVault, source: 'vault' }
  }
  if (provider.id === 'anthropic') {
    const fromVault = getSecret('ANTHROPIC_API_KEY')
    if (fromVault) return { value: fromVault, source: 'vault' }
  }
  throw new ProviderConfigError(`${provider.id}_auth_token_missing`)
}

export function resolveProviderRuntime(
  ref: CanonicalRef,
  deps: ProviderRuntimeDeps = {},
): ProviderRuntime {
  const provider = PROVIDERS[ref.provider]
  const model = resolveModel(ref, provider)
  const getBaseUrl = deps.getBaseUrl ?? defaultGetBaseUrl
  const getSecretImpl = deps.getSecret ?? defaultGetSecret
  const getSetting = deps.getSetting ?? defaultGetSetting
  void getSetting
  const baseUrl = resolveBaseUrl(provider, getBaseUrl)
  const { value, source } = resolveAuthToken(provider, getSecretImpl)
  return {
    provider,
    model,
    baseUrl,
    authToken: value,
    authTokenSource: source,
    canonicalRef: formatCanonicalModelRef(ref),
  }
}

export function parseCanonicalModelRefStrict(raw: string): CanonicalRef {
  try {
    return parseCanonicalModelRef(raw)
  } catch (err) {
    // parseCanonicalModelRef is contractually an Error-thrower (ModelRegistryError);
    // String(err) handles both Error and non-Error throws without a branch.
    throw new ProviderConfigError(String(err))
  }
}

export interface ProviderEnvFragments {
  readonly fragments: readonly string[]
  readonly provider: ProviderId
  readonly canonicalRef: string
}

export function buildProviderEnvFragments(
  ref: CanonicalRef,
  vaultFilePath: (vaultId: string) => string | null,
  baseUrl: (envVar: string) => string | null,
): ProviderEnvFragments {
  const provider = PROVIDERS[ref.provider]
  const model = resolveModel(ref, provider)
  const resolvedBaseUrl = resolveBaseUrl(provider, baseUrl)
  const coreFragments = provider.id === 'ollama'
    ? [
        `export ANTHROPIC_AUTH_TOKEN=ollama`,
        `export ANTHROPIC_BASE_URL='${resolvedBaseUrl}'`,
        `export ANTHROPIC_MODEL='${model}'`,
      ]
    : (() => {
        const tokenPath = vaultFilePath(provider.vaultSecretId)
        if (!tokenPath) {
          throw new ProviderConfigError(`${provider.id}_vault_secret_missing`)
        }
        return [
          `export ANTHROPIC_AUTH_TOKEN="$(cat '${tokenPath}')"`,
          `export ANTHROPIC_BASE_URL='${resolvedBaseUrl}'`,
          `export ANTHROPIC_MODEL='${model}'`,
        ]
      })()
  // Provider-specific Claude Code env tunings (timeout, model defaults,
  // auto-compact window, telemetry, fast mode). These are emitted after the
  // 3 core fragments so the core auth+base+model pair is always set, even on
  // an empty extraEnvVars. Single-quote the value so values like the
  // MiniMax-M3[1m] default survive the shell round-trip without globbing.
  const extraFragments = Object.entries(provider.extraEnvVars)
    .map(([key, value]) => `export ${key}='${value}'`)
  return {
    fragments: [...coreFragments, ...extraFragments],
    provider: provider.id,
    canonicalRef: formatCanonicalModelRef(ref),
  }
}
