// Coverage suite for src/web/routes/profiles.ts.
//
// The route handler is the dispatcher wrapper for /api/profiles -- a
// read-only GET that maps `listProfileTemplates()` to a trimmed JSON payload
// and otherwise returns false so the rest of the router chain can try.
//
// Branches to cover (per the route source):
//   1. `path === '/api/profiles' && method === 'GET'` -- the true arm. Must
//      write a JSON body and return true.
//   2. `path === '/api/profiles' && method !== 'GET'` -- the inner false arm
//      of the `&&`. Returns false without touching the response.
//   3. `path !== '/api/profiles'` -- the outer false arm. Returns false
//      without touching the response.
//
// The route imports two modules: '../http-helpers.js' (the `json` writer)
// and '../profiles.js' (`listProfileTemplates`). We mock the latter so the
// payload is deterministic and we are not coupled to the on-disk fixture
// files under templates/profiles/. The `json` helper is so trivial
// (writeHead + end) that mocking it would be over-engineering -- we assert
// on a real ServerResponse-shaped stand-in instead.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Mock the upstream profile registry. Each test resets this so we exercise
// the route's mapping logic against controlled data.
vi.mock('../web/profiles.js', () => ({
  listProfileTemplates: vi.fn(),
}))

const { listProfileTemplates } = await import('../web/profiles.js')
const { tryHandleProfiles } = await import('../web/routes/profiles.js')

function mkRes() {
  const res: {
    statusCode: number
    headers: Record<string, string | string[]>
    body: string
    writeHead: any
    end: any
  } = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data?: string) {
      if (data !== undefined) this.body += data
    },
  }
  return res as unknown as http.ServerResponse & {
    statusCode: number
    headers: Record<string, string | string[]>
    body: string
  }
}

function mkCtx(path: string, method: string): RouteContext {
  const res = mkRes()
  const req = { headers: {} } as unknown as http.IncomingMessage
  return {
    req,
    res,
    path,
    method,
    url: new URL(`http://localhost:3420${path}`),
    fedPeer: null,
  }
}

async function call(path: string, method: string): Promise<{
  handled: boolean
  res: ReturnType<typeof mkRes>
  body: any
}> {
  const ctx = mkCtx(path, method)
  const handled = await tryHandleProfiles(ctx)
  return {
    handled,
    res: ctx.res as any,
    body: ((ctx.res as unknown as { body?: string }).body ? JSON.parse((ctx.res as unknown as { body?: string }).body as string) : null),
  }
}

beforeEach(() => {
  vi.mocked(listProfileTemplates).mockReset()
})

describe('tryHandleProfiles -- non-matching inputs', () => {
  it('returns false for a completely unrelated path', async () => {
    const r = await call('/api/other', 'GET')
    expect(r.handled).toBe(false)
    expect(r.res.statusCode).toBe(0)
    expect(r.res.body).toBe('')
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })

  it('returns false for /api/profiles with a non-GET method (POST)', async () => {
    const r = await call('/api/profiles', 'POST')
    expect(r.handled).toBe(false)
    expect(r.res.statusCode).toBe(0)
    expect(r.res.body).toBe('')
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })

  it('returns false for /api/profiles with PUT', async () => {
    const r = await call('/api/profiles', 'PUT')
    expect(r.handled).toBe(false)
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })

  it('returns false for /api/profiles with DELETE', async () => {
    const r = await call('/api/profiles', 'DELETE')
    expect(r.handled).toBe(false)
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })

  it('returns false when the path has a trailing slash', async () => {
    // The comparison is strict equality -- the dispatcher will fall through.
    const r = await call('/api/profiles/', 'GET')
    expect(r.handled).toBe(false)
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })

  it('returns false for a path that only contains /api/profiles as a suffix', async () => {
    const r = await call('/v1/api/profiles', 'GET')
    expect(r.handled).toBe(false)
    expect(vi.mocked(listProfileTemplates)).not.toHaveBeenCalled()
  })
})

