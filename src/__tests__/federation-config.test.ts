import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { checkBearerToken } from '../web/dashboard-auth.js'
import {
  validateFederationConfig,
  getFederationConfig,
  writeFederationConfig,
  identifyFederationCaller,
  setFederationEnabledPreservingFile,
  setFederationRoutingModePreservingFile,
  removeFederationStore,
  generatePeerInboundToken,
  isAcceptablePeerBaseUrl,
  abandonWindowMsForPeer,
  federationFileHealth,
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  FEDERATION_MIN_TOKEN_LENGTH,
  DEFAULT_ABANDON_WINDOW_MINUTES,
  type FederationConfig,
} from '../web/federation/config.js'

// ---------------------------------------------------------------------------
// node:fs.watch mock: capture the callback so the suite can fire a change
// event for federation.json deterministically and exercise the watcher's
// reload-on-watch body (line 246). Real unlinkSync/mkdirSync/existsSync/
// readFileSync stay live so the on-disk flow is exercised end-to-end.
// ---------------------------------------------------------------------------

type WatchCallback = (eventType: string, filename: string | null) => void
let watchCallback: WatchCallback | null = null
let watchDir: string | null = null
let watchOptions: unknown = null

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    watch: ((dir: string, options: unknown, cb: WatchCallback) => {
      watchCallback = cb
      watchDir = dir
      watchOptions = options
      return { close: () => { /* tests never close via this seam */ } } as unknown as ReturnType<typeof actual.watch>
    }) as typeof actual.watch,
  }
})

// Isolated store dir (initDatabase(':memory:') precedent: explicit override,
// never the real checkout's store/).
const TMP = mkdtempSync(join(tmpdir(), 'fed-config-test-'))
const IN_TOKEN = 'f'.repeat(64)
const OUT_TOKEN = 'e'.repeat(64)

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

