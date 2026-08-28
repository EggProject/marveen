// Coverage tests for src/web/federation/onboarding.ts -- the file-system and
// orchestration paths (ensureFederationClaudeMdSection, ensureBlockInFile,
// resolveLang). The pure renderers are covered by federation-onboarding.test.ts.
//
// Same harness pattern as autonomy-section.test.ts: redirect PROJECT_ROOT to a
// tmpdir via vi.mock('../config.js', ...) so the orchestrator's writes target
// the sandbox, never the live checkout. STORE_DIR is redirected through
// _setFederationStoreDirForTest so the federation.json read/write goes to the
// sandbox too. settings-store is mocked to control DASHBOARD_LANG (the lang
// resolveLang() pulls) -- it defaults to 'hu', and we drive 'en' to cover the
// non-default branch. atomic-write is a spy so we can assert on disk changes.
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Import the pure renderers/apply directly too so we can exercise the
// branches the orchestrator path doesn't reach (en+unpaired peer, the
// trailing/leading blank-line removal branches in applyFederationBlock, the
// `cfg.routingMode ?? DEFAULT_ROUTING_MODE` nullish branch).

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fed-onboard-cov-'))
const tmpStore = mkdtempSync(join(tmpdir(), 'marveen-fed-onboard-store-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: tmpStore,
  MAIN_AGENT_ID: 'arthur',
  BOT_NAME: 'Arthur',
  WEB_PORT: 3420,
}))

const listAgents = vi.fn<(dir: string) => string[]>(() => [])
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  listAgentNames: () => listAgents(tmpRoot),
}))

const atomicWrites: Array<{ path: string; data: string }> = []
// Optional override: when set, atomicWriteFileSync throws for matching paths,
// exercising the per-file catch branch in ensureBlockInFile.
let throwingPaths: Set<string> | null = null
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, data: string) => {
    if (throwingPaths && throwingPaths.has(path)) throw new Error('disk full')
    atomicWrites.push({ path, data })
    writeFileSync(path, data, 'utf-8')
  },
}))

// Onboarding writes go to CLAUDE.md files only -- federation.json writes
// (config.ts) are tracked separately so per-test assertions can isolate them.
function claudeWrites(): Array<{ path: string; data: string }> {
  return atomicWrites.filter((w) => w.path.endsWith('CLAUDE.md'))
}

// getEffectiveSettingValue drives resolveLang's branching. Default is 'hu'
// (the registry default for DASHBOARD_LANG); we flip to 'en' per-test for the
// non-default branch, and throw per-test for the catch fallback.
const getEffectiveSettingValue = vi.fn<(key: string) => string | number>(() => 'hu')
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => getEffectiveSettingValue(key),
}))

const { ensureFederationClaudeMdSection, renderFederationBlock, applyFederationBlock, FEDERATION_BLOCK_BEGIN, FEDERATION_BLOCK_END } = await import(
  '../web/federation/onboarding.js'
)
const { _setFederationStoreDirForTest, reloadFederationForTest, writeFederationConfig } = await import(
  '../web/federation/config.js'
)

const MAIN_CLAUDE = join(tmpRoot, 'CLAUDE.md')

function setEnabled(enabled: boolean): void {
  writeFederationConfig({
    enabled,
    systemId: 'arthur',
    routingMode: 'catalog-first',
    peers: enabled
      ? [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: 'x'.repeat(64), inboundToken: 'y'.repeat(64), trust: 'untrusted' }]
      : [],
  })
}

function setupMainClaudeMd(content: string): void {
  mkdirSync(tmpRoot, { recursive: true })
  writeFileSync(MAIN_CLAUDE, content, 'utf-8')
}

