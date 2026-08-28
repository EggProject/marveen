import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createDashboardUser, getDb } from '../db.js'
import {
  resolveAuth,
  requiresAuth,
  parseCookies,
  isFederationWireEndpoint,
  SESSION_COOKIE_NAME,
} from '../web/auth-gate.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { createDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
} from '../web/federation/config.js'

// CRITICAL FLEET-REGRESSION SUITE.
//
// The whole fleet's curl calls depend on the bearer lane staying byte-identical
// after the inline web.ts gate was extracted into resolveAuth. These tests lock
// that contract: bearer accepted with users present AND absent, the SSE ?token=
// path, federation endpoint-scoping, and the /api/auth/status shape.

const TOKEN = 'a'.repeat(64)

// Minimal IncomingMessage stand-in: the gate only reads .headers.
function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

function mkUrl(path: string, query = ''): URL {
  return new URL(`http://127.0.0.1:3420${path}${query}`)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
})

afterAll(() => {
  _clearDeviceKeyCacheForTest()
})

describe('requiresAuth (gated-path predicate)', () => {
  it('leaves the public probes ungated', () => {
    expect(requiresAuth('/api/auth/status', 'GET')).toBe(false)
    expect(requiresAuth('/api/auth/login', 'POST')).toBe(false)
    expect(requiresAuth('/api/marveen/avatar', 'GET')).toBe(false)
    expect(requiresAuth('/api/agents/zara/avatar', 'GET')).toBe(false)
  })
  it('gates every other /api/* path and the fleet manifest', () => {
    expect(requiresAuth('/api/memories', 'GET')).toBe(true)
    expect(requiresAuth('/api/memories', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/users', 'POST')).toBe(true)
    expect(requiresAuth('/.well-known/fleetq', 'GET')).toBe(true)
  })
  it('does not gate non-api static paths', () => {
    expect(requiresAuth('/', 'GET')).toBe(false)
    expect(requiresAuth('/app.js', 'GET')).toBe(false)
  })
})

describe('bearer lane (byte-identical, users absent AND present)', () => {
  it('accepts a valid bearer with ZERO users configured', () => {
    // fresh in-memory DB: no dashboard_users rows
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })

  it('accepts the SAME valid bearer once a user EXISTS (no behavior drift)', () => {
    createDashboardUser('operator', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })

  it('rejects a wrong bearer with no cookie -> none (401 upstream)', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer wrong' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })

  it('rejects a missing Authorization header -> none', () => {
    const r = resolveAuth(mkReq(), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('SSE pane-stream ?token= lane', () => {
  const path = '/api/agents/zara/pane/stream'
  it('accepts the token via query on the SSE path', () => {
    const r = resolveAuth(mkReq(), mkUrl(path, `?token=${TOKEN}`), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
  it('rejects a wrong token via query', () => {
    const r = resolveAuth(mkReq(), mkUrl(path, '?token=nope'), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('does NOT honor ?token= on a non-SSE path', () => {
    const r = resolveAuth(mkReq(), mkUrl('/api/memories', `?token=${TOKEN}`), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('accepts a session cookie on the SSE path (cookie-only EventSource)', () => {
    const u = createDashboardUser('sse-user', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` }), mkUrl(path), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'session', user: 'sse-user' })
  })
})

describe('session cookie lane', () => {
  it('resolves a valid session cookie to its user', () => {
    const u = createDashboardUser('alice', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'session', user: 'alice' })
  })

  it('bearer takes precedence over a present session cookie', () => {
    const u = createDashboardUser('bob', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${TOKEN}`, cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'token' })
  })

  it('rejects an unknown/garbage cookie value -> none', () => {
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=deadbeef` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('federation endpoint scoping is preserved', () => {
  // Federation is disabled by default (no store/federation.json), so
  // identifyFederationCaller returns null: a fed token can never authenticate.
  it('does not authenticate an arbitrary token on the manifest endpoint', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer some-peer-token' }), mkUrl('/api/federation/manifest'), '/api/federation/manifest', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('still accepts the dashboard bearer on a federation endpoint', () => {
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/federation/inbox'), '/api/federation/inbox', 'POST', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
  it('federation scoping does not leak onto a non-federation path', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer some-peer-token' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('parseCookies', () => {
  it('parses multiple pairs and trims whitespace', () => {
    expect(parseCookies('a=1; b=2;  c=3')).toEqual({ a: '1', b: '2', c: '3' })
  })
  it('returns empty for no header', () => {
    expect(parseCookies(undefined)).toEqual({})
  })
  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookies('mv_session=first; mv_session=second')).toEqual({ mv_session: 'first' })
  })
  it('skips malformed pairs with no equals sign', () => {
    // "foo" has no '=' so it is dropped, but the well-formed pairs survive.
    expect(parseCookies('foo; a=1; bar')).toEqual({ a: '1' })
  })
  it('skips pairs whose name is empty after trim', () => {
    // "=value" produces name="" so the pair is dropped, "=2; b=3" also drops.
    expect(parseCookies('=v; b=3')).toEqual({ b: '3' })
  })
  it('handles a leading/only semicolon gracefully', () => {
    expect(parseCookies(';a=1')).toEqual({ a: '1' })
  })
})

describe('isFederationWireEndpoint', () => {
  it('matches GET /api/federation/manifest', () => {
    expect(isFederationWireEndpoint('/api/federation/manifest', 'GET')).toBe(true)
  })
  it('matches POST /api/federation/inbox', () => {
    expect(isFederationWireEndpoint('/api/federation/inbox', 'POST')).toBe(true)
  })
  it('does not match POST on /api/federation/manifest', () => {
    expect(isFederationWireEndpoint('/api/federation/manifest', 'POST')).toBe(false)
  })
  it('does not match GET on /api/federation/inbox', () => {
    expect(isFederationWireEndpoint('/api/federation/inbox', 'GET')).toBe(false)
  })
  it('does not match unrelated federation-prefixed paths', () => {
    expect(isFederationWireEndpoint('/api/federation/capabilities', 'GET')).toBe(false)
    expect(isFederationWireEndpoint('/api/federation/manifest', 'PUT')).toBe(false)
  })
})

describe('device-key lanes (Bearer + SSE ?token=)', () => {
  it('a device key authenticates as { kind: device } on the Bearer lane', () => {
    const minted = createDeviceKey('phone')
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${minted.key}` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'device', device: 'phone', deviceId: minted.id })
  })
  it('a device key authenticates on the SSE pane-stream ?token= lane', () => {
    const minted = createDeviceKey('phone')
    const path = '/api/agents/zara/pane/stream'
    const r = resolveAuth(mkReq(), mkUrl(path, `?token=${minted.key}`), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'device', device: 'phone', deviceId: minted.id })
  })
})

describe('federation auth path (peer recognized, endpoint-scoped)', () => {
  const FED_DIR = mkdtempSync(join(tmpdir(), 'auth-gate-fed-'))
  const PEER_TOKEN = 'f'.repeat(64)

  beforeEach(() => {
    _setFederationStoreDirForTest(FED_DIR)
    writeFileSync(
      join(FED_DIR, 'federation.json'),
      JSON.stringify({
        enabled: true,
        systemId: 'tester',
        peers: [
          { id: 'remote-1', baseUrl: 'https://peer.example.ts.net', inboundToken: PEER_TOKEN, outboundToken: 'e'.repeat(64), trust: 'untrusted' },
        ],
      }),
    )
    reloadFederationForTest()
  })

  afterAll(() => {
    rmSync(FED_DIR, { recursive: true, force: true })
  })

  it('a valid peer token authenticates as { kind: federation } on the manifest endpoint', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${PEER_TOKEN}` }),
      mkUrl('/api/federation/manifest'),
      '/api/federation/manifest',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'federation', peer: 'remote-1' })
  })
  it('a valid peer token authenticates as { kind: federation } on the inbox endpoint', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${PEER_TOKEN}` }),
      mkUrl('/api/federation/inbox'),
      '/api/federation/inbox',
      'POST',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'federation', peer: 'remote-1' })
  })
  it('does NOT authenticate a peer token on a non-federation path (still endpoint-scoped)', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${PEER_TOKEN}` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'none' })
  })
})
