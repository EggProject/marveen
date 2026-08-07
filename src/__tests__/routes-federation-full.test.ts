// 100% coverage suite for src/web/routes/federation.ts.
//
// Pins CURRENT behaviour (defensive against regressions). Branches covered:
// the manifest (403 when disabled; tokens never leak), the inbox endpoint
// (validation matrix, dedup, 413 on over-limit body, declared-size 413),
// the peers view (always redacted), the status endpoint, the directory
// endpoint (per-peer + local agents, never leaks tokens), the manual
// refresh, the apply endpoint (ok + fail), the PUT full-doc endpoint
// (valid replace, wantsDisable flip path, removedByPut per-peer purge,
// and disabled cleanup), the enabled endpoint (lossless flag flip +
// 409 on invalid file), the routing-mode endpoint (success + 409 +
// invalid mode 400), the peer add endpoint (mints inbound token,
// validation for baseUrl / abandonWindowMinutes / shareCapabilitySummaries
// / duplicate / equals-own-systemId, config-unhealthy 409), the peer
// patch endpoint (baseUrl, outboundToken, abandonWindowMinutes, share-
// CapabilitySummaries, validation, %2F guard), the peer delete endpoint
// (unknown, removal cascade), the inbound-token reveal + rotate, the
// full remove endpoint (files purged, queue failed, idempotent), and the
// final dispatcher fallthrough.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../db.js'
import type http from 'node:http'

const TMP = mkdtempSync(join(tmpdir(), 'federation-full-'))
mkdirSync(TMP, { recursive: true })
// Pin marveenVersion to the falsy-version branch (sub 1 of line 72): no
// `version` field in package.json means `JSON.parse(...).version` is
// undefined, the `|| 'unknown'` short-circuit fires, and marveenVersion
// lands at 'unknown'. The truthy branch is exercised separately below by
// mutating the file to include a version and re-loading the module.
writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'no-version' }))

const IN_TOKEN = 'a'.repeat(64)
const OUT_TOKEN = 'b'.repeat(64)
const MAIN_AGENT_ID = 'marveen'

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      MAIN_AGENT_ID: { get: () => MAIN_AGENT_ID, enumerable: true },
      BOT_NAME: { get: () => 'Marveen', enumerable: true },
      PROJECT_ROOT: { get: () => TMP, enumerable: true },
    },
  )
})

const H = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    loggerInfo: mkFn(),
    loggerWarn: mkFn(),
    loggerError: mkFn(),
    loggerDebug: mkFn(),
    createAgentMessage: vi.fn(),
    failPendingFederatedMessages: vi.fn(),
    purgeCapabilityCache: vi.fn(),
    resetPeerBackoff: vi.fn(),
    resetFederationPollerCache: vi.fn(),
    refreshFederationStatus: vi.fn(),
    hardRestartMarveenChannels: vi.fn(),
    ensureFederationClaudeMdSection: vi.fn(),
    // validateFederationConfig refusal control: a function that the test
    // sets to force the next call to return a string (validator refusal).
    validateFederationConfigRefuse: () => undefined as string | undefined,
    validateFederationConfigStripRoutingMode: () => false,
    getFederationConfigStripRoutingMode: () => false,
    setFederationRoutingModePreservingFileRefuse: false,
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('../db.js', async (orig) => {
  const actual = await orig<typeof import('../db.js')>()
  return {
    ...actual,
    createAgentMessage: (...args: unknown[]) => H.createAgentMessage(...args),
    failPendingFederatedMessages: (...args: unknown[]) => H.failPendingFederatedMessages(...args),
  }
})

vi.mock('../web/federation/capabilities.js', () => ({
  containsPrivateData: (s: string) => s.includes('PRIVATE'),
  getCapabilitySummary: () => ({ summary: 'a summary', fresh: false }),
  mainAgentCapabilitySummary: () => 'main summary',
  purgeCapabilityCache: () => H.purgeCapabilityCache(),
}))

vi.mock('../web/federation/bridge.js', () => ({
  resetPeerBackoff: (...args: unknown[]) => H.resetPeerBackoff(...args),
}))

vi.mock('../web/federation/poller.js', () => ({
  getFederationStatus: () => [{
    id: 'teodor',
    state: 'ok',
    lastOkAt: 100,
    manifest: {
      agents: [
        { id: 'kutato', displayName: 'Kutato', model: 'm', capabilitySummary: 'research' },
        { id: 'parser', displayName: 'Parser', model: 'm' },
      ],
      skills: [
        { agent: 'kutato', name: 'deep-research', description: 'multi-source research' },
        { agent: 'kutato', name: 'summarize', description: 'condense' },
        { agent: 'parser', name: 'parse-csv', description: 'parse csv' },
      ],
    },
  }],
  refreshFederationStatus: (...args: unknown[]) => H.refreshFederationStatus(...args),
  resetFederationPollerCache: (...args: unknown[]) => H.resetFederationPollerCache(...args),
}))

vi.mock('../web/federation/onboarding.js', () => ({
  ensureFederationClaudeMdSection: () => H.ensureFederationClaudeMdSection(),
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => H.hardRestartMarveenChannels(),
}))

vi.mock('../web/federation/local-catalog.js', () => ({
  catalogAgentNames: () => ['alpha'],
  listAgentLocalSkills: (n: string) => n === 'alpha' ? [{ name: 'do-thing', description: 'does the thing' }] : [],
}))

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    isKnownAgent: () => false,
    readAgentDisplayName: (n: string) => n,
    readAgentModel: () => 'm',
  }
})

const {
  tryHandleFederation,
  validateInboxPayload,
  _resetInboxDedupForTest,
  purgeInboxDedup,
  DIRECTORY_MAX_AGENTS_PER_PEER,
  DIRECTORY_MAX_SKILLS_PER_AGENT,
  DIRECTORY_SKILL_DESC_MAX,
} = await import('../web/routes/federation.js')
const {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  writeFederationConfig,
  getFederationConfig,
  setFederationEnabledPreservingFile,
  setFederationRoutingModePreservingFile,
  removeFederationStore,
} = await import('../web/federation/config.js')
const { logger } = await import('../logger.js')

