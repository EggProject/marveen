// 100% coverage suite for src/web/routes/static.ts.
//
// tryHandleStatic is the dashboard server's static-asset dispatcher: SPA
// shell, versioned JS/CSS, branded PWA manifest, service worker, language
// packs, and avatar/icon files. Every branch is filesystem-driven (etag
// computation, asset-version probes, avatar existence), so the suite runs
// against a tmpdir-scoped webDir + a mocked PROJECT_ROOT/BRAND_NAME so the
// live checkout stays untouched. No db/logger/auth collaborators are imported
// by this module, so per the "pure routes" rule none of those mocks are added.
//
// Coverage targets:
//   - buildManifest: byte-preserving default-brand case, custom brand,
//     manifest missing the `name` or `short_name` keys, neither key present,
//     JSON-escapable special chars in the brand name.
//   - assetVersion: success path (served via tryHandleStatic /), 0-fallback
//     when app.js / style.css are missing from webDir.
//   - serveIndexHtml: 200 with versioned script/link tags + branded
//     apple-mobile-web-app-title; 200 with mismatched if-none-match; 304
//     when if-none-match equals etag; 404 when index.html is absent.
//   - escapeAttr: & " < > all replaced (exercised through the brand-name
//     rewrite when BRAND_NAME contains special chars).
//   - detectAvatarType: no avatar (null branch), png/jpg/jpeg/webp avatar
//     probe order.
//   - tryHandleStatic: /style.css, /app.js, /sw.js, /lang/{hu,en}.js allowlist
//     hit, /lang/foo.js allowlist miss, /avatars/<exists> hit, /avatars/<missing>
//     miss, /icons/<exists> hit, /icons/<missing> miss, manifest catch-block
//     fallback when manifest.json is unreadable, unknown path returns false.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'static-routes-'))
  const project = path.join(sandbox, 'project')
  const store = path.join(project, 'store')
  const web = path.join(sandbox, 'web')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(store, { recursive: true })
  fs.mkdirSync(web, { recursive: true })
  return {
    sandbox,
    project,
    store,
    web,
    brand: 'Marveen' as string,
  }
})

const PROJECT = H.project
const STORE = H.store
const WEB = H.web

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      BRAND_NAME: { get: () => H.brand, enumerable: true },
    },
  )
})

// Import AFTER every mock is registered.
const { tryHandleStatic, buildManifest } = await import('../web/routes/static.js')