function setupSubClaudeMd(name: string, content: string): void {
  const dir = join(tmpRoot, 'agents', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function clearWrites(): void { atomicWrites.length = 0 }

beforeAll(() => {
  _setFederationStoreDirForTest(tmpStore)
})

beforeEach(() => {
  // Reset every test to: tmpRoot has no CLAUDE.md, no agents/, no federation.json.
  // Each test sets up exactly what it needs.
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(join(tmpStore, 'federation.json'), { force: true })
  clearWrites()
  reloadFederationForTest()
  listAgents.mockImplementation(() => [])
  getEffectiveSettingValue.mockImplementation(() => 'hu')
  delete process.env['WEB_ONLY']
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(tmpStore, { recursive: true, force: true })
  delete process.env['WEB_ONLY']
})

const FED_BEGIN = '<!-- MARVEEN-FEDERATION:BEGIN'
const FED_END = '<!-- MARVEEN-FEDERATION:END -->'
const POLICY_ANCHOR = '<!-- MARVEEN-FEDERATION:POLICY -->'

describe('ensureFederationClaudeMdSection -- WEB_ONLY guard', () => {
  it('returns false (no write) when process.env.WEB_ONLY === "true"', () => {
    process.env['WEB_ONLY'] = 'true'
    setEnabled(true)
    setupMainClaudeMd('# Main\n')
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(false)
    expect(readFileSync(MAIN_CLAUDE, 'utf-8')).toBe('# Main\n') // untouched
    expect(claudeWrites()).toHaveLength(0)
  })
})

describe('ensureFederationClaudeMdSection -- main agent write/remove', () => {
  it('inserts the block into PROJECT_ROOT/CLAUDE.md when enabled', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n\nExisting content.\n')
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(true)
    const after = readFileSync(MAIN_CLAUDE, 'utf-8')
    expect(after).toContain(FED_BEGIN)
    expect(after).toContain(FED_END)
    expect(after).toContain('Existing content.') // persona preserved
    expect(after).toContain(POLICY_ANCHOR)        // owner policy seeded (main agent only)
  })

  it('removes the block from PROJECT_ROOT/CLAUDE.md when disabled', () => {
    // Start enabled, then flip to disabled and re-run.
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    ensureFederationClaudeMdSection()
    expect(readFileSync(MAIN_CLAUDE, 'utf-8')).toContain(FED_BEGIN)
    setEnabled(false)
    clearWrites()
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(true) // file actually changed
    const after = readFileSync(MAIN_CLAUDE, 'utf-8')
    expect(after).not.toContain(FED_BEGIN)
    expect(after).toContain('# Arthur')
    // POLICY_ANCHOR lives OUTSIDE the managed block and survives removal.
    expect(after).toContain(POLICY_ANCHOR)
  })

  it('seeds the policy on first enable and is idempotent (no re-seed, no write) on second enable', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    const r1 = ensureFederationClaudeMdSection()
    expect(r1).toBe(true)
    const after1 = readFileSync(MAIN_CLAUDE, 'utf-8')
    expect(after1).toContain(POLICY_ANCHOR)
    // Idempotent re-run: nothing changed.
    clearWrites()
    const r2 = ensureFederationClaudeMdSection()
    expect(r2).toBe(false)
    expect(claudeWrites()).toHaveLength(0)
    // The file is byte-identical to the first pass.
    expect(readFileSync(MAIN_CLAUDE, 'utf-8')).toBe(after1)
  })

  it('skips the main-agent write when PROJECT_ROOT/CLAUDE.md does not exist (no persona yet)', () => {
    setEnabled(true)
    listAgents.mockImplementation(() => []) // no sub-agents either
    // tmpRoot has no CLAUDE.md
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(false)
    expect(claudeWrites()).toHaveLength(0)
  })
})

