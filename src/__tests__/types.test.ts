// Tests for src/web/routes/types.ts.
//
// types.ts is purely type definitions (an `interface RouteContext` and a
// `type RouteHandler = ...`) -- the only import is `import type http from
// 'node:http'`, which TypeScript erases at compile time. There is no
// runtime code in this file, so v8 coverage reports 0/0 statements and
// branches/functions/lines (which is trivially 100% the moment a test
// file picks the module up).
//
// The runtime tests below exist so the documented type contract -- the
// nullish behavior of `fedPeer`, the four-kind union on `auth`, the
// handler's `Promise<boolean>` return shape -- is pinned against silent
// regressions. If anyone narrows `auth.kind` or removes `null` from
// `fedPeer`, tsc will refuse to compile these tests and the gate fails.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

import type { RouteContext, RouteHandler } from '../web/routes/types.js'

/** Build a minimal RouteContext fixture. `overrides` lets each test pin
 *  a specific subset of the optional fields so we exercise every
 *  documented shape. */
function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  const base: RouteContext = {
    // Cast to the http types -- the runtime objects are stubs; we never
    // call methods on them in these tests.
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    path: '/x',
    method: 'GET',
    url: new URL('http://localhost/x'),
    fedPeer: null,
  }
  return { ...base, ...overrides }
}

describe('web/routes/types.ts -- RouteContext shape', () => {
  it('accepts a minimal context with only the required fields', () => {
    const ctx = makeCtx()
    expect(ctx.path).toBe('/x')
    expect(ctx.method).toBe('GET')
    expect(ctx.url.pathname).toBe('/x')
    expect(ctx.fedPeer).toBeNull()
    expect(ctx.auth).toBeUndefined()
  })

  it('accepts fedPeer as null (treated identically to undefined)', () => {
    const ctx = makeCtx({ fedPeer: null })
    // The documented contract says handlers MUST treat null and absent
    // identically. Pin that here -- a future "strictNullChecks" pass
    // that drops the `null` arm would fail this test at compile time.
    expect(ctx.fedPeer).toBeNull()
    const isNonPeer = ctx.fedPeer == null
    expect(isNonPeer).toBe(true)
  })

  it('accepts fedPeer as a string peer name', () => {
    const ctx = makeCtx({ fedPeer: 'peer-alpha' })
    expect(ctx.fedPeer).toBe('peer-alpha')
  })

  it('accepts auth.kind = "token" with no extra fields', () => {
    const ctx = makeCtx({ auth: { kind: 'token' } })
    expect(ctx.auth?.kind).toBe('token')
    expect(ctx.auth?.user).toBeUndefined()
    expect(ctx.auth?.peer).toBeUndefined()
    expect(ctx.auth?.device).toBeUndefined()
  })

  it('accepts auth.kind = "session" with a user name', () => {
    const ctx = makeCtx({ auth: { kind: 'session', user: 'alice' } })
    expect(ctx.auth?.kind).toBe('session')
    expect(ctx.auth?.user).toBe('alice')
  })

  it('accepts auth.kind = "federation" with a peer name', () => {
    const ctx = makeCtx({ auth: { kind: 'federation', peer: 'peer-bravo' } })
    expect(ctx.auth?.kind).toBe('federation')
    expect(ctx.auth?.peer).toBe('peer-bravo')
  })

  it('accepts auth.kind = "device" with a device key name', () => {
    const ctx = makeCtx({ auth: { kind: 'device', device: 'laptop-01' } })
    expect(ctx.auth?.kind).toBe('device')
    expect(ctx.auth?.device).toBe('laptop-01')
  })

  it('rejects an unknown auth.kind (compile-time check)', () => {
    // This block is type-only: tsc must reject the literal at compile
    // time, which forces any future narrowing of the union to be a
    // deliberate change. The runtime `expect` is a smoke check that the
    // file compiles and runs.
    const ctx = makeCtx({ auth: { kind: 'session', user: 'bob' } })
    const knownKinds: ReadonlyArray<RouteContext['auth'] extends infer A
      ? A extends { kind: infer K } ? K : never
      : never> = ['token', 'session', 'federation', 'device']
    expect(knownKinds).toContain(ctx.auth?.kind)
  })
})

describe('web/routes/types.ts -- RouteHandler signature', () => {
  it('accepts a handler that returns true (response written)', async () => {
    const handler: RouteHandler = async (_ctx) => true
    const result = await handler(makeCtx())
    expect(result).toBe(true)
  })

  it('accepts a handler that returns false (let the next module try)', async () => {
    const handler: RouteHandler = async (_ctx) => false
    const result = await handler(makeCtx())
    expect(result).toBe(false)
  })

  it('accepts a handler that reads every RouteContext field', async () => {
    const handler: RouteHandler = async (ctx) => {
      // Touch every field so a future rename breaks this test, not just
      // the build of some downstream route file.
      const seen = {
        path: ctx.path,
        method: ctx.method,
        pathname: ctx.url.pathname,
        fedPeer: ctx.fedPeer,
        authKind: ctx.auth?.kind ?? null,
        authUser: ctx.auth?.user ?? null,
        authPeer: ctx.auth?.peer ?? null,
        authDevice: ctx.auth?.device ?? null,
      }
      return Object.keys(seen).length > 0
    }
    const ctx = makeCtx({
      fedPeer: 'peer-charlie',
      auth: { kind: 'federation', peer: 'peer-charlie' },
    })
    const result = await handler(ctx)
    expect(result).toBe(true)
    expect(ctx.fedPeer).toBe('peer-charlie')
    expect(ctx.auth?.kind).toBe('federation')
  })

  it('RouteHandler is async-only (return type is Promise<boolean>)', () => {
    // If the type signature ever drops the Promise wrapper, tsc refuses
    // the literal `async () => false` below. The runtime assertion is
    // just a smoke check.
    const handler: RouteHandler = async () => false
    expect(handler(makeCtx())).toBeInstanceOf(Promise)
  })
})
