// Zod schemas for Vault/Settings request payloads.
//
// These mirror the runtime-side validation in @marveen/core. The
// installer validates locally before pushing so a typo in the
// operator-typed credential produces a clean Hungarian error instead
// of a 400 from the dashboard.

import { z } from 'zod'

export const VaultId = z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/)

export const SettingsKey = z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/)

export const VaultRequest = z.object({
  id: VaultId,
  label: z.string().min(1).max(256),
  value: z.string().min(1).max(8192),
})

export const SettingsRequest = z.object({
  key: SettingsKey,
  value: z.string().min(1).max(4096),
  actor: z.literal('installer').optional(),
})

export type VaultRequestInput = z.infer<typeof VaultRequest>
export type SettingsRequestInput = z.infer<typeof SettingsRequest>