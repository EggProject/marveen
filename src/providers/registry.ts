// Single source of truth for provider + model metadata. Pure, dependency-free,
// no fs or env reads. The runtime model layer (model-runtime.ts) wraps it in
// a canonical-resolver and secret-aware spawn spec.

export const PROVIDER_IDS = ['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8[1m]'
export const ANTHROPIC_DEFAULT_MODEL = CLAUDE_DEFAULT_MODEL

export interface ProviderEntry {
  readonly id: ProviderId
  readonly displayName: string
  readonly baseUrlEnvVar: string
  readonly baseUrlDefault: string | null
  readonly authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN'
  readonly modelEnvVar: 'ANTHROPIC_MODEL'
  readonly vaultSecretId: string
  readonly canonicalEnvBase: string
  readonly usesAnthropicModel: boolean
  readonly models: readonly ModelSpec[]
  // Provider-specific Claude Code env fragments. The 3 core env vars
  // (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL) are emitted
  // unconditionally by buildProviderEnvFragments; extraEnvVars covers the
  // provider-specific tunings (timeout, model defaults, auto-compact window,
  // telemetry, fast mode) that every `claude` invocation under this provider
  // needs to start successfully.
  readonly extraEnvVars: Readonly<Record<string, string>>
}

export interface ModelSpec {
  readonly id: string
  readonly displayName: string
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderEntry>> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    baseUrlDefault: null,
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    modelEnvVar: 'ANTHROPIC_MODEL',
    vaultSecretId: 'CLAUDE_CODE_OAUTH_TOKEN',
    canonicalEnvBase: 'anthropic',
    usesAnthropicModel: false,
    extraEnvVars: {},
    models: [
      { id: 'claude-opus-4-8[1m]', displayName: 'Claude Opus 4.8 (1M context)' },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
    ],
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    baseUrlEnvVar: 'MINIMAX_BASE_URL',
    baseUrlDefault: null,
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    modelEnvVar: 'ANTHROPIC_MODEL',
    vaultSecretId: 'MINIMAX_API_KEY',
    canonicalEnvBase: 'minimax',
    usesAnthropicModel: true,
    // MiniMax M3 + 1M context requires these tunings on every claude call;
    // omitting them leaves the model unusable under Anthropic-compatible
    // routing. See provider-runtime tests for the verbatim contract.
    extraEnvVars: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    },
    models: [
      { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    baseUrlDefault: 'https://api.deepseek.com/anthropic',
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    modelEnvVar: 'ANTHROPIC_MODEL',
    vaultSecretId: 'DEEPSEEK_API_KEY',
    canonicalEnvBase: 'deepseek',
    usesAnthropicModel: true,
    extraEnvVars: {},
    models: [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    baseUrlDefault: 'https://openrouter.ai/api',
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    modelEnvVar: 'ANTHROPIC_MODEL',
    vaultSecretId: 'openrouter-fleet-key',
    canonicalEnvBase: 'openrouter',
    usesAnthropicModel: true,
    extraEnvVars: {},
    models: [
      { id: 'auto:premium_reasoning', displayName: 'OpenRouter Auto (premium reasoning)' },
      { id: 'auto:build_strong', displayName: 'OpenRouter Auto (build strong)' },
      { id: 'auto:analysis_efficient', displayName: 'OpenRouter Auto (analysis)' },
      { id: 'auto:routine_lowcost', displayName: 'OpenRouter Auto (low cost)' },
    ],
  },
  ollama: {
    id: 'ollama',
    displayName: 'Ollama (local)',
    baseUrlEnvVar: 'OLLAMA_URL',
    baseUrlDefault: 'http://localhost:11434',
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    modelEnvVar: 'ANTHROPIC_MODEL',
    vaultSecretId: '',
    canonicalEnvBase: 'ollama',
    usesAnthropicModel: true,
    extraEnvVars: {},
    models: [],
  },
}

export const PROVIDER_ID_LIST: readonly ProviderId[] = PROVIDER_IDS

export interface CanonicalRef {
  readonly provider: ProviderId
  readonly model: string
}

export function parseCanonicalModelRef(raw: string): CanonicalRef {
  const colon = raw.indexOf(':')
  if (colon <= 0 || colon === raw.length - 1) {
    throw new ModelRegistryError(`invalid_canonical_ref:${raw}`)
  }
  const provider = raw.slice(0, colon)
  const model = raw.slice(colon + 1)
  if (!isProviderId(provider)) {
    throw new ModelRegistryError(`unknown_provider:${provider}`)
  }
  return { provider, model }
}

export function formatCanonicalModelRef(ref: CanonicalRef): string {
  return `${ref.provider}:${ref.model}`
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRegistryError'
  }
}

export function getProvider(id: ProviderId): ProviderEntry {
  return PROVIDERS[id]
}

export function getProviderModels(id: ProviderId): readonly ModelSpec[] {
  return PROVIDERS[id].models
}

export function isProviderModel(provider: ProviderId, model: string): boolean {
  if (provider === 'ollama') return model.trim().length > 0
  if (provider === 'openrouter') return /^auto:|^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(model)
  return PROVIDERS[provider].models.some((m) => m.id === model)
}