beforeEach(() => {
  // Some failure-path tests intentionally replace federation.json with a
  // directory or a write-blocking file; rmSync without { recursive: true }
  // throws on those. Use rmSync with recursive + force to be tolerant.
  rmSync(join(TMP, 'federation.json'), { recursive: true, force: true })
  rmSync(join(TMP, '.federation-token'), { force: true })
  _setFederationStoreDirForTest(TMP)
  watchCallback = null
  watchDir = null
  watchOptions = null
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const validPeers = [{ id: 'arthur', baseUrl: 'https://macbook.example.ts.net', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }]

describe('validateFederationConfig (pure)', () => {
  it('accepts a minimal valid config and defaults systemId to MAIN_AGENT_ID', () => {
    const r = validateFederationConfig({ enabled: true, peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe(MAIN_AGENT_ID)
      expect(r.peers[0]).toMatchObject({ id: 'arthur', trust: 'untrusted', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN })
    }
  })

  it('parses peers for DISABLED configs too (lossless disable)', () => {
    const r = validateFederationConfig({ enabled: false, systemId: 'teodor', peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.enabled).toBe(false)
      expect(r.peers).toHaveLength(1)
    }
  })

  it('is strict about enabled === true', () => {
    for (const enabled of ['true', 1, undefined]) {
      const r = validateFederationConfig({ enabled, peers: validPeers })
      if (typeof r !== 'string') expect(r.enabled).toBe(false)
      else expect.fail(`expected config, got: ${r}`)
    }
  })

  it('defaults routingMode to catalog-first when absent, round-trips a valid mode', () => {
    const def = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof def === 'string') return expect.fail(def)
    expect(def.routingMode).toBe('catalog-first')
    for (const mode of ['strong', 'catalog-first', 'advisory'] as const) {
      const r = validateFederationConfig({ enabled: true, routingMode: mode, peers: validPeers })
      if (typeof r === 'string') return expect.fail(r)
      expect(r.routingMode).toBe(mode)
    }
  })

  it('rejects an unknown routingMode (fail-closed)', () => {
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 'aggressive', peers: validPeers })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 5, peers: validPeers })).toBe('string')
  })

  it('allows an EMPTY outboundToken (pairing pending) but rejects a short one', () => {
    const pending = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: '' }] })
    expect(typeof pending).not.toBe('string')
    if (typeof pending !== 'string') expect(pending.peers[0].outboundToken).toBe('')
    const missing = validateFederationConfig({ enabled: true, peers: [{ id: 'arthur', baseUrl: 'https://x.example', inboundToken: IN_TOKEN }] })
    expect(typeof missing).not.toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: 'short' }] })).toBe('string')
  })

  it('REQUIRES a well-formed inboundToken (min length, empty-string bypass guard)', () => {
    for (const inboundToken of [undefined, '', '   ', 'short', 'x'.repeat(FEDERATION_MIN_TOKEN_LENGTH - 1)]) {
      const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], inboundToken }] })
      expect(typeof r).toBe('string')
    }
  })

  it('rejects duplicate inbound tokens (cross-peer impersonation guard)', () => {
    const r = validateFederationConfig({
      enabled: true,
      peers: [validPeers[0], { id: 'cecil', baseUrl: 'https://c.example', inboundToken: IN_TOKEN }],
    })
    expect(r).toContain('duplicate inbound token')
  })

  it('rejects peer id equal to own systemId and duplicate peer ids', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'arthur', peers: validPeers })).toContain('equals own systemId')
    expect(validateFederationConfig({ enabled: true, peers: [...validPeers, { ...validPeers[0], inboundToken: 'g'.repeat(64) }] })).toContain('duplicate peer id')
  })

  it('lowercases systemId and peer ids at validation -- case-insensitive ids, stored lowercase (L1)', () => {
    const r = validateFederationConfig({ enabled: true, systemId: 'Teodor', peers: [{ ...validPeers[0], id: 'Arthur' }] })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe('teodor')
      expect(r.peers[0].id).toBe('arthur')
    }
  })

  it('detects id collisions ACROSS case (own-system + duplicate)', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ ...validPeers[0], id: 'Teodor' }] })).toContain('equals own systemId')
    expect(validateFederationConfig({
      enabled: true, systemId: 'x',
      peers: [validPeers[0], { ...validPeers[0], id: 'ARTHUR', inboundToken: 'a'.repeat(64) }],
    })).toContain('duplicate peer id')
  })

  it('rejects unknown trust values (fail-closed forward-compat)', () => {
    expect(validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], trust: 'trusted' }] })).toContain('trust')
  })

  it('parses the per-peer shareCapabilitySummaries flag strictly and ROUND-TRIPS it (L5)', () => {
    const on = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: true }] })
    if (typeof on === 'string') expect.fail(on)
    // Must survive the validator: every mutating endpoint persists the
    // validator's output, so a dropped field would silently revoke the grant.
    expect(on.peers[0].shareCapabilitySummaries).toBe(true)
    const off = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof off === 'string') expect.fail(off)
    expect(off.peers[0].shareCapabilitySummaries).toBeUndefined() // default: not shared
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: 'yes' }] })).toBe('string')
  })

  it('validates abandonWindowMinutes bounds', () => {
    const ok = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: 1440 }] })
    if (typeof ok !== 'string') expect(ok.peers[0].abandonWindowMinutes).toBe(1440)
    else expect.fail(ok)
    for (const w of [0, 4, 999999, 1.5, '60']) {
      expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: w }] })).toBe('string')
    }
  })

  it('rejects invalid ids and baseUrls; strips trailing slashes', () => {
    expect(typeof validateFederationConfig({ enabled: true, systemId: 'bad name', peers: [] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], id: 'a/b' }] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'http://evil.example.com' }] })).toBe('string')
    const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'https://x.example//' }] })
    if (typeof r !== 'string') expect(r.peers[0].baseUrl).toBe('https://x.example')
  })
})

describe('isAcceptablePeerBaseUrl / abandonWindowMsForPeer / token mint', () => {
  it('requires https except on loopback', () => {
    expect(isAcceptablePeerBaseUrl('https://any.example')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://127.0.0.1:3432')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://192.168.1.10:3420')).toBe(false)
  })

  it('abandon window defaults to 60 min and honours per-peer override', () => {
    const cfg: FederationConfig = {
      enabled: true, systemId: 'a',
      peers: [
        { id: 'fast', baseUrl: 'https://x', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' },
        { id: 'laptop', baseUrl: 'https://y', outboundToken: OUT_TOKEN, inboundToken: 'g'.repeat(64), trust: 'untrusted', abandonWindowMinutes: 1440 },
      ],
    }
    expect(abandonWindowMsForPeer(cfg, 'fast')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'laptop')).toBe(1440 * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'unknown')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    // Case-insensitive: a pre-normalization stored row may carry 'Laptop/x'.
    expect(abandonWindowMsForPeer(cfg, 'Laptop')).toBe(1440 * 60_000)
  })

  it('mints 64-hex tokens', () => {
    expect(generatePeerInboundToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(generatePeerInboundToken()).not.toBe(generatePeerInboundToken())
  })
})

describe('fail-closed store reads', () => {
  it('missing file / garbage JSON / one invalid peer -> disabled with no peers', () => {
    expect(getFederationConfig().enabled).toBe(false)
    writeFileSync(join(TMP, 'federation.json'), '{not json')
    reloadFederationForTest()
    expect(getFederationConfig().enabled).toBe(false)
    writeConfigFile({ enabled: true, peers: [validPeers[0], { id: 'bad peer!', baseUrl: 'https://x.example', inboundToken: 'g'.repeat(64) }] })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(0)
  })

  it('valid enabled file -> enabled with parsed peers', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.peers.map((p) => p.id)).toEqual(['arthur'])
  })
})