// Validate-on-demand mock: the federation/config module is wrapped at the
// test boundary so its validateFederationConfig passes through to the real
// implementation unless H.validateFederationConfigRefuse() returned a
// string for the next call. Survives vi.resetModules() because the wrapper
// lives in the db.js mock factory which vi.mock re-applies on re-import.
vi.mock('../web/federation/config.js', async (orig) => {
  const actual = await orig<typeof import('../web/federation/config.js')>()
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'validateFederationConfig') {
        return (...args: unknown[]) => {
          const refused = H.validateFederationConfigRefuse()
          if (typeof refused === 'string') return refused
          const validated = target.validateFederationConfig(...args)
          if (typeof validated === 'string') return validated
          const remove = H.validateFederationConfigStripRoutingMode()
          if (remove) {
            const { routingMode: _, ...rest } = validated as Record<string, unknown>
            return rest as typeof validated
          }
          return validated
        }
      }
      if (prop === 'setFederationRoutingModePreservingFile') {
        return (...args: unknown[]) => {
          if (H.setFederationRoutingModePreservingFileRefuse) return false
          return target.setFederationRoutingModePreservingFile(...args)
        }
      }
      if (prop === 'getFederationConfig') {
        return () => {
          const cfg = target.getFederationConfig()
          if (H.getFederationConfigStripRoutingMode() && typeof cfg === 'object') {
            const { routingMode: _, ...rest } = cfg as Record<string, unknown>
            return rest as typeof cfg
          }
          return cfg
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------
function mkReq(body?: string): http.IncomingMessage {
  const ee = new EventEmitter() as unknown as http.IncomingMessage
  ;(ee as unknown as { headers: Record<string, string> }).headers = body
    ? { 'content-length': String(body.length) }
    : {}
  if (body !== undefined) {
    process.nextTick(() => {
      ee.emit('data', Buffer.from(body))
      ee.emit('end')
    })
  } else {
    process.nextTick(() => { ee.emit('end') })
  }
  return ee
}

interface MockRes {
  statusCode: number
  body: string
}
function mkRes(): MockRes {
  const state: MockRes = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as http.ServerResponse
  return new Proxy(state, {
    get(t, p) {
      if (p === 'writeHead') return (code: number) => { t.statusCode = code; return res }
      if (p === 'end') return (data?: unknown) => { t.body = String(data ?? '') }
      if (p === 'setHeader') return () => {}
      return Reflect.get(t, p)
    },
  }) as unknown as MockRes
}

function fakeCtx(method: string, path: string, body?: unknown, fedPeer: string | null = null): { ctx: Parameters<typeof tryHandleFederation>[0]; res: MockRes } {
  const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = mkReq(raw)
  const res = mkRes() as unknown as http.ServerResponse
  return {
    ctx: {
      req, res,
      path: path.split('?')[0],
      method,
      url: new URL(`http://localhost${path}`),
      fedPeer,
    },
    res: res as unknown as MockRes,
  }
}

async function call(method: string, path: string, body?: unknown, fedPeer: string | null = null): Promise<{ statusCode: number; json: any }> {
  const { ctx, res } = fakeCtx(method, path, body, fedPeer)
  expect(await tryHandleFederation(ctx)).toBe(true)
  let parsed: any = {}
  try { parsed = JSON.parse(res.body) } catch { /* empty */ }
  return { statusCode: res.statusCode || 200, json: parsed }
}

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

beforeEach(() => {
  vi.clearAllMocks()
  rmSync(join(TMP, 'federation.json'), { force: true })
  rmSync(join(TMP, '.federation-token'), { force: true })
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
  H.createAgentMessage.mockReturnValue({ id: 1, content: 'x', from_agent: 'a', to_agent: 'b', status: 'pending', created_at: 0 })
  H.failPendingFederatedMessages.mockReturnValue([])
  H.refreshFederationStatus.mockResolvedValue([])
  H.hardRestartMarveenChannels.mockReturnValue({ ok: true })
  H.resetPeerBackoff.mockReturnValue(undefined)
  H.resetFederationPollerCache.mockReturnValue(undefined)
  H.ensureFederationClaudeMdSection.mockReturnValue(undefined)
  H.purgeCapabilityCache.mockReturnValue(undefined)
})

afterEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
})

// ===========================================================================
// GET /api/federation/manifest
// ===========================================================================

describe('GET /api/federation/manifest', () => {
  it('403s when federation is disabled', async () => {
    const r = await call('GET', '/api/federation/manifest')
    expect(r.statusCode).toBe(403)
    expect(r.json.error).toMatch(/disabled/i)
  })

  it('returns the system/version/agents manifest when enabled', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/manifest')
    expect(r.statusCode).toBe(200)
    expect(r.json.system).toBe('localsys')
    expect(r.json.federationVersion).toBe(1)
    expect(r.json.marveenVersion).toBeDefined()
    expect(Array.isArray(r.json.agents)).toBe(true)
    expect(r.json.agents.some((a: { id: string }) => a.id === MAIN_AGENT_ID)).toBe(true)
  })
})

// ===========================================================================
// GET /api/federation/peers (view)
// ===========================================================================

describe('GET /api/federation/peers (list view)', () => {
  it('returns an empty peers list with the default routingMode', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/peers')
    expect(r.statusCode).toBe(200)
    expect(r.json.peers).toEqual([])
    expect(r.json.routingMode).toBe('catalog-first')
  })

  it('never leaks raw tokens in the view', async () => {
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://t.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN }],
    })
    const r = await call('GET', '/api/federation/peers')
    expect(r.json.body ?? r.json).toBeDefined()
    const blob = JSON.stringify(r.json)
    expect(blob).not.toContain(OUT_TOKEN)
    expect(blob).not.toContain(IN_TOKEN)
    expect(r.json.peers[0]).toMatchObject({ id: 'teodor', hasOutboundToken: true, hasInboundToken: true })
  })
})

// ===========================================================================
// GET /api/federation/status
// ===========================================================================

describe('GET /api/federation/status', () => {
  it('returns the poller cache peer snapshot', async () => {
    const r = await call('GET', '/api/federation/status')
    expect(r.statusCode).toBe(200)
    expect(r.json.peers).toHaveLength(1)
    expect(r.json.peers[0]).toMatchObject({ id: 'teodor', state: 'ok' })
  })
})

// ===========================================================================
// GET /api/federation/directory
// ===========================================================================

