import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isKeychainAvailable, keychainStore, keychainRetrieve, KeychainUnavailableError } from './keychain.js'
import { logger } from '../logger.js'

const VAULT_PATH = join(PROJECT_ROOT, 'store', 'vault.json')
const VAULT_KEY_PATH = join(PROJECT_ROOT, 'store', '.vault-key')
const VAULT_KEY_MIGRATED = join(PROJECT_ROOT, 'store', '.vault-key.migrated')
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32

interface VaultEntry {
  id: string
  label: string
  encrypted: string  // base64(salt + iv + tag + ciphertext)
  createdAt: string
  updatedAt: string
}

interface VaultStore {
  entries: VaultEntry[]
}

function getMasterKey(): Buffer {
  if (isKeychainAvailable()) {
    if (existsSync(VAULT_KEY_PATH)) {
      const fileKey = readFileSync(VAULT_KEY_PATH, 'utf-8').trim()
      try {
        keychainStore(fileKey)
        renameSync(VAULT_KEY_PATH, VAULT_KEY_MIGRATED)
        logger.info('Vault master key migrated from file to macOS Keychain')
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Keychain migration failed, keeping file-based key')
      }
      return Buffer.from(fileKey, 'base64')
    }

    let existing: string | null = null
    let keychainFailed = false
    try {
      existing = keychainRetrieve()
    } catch (err) {
      if (!(err instanceof KeychainUnavailableError)) throw err
      // Keychain is reachable but locked / ACL-blocked / missing binary.
      // Mark and fall through; the entries-exist guard below refuses to
      // mint only when the vault is non-empty. First-run (vault empty
      // + unreachable keychain) still mints -- re-keying is unavoidable
      // in this one edge case.
      keychainFailed = true
    }
    if (existing) return Buffer.from(existing, 'base64')

    // Defense-in-depth: if the vault already holds secrets AND the keychain
    // is unreachable (throw, not just null-return), NEVER mint a replacement.
    // A null return without a throw means the item is genuinely absent --
    // safe to mint, even if the vault already has entries from a prior
    // process (round-trip pattern in tests, or a process that lost its
    // keychain between runs but kept the encrypted vault file).
    if (keychainFailed && vaultHasContent()) {
      throw new KeychainUnavailableError(
        'Vault already contains secrets but the macOS Keychain master key is unreachable. ' +
        'Refusing to mint a replacement to avoid destroying the vault. ' +
        'Unlock the login keychain or restore the master key manually.',
      )
    }

    const newKey = randomBytes(64).toString('base64')
    try {
      keychainStore(newKey)
      logger.info('New vault master key stored in macOS Keychain')
    } catch (err) {
      // The file-fallback cascade is removed: a keychainStore throw (e.g. locked-keychain
      // prompt, exit 45) now propagates so the operator sees a user-facing error rather
      // than a silent downgrade to a same-uid-readable file at store/.vault-key (mode 0600).
      // Migration branch (lines 30-42) is unchanged: file is source of truth there, the
      // keychain push is best-effort.
      throw err
    }
    return Buffer.from(newKey, 'base64')
  }

  if (!existsSync(VAULT_KEY_PATH)) {
    const key = randomBytes(64).toString('base64')
    atomicWriteFileSync(VAULT_KEY_PATH, key, { mode: 0o600 })
  }
  return Buffer.from(readFileSync(VAULT_KEY_PATH, 'utf-8').trim(), 'base64')
}

function deriveKey(master: Buffer, salt: Buffer): Buffer {
  return scryptSync(master, salt, KEY_LENGTH)
}

function encrypt(plaintext: string): string {
  const master = getMasterKey()
  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(master, salt)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64')
}

function decrypt(packed: string): string {
  const master = getMasterKey()
  const buf = Buffer.from(packed, 'base64')
  const salt = buf.subarray(0, SALT_LENGTH)
  const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const key = deriveKey(master, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

function readVault(): VaultStore {
  const raw = readVaultRaw()
  return isVaultStore(raw) ? raw : { entries: [] }
}

function readVaultRaw(): unknown | undefined {
  try { return JSON.parse(readFileSync(VAULT_PATH, 'utf-8')) }
  catch { return undefined }
}

function isVaultStore(v: unknown): v is VaultStore {
  if (typeof v !== 'object' || v === null) return false
  if (!('entries' in v)) return false
  return Array.isArray(v.entries)
}

// A parseable-but-invalid vault may still hold encrypted secrets, so it
// counts as content and must block minting.
function vaultHasContent(): boolean {
  const raw = readVaultRaw()
  if (raw === undefined) return false
  return isVaultStore(raw) ? raw.entries.length > 0 : true
}

function writeVault(store: VaultStore): void {
  atomicWriteFileSync(VAULT_PATH, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

export function listSecrets(): Array<{ id: string, label: string, createdAt: string, updatedAt: string }> {
  return readVault().entries.map(({ id, label, createdAt, updatedAt }) => ({ id, label, createdAt, updatedAt }))
}

export function setSecret(id: string, label: string, value: string): void {
  const store = readVault()
  const now = new Date().toISOString()
  const idx = store.entries.findIndex(e => e.id === id)
  const entry: VaultEntry = { id, label, encrypted: encrypt(value), createdAt: now, updatedAt: now }
  if (idx >= 0) {
    entry.createdAt = store.entries[idx].createdAt
    store.entries[idx] = entry
  } else {
    store.entries.push(entry)
  }
  writeVault(store)
}

export function getSecret(id: string): string | null {
  const store = readVault()
  const entry = store.entries.find(e => e.id === id)
  if (!entry) return null
  return decrypt(entry.encrypted)
}

export function deleteSecret(id: string): boolean {
  const store = readVault()
  const before = store.entries.length
  store.entries = store.entries.filter(e => e.id !== id)
  if (store.entries.length === before) return false
  writeVault(store)
  return true
}

export function getSecretsForEnv(envMap: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, vaultId] of Object.entries(envMap)) {
    const value = getSecret(vaultId)
    if (value !== null) result[key] = value
  }
  return result
}