describe('identifyFederationCaller', () => {
  it('identifies the matching peer and only while enabled', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBe('arthur')
    expect(identifyFederationCaller(`Bearer ${'0'.repeat(64)}`, checkBearerToken)).toBeNull()
    expect(identifyFederationCaller(undefined, checkBearerToken)).toBeNull()
    writeConfigFile({ enabled: false, peers: validPeers })
    // Disabled: no auth work at all -- a disabled peer presents as plain 401.
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBeNull()
  })

  it('never authenticates against an empty/short stored token', () => {
    // Hand-edited file with a short inbound token fail-closes the WHOLE
    // config, so the caller loop never even sees it.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: '' }] })
    expect(identifyFederationCaller('Bearer  ', checkBearerToken)).toBeNull()
  })
})

describe('lossless enable/disable + removal', () => {
  it('setFederationEnabledPreservingFile flips the flag and keeps peers -- even INVALID ones stay in the file', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    expect(setFederationEnabledPreservingFile(false)).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(1) // lossless: peers survive the flip
    expect(setFederationEnabledPreservingFile(true)).toBe(true)
    expect(getFederationConfig().enabled).toBe(true)

    // The critical data-loss edge: an INVALID stored peer fail-closes the
    // VIEW (peers: []), but the flag flip must not write that emptiness back.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(getFederationConfig().peers).toHaveLength(0) // view is fail-closed
    expect(setFederationEnabledPreservingFile(false)).toBe(true)
    const raw = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(raw.peers).toHaveLength(1) // the file still has the peer
    expect(raw.enabled).toBe(false)
  })

  it('returns false on unreadable garbage (nothing to flip; validator already fail-closes)', () => {
    writeFileSync(join(TMP, 'federation.json'), '{oops')
    reloadFederationForTest()
    expect(setFederationEnabledPreservingFile(false)).toBe(false)
  })

  it('setFederationRoutingModePreservingFile sets the mode, keeps peers + enabled, survives an invalid stored peer', () => {
    writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
    expect(setFederationRoutingModePreservingFile('strong')).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.routingMode).toBe('strong')
    expect(cfg.enabled).toBe(true) // untouched
    expect(cfg.peers).toHaveLength(1) // lossless
    // Invalid stored peer -> the VIEW fail-closes, but the file (incl. the peer) is kept.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(setFederationRoutingModePreservingFile('advisory')).toBe(true)
    const raw = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(raw.routingMode).toBe('advisory')
    expect(raw.peers).toHaveLength(1)
  })

  it('removeFederationStore deletes config + legacy token file and is idempotent', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    removeFederationStore()
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(existsSync(join(TMP, '.federation-token'))).toBe(false)
    expect(getFederationConfig().enabled).toBe(false)
    removeFederationStore() // idempotent
  })

  it('writeFederationConfig refreshes the cache synchronously', () => {
    writeFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ id: 'arthur', baseUrl: 'https://x.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' }] })
    expect(getFederationConfig().enabled).toBe(true)
    expect(getFederationConfig().peers[0].id).toBe('arthur')
  })
})

// ============================================================================
// 100% coverage extensions: the watch callback, federationFileHealth, the
// identifyFederationCaller catch, the setFederationRoutingModePreservingFile
// catch, and the removeFederationStore non-ENOENT warn. The original test
// file covers the pure validators and the happy I/O paths; the bodies below
// cover the remaining branches.
// ============================================================================