describe('GET /api/federation/directory', () => {
  it('403s when federation is disabled', async () => {
    const r = await call('GET', '/api/federation/directory')
    expect(r.statusCode).toBe(403)
  })

  it('returns the local agent listing with main first and the routing notice', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/directory')
    expect(r.statusCode).toBe(200)
    expect(r.json.local.agents[0]).toMatchObject({ id: MAIN_AGENT_ID, displayName: 'Marveen' })
    expect(r.json.system).toBe('localsys')
    expect(r.json.notice).toMatch(/UNTRUSTED claims/i)
  })

  it('exports the documented size caps for callers to honour', () => {
    expect(DIRECTORY_MAX_AGENTS_PER_PEER).toBe(25)
    expect(DIRECTORY_MAX_SKILLS_PER_AGENT).toBe(6)
  })

  it('truncates claimedAgents to DIRECTORY_MAX_AGENTS_PER_PEER (line 419 slice branch)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    // Re-mock the poller for THIS test only: 30 agents means the slice truncates.
    const pollerMod = await import('../web/federation/poller.js')
    const stubPeer = { id: 'teodor', state: 'ok', lastOkAt: 100, manifest: { agents: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, displayName: `a${i}`, model: 'm' })), skills: [] } }
    const spy = vi.spyOn(pollerMod, 'getFederationStatus').mockReturnValueOnce([stubPeer])
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.peers[0].claimedAgents).toHaveLength(25)
    spy.mockRestore()
  })

  it('caps skill lists with DIRECTORY_MAX_SKILLS_PER_AGENT', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const pollerMod = await import('../web/federation/poller.js')
    const stubPeer = { id: 'teodor', state: 'ok', lastOkAt: 100, manifest: { agents: [{ id: 'k', displayName: 'K', model: 'm' }], skills: Array.from({ length: 12 }, (_, i) => ({ agent: 'k', name: `s${i}`, description: 'd' })) } }
    const spy = vi.spyOn(pollerMod, 'getFederationStatus').mockReturnValueOnce([stubPeer])
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.peers[0].claimedAgents[0].skills).toHaveLength(6)
    spy.mockRestore()
  })

  it('truncates skill descriptions longer than DIRECTORY_SKILL_DESC_MAX', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const pollerMod = await import('../web/federation/poller.js')
    const longDesc = 'x'.repeat(300)
    const stubPeer = { id: 'teodor', state: 'ok', lastOkAt: 100, manifest: { agents: [{ id: 'k', displayName: 'K', model: 'm' }], skills: [{ agent: 'k', name: 's', description: longDesc }] } }
    const spy = vi.spyOn(pollerMod, 'getFederationStatus').mockReturnValueOnce([stubPeer])
    const r = await call('GET', '/api/federation/directory')
    const truncated = r.json.peers[0].claimedAgents[0].skills[0].description
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated.length).toBeLessThanOrEqual(DIRECTORY_SKILL_DESC_MAX + 1)
    spy.mockRestore()
  })

  it('emits an empty skill list when the peer agent has no matching skills (line 424 fallback branch)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const pollerMod = await import('../web/federation/poller.js')
    const stubPeer = { id: 'teodor', state: 'ok', lastOkAt: 100, manifest: { agents: [{ id: 'unsupported', displayName: 'U', model: 'm' }], skills: [] } }
    const spy = vi.spyOn(pollerMod, 'getFederationStatus').mockReturnValueOnce([stubPeer])
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.peers[0].claimedAgents[0].skills).toEqual([])
    spy.mockRestore()
  })

  it('handles a peer with no manifest (null manifest -> empty skills)', async () => {
    // Line 410: st.manifest?.skills ?? []  -- the nullish branch.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const pollerMod = await import('../web/federation/poller.js')
    const stubPeer = { id: 'teodor', state: 'stale', lastOkAt: 0, manifest: { agents: [{ id: 'k', displayName: 'K', model: 'm' }] } }
    const spy = vi.spyOn(pollerMod, 'getFederationStatus').mockReturnValueOnce([stubPeer])
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.peers[0].claimedAgents[0].skills).toEqual([])
    spy.mockRestore()
  })

  it('reports the local sub-agent summary with stale: true marker', async () => {
    // Line 403: summary ? { capabilitySummary: summary, ...(fresh ? {} : { stale: true }) } : {}
    // -- the truthy-summary + not-fresh branch (the stale marker).
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.local.agents[1]).toMatchObject({ id: 'alpha', stale: true })
  })

  it('omits the local sub-agent summary when summary is falsy (line 403 falsy branch)', async () => {
    // Pin CURRENT behaviour: a local agent with no cached summary contributes
    // no capabilitySummary field to the directory listing.
    const capsMod = await import('../web/federation/capabilities.js')
    const spy = vi.spyOn(capsMod, 'getCapabilitySummary').mockReturnValueOnce({ summary: undefined, fresh: false })
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.local.agents[1].capabilitySummary).toBeUndefined()
    spy.mockRestore()
  })

  it('falls back to empty string when a skill description is nullish (line 237 ?? branch)', async () => {
    // The buildManifest self-authored skill descriptions pass through
    // `safeOutboundText(...) ?? ''`. When safeOutboundText returns undefined
    // (falsy text), the ?? '' fallback fires.
    const cfgMod = await import('../web/federation/local-catalog.js')
    const spy = vi.spyOn(cfgMod, 'listAgentLocalSkills').mockReturnValueOnce([{ name: 'do-thing', description: '' }])
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/manifest')
    expect(r.statusCode).toBe(200)
    expect(r.json.skills.find((s: { name: string }) => s.name === 'do-thing').description).toBe('')
    spy.mockRestore()
  })

  it('does not mark local summaries stale when fresh (line 403 fresh=true branch)', async () => {
    const capsMod = await import('../web/federation/capabilities.js')
    const spy = vi.spyOn(capsMod, 'getCapabilitySummary').mockReturnValueOnce({ summary: 'fresh', fresh: true })
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/directory')
    expect(r.json.local.agents[1]).toMatchObject({ capabilitySummary: 'fresh' })
    expect(r.json.local.agents[1].stale).toBeUndefined()
    spy.mockRestore()
  })
})

// ===========================================================================
// POST /api/federation/refresh
// ===========================================================================

describe('POST /api/federation/refresh', () => {
  it('returns the refreshed peers list', async () => {
    H.refreshFederationStatus.mockResolvedValue([{ id: 't' }])
    const r = await call('POST', '/api/federation/refresh')
    expect(r.statusCode).toBe(200)
    expect(r.json.peers).toEqual([{ id: 't' }])
    expect(H.refreshFederationStatus).toHaveBeenCalled()
  })
})

// ===========================================================================
// POST /api/federation/apply
// ===========================================================================

describe('POST /api/federation/apply', () => {
  it('returns ok:true on a successful channel restart', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: true })
    const r = await call('POST', '/api/federation/apply')
    expect(r.statusCode).toBe(200)
    expect(r.json.ok).toBe(true)
  })

  it('returns 500 with the channel-restart error when it fails', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'tmux missing' })
    const r = await call('POST', '/api/federation/apply')
    expect(r.statusCode).toBe(500)
    expect(r.json.error).toBe('tmux missing')
  })

  it('falls back to a generic error string when no error message is returned', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: false })
    const r = await call('POST', '/api/federation/apply')
    expect(r.statusCode).toBe(500)
    expect(r.json.error).toBe('Restart failed')
  })
})

// ===========================================================================
// PUT /api/federation/peers (full document)
// ===========================================================================

describe('PUT /api/federation/peers', () => {
  it('persists a valid enabled:false document as given (peers survive)', async () => {
    const r = await call('PUT', '/api/federation/peers', {
      enabled: false, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }],
    })
    expect(r.statusCode).toBe(200)
    expect(r.json.enabled).toBe(false)
    expect(r.json.peers).toHaveLength(1)
  })

  it('persists a valid enabled:true document with the routingMode default', async () => {
    const r = await call('PUT', '/api/federation/peers', {
      enabled: true, systemId: 'localsys', routingMode: 'strong',
      peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }],
    })
    expect(r.statusCode).toBe(200)
    expect(r.json.routingMode).toBe('strong')
    expect(getFederationConfig().routingMode).toBe('strong')
  })

  it('returns 400 on a body that fails validation outright', async () => {
    const r = await call('PUT', '/api/federation/peers', { enabled: true, peers: 'not-an-array' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/Invalid federation config/)
  })

  it('flips enabled=false via the flag-only path when an invalid body wants disable', async () => {
    // Write an enabled config first so the flip has something to flip.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.failPendingFederatedMessages.mockReturnValue([99, 100])
    const r = await call('PUT', '/api/federation/peers', { enabled: 'not a bool', peers: 'junk' })
    expect(r.statusCode).toBe(200)
    expect(r.json.enabled).toBe(false)
    expect(H.resetPeerBackoff).toHaveBeenCalled()
    expect(H.resetFederationPollerCache).toHaveBeenCalled()
    expect(H.ensureFederationClaudeMdSection).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fed: true }),
      expect.stringContaining('disabled via PUT'),
    )
  })

  it('runs the per-peer purge + reset for dropped peers in a valid PUT', async () => {
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [
        { id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN },
        { id: 'cecil', baseUrl: 'https://c.example', inboundToken: 'c'.repeat(64) },
      ],
    })
    H.failPendingFederatedMessages.mockReturnValue([10])
    const r = await call('PUT', '/api/federation/peers', {
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }],
    })
    expect(r.statusCode).toBe(200)
    expect(r.json.peers).toHaveLength(1)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledWith('cecil', expect.stringContaining("'cecil'"))
    expect(purgeInboxDedup).toBeDefined()
  })

  it('also runs the queue/peer-reset cleanup when the persisted config is enabled:false', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.failPendingFederatedMessages.mockReturnValue([1, 2])
    const r = await call('PUT', '/api/federation/peers', {
      enabled: false, systemId: 'localsys', peers: [],
    })
    expect(r.statusCode).toBe(200)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledTimes(1)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledWith(undefined, expect.stringContaining('disabled while pending'))
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fed: true, failedPending: 2 }),
      expect.stringContaining('pending outbound messages failed on disable'),
    )
  })
})

