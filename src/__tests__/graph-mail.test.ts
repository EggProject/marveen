import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCredentials } from '../graph-mail.js'

// Module-scope CREDS_PATH is resolved at import time from process.env.MARVEEN_MAIL_CREDS,
// so each module-using test resets modules + sets env + dynamic-imports graph-mail.js
// fresh. parseCredentials is exported and filesystem-free, so it does not need this dance.

const originalFetch = globalThis.fetch
const originalEnvCreds = process.env.MARVEEN_MAIL_CREDS

function credsFile(dir: string): string {
  const p = join(dir, 'marveen-mail-ugyfelkod')
  writeFileSync(
    p,
    [
      'TENANT_ID=tenant-aaaa',
      'CLIENT_ID=client-bbbb',
      'CLIENT_SECRET=secret-cccc',
      'MAILBOX=marveen@pecibt.hu',
    ].join('\n'),
    'utf-8',
  )
  return p
}

function mockResponseOnce(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnvCreds === undefined) delete process.env.MARVEEN_MAIL_CREDS
  else process.env.MARVEEN_MAIL_CREDS = originalEnvCreds
  vi.restoreAllMocks()
})

// ──────────────────────────────────────────────────────────────────────────────
// parseCredentials — pure, filesystem-free. Pinned for completeness.
// ──────────────────────────────────────────────────────────────────────────────
describe('parseCredentials', () => {
  const full = [
    'TENANT_ID=tenant-aaaa',
    'CLIENT_ID=client-bbbb',
    'CLIENT_SECRET=secret-cccc',
    'MAILBOX=marveen@pecibt.hu',
  ].join('\n')

  it('parses a well-formed credentials file', () => {
    const c = parseCredentials(full)
    expect(c.tenantId).toBe('tenant-aaaa')
    expect(c.clientId).toBe('client-bbbb')
    expect(c.clientSecret).toBe('secret-cccc')
    expect(c.mailbox).toBe('marveen@pecibt.hu')
  })

  it('ignores comments and blank lines', () => {
    const c = parseCredentials(`# header\n\n${full}\n# trailing`)
    expect(c.mailbox).toBe('marveen@pecibt.hu')
  })

  it('skips lines that have no = sign (malformed but harmless)', () => {
    // The parser is lenient on keyless lines -- only lines with '=' become
    // entries; bare words are silently dropped. The credentials file format
    // is operator-maintained, but a stray note shouldn't brick the module.
    const c = parseCredentials(`orphan note without equals\n${full}`)
    expect(c.mailbox).toBe('marveen@pecibt.hu')
  })

  it('strips surrounding double quotes from values', () => {
    const c = parseCredentials(full.replace('CLIENT_SECRET=secret-cccc', 'CLIENT_SECRET="secret-cccc"'))
    expect(c.clientSecret).toBe('secret-cccc')
  })

  it('strips surrounding single quotes from values', () => {
    const c = parseCredentials(full.replace('CLIENT_SECRET=secret-cccc', "CLIENT_SECRET='secret-cccc'"))
    expect(c.clientSecret).toBe('secret-cccc')
  })

  it('keeps = characters inside a value', () => {
    const c = parseCredentials(full.replace('CLIENT_SECRET=secret-cccc', 'CLIENT_SECRET=ab=cd=ef'))
    expect(c.clientSecret).toBe('ab=cd=ef')
  })

  it('throws listing every missing key', () => {
    expect(() => parseCredentials('MAILBOX=marveen@pecibt.hu')).toThrowError(/TENANT_ID.*CLIENT_ID.*CLIENT_SECRET/)
  })

  it('treats an empty value as missing', () => {
    expect(() => parseCredentials(full.replace('CLIENT_SECRET=secret-cccc', 'CLIENT_SECRET='))).toThrowError(/CLIENT_SECRET/)
  })

  it('reports MAILBOX as missing when the key is absent entirely', () => {
    // Line 93's `?? ''` fires when MAILBOX isn't in the parsed map at all
    // (vs. present-but-empty, which the empty-string check catches).
    expect(() =>
      parseCredentials(
        'TENANT_ID=t\nCLIENT_ID=c\nCLIENT_SECRET=s\n# no MAILBOX line',
      ),
    ).toThrowError(/MAILBOX/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Everything below touches the module-scoped CREDS_PATH / cachedCreds / cachedToken,
// so each test rebuilds the module registry and points MARVEEN_MAIL_CREDS at a
// fresh tmpdir file.
// ──────────────────────────────────────────────────────────────────────────────
describe('loadCredentials + getToken (cache, mtime, errors)', () => {
  let tmp: string
  let credsPath: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsPath = credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = credsPath
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws a file-not-found error when CREDS_PATH is missing', async () => {
    rmSync(credsPath, { force: true })
    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/credentials file not found/)
  })

  it('throws an opaque EISDIR when CREDS_PATH points at a directory (pinned defect)', async () => {
    // The statSync try/catch only catches "not found"; readFileSync on a
    // directory throws EISDIR. The operator sees a low-level fs error with
    // no hint that MARVEEN_MAIL_CREDS is the wrong path. Documented in
    // graph-mail-stat-not-isdir.
    rmSync(credsPath, { force: true })
    process.env.MARVEEN_MAIL_CREDS = tmp // tmp IS the directory, not the file inside it
    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/credentials file not readable at .*EISDIR/)
  })

  it('falls back to "unknown" code when the readFileSync error has no .code property (graph-mail:121 ?? branch)', async () => {
    // Az `err.code ?? 'unknown'` (src/graph-mail.ts:121) akkor fut le, ha a
    // readFileSync ugyan dob, de a hibauzenet NEM rendszer-errno (nincs .code
    // mező). A stat atszokott, a readFileSpy egy tokbol dobott sima Error,
    // aminek nincs .code-ja -- pont az ?? fallback agat nyitja meg.
    // vi.doMock('node:fs') csak a kovetkezo import-ig el, igy a beforeEach-ben
    // beallitott MARVEEN_MAIL_CREDS marad ervenyben, es a freshly imported
    // graph-mail.js megkapja a szintetikus readFile-et.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        readFileSync: () => {
          throw new Error('synthetic no-code failure')
        },
      }
    })
    vi.resetModules()
    try {
      const { listMessages } = await import('../graph-mail.js')
      await expect(listMessages()).rejects.toThrowError(/credentials file not readable at .*unknown/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('mints a token via the client-credentials endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/oauth2/v2.0/token')) {
        return mockResponseOnce(200, { access_token: 'tok-1', expires_in: 3600 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    const msgs = await listMessages()
    expect(msgs).toEqual([])

    // First call must be the token endpoint, POST form-urlencoded.
    const tokenCall = calls[0]
    expect(tokenCall?.url).toMatch(/login\.microsoftonline\.com\/tenant-aaaa\/oauth2\/v2\.0\/token/)
    expect(tokenCall?.init?.method).toBe('POST')
    expect((tokenCall?.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = tokenCall?.init?.body as URLSearchParams
    expect(body.get('client_id')).toBe('client-bbbb')
    expect(body.get('client_secret')).toBe('secret-cccc')
    expect(body.get('grant_type')).toBe('client_credentials')

    // Second call hits Graph with the Bearer header.
    const graphCall = calls[1]
    expect(graphCall?.url).toMatch(/graph\.microsoft\.com\/v1\.0\/users\/marveen%40pecibt\.hu\/mailFolders\/inbox\/messages/)
    expect((graphCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('reuses a cached token on the second listMessages call within expiry', async () => {
    let tokenCalls = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        tokenCalls++
        return mockResponseOnce(200, { access_token: 'tok-cached', expires_in: 3600 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages()
    await listMessages()
    expect(tokenCalls).toBe(1)
  })

  it('refetches when the cached token is within 60s of expiry', async () => {
    let tokenCalls = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        tokenCalls++
        // expires_in: 30 -> the safety margin (60s) sees it as expired.
        return mockResponseOnce(200, { access_token: `tok-${tokenCalls}`, expires_in: 30 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages()
    await listMessages()
    expect(tokenCalls).toBe(2)
  })

  it('refetches when the credentials file mtime advances (operator-rotated secret)', async () => {
    let tokenCalls = 0
    let graphCalls = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        tokenCalls++
        return mockResponseOnce(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600 })
      }
      graphCalls++
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages()
    expect(tokenCalls).toBe(1)
    expect(graphCalls).toBe(1)

    // Operator rotates the secret. To force a fresh mtime that the module's
    // cachedCreds entry will reject, we wait past the second-granularity
    // window and rewrite the file with a different CLIENT_ID (which also
    // invalidates the token cache -- two birds, one stone).
    await new Promise((r) => setTimeout(r, 1100))
    writeFileSync(
      credsPath,
      [
        'TENANT_ID=tenant-aaaa',
        'CLIENT_ID=client-ROTATED',
        'CLIENT_SECRET=secret-cccc',
        'MAILBOX=marveen@pecibt.hu',
      ].join('\n'),
      'utf-8',
    )
    await listMessages()
    expect(tokenCalls).toBe(2)
    expect(graphCalls).toBe(2)
  })

  it('throws on token endpoint HTTP error and surfaces the short error code', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return mockResponseOnce(401, { error: 'invalid_client', error_description: 'bad' })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/token request failed \(401 invalid_client\)/)
  })

  it('falls back to "unknown" code when the token endpoint returns a non-JSON error body', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return new Response('upstream gateway down', { status: 502 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/token request failed \(502 unknown\)/)
  })

  it('falls back to "unknown" code when the token error body is JSON without an error field', async () => {
    // Line 163's `?? 'unknown'` fires when the body parses but the
    // `error` property is absent (AADSTS sometimes emits only
    // `error_description`).
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return mockResponseOnce(400, { error_description: 'something else' })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/token request failed \(400 unknown\)/)
  })

  it('invalidates the token cache when the credentials clientId changes (rotated app registration)', async () => {
    let tokenCalls = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        tokenCalls++
        return mockResponseOnce(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages: firstList } = await import('../graph-mail.js')
    await firstList()
    expect(tokenCalls).toBe(1)

    // Rotate CLIENT_ID -- the cached token was minted for the old client and
    // must not be reused. Wait past second-granularity so the cached mtime
    // is unambiguously stale.
    await new Promise((r) => setTimeout(r, 1100))
    writeFileSync(
      credsPath,
      [
        'TENANT_ID=tenant-aaaa',
        'CLIENT_ID=client-NEW',
        'CLIENT_SECRET=secret-cccc',
        'MAILBOX=marveen@pecibt.hu',
      ].join('\n'),
      'utf-8',
    )

    // Re-import to get a fresh module instance whose fetch sees the rotated file.
    vi.resetModules()
    const { listMessages: secondList } = await import('../graph-mail.js')
    await secondList()
    expect(tokenCalls).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// withTimeout — the setTimeout(() => controller.abort(), 20_000) branch fires
// only when the upstream fetch hangs past the deadline. Drive it with fake
// timers + a fetch that resolves only on signal abort.
// ──────────────────────────────────────────────────────────────────────────────
describe('withTimeout 20s abort branch', () => {
  let tmp: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = join(tmp, 'marveen-mail-ugyfelkod')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('aborts the hung fetch when the 20s request timeout elapses', async () => {
    // The withTimeout() helper sets a setTimeout(20_000) that aborts the
    // AbortController. If the upstream fetch never resolves, the abort
    // callback fires and the hung promise rejects. This is the only path
    // that exercises the inner () => controller.abort() arrow.
    vi.useFakeTimers()
    try {
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            if (signal.aborted) reject(new Error('aborted'))
            else signal.addEventListener('abort', () => reject(new Error('aborted')))
          }
        })
      }) as unknown as typeof fetch

      const { listMessages } = await import('../graph-mail.js')
      const promise = listMessages()
      // Silence unhandled rejection while we let the timer fire.
      promise.catch(() => {})

      // Advance past the 20_000ms deadline; vi.advanceTimersByTimeAsync drains
      // the microtask queue so the abort -> reject -> propagate chain completes.
      await vi.advanceTimersByTimeAsync(20_500)

      await expect(promise).rejects.toThrow(/aborted/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// listMessages — query string construction + error/empty paths.
// ──────────────────────────────────────────────────────────────────────────────
describe('listMessages', () => {
  let tmp: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = join(tmp, 'marveen-mail-ugyfelkod')

    // Always-on token mint; specific tests override the Graph call response.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns parsed messages from the Graph response', async () => {
    const sample = {
      value: [
        {
          id: 'm1',
          subject: 'hi',
          from: { emailAddress: { address: 'a@b' } },
          receivedDateTime: '2026-08-01T10:00:00Z',
          isRead: false,
        },
      ],
    }
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, sample)
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    const msgs = await listMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.id).toBe('m1')
    expect(msgs[0]?.subject).toBe('hi')
  })

  it('returns an empty array when Graph omits the value field', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, {})
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    expect(await listMessages()).toEqual([])
  })

  it('clamps top to [1, 50]', async () => {
    const seenUrls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seenUrls.push(url)
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')

    await listMessages({ top: 0 })
    expect(seenUrls[1]).toMatch(/%24top=1\b/)

    await listMessages({ top: 9999 })
    const lastGraphUrl = seenUrls[seenUrls.length - 1]
    expect(lastGraphUrl).toMatch(/%24top=50\b/)
  })

  it('targets a custom folder via the folder option', async () => {
    const seenUrls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seenUrls.push(url)
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages({ folder: 'sentitems' })
    expect(seenUrls[1]).toMatch(/mailFolders\/sentitems\/messages/)
  })

  it('adds $filter=isRead eq false when unreadOnly is set', async () => {
    const seenUrls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seenUrls.push(url)
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages({ unreadOnly: true })
    expect(seenUrls[1]).toMatch(/%24filter=isRead\+eq\+false/)
  })

  it('throws when Graph returns a non-2xx listMessages response', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return new Response('MailboxNotFoundForUser', { status: 404 })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await expect(listMessages()).rejects.toThrowError(/listMessages failed \(404 MailboxNotFoundForUser\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// sendMail — payload shape, cc, contentType, 202 success, error path.
// ──────────────────────────────────────────────────────────────────────────────
describe('sendMail', () => {
  let tmp: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = join(tmp, 'marveen-mail-ugyfelkod')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('POSTs the expected payload and treats 202 as success', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return new Response('', { status: 202 })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await sendMail({ to: 'a@b.com', subject: 's', body: 'b' })

    const sendCall = calls.find((c) => c.url.includes('/sendMail'))
    expect(sendCall?.init?.method).toBe('POST')
    const payload = JSON.parse((sendCall?.init?.body as string) ?? '{}') as {
      message: { toRecipients: unknown; body: { contentType: string; content: string }; subject: string }
      saveToSentItems: boolean
    }
    expect(payload.message.subject).toBe('s')
    expect(payload.message.body).toEqual({ contentType: 'Text', content: 'b' })
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'a@b.com' } }])
    expect(payload.saveToSentItems).toBe(true)
  })

  it('accepts an array of recipients and cc list, with HTML contentType', async () => {
    const sentPayloads: unknown[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      if (url.includes('/sendMail')) {
        sentPayloads.push(JSON.parse((init?.body as string) ?? '{}'))
        return new Response('', { status: 202 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await sendMail({
      to: [' a@x.com ', 'b@x.com', ''],
      cc: ['c@x.com'],
      subject: 's',
      body: '<p>b</p>',
      contentType: 'HTML',
    })

    const payload = sentPayloads[0] as {
      message: { toRecipients: unknown[]; ccRecipients: unknown[]; body: { contentType: string } }
      saveToSentItems: boolean
    }
    expect(payload.message.toRecipients).toEqual([
      { emailAddress: { address: 'a@x.com' } },
      { emailAddress: { address: 'b@x.com' } },
    ])
    expect(payload.message.ccRecipients).toEqual([{ emailAddress: { address: 'c@x.com' } }])
    expect(payload.message.body.contentType).toBe('HTML')
  })

  it('honors saveToSentItems: false', async () => {
    let payload: { saveToSentItems: boolean } | null = null
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      if (url.includes('/sendMail')) {
        payload = JSON.parse((init?.body as string) ?? '{}') as { saveToSentItems: boolean }
        return new Response('', { status: 202 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await sendMail({ to: 'a@b.com', subject: 's', body: 'b', saveToSentItems: false })
    expect(payload?.saveToSentItems).toBe(false)
  })

  it('throws when Graph returns an error other than 202', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return new Response('Recipient not found', { status: 400 })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await expect(sendMail({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrowError(
      /sendMail failed \(400 Recipient not found\)/,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// verifyAccess — returns { mailbox, messageCount } and surfaces Graph errors.
// ──────────────────────────────────────────────────────────────────────────────
describe('verifyAccess', () => {
  let tmp: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = join(tmp, 'marveen-mail-ugyfelkod')

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [{ id: 'a' }, { id: 'b' }] })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns the mailbox and messageCount', async () => {
    const { verifyAccess } = await import('../graph-mail.js')
    const r = await verifyAccess()
    expect(r).toEqual({ mailbox: 'marveen@pecibt.hu', messageCount: 2 })
  })

  it('defaults messageCount to 0 when Graph omits the value array', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, {})
    }) as unknown as typeof fetch

    const { verifyAccess } = await import('../graph-mail.js')
    expect(await verifyAccess()).toEqual({ mailbox: 'marveen@pecibt.hu', messageCount: 0 })
  })

  it('throws when Graph cannot reach the mailbox', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return new Response('Forbidden', { status: 403 })
    }) as unknown as typeof fetch

    const { verifyAccess } = await import('../graph-mail.js')
    await expect(verifyAccess()).rejects.toThrowError(/verifyAccess failed for marveen@pecibt\.hu \(403 Forbidden\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// mailboxPath URL-encodes '@'. toRecipientList shapes pinned through sendMail
// since the helper is private to the module.
// ──────────────────────────────────────────────────────────────────────────────
describe('mailboxPath encoding + toRecipientList shapes', () => {
  let tmp: string

  beforeEach(() => {
    vi.resetModules()
    tmp = mkdtempSync(join(tmpdir(), 'graph-mail-'))
    credsFile(tmp)
    process.env.MARVEEN_MAIL_CREDS = join(tmp, 'marveen-mail-ugyfelkod')

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('URL-encodes the mailbox address in the Graph path', async () => {
    const seenUrls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seenUrls.push(url)
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { listMessages } = await import('../graph-mail.js')
    await listMessages()
    expect(seenUrls[1]).toContain('/users/marveen%40pecibt.hu/')
  })

  it('coerces a single recipient string into a single-element toRecipients array', async () => {
    let payload: { message: { toRecipients: unknown[] } } | null = null
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      if (url.includes('/sendMail')) {
        payload = JSON.parse((init?.body as string) ?? '{}') as { message: { toRecipients: unknown[] } }
        return new Response('', { status: 202 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await sendMail({ to: 'sole@example.com', subject: 's', body: 'b' })
    expect(payload?.message.toRecipients).toEqual([{ emailAddress: { address: 'sole@example.com' } }])
  })

  it('strips whitespace and drops empty recipients from the input list', async () => {
    let payload: { message: { toRecipients: unknown[] } } | null = null
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth2/v2.0/token')) return mockResponseOnce(200, { access_token: 'tok', expires_in: 3600 })
      if (url.includes('/sendMail')) {
        payload = JSON.parse((init?.body as string) ?? '{}') as { message: { toRecipients: unknown[] } }
        return new Response('', { status: 202 })
      }
      return mockResponseOnce(200, { value: [] })
    }) as unknown as typeof fetch

    const { sendMail } = await import('../graph-mail.js')
    await sendMail({ to: ['  a@x.com  ', '', '   ', 'b@x.com'], subject: 's', body: 'b' })
    expect(payload?.message.toRecipients).toEqual([
      { emailAddress: { address: 'a@x.com' } },
      { emailAddress: { address: 'b@x.com' } },
    ])
  })
})