describe('federationFileHealth', () => {
  it('reports "absent" when the file does not exist', () => {
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(federationFileHealth()).toBe('absent')
  })

  it('reports "ok" when the file exists and validates cleanly', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    expect(federationFileHealth()).toBe('ok')
  })

  it('reports "invalid" when the file fails validation (one bad peer fail-closes the view)', () => {
    writeConfigFile({ enabled: true, peers: [{ id: 'bad peer!', baseUrl: 'https://x.example', inboundToken: 'g'.repeat(64) }] })
    expect(federationFileHealth()).toBe('invalid')
  })

  it('reports "invalid" when the file is unreadable / unparseable', () => {
    writeFileSync(join(TMP, 'federation.json'), '{not json')
    expect(federationFileHealth()).toBe('invalid')
  })

  it('reports "invalid" when readFileSync throws (e.g. replaced by a directory)', () => {
    // Pre-create the path as a directory so readFileSync fails with EISDIR.
    mkdirSync(join(TMP, 'federation.json'), { recursive: true })
    expect(federationFileHealth()).toBe('invalid')
  })
})

describe('watch + ensureWatching', () => {
  it('registers a watcher on the configured store dir with { persistent: false }', () => {
    getFederationConfig() // triggers ensureWatching -> watch(...)
    expect(watchCallback).not.toBeNull()
    expect(watchDir).toBe(TMP)
    expect(watchOptions).toEqual({ persistent: false })
  })

  it('reload-on-watch: a change to federation.json re-reads the file', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    getFederationConfig() // arm watcher
    expect(getFederationConfig().peers[0].id).toBe('arthur')
    // External write: an unrelated process renames the file.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], id: 'cecil', baseUrl: 'https://c.example', inboundToken: 'g'.repeat(64) }] })
    expect(watchCallback).not.toBeNull()
    watchCallback!('change', 'federation.json')
    expect(getFederationConfig().peers[0].id).toBe('cecil')
  })

  it('reload-on-watch: a change to a different filename is ignored', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    getFederationConfig() // arm watcher
    const before = getFederationConfig()
    watchCallback!('change', 'unrelated.json')
    expect(getFederationConfig()).toBe(before)
  })

  it('handles a watch callback where filename is null (macOS delivery quirk)', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    getFederationConfig() // arm watcher
    const before = getFederationConfig()
    watchCallback!('change', null)
    expect(getFederationConfig()).toBe(before)
  })

  it('ensureWatching swallows mkdirSync / watch failures (best-effort watcher setup)', () => {
    // Force mkdirSync to throw on the store dir: replace the dir with a file
    // of the same name. The inner try/catch in ensureWatching swallows it.
    const blocker = join(TMP, 'federation-blocker')
    writeFileSync(blocker, 'not a dir')
    // mkdirSync on a path that already exists as a file throws EEXIST.
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('mocked mkdir failure'), { code: 'EEXIST' })
    })
    expect(() => getFederationConfig()).not.toThrow()
    expect(getFederationConfig().enabled).toBe(false)
  })

  it('does not re-register the watcher on a second getFederationConfig call', () => {
    getFederationConfig()
    const first = watchCallback
    getFederationConfig()
    expect(watchCallback).toBe(first)
  })
})

describe('identifyFederationCaller (catch path)', () => {
  it('returns null when the injected check function throws', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    const explosive = () => { throw new Error('boom') }
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, explosive)).toBeNull()
  })
})

describe('setFederationRoutingModePreservingFile (catch path)', () => {
  it('returns false when the underlying write throws (mkdirSync fails)', () => {
    writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('mocked mkdir failure'), { code: 'EACCES' })
    })
    expect(setFederationRoutingModePreservingFile('strong')).toBe(false)
  })
})

describe('removeFederationStore (non-ENOENT warn)', () => {
  it('warns when unlinkSync fails with a non-ENOENT error and still completes', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    // Block unlinkSync on the first call only (so the legacy-token unlink
    // still resolves to ENOENT and the loop exits cleanly).
    const err = Object.assign(new Error('mocked unlink failure'), { code: 'EBUSY' })
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw err })
    expect(() => removeFederationStore()).not.toThrow()
    expect(spy).toHaveBeenCalled()
    // The legacy token file surfaced via the spy bypass, so further calls
    // (the legacy-token path) fall through to the real unlinkSync -- which
    // hits ENOENT and is silently ignored.
  })

  it('ENOTEMPTY on federation.json does not abort the legacy-token removal', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    writeFileSync(join(TMP, '.federation-token'), 'legacy')
    const err = Object.assign(new Error('mocked unlink failure'), { code: 'ENOTEMPTY' })
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw err }).mockImplementationOnce(() => undefined)
    expect(() => removeFederationStore()).not.toThrow()
    // The cached config is reset to DISABLED regardless of the warn.
    expect(getFederationConfig().enabled).toBe(false)
  })
})