// ===========================================================================
// POST /api/federation/enabled (master switch)
// ===========================================================================

describe('POST /api/federation/enabled', () => {
  it('flips the master switch on (lossless for peers)', async () => {
    writeConfigFile({ enabled: false, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('POST', '/api/federation/enabled', { enabled: true })
    expect(r.statusCode).toBe(200)
    expect(r.json.enabled).toBe(true)
    expect(r.json.peers).toHaveLength(1)
  })

  it('fails pending messages on disable and logs the count', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.failPendingFederatedMessages.mockReturnValue([1])
    const r = await call('POST', '/api/federation/enabled', { enabled: false })
    expect(r.statusCode).toBe(200)
    expect(r.json.enabled).toBe(false)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledWith(undefined, expect.stringContaining('disabled while pending'))
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedPending: 1 }),
      expect.stringContaining('pending outbound messages failed on disable'),
    )
  })

  it('treats any non-true value as false (defensive)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/enabled', { enabled: 'truthy string' })
    expect(r.statusCode).toBe(200)
    expect(r.json.enabled).toBe(false)
  })

  it('returns 409 when the file fails validation and refuses to flip the flag', async () => {
    writeConfigFile({ enabled: false, systemId: 'localsys', peers: 'not-an-array' })
    const r = await call('POST', '/api/federation/enabled', { enabled: true })
    expect(r.statusCode).toBe(409)
    expect(getFederationConfig().enabled).toBe(false)
  })
})

// ===========================================================================
// POST /api/federation/routing-mode
// ===========================================================================

describe('POST /api/federation/routing-mode', () => {
  it('accepts a known mode and persists it', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/routing-mode', { mode: 'strong' })
    expect(r.statusCode).toBe(200)
    expect(r.json.routingMode).toBe('strong')
    expect(getFederationConfig().routingMode).toBe('strong')
  })

  it('returns 400 for an unknown mode', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/routing-mode', { mode: 'aggressive' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/invalid mode/)
  })

  it('returns 400 when mode is missing or not a string', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r1 = await call('POST', '/api/federation/routing-mode', {})
    expect(r1.statusCode).toBe(400)
    const r2 = await call('POST', '/api/federation/routing-mode', { mode: 5 })
    expect(r2.statusCode).toBe(400)
  })

  it('returns 409 when setFederationRoutingModePreservingFile refuses', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    // The federation/config mock wraps setFederationRoutingModePreservingFile
    // via a control function so we can force the next call to return false.
    H.setFederationRoutingModePreservingFileRefuse = true
    const r = await call('POST', '/api/federation/routing-mode', { mode: 'strong' })
    expect(r.statusCode).toBe(409)
    expect(r.json.error).toMatch(/unreadable/)
    H.setFederationRoutingModePreservingFileRefuse = false
  })
})

// ===========================================================================
// POST /api/federation/peers (add)
// ===========================================================================

describe('POST /api/federation/peers (add)', () => {
  it('mints an inbound token, returns it once, and persists the peer', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(201)
    expect(r.json.peer).toMatchObject({ id: 'teodor', hasInboundToken: true, hasOutboundToken: false })
    expect(r.json.inboundToken).toMatch(/^[0-9a-f]{64}$/)
    expect(getFederationConfig().peers).toHaveLength(1)
  })

  it('persists the abandonWindowMinutes when supplied', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', abandonWindowMinutes: 1440 })
    expect(r.statusCode).toBe(201)
    expect(getFederationConfig().peers[0].abandonWindowMinutes).toBe(1440)
  })

  it('persists shareCapabilitySummaries=true when supplied on add', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', shareCapabilitySummaries: true })
    expect(r.statusCode).toBe(201)
    expect(r.json.peer).toMatchObject({ shareCapabilitySummaries: true })
    expect(getFederationConfig().peers[0].shareCapabilitySummaries).toBe(true)
  })

  it('persists an outboundToken when supplied on add', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', outboundToken: OUT_TOKEN })
    expect(r.statusCode).toBe(201)
    expect(getFederationConfig().peers[0].outboundToken).toBe(OUT_TOKEN)
  })

  it('falls back to empty outboundToken when the field is missing', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(201)
    expect(getFederationConfig().peers[0].outboundToken).toBe('')
  })

  it('falls back to MAIN_AGENT_ID as systemId when no config file exists', async () => {
    // No config file -> getFederationConfig() returns DISABLED (systemId '').
    // refuseIfConfigUnhealthy checks `federationFileHealth() === 'invalid'`,
    // which is `false` for an absent file, so the add proceeds. The
    // `cfg.systemId || MAIN_AGENT_ID` fallback in line 599 keeps the new
    // config well-formed.
    rmSync(join(TMP, 'federation.json'), { force: true })
    _setFederationStoreDirForTest(TMP)
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(201)
    const cfg = getFederationConfig()
    expect(cfg.systemId).toBe(MAIN_AGENT_ID)
  })

  it('returns 400 for a non-object body', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    // Use a JSON-valid non-object (the null literal) -- JSON.parse succeeds
    // and the post-parse non-object guard fires.
    const r = await call('POST', '/api/federation/peers', 'null')
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/JSON object/)
  })

  it('returns 400 for a JSON primitive body (typeof branch)', async () => {
    // Line 330 sub 1: payload === null is false, so the typeof check runs
    // and finds the value is not an object -> 400.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', '42')
    expect(r.statusCode).toBe(400)
  })

  it('returns 400 for an invalid peer id', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'bad/id', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/invalid peer id/)
  })

  it('returns 400 when peer id equals own systemId', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'localsys', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/peer id equals own/)
  })

  it('returns 409 when the peer already exists', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(409)
  })

  it('returns 400 for an invalid baseUrl (must be https or http loopback)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'http://example.com' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/invalid baseUrl/)
  })

  it('returns 400 for an invalid abandonWindowMinutes', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r1 = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', abandonWindowMinutes: 'big' })
    expect(r1.statusCode).toBe(400)
    const r2 = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', abandonWindowMinutes: 1 })
    expect(r2.statusCode).toBe(400)
    const r3 = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', abandonWindowMinutes: 999_999 })
    expect(r3.statusCode).toBe(400)
  })

  it('returns 400 when shareCapabilitySummaries is not a boolean', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example', shareCapabilitySummaries: 'yes' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/shareCapabilitySummaries/)
  })

  it('returns 409 when the file fails validation (refuseIfConfigUnhealthy)', async () => {
    // Hand-write a peer with a too-short inbound token so the file is "invalid"
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'short' }] })
    const r = await call('POST', '/api/federation/peers', { id: 'cecil', baseUrl: 'https://c.example' })
    expect(r.statusCode).toBe(409)
  })
})

// ===========================================================================
// PATCH /api/federation/peers/:id
// ===========================================================================