describe('tryHandleProfiles -- GET /api/profiles', () => {
  it('returns true and writes 200 OK with an empty list when no profiles are registered', async () => {
    vi.mocked(listProfileTemplates).mockReturnValue([])

    const r = await call('/api/profiles', 'GET')

    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(r.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(r.res.headers['Cache-Control']).toBe('private, no-store')
    expect(r.body).toEqual([])
    expect(vi.mocked(listProfileTemplates)).toHaveBeenCalledTimes(1)
  })

  it('maps every profile to a trimmed {id,label,description,permissionMode,allowCount,denyCount} shape', async () => {
    vi.mocked(listProfileTemplates).mockReturnValue([
      {
        id: 'developer-senior',
        label: 'Senior dev',
        description: 'Read + Bash; allowlist-tight.',
        permissionMode: 'strict',
        filesystem: { allow: ['Read(/repo/**)'], deny: ['Bash(sudo:*)', 'Write(/etc/**)'] },
      },
      {
        id: 'marketer',
        label: 'Marketer',
        description: 'Network only.',
        permissionMode: 'permissive',
        filesystem: { allow: [], deny: [] },
      },
    ])

    const r = await call('/api/profiles', 'GET')

    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(r.body).toEqual([
      {
        id: 'developer-senior',
        label: 'Senior dev',
        description: 'Read + Bash; allowlist-tight.',
        permissionMode: 'strict',
        allowCount: 1,
        denyCount: 2,
      },
      {
        id: 'marketer',
        label: 'Marketer',
        description: 'Network only.',
        permissionMode: 'permissive',
        allowCount: 0,
        denyCount: 0,
      },
    ])
  })

  it('strips the filesystem array contents and only exposes the counts (no allow/deny strings leak)', async () => {
    // Defensive: the route must not echo the allow/deny strings -- that
    // would let the dashboard render the full list. Only the count survives.
    vi.mocked(listProfileTemplates).mockReturnValue([
      {
        id: 'p',
        label: 'L',
        description: 'D',
        permissionMode: 'strict',
        filesystem: { allow: ['SECRET-ALLOW'], deny: ['SECRET-DENY'] },
      },
    ])

    const r = await call('/api/profiles', 'GET')

    const [entry] = r.body
    expect(entry).not.toHaveProperty('filesystem')
    expect(entry).not.toHaveProperty('allow')
    expect(entry).not.toHaveProperty('deny')
    expect(JSON.stringify(r.body)).not.toContain('SECRET-ALLOW')
    expect(JSON.stringify(r.body)).not.toContain('SECRET-DENY')
    expect(entry.allowCount).toBe(1)
    expect(entry.denyCount).toBe(1)
  })

  it('passes the raw return value of listProfileTemplates through (ordering preserved)', async () => {
    const fixtures = [
      { id: 'a', label: 'A', description: 'a', permissionMode: 'permissive' as const, filesystem: { allow: [], deny: [] } },
      { id: 'b', label: 'B', description: 'b', permissionMode: 'strict' as const, filesystem: { allow: ['x'], deny: [] } },
      { id: 'c', label: 'C', description: 'c', permissionMode: 'permissive' as const, filesystem: { allow: [], deny: ['y', 'z'] } },
    ]
    vi.mocked(listProfileTemplates).mockReturnValue(fixtures)

    const r = await call('/api/profiles', 'GET')

    expect(r.body.map((p: any) => p.id)).toEqual(['a', 'b', 'c'])
    expect(r.body[1].allowCount).toBe(1)
    expect(r.body[2].denyCount).toBe(2)
  })

  it('invokes listProfileTemplates exactly once per request', async () => {
    vi.mocked(listProfileTemplates).mockReturnValue([])

    await call('/api/profiles', 'GET')
    await call('/api/profiles', 'GET')

    expect(vi.mocked(listProfileTemplates)).toHaveBeenCalledTimes(2)
  })
})