describe('ensureFederationClaudeMdSection -- sub-agent pass', () => {
  it('writes the minimal reply/loop block to each sub-agent CLAUDE.md (no policy seed)', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n') // so the main-agent pass writes something
    setupSubClaudeMd('bot-1', '# Bot 1 persona\n')
    setupSubClaudeMd('bot-2', '# Bot 2 persona\n')
    listAgents.mockImplementation(() => ['bot-1', 'bot-2'])
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(true)

    const bot1 = readFileSync(join(tmpRoot, 'agents', 'bot-1', 'CLAUDE.md'), 'utf-8')
    const bot2 = readFileSync(join(tmpRoot, 'agents', 'bot-2', 'CLAUDE.md'), 'utf-8')
    for (const content of [bot1, bot2]) {
      expect(content).toContain(FED_BEGIN)
      expect(content).toContain(FED_END)
      // Sub-agent block must NOT seed the owner policy (that lives with main).
      expect(content).not.toContain(POLICY_ANCHOR)
    }
    expect(bot1).toContain('# Bot 1 persona')
    expect(bot2).toContain('# Bot 2 persona')
  })

  it('removes the block from sub-agent CLAUDE.md files when disabled', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    setupSubClaudeMd('bot-1', '# Bot 1\n')
    setupSubClaudeMd('bot-2', '# Bot 2\n')
    listAgents.mockImplementation(() => ['bot-1', 'bot-2'])
    ensureFederationClaudeMdSection() // enable
    expect(readFileSync(join(tmpRoot, 'agents', 'bot-1', 'CLAUDE.md'), 'utf-8')).toContain(FED_BEGIN)

    setEnabled(false)
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(true)
    expect(readFileSync(join(tmpRoot, 'agents', 'bot-1', 'CLAUDE.md'), 'utf-8')).not.toContain(FED_BEGIN)
    expect(readFileSync(join(tmpRoot, 'agents', 'bot-2', 'CLAUDE.md'), 'utf-8')).not.toContain(FED_BEGIN)
  })

  it('skips a sub-agent whose CLAUDE.md does not exist (no throw, sibling still processed)', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    setupSubClaudeMd('present', '# Present\n')
    // Create the dir for the missing one but no CLAUDE.md inside it.
    mkdirSync(join(tmpRoot, 'agents', 'ghost'), { recursive: true })
    listAgents.mockImplementation(() => ['present', 'ghost'])
    expect(() => ensureFederationClaudeMdSection()).not.toThrow()
    expect(readFileSync(join(tmpRoot, 'agents', 'present', 'CLAUDE.md'), 'utf-8')).toContain(FED_BEGIN)
  })

  it('returns true if ONLY a sub-agent changed (main had nothing to do)', () => {
    // No main CLAUDE.md at all -> main pass is a no-op.
    setEnabled(true)
    setupSubClaudeMd('bot-1', '# Bot 1\n')
    listAgents.mockImplementation(() => ['bot-1'])
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(true) // changed because of sub-agent
    expect(readFileSync(join(tmpRoot, 'agents', 'bot-1', 'CLAUDE.md'), 'utf-8')).toContain(FED_BEGIN)
  })

  it('returns false when nothing changed (main unchanged, sub-agents unchanged)', () => {
    setEnabled(false)
    // Pre-seed the main file WITHOUT the federation block (so the disable pass
    // is a no-op remove), and pre-seed a sub-agent WITHOUT the block.
    setupMainClaudeMd('# Arthur\n')
    setupSubClaudeMd('bot-1', '# Bot 1\n')
    listAgents.mockImplementation(() => ['bot-1'])
    const r = ensureFederationClaudeMdSection()
    expect(r).toBe(false) // nothing to do
    expect(claudeWrites()).toHaveLength(0)
  })
})

describe('ensureFederationClaudeMdSection -- lang resolution', () => {
  it('renders the English block when DASHBOARD_LANG === "en" (resolveLang non-default branch)', () => {
    getEffectiveSettingValue.mockImplementation(() => 'en')
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    ensureFederationClaudeMdSection()
    const after = readFileSync(MAIN_CLAUDE, 'utf-8')
    expect(after).toContain('Federation: partner systems')
    expect(after).not.toContain('Föderáció: társrendszerek')
  })

  it('falls back to "hu" when getEffectiveSettingValue throws (resolveLang catch branch)', () => {
    getEffectiveSettingValue.mockImplementation(() => { throw new Error('store unavailable') })
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    expect(() => ensureFederationClaudeMdSection()).not.toThrow()
    const after = readFileSync(MAIN_CLAUDE, 'utf-8')
    expect(after).toContain('Föderáció: társrendszerek')
  })
})

describe('ensureFederationClaudeMdSection -- error swallowing', () => {
  it('returns false (does not throw) when the top-level try{} catches', () => {
    setEnabled(true)
    // Force an unhandled throw inside the orchestration by making listAgentNames
    // throw on first read. The orchestrator must swallow it and return false.
    listAgents.mockImplementation(() => { throw new Error('catalog exploded') })
    expect(() => ensureFederationClaudeMdSection()).not.toThrow()
    expect(ensureFederationClaudeMdSection()).toBe(false)
  })
})

describe('ensureBlockInFile -- per-file catch branch', () => {
  it('returns false (logs warn, does not throw) when writing the main CLAUDE.md throws', () => {
    setEnabled(true)
    setupMainClaudeMd('# Arthur\n')
    // Force atomicWriteFileSync to throw for the main file -- the per-file
    // catch in ensureBlockInFile must swallow it. The orchestrator's top-
    // level try{} catches anything escaping, but here the inner catch handles
    // it cleanly and the sub-agent pass still runs.
    throwingPaths = new Set([MAIN_CLAUDE])
    try {
      setupSubClaudeMd('bot-1', '# Bot 1\n')
      listAgents.mockImplementation(() => ['bot-1'])
      const r = ensureFederationClaudeMdSection()
      // Main-file write failed -> changed stays false (main pass caught it
      // and returned false); sub-agent pass may still flip it. Set up so the
      // sub-agent does NOT change either (sub-agent is a fresh write but the
      // mock lets it through). Since the sub-agent gets the block written,
      // changed is true. The point: no throw, and main file is left untouched.
      expect(r).toBe(true)
      expect(readFileSync(MAIN_CLAUDE, 'utf-8')).toBe('# Arthur\n') // main untouched
      // Sub-agent DID get written (sub-agent pass did not throw).
      expect(readFileSync(join(tmpRoot, 'agents', 'bot-1', 'CLAUDE.md'), 'utf-8')).toContain(FED_BEGIN)
    } finally {
      throwingPaths = null
    }
  })
})