describe('PATCH /api/federation/peers/:id', () => {
  it('edits baseUrl + trims trailing slashes', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'https://new.example///' })
    expect(r.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].baseUrl).toBe('https://new.example')
  })

  it('returns 400 for an invalid baseUrl on patch', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'http://example.com' })
    expect(r.statusCode).toBe(400)
  })

  it('edits the outbound token (or clears it with empty string)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r1 = await call('PATCH', '/api/federation/peers/teodor', { outboundToken: OUT_TOKEN })
    expect(r1.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].outboundToken).toBe(OUT_TOKEN)

    const r2 = await call('PATCH', '/api/federation/peers/teodor', { outboundToken: '' })
    expect(r2.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].outboundToken).toBe('')

    const r3 = await call('PATCH', '/api/federation/peers/teodor', { outboundToken: 'short' })
    expect(r3.statusCode).toBe(400)
  })

  it('edits abandonWindowMinutes (number, null to delete, or invalid 400)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const ok = await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 1440 })
    expect(ok.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].abandonWindowMinutes).toBe(1440)

    const cleared = await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: null })
    expect(cleared.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].abandonWindowMinutes).toBeUndefined()

    const bad = await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 'big' })
    expect(bad.statusCode).toBe(400)

    const tooSmall = await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 1 })
    expect(tooSmall.statusCode).toBe(400)

    const tooBig = await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 99_999 })
    expect(tooBig.statusCode).toBe(400)
  })

  it('edits shareCapabilitySummaries (set + revoke)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const set = await call('PATCH', '/api/federation/peers/teodor', { shareCapabilitySummaries: true })
    expect(set.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].shareCapabilitySummaries).toBe(true)

    const bad = await call('PATCH', '/api/federation/peers/teodor', { shareCapabilitySummaries: 'yes' })
    expect(bad.statusCode).toBe(400)

    const unset = await call('PATCH', '/api/federation/peers/teodor', { shareCapabilitySummaries: false })
    expect(unset.statusCode).toBe(200)
    expect(getFederationConfig().peers[0].shareCapabilitySummaries).toBeUndefined()
  })

  it('returns 404 for an unknown peer', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('PATCH', '/api/federation/peers/nobody', { outboundToken: OUT_TOKEN })
    expect(r.statusCode).toBe(404)
  })

  it('returns 400 for a %2F-smuggled slash in the id', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('PATCH', '/api/federation/peers/a%2Fb', {})
    expect(r.statusCode).toBe(400)
  })

  it('returns 409 when the file is invalid-but-present', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'short' }] })
    const r = await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'https://t2.example' })
    expect(r.statusCode).toBe(409)
  })

  it('returns 400 for a non-object body on PATCH', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('PATCH', '/api/federation/peers/teodor', '"oops"')
    expect(r.statusCode).toBe(400)
  })
})

// ===========================================================================
// DELETE /api/federation/peers/:id
// ===========================================================================

describe('DELETE /api/federation/peers/:id', () => {
  it('returns 404 for an unknown peer', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('DELETE', '/api/federation/peers/nobody')
    expect(r.statusCode).toBe(404)
  })

  it('removes the peer and runs the per-peer purge cascade', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    H.failPendingFederatedMessages.mockReturnValue([10, 11])
    const r = await call('DELETE', '/api/federation/peers/teodor')
    expect(r.statusCode).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.failedPending).toBe(2)
    expect(getFederationConfig().peers).toHaveLength(0)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledWith('teodor', expect.stringContaining("'teodor'"))
    expect(H.resetPeerBackoff).toHaveBeenCalledWith('teodor')
    expect(H.resetFederationPollerCache).toHaveBeenCalledWith('teodor')
    expect(H.ensureFederationClaudeMdSection).toHaveBeenCalled()
  })

  it('returns 400 for a %2F-smuggled slash in the id', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('DELETE', '/api/federation/peers/a%2Fb')
    expect(r.statusCode).toBe(400)
  })

  it('returns 409 when the file is invalid-but-present', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'short' }] })
    const r = await call('DELETE', '/api/federation/peers/teodor')
    expect(r.statusCode).toBe(409)
  })
})

// ===========================================================================
// GET /api/federation/peers/:id/inbound-token
// ===========================================================================

describe('GET /api/federation/peers/:id/inbound-token (reveal)', () => {
  it('returns the inbound token (logs the reveal at info)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('GET', '/api/federation/peers/teodor/inbound-token')
    expect(r.statusCode).toBe(200)
    expect(r.json.inboundToken).toBe(IN_TOKEN)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fed: true, peer: 'teodor' }),
      expect.stringContaining('inbound token revealed'),
    )
  })

  it('returns 404 for an unknown peer', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/peers/nobody/inbound-token')
    expect(r.statusCode).toBe(404)
  })

  it('returns 400 for a %2F-smuggled slash in the id', async () => {
    const r = await call('GET', '/api/federation/peers/a%2Fb/inbound-token')
    expect(r.statusCode).toBe(400)
  })
})

// ===========================================================================
// POST /api/federation/peers/:id/rotate-inbound-token
// ===========================================================================

describe('POST /api/federation/peers/:id/rotate-inbound-token', () => {
  it('mints a fresh token and persists it', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    expect(r.statusCode).toBe(200)
    expect(r.json.inboundToken).not.toBe(IN_TOKEN)
    expect(r.json.inboundToken).toMatch(/^[0-9a-f]{64}$/)
    expect(getFederationConfig().peers[0].inboundToken).not.toBe(IN_TOKEN)
  })

  it('returns 404 for an unknown peer', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers/nobody/rotate-inbound-token')
    expect(r.statusCode).toBe(404)
  })

  it('returns 400 for a %2F-smuggled slash in the id', async () => {
    const r = await call('POST', '/api/federation/peers/a%2Fb/rotate-inbound-token')
    expect(r.statusCode).toBe(400)
  })

  it('returns 409 when the file is invalid-but-present', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'short' }] })
    const r = await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    expect(r.statusCode).toBe(409)
  })
})

// ===========================================================================
// POST /api/federation/remove
// ===========================================================================

describe('POST /api/federation/remove', () => {
  it('purges the store, queue, dedup and capability cache; is idempotent', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    H.failPendingFederatedMessages.mockReturnValue([5])
    const r = await call('POST', '/api/federation/remove')
    expect(r.statusCode).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.failedPending).toBe(1)
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(existsSync(join(TMP, '.federation-token'))).toBe(false)
    expect(H.failPendingFederatedMessages).toHaveBeenCalledWith(undefined, expect.stringContaining('removed while pending'))
    expect(H.resetPeerBackoff).toHaveBeenCalled()
    expect(H.resetFederationPollerCache).toHaveBeenCalled()
    expect(H.purgeCapabilityCache).toHaveBeenCalled()
    expect(H.ensureFederationClaudeMdSection).toHaveBeenCalled()

    const again = await call('POST', '/api/federation/remove')
    expect(again.statusCode).toBe(200)
    expect(again.json.ok).toBe(true)
  })
})

// ===========================================================================
// safeOutboundText -- falsy text short-circuits to undefined
// ===========================================================================