// --- fixtures ---------------------------------------------------------------

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Dashboard</title>
<link rel="stylesheet" href="/style.css">
<meta name="apple-mobile-web-app-title" content="Marveen">
<script src="/app.js"></script>
</head>
<body></body>
</html>
`

const MANIFEST = `{
  "name": "Marveen Dashboard",
  "short_name": "Marveen",
  "start_url": "/",
  "display": "standalone",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" }
  ]
}
`

function seedWebDir(): void {
  rmSync(WEB, { recursive: true, force: true })
  mkdirSync(WEB, { recursive: true })
  mkdirSync(join(WEB, 'lang'), { recursive: true })
  mkdirSync(join(WEB, 'avatars'), { recursive: true })
  mkdirSync(join(WEB, 'icons'), { recursive: true })
  writeFileSync(join(WEB, 'index.html'), INDEX_HTML)
  writeFileSync(join(WEB, 'app.js'), 'console.log("app")')
  writeFileSync(join(WEB, 'style.css'), 'body { color: red; }')
  writeFileSync(join(WEB, 'manifest.json'), MANIFEST)
  writeFileSync(join(WEB, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(WEB, 'lang', 'hu.js'), 'window._i18n = window._i18n || {}; window._i18n.hu = {}')
  writeFileSync(join(WEB, 'lang', 'en.js'), 'window._i18n = window._i18n || {}; window._i18n.en = {}')
  writeFileSync(join(WEB, 'avatars', 'present.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(WEB, 'icons', 'present.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
}

function rmStore(): void {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
}

// --- HTTP harness -----------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string | Buffer): MockRes
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
        }
      }
      return this
    },
    end(data) {
      if (data !== undefined) this.body += Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
      return this
    },
  } as MockRes
}

interface FakeCall {
  ctx: import('../web/routes/types.js').RouteContext
  res: MockRes
}

function call(path: string, opts: { headers?: Record<string, string> } = {}): FakeCall {
  const res = mkRes()
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req: { headers: opts.headers ?? {} } as unknown as import('node:http').IncomingMessage,
    res: res as unknown as import('node:http').ServerResponse,
    path: url.pathname,
    method: 'GET',
    url,
  } as import('../web/routes/types.js').RouteContext
  return { ctx, res }
}

// --- lifecycle --------------------------------------------------------------

beforeAll(() => {
  // brand/seeded webdir is set up per test; nothing global required.
})

beforeEach(() => {
  rmStore()
  seedWebDir()
})

afterEach(() => {
  H.brand = 'Marveen'
})

afterAll(() => {
  rmSync(H.sandbox, { recursive: true, force: true })
})

// =========================================================================
// buildManifest
// =========================================================================

describe('buildManifest', () => {
  it('preserves the shipped manifest byte-for-byte when the brand matches', () => {
    const raw = MANIFEST
    const out = buildManifest(raw, 'Marveen')
    // JSON.stringify('Marveen Dashboard') === '"Marveen Dashboard"' and the
    // shipped manifest already contains exactly that, so the rewrite is a
    // no-op aside from whitespace that the replace preserves via the captured
    // prefix group.
    expect(out).toBe(raw)
  })

  it('rewrites name and short_name when the brand differs from the shipped default', () => {
    const out = buildManifest(MANIFEST, 'Acme')
    expect(out).toContain('"name": "Acme Dashboard"')
    expect(out).toContain('"short_name": "Acme"')
    // The shipped name/short_name values must be gone.
    expect(out).not.toContain('Marveen Dashboard')
    expect(out).not.toContain('"short_name": "Marveen"')
  })

  it('only replaces the `short_name` value when the manifest has no `name` key', () => {
    const raw = `{\n  "short_name": "OldName",\n  "start_url": "/"\n}\n`
    const out = buildManifest(raw, 'Acme')
    expect(out).toContain('"short_name": "Acme"')
    expect(out).not.toContain('OldName')
    // No `name` key was introduced.
    expect(out).not.toContain('"name"')
  })

  it('only replaces the `name` value when the manifest has no `short_name` key', () => {
    const raw = `{\n  "name": "OldName",\n  "start_url": "/"\n}\n`
    const out = buildManifest(raw, 'Acme')
    expect(out).toContain('"name": "Acme Dashboard"')
    expect(out).not.toContain('OldName')
    expect(out).not.toContain('"short_name"')
  })

  it('returns the manifest untouched when neither key is present', () => {
    const raw = `{\n  "start_url": "/",\n  "display": "standalone"\n}\n`
    const out = buildManifest(raw, 'Acme')
    expect(out).toBe(raw)
  })

  it('JSON-escapes quotes/backslashes in the brand name without breaking the manifest', () => {
    // JSON.stringify wraps the brand in double quotes and escapes inner
    // double quotes + backslashes so the result is still parseable JSON.
    const out = buildManifest(MANIFEST, 'A"B\\C')
    // Name should become `A\"B\\C Dashboard` (the captured `name` prefix is
    // preserved as-is; the brand value is the JSON-stringified form).
    expect(out).toContain('A\\"B\\\\C Dashboard')
    expect(out).toContain('"short_name": "A\\"B\\\\C"')
    // Result must round-trip through JSON.parse -- proves the brand was
    // escaped, not raw-injected.
    const parsed = JSON.parse(out) as { name: string; short_name: string }
    expect(parsed.name).toBe('A"B\\C Dashboard')
    expect(parsed.short_name).toBe('A"B\\C')
  })

  it('does not match `name` against `short_name` (key-anchored regex)', () => {
    // The `name` regex is anchored on the literal `"name"` key (not a
    // prefix), so a `short_name` line must NOT be consumed as a `name`
    // rewrite. With only `short_name` present, the `name` replace is a
    // no-op; the assertion is that no fabricated `name` key appears.
    const raw = `{\n  "short_name": "OldShort",\n  "start_url": "/"\n}\n`
    const out = buildManifest(raw, 'Acme')
    expect(out).toContain('"short_name": "Acme"')
    expect(out).not.toContain('"name"')
    expect(out).not.toContain('OldShort')
  })
})

// =========================================================================
// tryHandleStatic: SPA shell + version rewriting
// =========================================================================