// Direct coverage of branches in the pure renderers and applyFederationBlock
// that the orchestrator path does not exercise. Each test names the specific
// branch it is closing.
describe('renderFederationBlock -- missing branches', () => {
  const ID_EN = { botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang: 'en' as const }
  const cfgUnpaired = (): Parameters<typeof renderFederationBlock>[0] => ({
    enabled: true,
    systemId: 'arthur',
    peers: [{ id: 'pending', baseUrl: 'https://pending.example', outboundToken: '', inboundToken: 'y'.repeat(64), trust: 'untrusted' }],
  })

  it('en + unpaired peer: renders the English "pairing in progress" marker', () => {
    const block = renderFederationBlock(cfgUnpaired(), ID_EN)
    expect(block).toContain('`pending` (https://pending.example) — pairing in progress')
    expect(block).not.toContain('párosítás folyamatban') // not the hu marker
  })

  it('id.lang === "en" ? en : hu picks the English template literal', () => {
    const block = renderFederationBlock(cfgUnpaired(), ID_EN)
    // The English template literal references its own block-begin marker.
    expect(block.startsWith(FED_BEGIN)).toBe(true)
    expect(block).toContain('Federation: partner systems')
  })

  it('id.lang === "en" ? en : hu picks the Hungarian template literal', () => {
    const block = renderFederationBlock(cfgUnpaired(), { ...ID_EN, lang: 'hu' })
    expect(block).toContain('Föderáció: társrendszerek')
  })

  it('cfg.routingMode ?? DEFAULT_ROUTING_MODE: absent routingMode still renders (nullish branch)', () => {
    // No routingMode on the config -- the nullish coalesce picks DEFAULT.
    const block = renderFederationBlock(cfgUnpaired(), ID_EN)
    expect(block).toContain('GET /api/federation/directory')
  })

  it('renders the "no peers configured" fallback when peers[] is empty (hu branch)', () => {
    const block = renderFederationBlock(
      { enabled: true, systemId: 'arthur', peers: [] },
      { botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang: 'hu' },
    )
    expect(block).toContain('- (nincs társ konfigurálva)')
  })

  it('renders the "no peers configured" fallback when peers[] is empty (en branch)', () => {
    const block = renderFederationBlock(
      { enabled: true, systemId: 'arthur', peers: [] },
      { botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang: 'en' },
    )
    expect(block).toContain('- (no peers configured)')
  })
})

describe('applyFederationBlock -- blank-line strip branches', () => {
  const block = renderFederationBlock(
    { enabled: true, systemId: 'arthur', peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: 'x'.repeat(64), inboundToken: 'y'.repeat(64), trust: 'untrusted' }] },
    { botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang: 'hu' },
  )

  it('removes the leading AND trailing blank line around an inserted block (both pop() and shift() branches)', () => {
    // Insert, then remove -- the inserter adds '' on BOTH sides of the block,
    // so on remove before ends with '' AND after starts with ''. Both
    // before.pop() AND after.shift() must run, otherwise the file grows on
    // every enable->disable->enable cycle.
    const inserted = applyFederationBlock('# Persona\n\n## Inter-agent kommunikáció\nbody\n\n## Next\n', block)!
    const removed = applyFederationBlock(inserted, null)!
    expect(removed).toBe('# Persona\n\n## Inter-agent kommunikáció\nbody\n\n## Next\n')
  })

  it('does NOT pop before when the prior line is not empty', () => {
    // Force the inserter to land BEFORE the next '## ' heading so the blank
    // line ends up between lines, not trailing the BEFORE slice's last entry
    // being empty. Actually, the inserter always inserts a blank line before
    // the block, so before[last] is always ''. Use a custom remove scenario:
    // a file where the BEGIN marker sits at line 0 (no preceding lines) and
    // the END marker is followed immediately by content (no leading blank).
    const crafted = `${FEDERATION_BLOCK_BEGIN}\n${FEDERATION_BLOCK_END}\nrest`
    const out = applyFederationBlock(crafted, null)!
    // before.length === 0 -> before.pop() NOT called (length branch is false)
    // after[0] === 'rest' !== '' -> after.shift() NOT called
    expect(out).toBe('rest')
  })
})
