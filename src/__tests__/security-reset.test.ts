// 100% coverage suite for src/web/security-reset.ts (AUTHPLAN1 #5).
//
// The module is a thin orchestrator: revokeAllDeviceKeys + revokeAllSessions,
// logConfigChange('security.reset', ...), return the counts. Nothing imports
// env / os / subprocesses -- the only side effect is on the SQLite DB the
// shared `initDatabase(':memory:')` provides. We exercise the function on
// several states:
//
//   - empty install (counts == 0)
//   - one device key + one session (counts == 1+1)
//   - many of each (counts == N+N)
//   - dashboard_users must be untouched (not a factory reset)
//   - the audit row captures the counts as text and the actor verbatim
//   - the audit row has old_value = NULL and new_value = "device_keys=N sessions=M"
//   - the SecurityResetResult interface fields match what is returned

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, createDashboardUser } from '../db.js'
import { securityReset } from '../web/security-reset.js'
import {
  createDeviceKey,
  resolveDeviceKey,
  listDeviceKeys,
  _clearDeviceKeyCacheForTest,
} from '../web/auth-device-keys.js'
import {
  createSession,
  resolveSession,
  _clearSessionCacheForTest,
} from '../web/auth-sessions.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  _clearSessionCacheForTest()
  const db = getDb()
  db.prepare('DELETE FROM device_keys').run()
  db.prepare('DELETE FROM auth_sessions').run()
  db.prepare('DELETE FROM dashboard_users').run()
  db.prepare('DELETE FROM config_change_log').run()
})

describe('securityReset -- empty install', () => {
  it('returns 0/0 when there is nothing to revoke', () => {
    const r = securityReset('operator-cli')
    expect(r).toEqual({ deviceKeysRevoked: 0, sessionsCleared: 0 })
  })

  it('still writes an audit row on the no-op path (the audit must always run)', () => {
    securityReset('operator-cli')
    const rows = getDb()
      .prepare("SELECT key, old_value, new_value, actor FROM config_change_log WHERE key = 'security.reset'")
      .all() as Array<{ key: string; old_value: string | null; new_value: string | null; actor: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      key: 'security.reset',
      old_value: null,
      new_value: 'device_keys=0 sessions=0',
      actor: 'operator-cli',
    })
  })
})

describe('securityReset -- happy path', () => {
  it('revokes one device key and one session and returns their counts', () => {
    const u = createDashboardUser('op', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const key = createDeviceKey('phone')
    const cookie = createSession({ userId: u.id, username: u.username })
    // Pre-conditions: both are resolving.
    expect(resolveDeviceKey(key.key)).not.toBeNull()
    expect(resolveSession(cookie)).not.toBeNull()

    const r = securityReset('dashboard:cli')
    expect(r).toEqual({ deviceKeysRevoked: 1, sessionsCleared: 1 })

    // Post-conditions: both stop resolving, list is empty.
    expect(resolveDeviceKey(key.key)).toBeNull()
    expect(resolveSession(cookie)).toBeNull()
    expect(listDeviceKeys()).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM auth_sessions').get()).toEqual({ c: 0 })
  })

  it('revokes many device keys and many sessions and returns the sums', () => {
    const u = createDashboardUser('busy', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const keys = [createDeviceKey('a'), createDeviceKey('b'), createDeviceKey('c')]
    const cookies = [
      createSession({ userId: u.id, username: u.username }),
      createSession({ userId: u.id, username: u.username }),
    ]
    expect(keys).toHaveLength(3)
    expect(cookies).toHaveLength(2)

    const r = securityReset('audit-bot')
    expect(r).toEqual({ deviceKeysRevoked: 3, sessionsCleared: 2 })
    for (const k of keys) expect(resolveDeviceKey(k.key)).toBeNull()
    for (const c of cookies) expect(resolveSession(c)).toBeNull()
  })

  it('touches dashboard_users only via `users are NOT touched`: the user row and its password hash survive', () => {
    createDashboardUser('survivor', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const beforeRow = getDb()
      .prepare('SELECT username, password_hash, disabled FROM dashboard_users WHERE username = ?')
      .get('survivor') as { username: string; password_hash: string; disabled: number }
    expect(beforeRow).toBeDefined()

    securityReset('break-glass')

    const afterRow = getDb()
      .prepare('SELECT username, password_hash, disabled FROM dashboard_users WHERE username = ?')
      .get('survivor') as { username: string; password_hash: string; disabled: number }
    expect(afterRow).toEqual(beforeRow)
    expect(afterRow.password_hash).toBe('$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    expect(afterRow.disabled).toBe(0)
  })
})

describe('securityReset -- audit row contents', () => {
  it('records the actor verbatim, old_value as NULL, and new_value as the counts line', () => {
    const u = createDashboardUser('audit-user', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    createDeviceKey('k1')
    createDeviceKey('k2')
    createSession({ userId: u.id, username: u.username })

    securityReset('token-rotation-job')

    const row = getDb()
      .prepare('SELECT key, old_value, new_value, actor FROM config_change_log WHERE key = ?')
      .get('security.reset') as { key: string; old_value: string | null; new_value: string | null; actor: string }
    expect(row.key).toBe('security.reset')
    expect(row.old_value).toBeNull()
    expect(row.new_value).toBe('device_keys=2 sessions=1')
    expect(row.actor).toBe('token-rotation-job')
  })

  it('a second call writes a SECOND audit row (no dedup -- every reset is its own audit entry)', () => {
    securityReset('actor-A')
    securityReset('actor-B')
    const rows = getDb()
      .prepare("SELECT actor FROM config_change_log WHERE key = 'security.reset' ORDER BY id ASC")
      .all() as Array<{ actor: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]!.actor).toBe('actor-A')
    expect(rows[1]!.actor).toBe('actor-B')
  })

  it('the audit key is exactly "security.reset" (the break-glass enum value, no other keys appear)', () => {
    securityReset('op')
    const keys = (getDb()
      .prepare('SELECT DISTINCT key FROM config_change_log')
      .all() as Array<{ key: string }>).map((r) => r.key)
    expect(keys).toEqual(['security.reset'])
  })
})

describe('SecurityResetResult interface', () => {
  it('the returned object has exactly the two documented numeric fields', () => {
    const r = securityReset('shape-test')
    // Anchor the interface via a typed reference so a future field rename is
    // a compile error rather than a silent shape drift.
    const typed: { deviceKeysRevoked: number; sessionsCleared: number } = r
    expect(Object.keys(typed).sort()).toEqual(['deviceKeysRevoked', 'sessionsCleared'])
    expect(typeof typed.deviceKeysRevoked).toBe('number')
    expect(typeof typed.sessionsCleared).toBe('number')
    expect(typed.deviceKeysRevoked).toBeGreaterThanOrEqual(0)
    expect(typed.sessionsCleared).toBeGreaterThanOrEqual(0)
  })
})
