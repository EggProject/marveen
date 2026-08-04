// Conf wrapper holding the InstallerState schema.
//
// `installer-state.json` lives in the conf-managed
// ~/.config/marveen-installer/ directory and is purely metadata (last
// provider used, skipped step list, last installed version). It NEVER
// holds credentials -- credentials go to the dashboard Vault, not the
// installer state file.

import Conf from 'conf'
import type { ProviderMode } from '../types.js'

export interface InstallerState {
  lastInstalledVersion: string
  lastProvider: ProviderMode
  skippedSteps: string[]
  uninstalledAt: string | null
}

const DEFAULTS: InstallerState = {
  lastInstalledVersion: '',
  lastProvider: 'skip',
  skippedSteps: [],
  uninstalledAt: null,
}

type ConfFactory = (opts: Conf.Options<InstallerState>) => Conf<InstallerState>

let confFactory: ConfFactory = (opts) => new Conf<InstallerState>(opts)

export function setConfFactory(fn: ConfFactory): void {
  confFactory = fn
}

export function resetConfFactory(): void {
  confFactory = (opts) => new Conf<InstallerState>(opts)
}

export function createState(): Conf<InstallerState> {
  return confFactory({
    projectName: 'marveen-installer',
    projectSuffix: 'marveen',
    defaults: DEFAULTS,
    schema: {
      lastInstalledVersion: { type: 'string' },
      lastProvider: { type: 'string', enum: ['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip'] },
      skippedSteps: { type: 'array', items: { type: 'string' } },
      uninstalledAt: { type: ['string', 'null'] },
    },
  })
}

export function defaultState(): InstallerState {
  return { ...DEFAULTS, skippedSteps: [...DEFAULTS.skippedSteps] }
}