describe('tryHandleStatic "/" and "/index.html"', () => {
  it('serves index.html with versioned /app.js and /style.css URLs', async () => {
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('no-cache')
    // The shipped HTML uses relative-looking absolute paths (`/app.js`,
    // `/style.css`); the version rewrite must produce `?v=<token>` query
    // strings for both. The token comes from assetVersion() and is a
    // base-36 mtime/size pair joined with a dash; we just assert the
    // query param is present and non-empty rather than pinning the exact
    // encoding.
    expect(res.body).toMatch(/\/app\.js\?v=[A-Za-z0-9_-]+/)
    expect(res.body).toMatch(/\/style\.css\?v=[A-Za-z0-9_-]+/)
    // ETag header echoes back the same token(s) so conditional GETs work.
    expect(res.headers['ETag']).toBeTruthy()
    // ETag shape: "<mtimeMs>-<size>-<app.js version>-<style.css version>".
    // mtimeMs is a fractional ms (so it may include a `.`), and each
    // asset-version token is two base-36 numbers joined by `-`, where the
    // fractional-mtime of app.js / style.css surfaces as `.` in the
    // base-36 representation.
    expect(res.headers['ETag']).toMatch(/"[0-9.]+-[0-9]+-[A-Za-z0-9.-]+-[A-Za-z0-9.-]+"/)
  })

  it('replaces the apple-mobile-web-app-title with the configured brand', async () => {
    H.brand = 'Acme'
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.body).toContain('name="apple-mobile-web-app-title" content="Acme"')
  })

  it('escapes HTML-special chars in the brand name when rewriting apple-mobile-web-app-title', async () => {
    H.brand = 'A & B'
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.body).toContain('content="A &amp; B"')
    // The raw `&` must not appear inside the rewritten attribute.
    expect(res.body).not.toContain('content="A & B"')
  })

  it('treats /index.html identically to /', async () => {
    const { ctx, res } = call('/index.html')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<!DOCTYPE html>')
  })

  it('returns 304 when the if-none-match header equals the computed etag', async () => {
    // First request computes and exposes the etag via the response header;
    // echo it back as if-none-match to drive the 304 branch.
    const probe = call('/')
    expect(await tryHandleStatic(probe.ctx, WEB)).toBe(true)
    const etag = probe.res.headers['ETag']
    expect(etag).toBeTruthy()

    const { ctx, res } = call('/', { headers: { 'if-none-match': etag } })
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(304)
    expect(res.headers['ETag']).toBe(etag)
    expect(res.headers['Cache-Control']).toBe('no-cache')
    expect(res.body).toBe('')
  })

  it('returns 200 when the if-none-match header does not match', async () => {
    const { ctx, res } = call('/', { headers: { 'if-none-match': '"stale-token"' } })
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('returns 404 when index.html is missing', async () => {
    rmSync(join(WEB, 'index.html'))
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('Not found')
  })

  it('returns 200 with `?v=0` tokens when app.js and style.css are missing from webDir', async () => {
    // Exercises the assetVersion() `catch { return "0" }` branch for both
    // assets; the index still serves because statSync on index.html succeeds.
    rmSync(join(WEB, 'app.js'))
    rmSync(join(WEB, 'style.css'))
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('/app.js?v=0')
    expect(res.body).toContain('/style.css?v=0')
  })

  it('leaves index.html unchanged when the script/link tags are absent', async () => {
    // No `<script src="/app.js">` and no `<link rel="stylesheet" href="/style.css">`
    // patterns -- the two .replace() calls become no-ops but the response is
    // still 200. This guards against accidental regex-broadening.
    const bare = '<!DOCTYPE html><html><head></head><body>hi</body></html>\n'
    writeFileSync(join(WEB, 'index.html'), bare)
    const { ctx, res } = call('/')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(bare)
  })
})

// =========================================================================
// tryHandleStatic: versioned JS/CSS + service worker
// =========================================================================

describe('tryHandleStatic: assets', () => {
  it('serves /style.css with a long max-age cache header', async () => {
    const { ctx, res } = call('/style.css')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('private, max-age=86400')
    expect(res.headers['Content-Type']).toBe('text/css; charset=utf-8')
    expect(res.body).toContain('color: red')
  })

  it('serves /app.js with a long max-age cache header', async () => {
    const { ctx, res } = call('/app.js')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('private, max-age=86400')
    expect(res.body).toContain('console.log')
  })

  it('serves /sw.js with the default (no-cache) cache header', async () => {
    const { ctx, res } = call('/sw.js')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-cache')
  })
})

// =========================================================================
// tryHandleStatic: PWA manifest (branded + avatar-rewrite)
// =========================================================================