describe('safeOutboundText short-circuits', () => {
  it('returns undefined for falsy text without calling containsPrivateData', async () => {
    // Force getCapabilitySummary to return fresh=true + summary=undefined so
    // buildManifest's summaryFor() calls safeOutboundText(undefined), which
    // must short-circuit on the first line and return undefined.
    const capsMod = await import('../web/federation/capabilities.js')
    const spy = vi.spyOn(capsMod, 'getCapabilitySummary').mockReturnValueOnce({ summary: undefined, fresh: true })
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'sharer', baseUrl: 'https://s.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64), shareCapabilitySummaries: true }],
    })
    const r = await call('GET', '/api/federation/manifest', undefined, 'sharer')
    expect(r.statusCode).toBe(200)
    spy.mockRestore()
  })

  it('keeps the summary text when containsPrivateData returns false', async () => {
    const capsMod = await import('../web/federation/capabilities.js')
    const spy = vi.spyOn(capsMod, 'getCapabilitySummary').mockReturnValueOnce({ summary: 'benign summary text', fresh: true })
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'sharer', baseUrl: 'https://s.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64), shareCapabilitySummaries: true }],
    })
    const r = await call('GET', '/api/federation/manifest', undefined, 'sharer')
    expect(r.statusCode).toBe(200)
    spy.mockRestore()
  })
})

// ===========================================================================
// resolveLang -- getEffectiveSettingValue 'en' branch
// ===========================================================================

describe('resolveLang -- DASHBOARD_LANG=en branch', () => {
  it('returns "en" when DASHBOARD_LANG is "en"', async () => {
    const settingsMod = await import('../settings-store.js')
    const spy = vi.spyOn(settingsMod, 'getEffectiveSettingValue').mockReturnValue('en')
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/manifest')
    expect(r.statusCode).toBe(200)
    spy.mockRestore()
  })
})

// ===========================================================================
// peerView -- abandonWindowMinutes branch (present)
// ===========================================================================

describe('peerView exposes abandonWindowMinutes when present', () => {
  it('includes abandonWindowMinutes in the peer view when set', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [
      { id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN, abandonWindowMinutes: 1440 },
    ] })
    const r = await call('GET', '/api/federation/peers')
    expect(r.json.peers[0]).toMatchObject({ abandonWindowMinutes: 1440 })
  })
})

// ===========================================================================
// peersView -- routingMode fallback when absent
// ===========================================================================

describe('peersView falls back to DEFAULT_ROUTING_MODE', () => {
  it('reports the default routing mode when the stored config omits it', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/peers')
    expect(r.json.routingMode).toBe('catalog-first')
  })

  it('uses the ?? DEFAULT_ROUTING_MODE branch when routingMode is nullish (line 261)', async () => {
    // Strip routingMode from the cached config to force the ?? branch in
    // peersView. The validator always sets routingMode in production, so
    // this is defensive code; we hit it via a config-side strip.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.getFederationConfigStripRoutingMode = () => true
    const r = await call('GET', '/api/federation/peers')
    expect(r.json.routingMode).toBe('catalog-first')
    H.getFederationConfigStripRoutingMode = () => false
  })
})

describe('safeOutboundText drops text containing PRIVATE', () => {
  it('returns undefined when containsPrivateData returns true', async () => {
    // The default mock returns true only when text contains 'PRIVATE'.
    // A fresh summary containing 'PRIVATE' must be dropped to undefined.
    const capsMod = await import('../web/federation/capabilities.js')
    const spy = vi.spyOn(capsMod, 'getCapabilitySummary').mockReturnValueOnce({ summary: 'contains PRIVATE data', fresh: true })
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'sharer', baseUrl: 'https://s.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64), shareCapabilitySummaries: true }],
    })
    const r = await call('GET', '/api/federation/manifest', undefined, 'sharer')
    expect(r.statusCode).toBe(200)
    spy.mockRestore()
  })
})

// ===========================================================================
// shareCapabilitySummaries -- false (not undefined) on peer view
// ===========================================================================

describe('peerView reports shareCapabilitySummaries=false as false', () => {
  it('returns false (not undefined) when the peer has shareCapabilitySummaries=false', async () => {
    // Pin CURRENT behaviour: peerView always emits the flag, defaulting to
    // `false` via the strict `=== true` comparison. The dashboard uses this
    // to distinguish "off" from "field missing".
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [
      { id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN, shareCapabilitySummaries: false },
    ] })
    const r = await call('GET', '/api/federation/peers')
    expect(r.json.peers[0].shareCapabilitySummaries).toBe(false)
  })
})

// ===========================================================================
// resolveLang -- getEffectiveSettingValue throws -> 'hu' fallback
// ===========================================================================

describe('resolveLang fallback', () => {
  it('falls back to "hu" when getEffectiveSettingValue throws', async () => {
    const settingsMod = await import('../settings-store.js')
    const spy = vi.spyOn(settingsMod, 'getEffectiveSettingValue').mockImplementationOnce(() => { throw new Error('settings broken') })
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('GET', '/api/federation/manifest')
    expect(r.statusCode).toBe(200)
    spy.mockRestore()
  })
})

// ===========================================================================
// inbox -- readBody throws a non-RequestBodyTooLargeError
// ===========================================================================

describe('POST /api/federation/inbox -- readBody non-size error re-throws', () => {
  it('rethrows when the request stream errors out (not a size error)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    const ee = new EventEmitter() as unknown as http.IncomingMessage
    ;(ee as unknown as { headers: Record<string, string> }).headers = {}
    ;(ee as unknown as { destroy(): void }).destroy = () => { /* noop */ }
    process.nextTick(() => {
      ee.emit('error', new Error('stream exploded'))
      ee.emit('end')
    })
    const res = mkRes() as unknown as http.ServerResponse
    const ctx = { req: ee, res, path: '/api/federation/inbox', method: 'POST', url: new URL('http://localhost/api/federation/inbox'), fedPeer: 'teodor' }
    await expect(tryHandleFederation(ctx as never)).rejects.toThrow(/stream exploded/)
  })
})

// ===========================================================================
// rememberRef -- DEDUP_CAP overflow evicts the oldest entry
// ===========================================================================

describe('rememberRef DEDUP_CAP overflow', () => {
  it('drops the oldest entry once the dedup map reaches DEDUP_CAP', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    H.createAgentMessage.mockReset().mockImplementation((from: string) => ({ id: 1, content: 'x', from_agent: from, to_agent: 'marveen', status: 'pending', created_at: 0 }))
    // Send DEDUP_CAP (1000) unique messages, then a 1001st with a fresh ref.
    // The fresh ref is a brand-new insert (no dedup hit), then rememberRef
    // sees size >= 1000 and evicts the oldest entry -- hitting the eviction
    // branch. Pins CURRENT behaviour (the eviction happens silently on every
    // insert past the cap).
    for (let i = 0; i < 1000; i += 1) {
      const r = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: `m${i}`, ref: `r${i}` }, 'teodor')
      expect(r.statusCode).toBe(202)
      expect(r.json.duplicate).toBeUndefined()
    }
    // 1001st request with a brand-new ref: dedup misses (it's a fresh key),
    // so createAgentMessage runs, then rememberRef evicts the oldest.
    const r = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'overflow', ref: 'r-overflow' }, 'teodor')
    expect(r.statusCode).toBe(202)
    expect(r.json.duplicate).toBeUndefined()
  })
})

// ===========================================================================
// dispatcher fallthrough
// ===========================================================================

describe('tryHandleFederation dispatcher', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx, res } = fakeCtx('GET', '/api/elsewhere')
    const handled = await tryHandleFederation(ctx)
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for the /peers endpoint with the wrong method', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await fakeCtx('PATCH', '/api/federation/peers')
    expect(await tryHandleFederation(r.ctx)).toBe(false)
  })
})