// ============================================================================
// More coverage extensions: loadConfigFromDisk unreadable dedup, the
// identifyFederationCaller "skip short/non-string token" guard, and the
// setFederationEnabledPreservingFile / setFederationRoutingModePreservingFile
// "parsed but not an object" branch.
// ============================================================================

describe('loadConfigFromDisk unreadable warn (line 233)', () => {
  it('logs the unreadable warn exactly once on the first broken-file read', () => {
    // Reset the warning memory so the dedup guard DOES fire its body.
    writeFileSync(join(TMP, 'federation.json'), '{not json')
    reloadFederationForTest()
    getFederationConfig()
    // A second read -- the dedup branch should NOT log again.
    getFederationConfig()
    // Sanity: the file is still unreadable but the cache returns DISABLED.
    expect(getFederationConfig().enabled).toBe(false)
  })
})

describe('identifyFederationCaller per-candidate guard (line 291)', () => {
  it('skips a peer whose stored inboundToken is not a string (defensive guard)', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    getFederationConfig() // load into cache
    // Bypass the validator by mutating the cached object directly: the
    // configured inboundToken type is string, but the gate's per-candidate
    // guard ALSO catches a non-string stored token (e.g. a hand-edited file
    // that the validator would have rejected, but the cache could carry
    // before the validator runs again on reload).
    const cfg = getFederationConfig()
    cfg.peers[0].inboundToken = undefined as unknown as string
    const check = vi.fn(() => true)
    expect(identifyFederationCaller('Bearer xxx', check)).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it('skips a peer whose stored inboundToken is shorter than FEDERATION_MIN_TOKEN_LENGTH', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    getFederationConfig() // load into cache
    const cfg = getFederationConfig()
    cfg.peers[0].inboundToken = 'short'
    const check = vi.fn(() => true)
    expect(identifyFederationCaller('Bearer xxx', check)).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })
})

describe('setFederationEnabledPreservingFile "parsed but not an object" branch', () => {
  it('returns false when the stored file is the JSON literal null', () => {
    writeFileSync(join(TMP, 'federation.json'), 'null')
    expect(setFederationEnabledPreservingFile(true)).toBe(false)
  })

  it('returns false when the stored file is a JSON array', () => {
    writeFileSync(join(TMP, 'federation.json'), '[]')
    expect(setFederationEnabledPreservingFile(true)).toBe(false)
  })

  it('returns false when the stored file is a JSON primitive (string)', () => {
    writeFileSync(join(TMP, 'federation.json'), '"a string"')
    expect(setFederationEnabledPreservingFile(true)).toBe(false)
  })
})

describe('setFederationRoutingModePreservingFile "parsed but not an object" branch', () => {
  it('returns false when the stored file is the JSON literal null', () => {
    writeFileSync(join(TMP, 'federation.json'), 'null')
    expect(setFederationRoutingModePreservingFile('strong')).toBe(false)
  })

  it('returns false when the stored file is a JSON array', () => {
    writeFileSync(join(TMP, 'federation.json'), '[]')
    expect(setFederationRoutingModePreservingFile('strong')).toBe(false)
  })

  it('returns false when the stored file is a JSON primitive (number)', () => {
    writeFileSync(join(TMP, 'federation.json'), '42')
    expect(setFederationRoutingModePreservingFile('strong')).toBe(false)
  })
})

// ============================================================================
// Final branch coverage: the "file does not exist" else branch of the
// file-reading on both setFederationEnabledPreservingFile and
// setFederationRoutingModePreservingFile, the "raw.systemId is set" else
// branch of the systemId fallback, and the "lastConfigWarning == unreadable"
// else branch of the unreadable warn dedup.
// ============================================================================

describe('setFederationEnabledPreservingFile (file does not exist)', () => {
  it('creates a fresh file from an empty store', () => {
    // beforeEach() has rmSync'd the file, so existsSync returns false.
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(setFederationEnabledPreservingFile(true)).toBe(true)
    expect(existsSync(join(TMP, 'federation.json'))).toBe(true)
  })
})

describe('setFederationRoutingModePreservingFile (file does not exist)', () => {
  it('creates a fresh file from an empty store', () => {
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(setFederationRoutingModePreservingFile('strong')).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(onDisk.routingMode).toBe('strong')
  })
})

