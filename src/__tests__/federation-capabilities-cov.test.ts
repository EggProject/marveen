// Supplemental tests for src/web/federation/capabilities.ts that reach the
// remaining v8-uncovered branches/lines in the existing
// federation-capabilities.test.ts suite:
//   - line 71  : _resetCapabilityCacheForTest body (never called from prod)
//   - lines 78-83 : readCapabilityCache parse/catch paths and the
//                   type-guard ternary (null / non-object / array all reject)
//   - line 98  : purgeCapabilityCache non-ENOENT unlink error
//   - line 131 : readSummarySource skills map callback executes for at least
//                one entry (the existing suite only ever sees an empty list)
//
// Strategy: redirect the local-catalog view of `agentDir` via a `../web/
// agent-config.js` mock so we can drop real .claude/skills/<skill>/ trees on
// disk and exercise the .map callback without polluting the repo's own
// agents/. Use a node:fs Proxy mock for the unlinkSync-fails-but-not-ENOENT
// path (vi.spyOn cannot mutate an ESM export). The existing tests already pin
// the happy-path behaviour -- these tests are strictly additive coverage.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PROJECT = mkdtempSync(join(tmpdir(), 'fed-cap-cov-project-'))
const TMP = mkdtempSync(join(tmpdir(), 'fed-cap-cov-store-'))
mkdirSync(join(PROJECT, 'agents'), { recursive: true })

// Mock the ONLY agent-config.js that exists in this repo (src/web/agent-
// config.ts). Both capabilities.ts and local-catalog.ts import from the same
// path relative to their own location, so this single mock governs both
// `agentDir` callers the capabilities module reaches.
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: (name: string) => join(PROJECT, 'agents', name),
    readAgentDisplayName: (_name: string) => 'Test Display',
    readAgentModel: (_name: string) => 'claude-sonnet-5',
  }
})