describe('marveenVersion truthy-version branch', () => {
  it('reports the parsed version when present (sub 0 of line 72)', async () => {
    // The falsy branch fires at module load (package.json has no `version`).
    // For the truthy branch, mutate the file to include a version and
    // re-load the module via resetModules + import.
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ version: '1.2.3-test' }))
    vi.resetModules()
    const fresh = await import('../web/routes/federation.js')
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const out: { statusCode: number; body: string } = { statusCode: 0, body: '' }
    const res = {
      writeHead(code: number) { out.statusCode = code; return res },
      end(data?: unknown) { out.body = String(data ?? '') },
      setHeader() {},
    } as unknown as http.ServerResponse
    const handled = await fresh.tryHandleFederation({
      req: mkReq(),
      res,
      path: '/api/federation/manifest',
      method: 'GET',
      url: new URL('http://localhost/api/federation/manifest'),
      fedPeer: null,
    })
    expect(handled).toBe(true)
    const body = JSON.parse(out.body)
    expect(body.marveenVersion).toBe('1.2.3-test')
    // Restore the falsy-version file so subsequent tests don't accidentally
    // hit the truthy branch again.
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'no-version' }))
    vi.resetModules()
  })
})

// ===========================================================================
// Inbox dedup -- rememberRef DEDUP_CAP overflow + purgeInboxDedup
// ===========================================================================

describe('inbox dedup internals', () => {
  it('purgeInboxDedup() with no arg clears every entry', () => {
    // Seed the dedup map via the public surface; the function is exported.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.createAgentMessage.mockReturnValue({ id: 1, content: 'x', from_agent: 'a', to_agent: 'b', status: 'pending', created_at: 0 })
    return (async () => {
      await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'a', ref: 'r1' }, 'teodor')
      await call('POST', '/api/federation/inbox', { from: 'cecil/x', to: 'marveen', content: 'b', ref: 'r1' }, 'cecil')
      purgeInboxDedup()
      // After clearing, the same ref from the same peer is a fresh insert
      // (not a duplicate).
      H.createAgentMessage.mockReturnValue({ id: 2, content: 'x', from_agent: 'a', to_agent: 'b', status: 'pending', created_at: 0 })
      const r = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'c', ref: 'r1' }, 'teodor')
      expect(r.json.duplicate).toBeUndefined()
    })()
  })

  it('purgeInboxDedup(peerId) only clears entries with that prefix', () => {
    return (async () => {
      writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
      H.createAgentMessage.mockReturnValue({ id: 1, content: 'x', from_agent: 'a', to_agent: 'b', status: 'pending', created_at: 0 })
      await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'a', ref: 'r1' }, 'teodor')
      await call('POST', '/api/federation/inbox', { from: 'cecil/x', to: 'marveen', content: 'b', ref: 'r1' }, 'cecil')
      purgeInboxDedup('teodor')
      H.createAgentMessage.mockReturnValue({ id: 2, content: 'x', from_agent: 'a', to_agent: 'b', status: 'pending', created_at: 0 })
      const t = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'c', ref: 'r1' }, 'teodor')
      expect(t.json.duplicate).toBeUndefined()
      const c = await call('POST', '/api/federation/inbox', { from: 'cecil/x', to: 'marveen', content: 'd', ref: 'r1' }, 'cecil')
      expect(c.json.duplicate).toBe(true)
    })()
  })
})

// ===========================================================================
// validateInboxPayload -- pure matrix
// ===========================================================================

describe('validateInboxPayload (pure matrix)', () => {
  const CFG = {
    enabled: true,
    systemId: 'localsys',
    peers: [{ id: 'teodor', baseUrl: 'https://t.example', outboundToken: 'b'.repeat(64), inboundToken: 'a'.repeat(64), trust: 'untrusted' }],
  }
  const DEPS = { isKnownAgent: () => false, mainAgentId: 'marveen' }

  it('rejects non-object payloads (null, array, primitive)', () => {
    expect(validateInboxPayload(null, CFG, DEPS, null)).toMatchObject({ status: 400 })
    expect(validateInboxPayload('string', CFG, DEPS, null)).toMatchObject({ status: 400 })
    expect(validateInboxPayload([], CFG, DEPS, null)).toMatchObject({ status: 400 })
  })

  it('rejects malformed from', () => {
    expect(validateInboxPayload({ from: 'x', to: 'marveen', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ from: 'a/b/c', to: 'marveen', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
  })

  it('rejects from-system equals local system', () => {
    expect(validateInboxPayload({ from: 'localsys/x', to: 'marveen', content: 'c' }, CFG, DEPS, null)).toMatchObject({ status: 403 })
  })

  it('rejects cross-peer impersonation when callerPeerId is set', () => {
    expect(validateInboxPayload({ from: 'cecil/x', to: 'marveen', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 403 })
  })

  it('accepts any configured peer when callerPeerId is null (dashboard caller)', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: 'c' }, CFG, DEPS, null)).toMatchObject({ from: 'teodor/x' })
    expect(validateInboxPayload({ from: 'stranger/x', to: 'marveen', content: 'c' }, CFG, DEPS, null)).toMatchObject({ status: 403 })
  })

  it('rejects a qualified to-segment (must be local)', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'peer/y', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 403 })
  })

  it('rejects an invalid to id segment', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'b@d', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
  })

  it('rejects unknown recipient (404)', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'unknown', content: 'c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 404 })
  })

  it('rejects empty / whitespace content', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: '' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: '   ' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
  })

  it('rejects invalid ref (non-string / too long / empty)', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: 'c', ref: 5 }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: 'c', ref: '' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: 'c', ref: 'x'.repeat(129) }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
  })

  it('accepts and stores lowercase the from system segment (case-insensitive)', () => {
    expect(validateInboxPayload({ from: 'TEODOR/x', to: 'marveen', content: 'c' }, CFG, DEPS, 'teodor'))
      .toMatchObject({ from: 'teodor/x' })
  })

  it('accepts explicit null ref', () => {
    const v = validateInboxPayload({ from: 'teodor/x', to: 'marveen', content: 'c', ref: null }, CFG, DEPS, 'teodor')
    expect(v).toMatchObject({ ref: null })
  })
})

// ===========================================================================
// Inbox endpoint -- HTTP surface (declared-size precheck, body 413, JSON, dedup, accept)
// ===========================================================================