describe('tryHandleStatic: /manifest.json', () => {
  it('serves the branded manifest with the configured brand when no avatar is stored', async () => {
    // No marveen-avatar.* files in PROJECT_ROOT/store -- detectAvatarType returns null.
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/manifest+json')
    expect(res.headers['Cache-Control']).toBe('no-cache')
    const parsed = JSON.parse(res.body) as { name: string; short_name: string; icons: unknown[] }
    expect(parsed.name).toBe('Marveen Dashboard')
    expect(parsed.short_name).toBe('Marveen')
    // Icons array is the shipped one (no avatar rewrite branch ran).
    expect(parsed.icons).toHaveLength(1)
  })

  it('rewrites the icons array to point at the live avatar when a .png avatar is stored', async () => {
    writeFileSync(join(STORE, 'marveen-avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as { icons: Array<{ src: string; sizes: string; type: string; purpose: string }> }
    expect(parsed.icons).toHaveLength(2)
    expect(parsed.icons[0]).toEqual({ src: '/api/marveen/avatar', sizes: '192x192', type: 'image/png', purpose: 'any' })
    expect(parsed.icons[1]).toEqual({ src: '/api/marveen/avatar', sizes: '512x512', type: 'image/png', purpose: 'any' })
  })

  it('detects a .jpg avatar and reports image/jpeg', async () => {
    writeFileSync(join(STORE, 'marveen-avatar.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    const parsed = JSON.parse(res.body) as { icons: Array<{ type: string }> }
    expect(parsed.icons[0]?.type).toBe('image/jpeg')
  })

  it('detects a .jpeg avatar and reports image/jpeg', async () => {
    writeFileSync(join(STORE, 'marveen-avatar.jpeg'), Buffer.from([0xff, 0xd8, 0xff]))
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    const parsed = JSON.parse(res.body) as { icons: Array<{ type: string }> }
    expect(parsed.icons[0]?.type).toBe('image/jpeg')
  })

  it('detects a .webp avatar and reports image/webp', async () => {
    writeFileSync(join(STORE, 'marveen-avatar.webp'), Buffer.from('RIFF'))
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    const parsed = JSON.parse(res.body) as { icons: Array<{ type: string }> }
    expect(parsed.icons[0]?.type).toBe('image/webp')
  })

  it('falls back to serveFile when the manifest cannot be read', async () => {
    // Drop the manifest so readFileSync throws inside the try -- the catch
    // branch delegates to serveFile, which itself returns 404 because the
    // file is absent.
    rmSync(join(WEB, 'manifest.json'))
    const { ctx, res } = call('/manifest.json')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('Not found')
  })
})

// =========================================================================
// tryHandleStatic: language pack allowlist
// =========================================================================

describe('tryHandleStatic: /lang/*', () => {
  it('serves /lang/hu.js from the lang subdirectory', async () => {
    const { ctx, res } = call('/lang/hu.js')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/javascript; charset=utf-8')
    expect(res.body).toContain('_i18n.hu')
  })

  it('serves /lang/en.js from the lang subdirectory', async () => {
    const { ctx, res } = call('/lang/en.js')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('_i18n.en')
  })

  it('returns 404 for any other language filename (allowlist miss)', async () => {
    const { ctx, res } = call('/lang/de.js')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('')
  })
})

// =========================================================================
// tryHandleStatic: avatars + icons
// =========================================================================

describe('tryHandleStatic: /avatars/* and /icons/*', () => {
  it('serves /avatars/present.png when the file exists', async () => {
    const { ctx, res } = call('/avatars/present.png')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('private, max-age=3600')
  })

  it('returns 404 for /avatars/missing.png when the file does not exist', async () => {
    const { ctx, res } = call('/avatars/missing.png')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('')
  })

  it('serves /icons/present.png when the file exists', async () => {
    const { ctx, res } = call('/icons/present.png')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('private, max-age=3600')
  })

  it('returns 404 for /icons/missing.png when the file does not exist', async () => {
    const { ctx, res } = call('/icons/missing.png')
    expect(await tryHandleStatic(ctx, WEB)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('')
  })
})

// =========================================================================
// tryHandleStatic: dispatcher fallback
// =========================================================================

describe('tryHandleStatic: dispatcher', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = call('/api/agents')
    expect(await tryHandleStatic(ctx, WEB)).toBe(false)
  })

  it('returns false for the root path of an unknown subdirectory', async () => {
    const { ctx } = call('/some/unhandled/path')
    expect(await tryHandleStatic(ctx, WEB)).toBe(false)
  })
})