// node:fs Proxy so we can fault-inject unlinkSync without vi.spyOn (ESM
// exports are not configurable). Default: pass through to the real impl.
let unlinkSyncFault: ((p: string) => never) | null = null
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'unlinkSync' && unlinkSyncFault) {
        return (p: string) => unlinkSyncFault!(p)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

const IN_TOKEN = 'i'.repeat(64)
const OUT_TOKEN = 'o'.repeat(64)

beforeEach(async () => {
  // Wipe the project subtree so each test can plant its own skill tree.
  rmSync(join(PROJECT, 'agents'), { recursive: true, force: true })
  rmSync(join(TMP, 'capability-summaries.json'), { force: true })
  rmSync(join(TMP, 'federation.json'), { force: true })
  rmSync(join(TMP, '.dashboard-token'), { force: true })
  mkdirSync(join(PROJECT, 'agents'), { recursive: true })
  unlinkSyncFault = null
  const caps = await import('../web/federation/capabilities.js')
  caps._setCapabilityStoreDirForTest(TMP)
  caps._resetCapabilityCacheForTest()
  const cfg = await import('../web/federation/config.js')
  cfg._setFederationStoreDirForTest(TMP)
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
})

describe('federation/capabilities supplemental coverage', () => {
  it('_resetCapabilityCacheForTest clears the in-memory cache so the next read hits disk', async () => {
    const caps = await import('../web/federation/capabilities.js')
    caps.writeCapabilityCache({ seed: { summary: 'seed', sourceHash: 'h' } })
    expect(caps.readCapabilityCache()).toEqual({ seed: { summary: 'seed', sourceHash: 'h' } })
    caps._resetCapabilityCacheForTest()
    // File is still on disk; a fresh read must repopulate from it.
    expect(caps.readCapabilityCache()).toEqual({ seed: { summary: 'seed', sourceHash: 'h' } })
  })

  it('readCapabilityCache type-guards non-object JSON values back to {}', async () => {
    const caps = await import('../web/federation/capabilities.js')
    for (const bad of ['null', '[1,2,3]', '"oops"', '42']) {
      writeFileSync(join(TMP, 'capability-summaries.json'), bad)
      caps._resetCapabilityCacheForTest()
      expect(caps.readCapabilityCache()).toEqual({})
    }
    // Malformed JSON falls through the catch into the {} default.
    writeFileSync(join(TMP, 'capability-summaries.json'), '{ not-json')
    caps._resetCapabilityCacheForTest()
    expect(caps.readCapabilityCache()).toEqual({})
  })

  it('readCapabilityCache parses a well-formed cache file freshly written to disk', async () => {
    const caps = await import('../web/federation/capabilities.js')
    writeFileSync(join(TMP, 'capability-summaries.json'), JSON.stringify({
      kept: { summary: 'kept summary', sourceHash: 'h1' },
    }))
    caps._resetCapabilityCacheForTest()
    const c = caps.readCapabilityCache()
    expect(c).toEqual({ kept: { summary: 'kept summary', sourceHash: 'h1' } })
    // Second call returns the memoised cache (covers the cache !== null branch).
    expect(caps.readCapabilityCache()).toBe(c)
  })

  it('purgeCapabilityCache warns but does not throw on a non-ENOENT unlink failure', async () => {
    const caps = await import('../web/federation/capabilities.js')
    const logger = await import('../logger.js')
    writeFileSync(join(TMP, 'capability-summaries.json'), '{}')
    caps._resetCapabilityCacheForTest()
    unlinkSyncFault = () => {
      const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException
      err.code = 'EBUSY'
      throw err
    }
    const warn = vi.spyOn(logger.logger, 'warn').mockImplementation(() => {})
    expect(() => caps.purgeCapabilityCache()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.any(Object), 'capabilities: cache unlink failed')
    // cache is still cleared even when unlink fails.
    expect(caps.readCapabilityCache()).toEqual({})
    warn.mockRestore()
  })

  it('readSummarySource returns the .claude/skills entries through the .map callback', async () => {
    const caps = await import('../web/federation/capabilities.js')
    const agentDir = join(PROJECT, 'agents', 'skilled')
    mkdirSync(join(agentDir, '.claude', 'skills', 'video-edit'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'skills', 'video-edit', 'SKILL.md'),
      '---\ndescription: Video editing pipeline.\n---\nbody\n')
    mkdirSync(join(agentDir, '.claude', 'skills', 'caption'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'skills', 'caption', 'SKILL.md'),
      '---\ndescription: Caption writing.\n---\nbody\n')
    const src = caps.readSummarySource('skilled')
    expect(src.skills).toEqual([
      { name: 'caption', description: 'Caption writing.' },
      { name: 'video-edit', description: 'Video editing pipeline.' },
    ])
    // The summarySourceHash must incorporate skills, so adding a skill flips
    // the hash and any cached entry becomes stale (line 215 freshness check).
    const before = caps.summarySourceHash(src, 'en')
    src.skills.push({ name: 'extra', description: 'Extra' })
    expect(caps.summarySourceHash(src, 'en')).not.toBe(before)
  })

  it('containsPrivateData catches a CONFIGURED drive folder id and chat id (non-empty constant branches)', async () => {
    // The boot-time constants OWNER_DRIVE_FOLDER and ALLOWED_CHAT_ID come from
    // .env at import time and are '' in the default test env. Drop a fresh
    // .env, reset the module registry, and re-import config.js / capabilities
    // .js so the new boot-time constants take effect.
    const cfgDir = mkdtempSync(join(tmpdir(), 'fed-cap-env-'))
    writeFileSync(join(cfgDir, '.env'),
      'OWNER_DRIVE_FOLDER=DriveFolderSecretXYZ\nALLOWED_CHAT_ID=999900009999\n')
    const previous = process.env['CLAUDECLAW_ENV_DIR']
    process.env['CLAUDECLAW_ENV_DIR'] = cfgDir
    try {
      vi.resetModules()
      const caps = await import('../web/federation/capabilities.js')
      caps._setCapabilityStoreDirForTest(TMP)
      const cfg = await import('../web/federation/config.js')
      cfg._setFederationStoreDirForTest(TMP)
      expect(caps.containsPrivateData('shares to DriveFolderSecretXYZ weekly')).toBe('drive folder')
      expect(caps.containsPrivateData('pings the 999900009999 group')).toBe('chat id')
    } finally {
      if (previous === undefined) delete process.env['CLAUDECLAW_ENV_DIR']
      else process.env['CLAUDECLAW_ENV_DIR'] = previous
      rmSync(cfgDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('containsPrivateData catches the peer OUTBOUND token (the inbound-only test leaves this branch cold)', async () => {
    const caps = await import('../web/federation/capabilities.js')
    const cfg = await import('../web/federation/config.js')
    writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }],
    }))
    cfg.reloadFederationForTest()
    expect(caps.containsPrivateData(`leak ${OUT_TOKEN} here`)).toBe('peer token')
  })

  it('containsPrivateData prefers the DASHBOARD_TOKEN env var over the on-disk token file', async () => {
    // The DASHBOARD_TOKEN env-first branch of readDashboardTokenBestEffort
    // is cold in the default test env (DASHBOARD_TOKEN unset). Plant an
    // on-disk token AND set the env var so the env path wins, and a leak of
    // the on-disk token would still be caught (the env var is a different
    // string).
    const caps = await import('../web/federation/capabilities.js')
    const onDisk = 'o'.repeat(64)
    const inEnv = 'e'.repeat(64)
    writeFileSync(join(TMP, '.dashboard-token'), onDisk)
    const previous = process.env['DASHBOARD_TOKEN']
    process.env['DASHBOARD_TOKEN'] = inEnv
    try {
      // Env-wins: a leak of the env value is caught.
      expect(caps.containsPrivateData(`leak ${inEnv} here`)).toBe('dashboard token')
      // The on-disk value is NOT scrubbed in this configuration (env-first
      // mirrors loadOrCreateDashboardToken's resolution order).
      expect(caps.containsPrivateData(`leak ${onDisk} here`)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env['DASHBOARD_TOKEN']
      else process.env['DASHBOARD_TOKEN'] = previous
    }
  })

  it('pickStaleAgents handles an entry with no consecutiveFailures field (the ?? 0 branch)', async () => {
    const caps = await import('../web/federation/capabilities.js')
    const hash = 'hf'
    // Same hash as candidate, no summary, no rejected, no consecutiveFailures
    // defined -- the `?? 0` branch must default to 0 and the entry must be
    // eligible (failures === 0 means no backoff applied).
    const cacheNoFailures: Record<string, unknown> = {
      a: { sourceHash: hash, lastAttemptAt: 1 },
    }
    expect(caps.pickStaleAgents([{ name: 'a', sourceHash: hash }], cacheNoFailures as never, 1000, 5)).toEqual(['a'])
  })

  it('generateOneSummary counter resets when the sourceHash changes between attempts (the false arm of prev.sourceHash === sourceHash)', async () => {
    const caps = await import('../web/federation/capabilities.js')
    // Seed a cache entry with a DIFFERENT sourceHash so the next failure
    // computes failures from 0 (the else branch of the ternary).
    caps.writeCapabilityCache({
      'hash-agent': { summary: 'old', sourceHash: 'stale', generatedAt: 1, lastAttemptAt: 1, consecutiveFailures: 9 },
    })
    const out = await caps.generateOneSummary('hash-agent', 'en', async () => ({ text: null }))
    expect(out).toBe('failed')
    const entry = caps.readCapabilityCache()['hash-agent']
    expect(entry.consecutiveFailures).toBe(1) // reset, not 10
  })

  it('pruneCapabilityCache is a no-op when every cached name is still valid (the early-return branch)', async () => {
    const caps = await import('../web/federation/capabilities.js')
    caps.writeCapabilityCache({
      only: { summary: 's', sourceHash: 'h' },
    })
    caps.pruneCapabilityCache(new Set(['only']))
    expect(caps.readCapabilityCache()).toEqual({ only: { summary: 's', sourceHash: 'h' } })
  })

  it('generateOneSummary failure counter starts from 0 when prev has a matching hash but no consecutiveFailures (e.g. a successful run was followed by a failure)', async () => {
    const caps = await import('../web/federation/capabilities.js')
    // Plant a successful-run entry: has sourceHash + lastAttemptAt + summary,
    // but NO consecutiveFailures (the success path never sets it). A failure
    // now must take the prev.sourceHash === sourceHash true arm AND default
    // consecutiveFailures through `?? 0`, yielding 1 -- not a NaN.
    const src = caps.readSummarySource('recoverable')
    const hash = caps.summarySourceHash(src, 'en')
    caps.writeCapabilityCache({
      recoverable: { summary: 'old success', sourceHash: hash, generatedAt: 1, lastAttemptAt: 1 },
    })
    const out = await caps.generateOneSummary('recoverable', 'en', async () => ({ text: null }))
    expect(out).toBe('failed')
    const entry = caps.readCapabilityCache()['recoverable']
    expect(entry.consecutiveFailures).toBe(1)
    // The failure path SPREADS prev (so the old summary is retained) and
    // only overrides sourceHash / lastAttemptAt / consecutiveFailures. The
    // privacy-scrub / freshness logic decides what reaches the wire later.
    expect(entry.summary).toBe('old success')
  })

  it('buildSummaryPrompt formats the .claude/skills list through the map callback and falls back to "(none)" on empty', async () => {
    const caps = await import('../web/federation/capabilities.js')
    // Non-empty skills: the map callback runs and emits one bullet per entry.
    const withSkills: { displayName: string; model: string; roleHead: string; skills: Array<{ name: string; description: string }> } = {
      displayName: 'agent', model: 'claude-sonnet-5', roleHead: 'role', skills: [
        { name: 'video-edit', description: 'Video editing pipeline.' },
        { name: 'caption', description: 'Caption writing.' },
      ],
    }
    const prompt = caps.buildSummaryPrompt('agent', withSkills, 'en')
    expect(prompt).toContain('- video-edit: Video editing pipeline.')
    expect(prompt).toContain('- caption: Caption writing.')
    expect(prompt).not.toContain('(none)')
    // Empty skills: the `(none)` fallback branch fires (the .map callback
    // never executes, but the join still produces '' so the `|| '(none)'` arm
    // must run).
    const empty: { displayName: string; model: string; roleHead: string; skills: Array<{ name: string; description: string }> } = {
      displayName: 'agent', model: 'claude-sonnet-5', roleHead: 'role', skills: [],
    }
    const emptyPrompt = caps.buildSummaryPrompt('agent', empty, 'hu')
    expect(emptyPrompt).toContain('(none)')
    expect(emptyPrompt).toContain('Írj magyarul.')
  })
})