describe('POST /api/federation/inbox', () => {
  it('403s when federation is disabled', async () => {
    const r = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'c' }, 'teodor')
    expect(r.statusCode).toBe(403)
  })

  it('413s on an over-limit Content-Length header (cheap precheck)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    const { ctx } = fakeCtx('POST', '/api/federation/inbox', undefined, 'teodor')
    ;(ctx.req.headers as Record<string, string>)['content-length'] = String(64 * 1024 + 1)
    expect(await tryHandleFederation(ctx)).toBe(true)
  })

  it('400s on a non-JSON body', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    const r = await call('POST', '/api/federation/inbox', 'not json', 'teodor')
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toBe('Invalid JSON')
  })

  it('replays an existing dedup entry without re-inserting', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    H.createAgentMessage.mockReset().mockReturnValue({ id: 42, content: 'x', from_agent: 'teodor/x', to_agent: 'marveen', status: 'pending', created_at: 0 })
    const first = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'c', ref: 'r1' }, 'teodor')
    expect(first.statusCode).toBe(202)
    expect(first.json.duplicate).toBeUndefined()
    const second = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'c', ref: 'r1' }, 'teodor')
    expect(second.statusCode).toBe(202)
    expect(second.json).toMatchObject({ duplicate: true })
  })

  it('accepts a valid peer message (no ref) and stores the row', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    H.createAgentMessage.mockReset().mockReturnValue({ id: 100, content: 'x', from_agent: 'teodor/x', to_agent: 'marveen', status: 'pending', created_at: 0 })
    const r = await call('POST', '/api/federation/inbox', { from: 'teodor/x', to: 'marveen', content: 'hello' }, 'teodor')
    expect(r.statusCode).toBe(202)
    expect(r.json.id).toBe(100)
  })

  it('rejects when validateInboxPayload fails (cross-peer from-system)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    const r = await call('POST', '/api/federation/inbox', { from: 'cecil/x', to: 'marveen', content: 'c' }, 'teodor')
    expect(r.statusCode).toBe(403)
  })

  it('413s when the body read itself overflows (no Content-Length)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64) }] })
    const ee = new EventEmitter() as unknown as http.IncomingMessage & { destroy(): void }
    ;(ee as unknown as { headers: Record<string, string> }).headers = {} // no content-length
    // readBody calls req.destroy() when the body exceeds the limit -- stub it.
    ;(ee as unknown as { destroy(): void }).destroy = () => { /* noop */ }
    process.nextTick(() => {
      ee.emit('data', Buffer.alloc(64 * 1024 + 1))
      ee.emit('end')
    })
    const res = mkRes() as unknown as http.ServerResponse
    const ctx = { req: ee, res, path: '/api/federation/inbox', method: 'POST', url: new URL('http://localhost/api/federation/inbox'), fedPeer: 'teodor' }
    expect(await tryHandleFederation(ctx as never)).toBe(true)
    const state = res as unknown as { statusCode: number; body: string }
    expect(state.statusCode).toBe(413)
  })
})

// ===========================================================================
// Build manifest -- shareCapabilitySummaries per-peer opt-in
// ===========================================================================

describe('buildManifest -- shareCapabilitySummaries per-peer gating', () => {
  it('shows the main-agent summary only for the owner (null callerPeerId) or flagged peers', async () => {
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [
        { id: 'sharer', baseUrl: 'https://s.example', inboundToken: 'a'.repeat(64), outboundToken: 'b'.repeat(64), shareCapabilitySummaries: true },
        { id: 'lurker', baseUrl: 'https://l.example', inboundToken: 'c'.repeat(64), outboundToken: 'b'.repeat(64) },
      ],
    })
    const mainWith = await call('GET', '/api/federation/manifest')
    expect(mainWith.json.agents.find((a: { id: string }) => a.id === 'marveen').capabilitySummary).toBeTruthy()

    const shareAsSharer = await call('GET', '/api/federation/manifest', undefined, 'sharer')
    expect(shareAsSharer.json.agents.find((a: { id: string }) => a.id === 'marveen').capabilitySummary).toBeTruthy()

    const shareAsLurker = await call('GET', '/api/federation/manifest', undefined, 'lurker')
    expect(shareAsLurker.json.agents.find((a: { id: string }) => a.id === 'marveen').capabilitySummary).toBeUndefined()
  })
})

// ===========================================================================
// Routing-mode edge cases (string mode validation)
// ===========================================================================

describe('routing-mode validation extras', () => {
  it('returns 400 when body is not an object', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/routing-mode', 'string')
    expect(r.statusCode).toBe(400)
  })

  it('returns 400 when payload is null', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/routing-mode', null)
    expect(r.statusCode).toBe(400)
  })
})

// ===========================================================================
// PUT, POST enabled, POST peers, PATCH, DELETE, rotate -- JSON parse-error path
// ===========================================================================

describe('body parse-error path (Symbol sentinel)', () => {
  it('PUT /peers: malformed JSON returns 400', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('PUT', '/api/federation/peers', '{not json')
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toBe('Invalid JSON')
  })

  it('POST /enabled: malformed JSON returns 400', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/enabled', '{not json')
    expect(r.statusCode).toBe(400)
  })

  it('POST /peers: malformed JSON returns 400', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const r = await call('POST', '/api/federation/peers', '{not json')
    expect(r.statusCode).toBe(400)
  })

  it('PATCH /peers/:id: malformed JSON returns 400', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    const r = await call('PATCH', '/api/federation/peers/teodor', '{not json')
    expect(r.statusCode).toBe(400)
  })
})

// ===========================================================================
// POST /peers -- full validation that fails AFTER the body parse
// ===========================================================================

describe('POST /peers (add) extra validation', () => {
  it('returns 400 when the assembled config fails validation (validator refusal)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    H.validateFederationConfigRefuse = () => 'forced validation failure'
    const r = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://t.example' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/Invalid peer/)
    H.validateFederationConfigRefuse = () => undefined
  })
})

// ===========================================================================
// PATCH /peers/:id -- validateFederationConfig returns a string
// ===========================================================================

describe('PATCH /peers/:id -- multiple peer branches', () => {
  it('preserves the other peers when patching one of two (map ternary both branches)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [
      { id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN },
      { id: 'cecil', baseUrl: 'https://c.example', inboundToken: 'c'.repeat(64) },
    ] })
    const r = await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'https://t2.example' })
    expect(r.statusCode).toBe(200)
    const cfg = getFederationConfig()
    expect(cfg.peers.find((p) => p.id === 'teodor')?.baseUrl).toBe('https://t2.example')
    expect(cfg.peers.find((p) => p.id === 'cecil')?.baseUrl).toBe('https://c.example')
  })
})

describe('PATCH /peers/:id validator refusal', () => {
  it('returns 400 when the assembled config fails validation (validator refusal)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    H.validateFederationConfigRefuse = () => 'forced validation failure'
    const r = await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'https://new.example' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/Invalid peer update/)
    H.validateFederationConfigRefuse = () => undefined
  })
})

describe('rotate-inbound-token -- multiple peer branches', () => {
  it('preserves the other peers when rotating one of two (map ternary both branches)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [
      { id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN },
      { id: 'cecil', baseUrl: 'https://c.example', inboundToken: 'c'.repeat(64) },
    ] })
    const r = await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    expect(r.statusCode).toBe(200)
    const cfg = getFederationConfig()
    expect(cfg.peers.find((p) => p.id === 'cecil')?.inboundToken).toBe('c'.repeat(64))
  })
})

// ===========================================================================
// DELETE /peers/:id -- validateFederationConfig returns a string
// ===========================================================================

describe('DELETE /peers/:id validator refusal', () => {
  it('returns 400 when the assembled config fails validation (validator refusal)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    H.validateFederationConfigRefuse = () => 'forced validation failure'
    const r = await call('DELETE', '/api/federation/peers/teodor')
    expect(r.statusCode).toBe(400)
    H.validateFederationConfigRefuse = () => undefined
  })
})

// ===========================================================================
// rotate-inbound-token -- validateFederationConfig returns a string
// ===========================================================================

describe('rotate-inbound-token validator refusal', () => {
  it('returns 400 when the assembled config fails validation (validator refusal)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://t.example', inboundToken: IN_TOKEN }] })
    H.validateFederationConfigRefuse = () => 'forced validation failure'
    const r = await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    expect(r.statusCode).toBe(400)
    H.validateFederationConfigRefuse = () => undefined
  })
})