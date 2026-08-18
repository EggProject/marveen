import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

const SECURITY = '/usr/bin/security'
const SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

// Real typeguard for the shape `execFileSync` attaches to its thrown Error
// on non-zero exit. The repo forbids `as`/`any` casts (CLAUDE.md 7.); the
// narrower `err is { status?: number; code?: string }` is enough for the
// exit-code check below and lets the rest of the file treat `err` as Error.
const isExecError = (e: unknown): e is { status?: number; code?: string } =>
  e instanceof Error || (typeof e === 'object' && e !== null)

// Thrown when the macOS Keychain is reachable but the master key is not.
// Distinct from "no key yet" (which returns null) -- a locked or ACL-blocked
// keychain is a real failure the caller must surface, not silently re-key
// over. The vault module catches this and refuses to mint a replacement.
export class KeychainUnavailableError extends Error {}

export function isKeychainAvailable(): boolean {
  return platform() === 'darwin'
}

export function keychainStore(value: string): void {
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
}

export function keychainRetrieve(): string | null {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() || null
  } catch (err) {
    // Exit 44 (`SecKeychainSearchCopyNext: The specified item could not be
    // found in the keychain.`) is the genuine "no key yet" case and keeps
    // returning null. Anything else -- exit 36 (locked keychain / SSH),
    // ENOENT on a non-darwin host, errSecInteractionNotAllowed, etc. -- is
    // an access failure the caller must surface as an actionable error.
    // Mapping them all to null previously let vault.getMasterKey silently
    // mint a replacement master key and overwrite the existing one with -U,
    // destroying every secret encrypted under the old key.
    if (isExecError(err) && err.status === 44) return null
    throw new KeychainUnavailableError(err instanceof Error ? err.message : String(err))
  }
}

export function keychainDelete(): boolean {
  try {
    execFileSync(SECURITY, [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}
