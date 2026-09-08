// Unified auth resolution for the dashboard HTTP gate.
//
// The factory form centralises the dashboard token without imposing class
// ceremony. The module-level singleton (defaultGate) is constructed eagerly
// at module init; the free functions below survive as thin wrappers so the
// 6 existing importers (src/web.ts + 5 test files) keep their call sites
// byte-equivalent.
//
// Precedence (first match wins):
//   1. Authorization: Bearer <dashboard token>   -> { kind: 'token' }
//   2. Authorization: Bearer <device key>        -> { kind: 'device', device, deviceId }
//   3. SSE pane-stream ?token=<dashboard token>   -> { kind: 'token' }  (path-scoped)
//   4. SSE pane-stream ?token=<device key>        -> { kind: 'device' } (path-scoped)
//   5. Federation inbound token, endpoint-scoped  -> { kind: 'federation', peer }
//   6. mv_session cookie                          -> { kind: 'session', user }
//   7. none of the above                          -> { kind: 'none' }

import type http from 'node:http'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey } from './auth-device-keys.js'
import type { RouteContext } from './routes/types.js'
import { loadOrCreateDashboardToken } from './dashboard-auth.js'

export type AuthResult =
  | { kind: 'token' }
  | { kind: 'device'; device: string; deviceId: number }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'none' }

export const SESSION_COOKIE_NAME = 'mv_session'

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    if (out[name] === undefined) out[name] = value
  }
  return out
}

export interface AuthGateDeps {
  readonly dashboardToken: string
}

export interface AuthGate {
  readonly requiresAuth: (path: string, method: string) => boolean
  readonly isFederationWireEndpoint: (path: string, method: string) => boolean
  readonly resolveAuth: (req: http.IncomingMessage, url: URL, path: string, method: string) => AuthResult
  readonly getRouteContextAuth: (auth: AuthResult) => RouteContext['auth']
}

export function createAuthGate(deps: AuthGateDeps): AuthGate {
  const requiresAuth = (path: string, method: string): boolean => {
    if (path === '/api/auth/status' && method === 'GET') return false
    if (path === '/api/auth/login' && method === 'POST') return false
    if (method === 'GET' && (path === '/api/marveen/avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
    if (path === '/.well-known/fleetq' && method === 'GET') return true
    return path.startsWith('/api/')
  }

  const isFederationWireEndpoint = (path: string, method: string): boolean => {
    return (
      (path === '/api/federation/manifest' && method === 'GET') ||
      (path === '/api/federation/inbox' && method === 'POST')
    )
  }

  const isSsePaneStream = (path: string, method: string): boolean => {
    return method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
  }

  const resolveAuth = (
    req: http.IncomingMessage,
    url: URL,
    path: string,
    method: string,
  ): AuthResult => {
    const { dashboardToken } = deps

    if (checkBearerToken(req.headers.authorization, dashboardToken)) return { kind: 'token' }

    const bearerMatch = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
    if (bearerMatch) {
      const dk = resolveDeviceKey(bearerMatch[1]!.trim())
      if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
    }

    if (isSsePaneStream(path, method)) {
      const qtoken = url.searchParams.get('token') ?? ''
      if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
      const dk = resolveDeviceKey(qtoken)
      if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
    }

    if (isFederationWireEndpoint(path, method)) {
      const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
      if (peer !== null) return { kind: 'federation', peer }
    }

    const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (cookieValue) {
      const session = resolveSession(cookieValue)
      if (session) return { kind: 'session', user: session.username }
    }

    return { kind: 'none' }
  }

  const getRouteContextAuth = (auth: AuthResult): RouteContext['auth'] => {
    switch (auth.kind) {
      case 'token': return { kind: 'token' }
      case 'device': return { kind: 'device', device: auth.device }
      case 'session': return { kind: 'session', user: auth.user }
      case 'federation': return { kind: 'federation', peer: auth.peer }
      case 'none': return undefined
    }
  }

  return { requiresAuth, isFederationWireEndpoint, resolveAuth, getRouteContextAuth }
}

export const defaultGate: AuthGate = createAuthGate({
  dashboardToken: loadOrCreateDashboardToken(),
})

// Backward-compat shim: the 5 test files imported the pre-factory signature
// with `dashboardToken` as a positional argument. The factory centralises the
// token in the `defaultGate` singleton, so the parameter is ignored here.
// Remove this shim once the callers migrate to `createAuthGate` or `defaultGate`.
export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _dashboardToken: string,
): AuthResult {
  return defaultGate.resolveAuth(req, url, path, method)
}

export function requiresAuth(path: string, method: string): boolean {
  return defaultGate.requiresAuth(path, method)
}

export function isFederationWireEndpoint(path: string, method: string): boolean {
  return defaultGate.isFederationWireEndpoint(path, method)
}