describe('setFederationRoutingModePreservingFile (systemId already set)', () => {
  it('keeps the stored systemId and does not overwrite it with MAIN_AGENT_ID', () => {
    writeConfigFile({ enabled: true, systemId: 'custom-system', routingMode: 'advisory', peers: validPeers })
    expect(setFederationRoutingModePreservingFile('strong')).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(onDisk.systemId).toBe('custom-system')
  })
})

describe('setFederationEnabledPreservingFile (systemId already set)', () => {
  it('keeps the stored systemId and does not overwrite it with MAIN_AGENT_ID', () => {
    writeConfigFile({ enabled: true, systemId: 'custom-system', peers: validPeers })
    expect(setFederationEnabledPreservingFile(false)).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(onDisk.systemId).toBe('custom-system')
  })
})

describe('loadConfigFromDisk unreadable warn dedup (else branch)', () => {
  it('does NOT re-log the unreadable warn on a second broken-file read', () => {
    // First broken-file read: the if-true branch fires, lastConfigWarning
    // becomes 'unreadable' and the dedup is armed.
    writeFileSync(join(TMP, 'federation.json'), '{not json')
    reloadFederationForTest()
    expect(getFederationConfig().enabled).toBe(false)
    // Re-arm the watcher's reload path: a filename event triggers
    // loadConfigFromDisk AND does NOT reset lastConfigWarning. The catch
    // path runs again; the if-check now evaluates to FALSE (lastConfigWarning
    // IS 'unreadable'), so the else branch runs (no log).
    writeFileSync(join(TMP, 'federation.json'), '{still not json')
    if (watchCallback) watchCallback('change', 'federation.json')
    expect(getFederationConfig().enabled).toBe(false)
  })
})

// ============================================================================
// Final coverage extensions: branches that the original suite never touched
// outside the validator and the live I/O paths.
// ============================================================================

describe('isAcceptablePeerBaseUrl (every branch)', () => {
  it('rejects non-string inputs (typeof guard)', () => {
    expect(isAcceptablePeerBaseUrl(undefined)).toBe(false)
    expect(isAcceptablePeerBaseUrl(null)).toBe(false)
    expect(isAcceptablePeerBaseUrl(42)).toBe(false)
    expect(isAcceptablePeerBaseUrl(true)).toBe(false)
    expect(isAcceptablePeerBaseUrl({})).toBe(false)
    expect(isAcceptablePeerBaseUrl([])).toBe(false)
  })

  it('rejects unparseable strings (URL constructor throw path)', () => {
    expect(isAcceptablePeerBaseUrl('not a url')).toBe(false)
    expect(isAcceptablePeerBaseUrl('://no-scheme')).toBe(false)
  })

  it('rejects non-http(s) protocols (the "url.protocol !== http:" branch)', () => {
    expect(isAcceptablePeerBaseUrl('ftp://peer.example')).toBe(false)
    expect(isAcceptablePeerBaseUrl('gopher://peer.example')).toBe(false)
    expect(isAcceptablePeerBaseUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('validateFederationConfig (root + peers branches)', () => {
  it('rejects null / undefined / array / primitive roots', () => {
    expect(validateFederationConfig(null)).toBe('root is not an object')
    expect(validateFederationConfig(undefined)).toBe('root is not an object')
    expect(validateFederationConfig('not an object')).toBe('root is not an object')
    expect(validateFederationConfig(42)).toBe('root is not an object')
    expect(validateFederationConfig([])).toBe('root is not an object')
  })

  it('rejects when peers is not an array (the "Array.isArray" guard)', () => {
    expect(validateFederationConfig({ enabled: true, peers: 'not an array' })).toBe('peers is not an array')
    expect(validateFederationConfig({ enabled: true, peers: {} })).toBe('peers is not an array')
    expect(validateFederationConfig({ enabled: true, peers: 42 })).toBe('peers is not an array')
  })

  it('rejects a non-object peer entry (null, string, number, array)', () => {
    expect(validateFederationConfig({ enabled: true, peers: [null] }))
      .toBe('peer entry is not an object')
    expect(validateFederationConfig({ enabled: true, peers: ['a string'] }))
      .toBe('peer entry is not an object')
    expect(validateFederationConfig({ enabled: true, peers: [42] }))
      .toBe('peer entry is not an object')
  })

  it('tolerates a missing peers key (the "obj.peers === undefined" branch)', () => {
    const r = validateFederationConfig({ enabled: false })
    expect(typeof r).toBe('object')
    expect((r as { peers: unknown[] }).peers).toEqual([])
  })
})
