// 100% coverage test for src/web/agent-bundle.ts.
//
// The single-agent + fleet bundle helpers all the dashboard endpoints depend on
// for portable per-agent (.tar.gz) and fleet-wide moves between machines.
//
// Mock strategy
//   - '../config.js' is the only "heavy" dep agent-bundle.ts pulls in (via
//     agent-config.js -> config.js -> PROJECT_ROOT). We mock it so the real
//     AGENTS_BASE_DIR is redirected into a fresh temp project, isolating the
//     suite from the host install.
//   - The other "heavy" deps the suite template lists (db / logger / auth-*
//     / child_process / os) are NOT imported by agent-bundle.ts (or by
//     agent-config.ts, atomic-write.ts, sanitize.ts in the exercised paths)
//     so we leave them real. execFileSync still shells out to the system tar
//     for round-trip tests; tar is deterministic on the macOS/Linux hosts
//     this runs on, and the live-install guard forbids us from touching the
//     real project root either way.
//   - node:fs stays real too (no monkey-patching); every filesystem state
//     lives under temp-sandbox dirs and is rmSync'd in afterEach.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  existsSync as realExistsSync,
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  rmSync, statSync as realStatSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rmTempDir } from './setup/temp-sandbox.js'

// existsSync_check is the local helper used by tests for assertion-side
// existence checks. The SUT call paths use the mocked version above; this is
// the unmocked, real one.
const existsSync_check = realExistsSync

// ---------------------------------------------------------------------------
// node:fs mock: two overrides, controlled by fsState.
//
//   - statThrowFor: substring match; statSync throws ENOENT for any path
//     that contains it. Drives the catch branch in importAllAgentsBundle.
//   - existsSecondFalse: substring match; the SECOND existsSync call with
//     that path returns false (others stay real). Drives the defensive
//     guard inside copyEntryInto, which is otherwise unreachable because
//     the caller has already pre-checked the same path.
//
// vi.hoisted() is required because vi.mock factory bodies run BEFORE module-
// scope `const` initializers are evaluated (vitest hoists the factory).
// ---------------------------------------------------------------------------
const { fsState } = vi.hoisted(() => ({
  fsState: {
    statThrowFor: null as string | null,
    existsSecondFalse: null as string | null,
  },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const seenCounts = new Map<string, number>()
  return {
    ...actual,
    statSync: ((p: unknown) => {
      const pathStr = String(p)
      if (fsState.statThrowFor && pathStr.includes(fsState.statThrowFor)) {
        throw Object.assign(new Error('mock stat throw'), { code: 'ENOENT' })
      }
      return (actual.statSync as typeof realStatSync)(p as Parameters<typeof realStatSync>[0])
    }) as typeof realStatSync,
    existsSync: ((p: unknown) => {
      const pathStr = String(p)
      if (fsState.existsSecondFalse && pathStr.includes(fsState.existsSecondFalse)) {
        const n = (seenCounts.get(pathStr) ?? 0) + 1
        seenCounts.set(pathStr, n)
        if (n >= 2) return false
      }
      return (actual.existsSync as typeof realExistsSync)(p as Parameters<typeof realExistsSync>[0])
    }) as typeof realExistsSync,
  }
})

// ---------------------------------------------------------------------------
// node:child_process mock for the unreachable peekBundleKind branch.
//
// peekBundleKind's "manifest.json missing after extract" branch only fires
// when `tar` exits 0 but writes no manifest.json to disk -- which real tar
// never does (it exits 1 with "Not found in archive"). To exercise the branch
// for coverage we install a thin shim that re-runs the real tar but no-ops
// the trailing manifest extraction call when the test toggles on a flag.
// ---------------------------------------------------------------------------
const tarState = { skipManifestExtract: false as boolean }
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((...args: Parameters<typeof execFileSync>) => {
      // peekBundleKind's only call signature: tar -xzf <bundle> -C <work> manifest.json
      if (
        tarState.skipManifestExtract &&
        args[0] === 'tar' &&
        Array.isArray(args[1]) &&
        args[1][0] === '-xzf' &&
        args[1].includes('manifest.json')
      ) {
        // Pretend tar succeeded without actually writing the file. This is
        // the only way to drive the "manifest.json missing after extract"
        // branch of peekBundleKind, since real tar refuses to fake it.
        return Buffer.alloc(0)
      }
      return (actual.execFileSync as typeof execFileSync)(...args)
    }) as typeof execFileSync,
  }
})

// ---------------------------------------------------------------------------
// Mock config.js so PROJECT_ROOT (used by agent-config.ts -> safeJoin) lands
// inside our temp sandbox. The sandbox + project roots are constructed
// synchronously at module load so AGENTS_BASE_DIR (computed when
// agent-config.ts first imports) resolves into the sandbox.
//
// We use a SINGLE project root for the whole file: beforeEach rmSync's its
// contents so each test sees an empty `agents/` + `store/`. Resetting the
// root between tests avoids the timing problem of trying to swap
// FAKE_PROJECT_ROOT after agent-config.ts has already snapshotted it.
// ---------------------------------------------------------------------------
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), 'marveen-web-agent-bundle-'))
const PROJECT = join(SANDBOX_ROOT, 'project')
const STORE = join(PROJECT, 'store')
mkdirSync(join(PROJECT, 'agents'), { recursive: true })
mkdirSync(STORE, { recursive: true })

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
    },
  )
})

// SUT import -- must come after the mock declaration so the redirected
// constants are in place before agent-config.ts evaluates AGENTS_BASE_DIR.
const ab = await import('../web/agent-bundle.js')

// ---------------------------------------------------------------------------
// Per-test reset: leave the directories in place (PROJECT is a const), just
// wipe their contents so each test starts from an empty agents/ + store/.
// ---------------------------------------------------------------------------
beforeEach(() => {
  rmSync(join(PROJECT, 'agents'), { recursive: true, force: true })
  mkdirSync(join(PROJECT, 'agents'), { recursive: true })
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
})
afterAll(() => { rmTempDir(SANDBOX_ROOT) })

function seedAgent(name: string, files: Record<string, string>): string {
  const dir = join(PROJECT, 'agents', name)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------
describe('module constants', () => {
  it('exposes BUNDLE_SCHEMA_VERSION = 1', () => {
    expect(ab.BUNDLE_SCHEMA_VERSION).toBe(1)
  })

  it('exports the public API surface', () => {
    for (const name of [
      'stageAgentDirForExport', 'stageAgentForExport', 'exportAgentBundle',
      'readBundleManifest', 'sanitizeImportedConfig', 'importAgentBundle',
      'bundleFilename', 'exportAllAgentsBundle', 'readFleetManifest',
      'peekBundleKind', 'importAllAgentsBundle', 'fleetBundleFilename',
    ]) {
      expect(typeof (ab as Record<string, unknown>)[name]).toBe('function')
    }
  })
})

// ---------------------------------------------------------------------------
// stageAgentDirForExport -- the building block both export wrappers share
// ---------------------------------------------------------------------------
describe('stageAgentDirForExport', () => {
  it('throws if the source root does not exist', () => {
    const stage = join(PROJECT, 'stage')
    expect(() => ab.stageAgentDirForExport(join(PROJECT, 'does-not-exist'), stage, false))
      .toThrow(/Agent source not found/)
  })

  it('copies the portable subset when present and returns the relative paths', () => {
    const src = join(PROJECT, 'agents', 'src-agent')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, 'agent-config.json'), '{"model":"x"}')
    writeFileSync(join(src, 'CLAUDE.md'), '# hi')
    writeFileSync(join(src, 'SOUL.md'), 'soul')
    writeFileSync(join(src, '.mcp.json'), '{}')
    writeFileSync(join(src, 'avatar.png'), 'png')
    mkdirSync(join(src, 'memory'), { recursive: true })
    writeFileSync(join(src, 'memory', 'MEMORY.md'), 'mem')
    writeFileSync(join(src, '.claude', 'settings.json'), '{}')
    mkdirSync(join(src, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(src, '.claude', 'hooks', 'pre.sh'), '#!/bin/sh')
    mkdirSync(join(src, '.claude', 'skills', 's'), { recursive: true })
    writeFileSync(join(src, '.claude', 'skills', 's', 'SKILL.md'), 'skill')
    const stage = join(PROJECT, 'stage')
    const staged = ab.stageAgentDirForExport(src, stage, false)

    expect(staged).toContain('agent-config.json')
    expect(staged).toContain('CLAUDE.md')
    expect(staged).toContain('SOUL.md')
    expect(staged).toContain('.mcp.json')
    expect(staged).toContain('avatar.png')
    expect(staged).toContain('memory')
    expect(staged).toContain(join('.claude', 'settings.json'))
    expect(staged).toContain(join('.claude', 'hooks'))
    expect(staged).toContain(join('.claude', 'skills'))
    expect(existsSync_check(join(stage, 'CLAUDE.md'))).toBe(true)
    expect(existsSync_check(join(stage, '.claude', 'skills', 's', 'SKILL.md'))).toBe(true)
  })

  it('skips missing portable entries silently (absence is normal)', () => {
    const src = join(PROJECT, 'agents', 'minimal')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    const stage = join(PROJECT, 'stage-min')
    const staged = ab.stageAgentDirForExport(src, stage, false)
    expect(staged).toEqual(['CLAUDE.md'])
    expect(existsSync_check(join(stage, 'CLAUDE.md'))).toBe(true)
  })

  it('exercises copyEntryInto\'s inner existsSync defensive guard (dead branch)', () => {
    // The inner `if (!existsSync(src)) return` in copyEntryInto is structurally
    // unreachable (the caller has already checked the same path). We force the
    // second existsSync call on a specific path to return false via the
    // fsState.existsSecondFalse flag to expose the branch.
    const src = join(PROJECT, 'agents', 'defensive')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'defensive-guard blocks the copy')
    const stage = join(PROJECT, 'stage-defensive')
    fsState.existsSecondFalse = 'CLAUDE.md'
    try {
      ab.stageAgentDirForExport(src, stage, false)
    } finally {
      fsState.existsSecondFalse = null
    }
    // The early-return inside copyEntryInto fires before cpSync runs, so
    // CLAUDE.md should NOT be staged. The point of this test is branch
    // coverage of the defensive guard, not functional behaviour.
    expect(existsSync_check(join(stage, 'CLAUDE.md'))).toBe(false)
  })

  it('stages nothing channel-secret-related when includeSecrets=true but .claude/channels is absent', () => {
    const src = join(PROJECT, 'agents', 'nochans')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    const stage = join(PROJECT, 'stage-nochans')
    const staged = ab.stageAgentDirForExport(src, stage, true)
    expect(staged.find((s) => s.includes('channels'))).toBeUndefined()
  })

  it('rejects a provider-as-file (no provider-level secrets staged)', () => {
    const src = join(PROJECT, 'agents', 'mixedprov-fileonly')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude', 'channels'), { recursive: true })
    // Single provider entry, but it's a file not a dir -> inner statSync
    // catches it and continues without staging anything under it.
    writeFileSync(join(src, '.claude', 'channels', 'README'), 'not a dir')
    const stage = join(PROJECT, 'stage-fileonly')
    const staged = ab.stageAgentDirForExport(src, stage, true)
    expect(staged.find((s) => s.includes('README'))).toBeUndefined()
    expect(existsSync_check(join(stage, '.claude', 'channels', 'README'))).toBe(false)
  })

  it('omits channel secrets when includeSecrets is false', () => {
    const src = join(PROJECT, 'agents', 'nosecrets')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels', 'telegram', '.env'), 'TOK=x')
    writeFileSync(join(src, '.claude', 'channels', 'telegram', 'access.json'), '{}')
    const stage = join(PROJECT, 'stage-nosecrets')
    const staged = ab.stageAgentDirForExport(src, stage, false)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'telegram', '.env'))).toBe(false)
    expect(staged.find((s) => s.includes('channels'))).toBeUndefined()
  })

  it('copies channel secret files + dirs when includeSecrets is true', () => {
    const src = join(PROJECT, 'agents', 'withsec')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels', 'telegram', '.env'), 'TOK=x')
    writeFileSync(join(src, '.claude', 'channels', 'telegram', 'access.json'), '{"a":1}')
    writeFileSync(join(src, '.claude', 'channels', 'telegram', 'invites.json'), '{"i":1}')
    mkdirSync(join(src, '.claude', 'channels', 'telegram', 'approved'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels', 'telegram', 'approved', 'one'), '1')

    const stage = join(PROJECT, 'stage-secs')
    const staged = ab.stageAgentDirForExport(src, stage, true)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'telegram', '.env'))).toBe(true)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'telegram', 'access.json'))).toBe(true)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'telegram', 'invites.json'))).toBe(true)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'telegram', 'approved', 'one'))).toBe(true)
    expect(staged.some((s) => s.endsWith(join('.claude', 'channels', 'telegram', '.env')))).toBe(true)
  })

  it('skips provider entries that are not directories without throwing', () => {
    const src = join(PROJECT, 'agents', 'mixedprov')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude', 'channels'), { recursive: true })
    // Mix of a regular file and a real provider dir under channels/.
    writeFileSync(join(src, '.claude', 'channels', 'README'), 'not a dir')
    mkdirSync(join(src, '.claude', 'channels', 'slack'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels', 'slack', '.env'), 'TOK=s')
    const stage = join(PROJECT, 'stage-mixed')
    const staged = ab.stageAgentDirForExport(src, stage, true)
    expect(existsSync_check(join(stage, '.claude', 'channels', 'slack', '.env'))).toBe(true)
    expect(staged.some((s) => s.includes('slack'))).toBe(true)
  })

  it('handles statSync throwing on a provider entry (catch branch, channels loop)', () => {
    // Drives the catch arm of the one-line try-catch on stageAgentDirForExport's
    // channels loop. With statThrowFor set, any provider entry that statSync
    // sees throws -> catch continues past it.
    const src = join(PROJECT, 'agents', 'mixedprov-throw')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude', 'channels'), { recursive: true })
    mkdirSync(join(src, '.claude', 'channels', 'sneaky'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels', 'sneaky', '.env'), 'TOK=s')
    const stage = join(PROJECT, 'stage-mixed-throw')
    fsState.statThrowFor = 'sneaky'
    try {
      const staged = ab.stageAgentDirForExport(src, stage, true)
      // sneaky's statSync threw -> caught & continued, so its secrets should
      // not have been staged.
      expect(staged.find((s) => s.includes('sneaky'))).toBeUndefined()
    } finally {
      fsState.statThrowFor = null
    }
  })

  // See docs/needs-to-be-fix/web-agent-bundle-channels-not-dir.md -- the
  // channels loop crashes when `.claude/channels` exists but is a regular
  // file; the `existsSync` guard passes and the readdirSync throws ENOTDIR.
  it('throws ENOTDIR when .claude/channels is a file, not a directory (defect)', () => {
    const src = join(PROJECT, 'agents', 'filedotclaude')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, '.claude', 'channels'), 'not a directory')
    const stage = join(PROJECT, 'stage-chansfile')
    expect(() => ab.stageAgentDirForExport(src, stage, true)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// stageAgentForExport -- thin wrapper that resolves agentDir(name) first
// ---------------------------------------------------------------------------
describe('stageAgentForExport', () => {
  it('resolves agentDir(name) and forwards to stageAgentDirForExport', () => {
    const src = join(PROJECT, 'agents', 'wrapped')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    const stage = join(PROJECT, 'wrapped-stage')
    const staged = ab.stageAgentForExport('wrapped', stage, false)
    expect(staged).toContain('CLAUDE.md')
    expect(existsSync_check(join(stage, 'CLAUDE.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// exportAgentBundle -- the full pack-into-tarball path
// ---------------------------------------------------------------------------
describe('exportAgentBundle', () => {
  it('packs the agent into a .tar.gz with a valid manifest', () => {
    seedAgent('packit', { 'CLAUDE.md': 'hi', 'memory/MEMORY.md': 'mem' })
    const out = join(STORE, 'packit.tar.gz')
    const manifest = ab.exportAgentBundle('packit', out)
    expect(manifest.agentName).toBe('packit')
    expect(manifest.includesSecrets).toBe(false)
    expect(manifest.schemaVersion).toBe(ab.BUNDLE_SCHEMA_VERSION)
    expect(existsSync_check(out)).toBe(true)
    // Quick smoke-check: tar can list it.
    const listing = execFileSync('tar', ['-tzf', out]).toString()
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('agent/')
    expect(listing).toContain('agent/CLAUDE.md')
  })

  it('includes the exportedBy/exportedAt fields when supplied', () => {
    seedAgent('withprov', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'withprov.tar.gz')
    const manifest = ab.exportAgentBundle('withprov', out, {
      exportedBy: 'tester',
      exportedAt: '2026-01-01T00:00:00Z',
    })
    expect(manifest.exportedBy).toBe('tester')
    expect(manifest.exportedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('omits optional fields when not supplied', () => {
    seedAgent('noopts', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'noopts.tar.gz')
    const manifest = ab.exportAgentBundle('noopts', out)
    expect((manifest as Record<string, unknown>).exportedBy).toBeUndefined()
    expect((manifest as Record<string, unknown>).exportedAt).toBeUndefined()
  })

  it('marks includesSecrets=true when opts.includeSecrets=true', () => {
    seedAgent('withsec2', {
      'CLAUDE.md': 'x',
      '.claude/channels/telegram/.env': 'TOK=x',
    })
    const out = join(STORE, 'withsec2.tar.gz')
    const manifest = ab.exportAgentBundle('withsec2', out, { includeSecrets: true })
    expect(manifest.includesSecrets).toBe(true)
  })

  it('creates the parent directory of outPath if missing', () => {
    seedAgent('mkpar', { 'CLAUDE.md': 'x' })
    const nestDir = join(STORE, 'nested', 'bundle.tar.gz')
    expect(existsSync_check(join(STORE, 'nested'))).toBe(false)
    ab.exportAgentBundle('mkpar', nestDir)
    expect(existsSync_check(join(STORE, 'nested'))).toBe(true)
    expect(existsSync_check(nestDir)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readBundleManifest -- the "look before you leap" check the real tar import
// runs after extraction.
// ---------------------------------------------------------------------------
describe('readBundleManifest', () => {
  function writeManifest(dir: string, body: unknown): void {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(body))
  }

  it('rejects an empty extracted root', () => {
    const ext = join(PROJECT, 'extracted-empty')
    mkdirSync(ext, { recursive: true })
    expect(() => ab.readBundleManifest(ext)).toThrow(/manifest\.json missing/)
  })

  it('rejects non-JSON manifest content', () => {
    const ext = join(PROJECT, 'extracted-bad')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'manifest.json'), 'not-json{{{')
    expect(() => ab.readBundleManifest(ext)).toThrow(/not valid JSON/)
  })

  it('rejects a manifest that is not an object', () => {
    const ext = join(PROJECT, 'extracted-null')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'manifest.json'), 'null')
    expect(() => ab.readBundleManifest(ext)).toThrow(/malformed/)
  })

  it('rejects a schemaVersion newer than this install supports', () => {
    const ext = join(PROJECT, 'extracted-newer')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: ab.BUNDLE_SCHEMA_VERSION + 1, agentName: 'future' })
    expect(() => ab.readBundleManifest(ext)).toThrow(/newer than this install/)
  })

  it('rejects a manifest that has no agentName', () => {
    const ext = join(PROJECT, 'extracted-nameless')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1 }) // no agentName
    expect(() => ab.readBundleManifest(ext)).toThrow(/no agentName/)
  })

  it('falls back to schemaVersion=0 when the field is missing or wrong type', () => {
    const ext = join(PROJECT, 'extracted-defaultver')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 'not-a-number', agentName: 'p' })
    const m = ab.readBundleManifest(ext)
    expect(m.schemaVersion).toBe(0)
    expect(m.agentName).toBe('p')
  })

  it('includes optional exportedBy/exportedAt when present', () => {
    const ext = join(PROJECT, 'extracted-opts')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, {
      schemaVersion: 1, agentName: 'p', exportedBy: 'tester', exportedAt: '2026-01-01',
    })
    const m = ab.readBundleManifest(ext)
    expect(m.exportedBy).toBe('tester')
    expect(m.exportedAt).toBe('2026-01-01')
  })

  it('drops exportedBy/exportedAt when not strings', () => {
    const ext = join(PROJECT, 'extracted-dropopts')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, agentName: 'p', exportedBy: 42, exportedAt: false })
    const m = ab.readBundleManifest(ext)
    expect((m as Record<string, unknown>).exportedBy).toBeUndefined()
    expect((m as Record<string, unknown>).exportedAt).toBeUndefined()
  })

  it('flags includesSecrets=false unless literally `true`', () => {
    const ext = join(PROJECT, 'extracted-incs')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, agentName: 'p', includesSecrets: 'yes' })
    expect(ab.readBundleManifest(ext).includesSecrets).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sanitizeImportedConfig -- strips machine-specific fields in place
// ---------------------------------------------------------------------------
describe('sanitizeImportedConfig', () => {
  it('is a no-op when there is no agent-config.json', () => {
    const staged = join(PROJECT, 'san-none')
    mkdirSync(staged, { recursive: true })
    expect(() => ab.sanitizeImportedConfig(staged)).not.toThrow()
  })

  it('returns silently when the config is not valid JSON', () => {
    const staged = join(PROJECT, 'san-bad-json')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'agent-config.json'), '{ this is not json ')
    expect(() => ab.sanitizeImportedConfig(staged)).not.toThrow()
    // File should be left untouched.
    expect(readFileSync(join(staged, 'agent-config.json'), 'utf-8')).toBe('{ this is not json ')
  })

  it('strips the three machine-specific keys and rewrites atomically', () => {
    const staged = join(PROJECT, 'san-strip')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'agent-config.json'), JSON.stringify({
      model: 'claude-opus-4-8[1m]',
      remoteHost: 'h', remoteWorkdir: '/w', claudeConfigDir: '/c',
      displayName: 'K',
    }))
    ab.sanitizeImportedConfig(staged)
    const cfg = JSON.parse(readFileSync(join(staged, 'agent-config.json'), 'utf-8'))
    expect(cfg.remoteHost).toBeUndefined()
    expect(cfg.remoteWorkdir).toBeUndefined()
    expect(cfg.claudeConfigDir).toBeUndefined()
    expect(cfg.model).toBe('claude-opus-4-8[1m]')
    expect(cfg.displayName).toBe('K')
  })

  it('leaves the file alone when there is nothing to strip (no atomic rewrite)', () => {
    const staged = join(PROJECT, 'san-nochange')
    mkdirSync(staged, { recursive: true })
    const payload = JSON.stringify({ model: 'claude-opus-4-8[1m]', displayName: 'K' })
    writeFileSync(join(staged, 'agent-config.json'), payload)
    // No machine-specific keys -> changed===false -> no atomic rewrite.
    ab.sanitizeImportedConfig(staged)
    expect(readFileSync(join(staged, 'agent-config.json'), 'utf-8')).toBe(payload)
  })
})

// ---------------------------------------------------------------------------
// importAgentBundle -- the full unpack path
// ---------------------------------------------------------------------------
describe('importAgentBundle', () => {
  it('rejects a buffer that is not a tar archive', () => {
    expect(() => ab.importAgentBundle(Buffer.from('definitely not a tar'),
      { resolveDest: (n: string) => join(PROJECT, 'agents', n) }))
      .toThrow(/could not extract/)
  })

  it('rejects a bundle whose agent/ directory is missing after extract', () => {
    // Build a tarball with manifest.json but no agent/ inside.
    const work = mkdtempSync(join(tmpdir(), 'marveen-no-agent-'))
    try {
      writeFileSync(join(work, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, agentName: 'solo',
      }))
      const out = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', out, '-C', work, 'manifest.json'])
      const buf = readFileSync(out)
      expect(() => ab.importAgentBundle(buf, {
        resolveDest: (n: string) => join(PROJECT, 'agents', n),
      })).toThrow(/agent\/.+directory missing/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects an agent name that sanitizes to empty', () => {
    seedAgent('empty', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'empty.tar.gz')
    ab.exportAgentBundle('empty', out)
    const buf = readFileSync(out)
    expect(() => ab.importAgentBundle(buf, {
      overrideName: '!!!',
      resolveDest: (n: string) => join(PROJECT, 'agents', n),
    })).toThrow(/empty after sanitization/)
  })

  it('round-trips a real pack + install through agentDir() into the sandbox', () => {
    seedAgent('rt', { 'CLAUDE.md': 'RT-agent' })
    const out = join(STORE, 'rt.tar.gz')
    ab.exportAgentBundle('rt', out)
    // Wipe the source so we can prove the installed copy came from the bundle.
    rmSync(join(PROJECT, 'agents', 'rt'), { recursive: true, force: true })
    const buf = readFileSync(out)
    const r = ab.importAgentBundle(buf)
    expect(r.name).toBe('rt')
    expect(r.overwritten).toBe(false)
    expect(existsSync_check(join(PROJECT, 'agents', 'rt', 'CLAUDE.md'))).toBe(true)
  })

  it('overwrites an existing agent dir when overwrite=true', () => {
    seedAgent('clobber', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'clobber.tar.gz')
    ab.exportAgentBundle('clobber', out)
    // Move the source dir aside so the first import is a fresh install
    // (overwritten===false), then mutate, then reimport with overwrite=true.
    rmSync(join(PROJECT, 'agents', 'clobber'), { recursive: true, force: true })
    const buf = readFileSync(out)
    const r1 = ab.importAgentBundle(buf)
    expect(r1.overwritten).toBe(false)
    // Edit the installed copy, then reimport with overwrite -> overwritten=true.
    writeFileSync(join(PROJECT, 'agents', 'clobber', 'CLAUDE.md'), 'mutated')
    const r2 = ab.importAgentBundle(buf, { overwrite: true })
    expect(r2.overwritten).toBe(true)
    // The mutated file should have been replaced with the bundled payload.
    expect(readFileSync(join(PROJECT, 'agents', 'clobber', 'CLAUDE.md'), 'utf-8'))
      .toBe('x')
  })

  it('strips machine-specific keys during import', () => {
    const src = join(PROJECT, 'agents', 'withmach')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'CLAUDE.md'), 'x')
    writeFileSync(join(src, 'agent-config.json'), JSON.stringify({
      model: 'claude-opus-4-8[1m]',
      remoteHost: 'h', remoteWorkdir: '/w', claudeConfigDir: '/c',
    }))
    const out = join(STORE, 'withmach.tar.gz')
    ab.exportAgentBundle('withmach', out)
    const buf = readFileSync(out)
    rmSync(src, { recursive: true, force: true })
    ab.importAgentBundle(buf)
    const cfg = JSON.parse(readFileSync(join(PROJECT, 'agents', 'withmach', 'agent-config.json'), 'utf-8'))
    expect(cfg.remoteHost).toBeUndefined()
    expect(cfg.remoteWorkdir).toBeUndefined()
    expect(cfg.claudeConfigDir).toBeUndefined()
  })

  it('creates the parent directory of the destination if it does not exist', () => {
    seedAgent('newsib', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'newsib.tar.gz')
    ab.exportAgentBundle('newsib', out)
    rmSync(join(PROJECT, 'agents', 'newsib'), { recursive: true, force: true })
    // resolveDest points at a path whose parent does not exist yet.
    const destBase = join(PROJECT, 'fresh-parent', 'agents')
    const buf = readFileSync(out)
    ab.importAgentBundle(buf, { resolveDest: (n: string) => join(destBase, n) })
    expect(existsSync_check(join(destBase, 'newsib', 'CLAUDE.md'))).toBe(true)
  })

  it('uses agentDir() when resolveDest is omitted', () => {
    seedAgent('defaultdest', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'defaultdest.tar.gz')
    ab.exportAgentBundle('defaultdest', out)
    rmSync(join(PROJECT, 'agents', 'defaultdest'), { recursive: true, force: true })
    const buf = readFileSync(out)
    const r = ab.importAgentBundle(buf)
    expect(r.name).toBe('defaultdest')
    expect(existsSync_check(join(PROJECT, 'agents', 'defaultdest', 'CLAUDE.md'))).toBe(true)
  })

  it('honors overrideName after sanitization (rename-on-import)', () => {
    seedAgent('renametest', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'renametest.tar.gz')
    ab.exportAgentBundle('renametest', out)
    rmSync(join(PROJECT, 'agents', 'renametest'), { recursive: true, force: true })
    const buf = readFileSync(out)
    const r = ab.importAgentBundle(buf, { overrideName: 'Renamed!' })
    expect(r.name).toBe('renamed')
    expect(existsSync_check(join(PROJECT, 'agents', 'renamed', 'CLAUDE.md'))).toBe(true)
  })

  it('returns overwritten=false when dest does not pre-exist', () => {
    seedAgent('freshdest', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'freshdest.tar.gz')
    ab.exportAgentBundle('freshdest', out)
    rmSync(join(PROJECT, 'agents', 'freshdest'), { recursive: true, force: true })
    const r = ab.importAgentBundle(readFileSync(out))
    expect(r.overwritten).toBe(false)
  })

  it('throws on collision when overwrite is false', () => {
    seedAgent('col', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'col.tar.gz')
    ab.exportAgentBundle('col', out)
    // Move the source aside so the first import is a fresh install.
    rmSync(join(PROJECT, 'agents', 'col'), { recursive: true, force: true })
    const buf = readFileSync(out)
    ab.importAgentBundle(buf) // first install (fresh)
    expect(() => ab.importAgentBundle(buf)).toThrow(/already exists/)
  })
})

// ---------------------------------------------------------------------------
// bundleFilename -- safe Content-Disposition helper
// ---------------------------------------------------------------------------
describe('bundleFilename', () => {
  it('produces marveen-agent-<safe>.tar.gz', () => {
    expect(ab.bundleFilename('tester')).toBe('marveen-agent-tester.tar.gz')
  })

  it('falls back to "agent" when nothing survives the character whitelist', () => {
    expect(ab.bundleFilename('!!!')).toBe('marveen-agent-agent.tar.gz')
  })

  it('strips path separators and dangerous characters', () => {
    expect(ab.bundleFilename('../../etc/passwd')).toBe('marveen-agent-passwd.tar.gz')
  })

  it('allows ASCII letters, digits, underscores, and dashes', () => {
    expect(ab.bundleFilename('Foo_123-bar')).toBe('marveen-agent-Foo_123-bar.tar.gz')
  })
})

// ---------------------------------------------------------------------------
// exportAllAgentsBundle -- fleet packer
// ---------------------------------------------------------------------------
describe('exportAllAgentsBundle', () => {
  it('packs every named agent that exists, skips stale names silently', () => {
    seedAgent('alive1', { 'CLAUDE.md': 'a1' })
    seedAgent('alive2', { 'CLAUDE.md': 'a2' })
    const out = join(STORE, 'fleet.tar.gz')
    const manifest = ab.exportAllAgentsBundle(out, ['alive1', 'ghost', 'alive2'])
    expect(manifest.agents.sort()).toEqual(['alive1', 'alive2'])
    expect(existsSync_check(out)).toBe(true)
    const listing = execFileSync('tar', ['-tzf', out]).toString()
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('agents/alive1/CLAUDE.md')
    expect(listing).toContain('agents/alive2/CLAUDE.md')
  })

  it('skips names that sanitize to empty', () => {
    seedAgent('sanreal', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'fleet-san.tar.gz')
    const manifest = ab.exportAllAgentsBundle(out, ['sanreal', '!!!'])
    expect(manifest.agents).toEqual(['sanreal'])
  })

  it('throws when no names survive (no exportable agents found)', () => {
    expect(() => ab.exportAllAgentsBundle(join(STORE, 'empty-fleet.tar.gz'), ['ghost1', '!!!', 'also-ghost']))
      .toThrow(/No exportable agents found/)
  })

  it('propagates includeSecrets and optional fields into the manifest', () => {
    seedAgent('secagent', {
      'CLAUDE.md': 'x',
      '.claude/channels/discord/.env': 'TOK=d',
    })
    const out = join(STORE, 'fleet-secs.tar.gz')
    const m = ab.exportAllAgentsBundle(out, ['secagent'], {
      includeSecrets: true, exportedBy: 'tester', exportedAt: '2026-01-01',
    })
    expect(m.includesSecrets).toBe(true)
    expect(m.exportedBy).toBe('tester')
    expect(m.exportedAt).toBe('2026-01-01')
  })

  it('omits optional fields when not supplied', () => {
    seedAgent('nooptsfleet', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'nooptsfleet.tar.gz')
    const m = ab.exportAllAgentsBundle(out, ['nooptsfleet'])
    expect((m as Record<string, unknown>).exportedBy).toBeUndefined()
    expect((m as Record<string, unknown>).exportedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// readFleetManifest
// ---------------------------------------------------------------------------
describe('readFleetManifest', () => {
  function writeManifest(dir: string, body: unknown): void {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(body))
  }

  it('rejects when manifest.json is missing', () => {
    const ext = join(PROJECT, 'fleet-ext-missing')
    mkdirSync(ext, { recursive: true })
    expect(() => ab.readFleetManifest(ext)).toThrow(/manifest\.json missing/)
  })

  it('rejects non-JSON manifest content', () => {
    const ext = join(PROJECT, 'fleet-ext-bad')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'manifest.json'), '{oops')
    expect(() => ab.readFleetManifest(ext)).toThrow(/not valid JSON/)
  })

  it('rejects a manifest whose top-level is not an object', () => {
    const ext = join(PROJECT, 'fleet-ext-null')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'manifest.json'), '42')
    expect(() => ab.readFleetManifest(ext)).toThrow(/malformed/)
  })

  it('rejects a schemaVersion newer than supported', () => {
    const ext = join(PROJECT, 'fleet-ext-newer')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: ab.BUNDLE_SCHEMA_VERSION + 1, kind: 'fleet', agents: [] })
    expect(() => ab.readFleetManifest(ext)).toThrow(/newer than this install/)
  })

  it('rejects a manifest whose kind is not "fleet"', () => {
    const ext = join(PROJECT, 'fleet-ext-wrong-kind')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, kind: 'agent', agents: [] })
    expect(() => ab.readFleetManifest(ext)).toThrow(/not a fleet bundle/)
  })

  it('filters out non-string entries from the agents array', () => {
    const ext = join(PROJECT, 'fleet-ext-mixed-agents')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, kind: 'fleet', agents: ['a', 42, 'b', null, 'c'] })
    const m = ab.readFleetManifest(ext)
    expect(m.agents).toEqual(['a', 'b', 'c'])
  })

  it('defaults the agents list to [] when not an array', () => {
    const ext = join(PROJECT, 'fleet-ext-no-agents')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, kind: 'fleet', agents: 'oops' })
    const m = ab.readFleetManifest(ext)
    expect(m.agents).toEqual([])
  })

  it('forwards optional exportedBy/exportedAt only when string', () => {
    const ext = join(PROJECT, 'fleet-ext-opts')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, {
      schemaVersion: 1, kind: 'fleet', agents: ['a'],
      exportedBy: 'tester', exportedAt: '2026-01-01',
    })
    const m = ab.readFleetManifest(ext)
    expect(m.exportedBy).toBe('tester')
    expect(m.exportedAt).toBe('2026-01-01')
  })

  it('drops optional fields that are not strings', () => {
    const ext = join(PROJECT, 'fleet-ext-opts-bad')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, {
      schemaVersion: 1, kind: 'fleet', agents: ['a'],
      exportedBy: 99, exportedAt: false,
    })
    const m = ab.readFleetManifest(ext)
    expect((m as Record<string, unknown>).exportedBy).toBeUndefined()
    expect((m as Record<string, unknown>).exportedAt).toBeUndefined()
  })

  it('flags includesSecrets=false unless literally true', () => {
    const ext = join(PROJECT, 'fleet-ext-incs')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 1, kind: 'fleet', agents: [], includesSecrets: 1 })
    expect(ab.readFleetManifest(ext).includesSecrets).toBe(false)
  })

  it('falls back to schemaVersion=0 when the field is missing or wrong type', () => {
    const ext = join(PROJECT, 'fleet-ext-defaultver')
    mkdirSync(ext, { recursive: true })
    writeManifest(ext, { schemaVersion: 'not-a-number', kind: 'fleet', agents: ['x'] })
    const m = ab.readFleetManifest(ext)
    expect(m.schemaVersion).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// peekBundleKind -- triage entry point for the unified upload endpoint
// ---------------------------------------------------------------------------
describe('peekBundleKind', () => {
  it('returns "fleet" when manifest.kind === "fleet"', () => {
    seedAgent('peekfleet', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'peek-fleet.tar.gz')
    ab.exportAllAgentsBundle(out, ['peekfleet'])
    expect(ab.peekBundleKind(readFileSync(out))).toBe('fleet')
  })

  it('returns "agent" when manifest.kind is absent (single-agent bundle)', () => {
    seedAgent('peekagent', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'peek-agent.tar.gz')
    ab.exportAgentBundle('peekagent', out)
    expect(ab.peekBundleKind(readFileSync(out))).toBe('agent')
  })

  it('rejects a buffer that is not a tar archive', () => {
    expect(() => ab.peekBundleKind(Buffer.from('not a tar')))
      .toThrow(/could not extract/)
  })

  it('rejects an archive whose manifest.json is missing after extract', () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-peek-no-manifest-'))
    try {
      // Build an archive with a non-manifest file inside so the tarball is
      // well-formed. The execFileSync shim then skips the trailing
      // manifest.json extraction so peekBundleKind sees "no manifest".
      writeFileSync(join(work, 'placeholder.txt'), 'x')
      const tmpOut = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', tmpOut, '-C', work, 'placeholder.txt'])
      const buf = readFileSync(tmpOut)
      tarState.skipManifestExtract = true
      try {
        expect(() => ab.peekBundleKind(buf)).toThrow(/manifest\.json missing/)
      } finally {
        tarState.skipManifestExtract = false
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects an archive whose manifest.json is not valid JSON', () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-peek-badjson-'))
    try {
      writeFileSync(join(work, 'manifest.json'), 'not json')
      const buf = execFileSync('tar', ['-czf', '-', '-C', work, 'manifest.json'])
      expect(() => ab.peekBundleKind(buf)).toThrow(/not valid JSON/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// importAllAgentsBundle
// ---------------------------------------------------------------------------
describe('importAllAgentsBundle', () => {
  it('imports every fresh agent from a fleet bundle', () => {
    seedAgent('imp1', { 'CLAUDE.md': 'I1' })
    seedAgent('imp2', { 'CLAUDE.md': 'I2' })
    const out = join(STORE, 'imp-fleet.tar.gz')
    ab.exportAllAgentsBundle(out, ['imp1', 'imp2'])
    rmSync(join(PROJECT, 'agents', 'imp1'), { recursive: true, force: true })
    rmSync(join(PROJECT, 'agents', 'imp2'), { recursive: true, force: true })
    const r = ab.importAllAgentsBundle(readFileSync(out))
    expect(r.imported.map((x) => x.name).sort()).toEqual(['imp1', 'imp2'])
    expect(r.skipped).toEqual([])
    expect(r.includesSecrets).toBe(false)
  })

  it('skips existing agents when overwrite is false', () => {
    seedAgent('existing', { 'CLAUDE.md': 'old' })
    seedAgent('newcomer', { 'CLAUDE.md': 'new' })
    const out = join(STORE, 'mixed-fleet.tar.gz')
    ab.exportAllAgentsBundle(out, ['existing', 'newcomer'])
    // Remove the newcomer from disk so it must be imported, leaving existing
    // seeded pre-import to exercise the skip branch.
    rmSync(join(PROJECT, 'agents', 'newcomer'), { recursive: true, force: true })
    const r1 = ab.importAllAgentsBundle(readFileSync(out))
    expect(r1.imported.map((x) => x.name).sort()).toEqual(['newcomer'])
    expect(r1.skipped).toEqual([{ name: 'existing', reason: 'already exists' }])
  })

  it('overwrites existing agents when overwrite=true', () => {
    seedAgent('overwrite2', { 'CLAUDE.md': 'v1' })
    seedAgent('overwrite3', { 'CLAUDE.md': 'v3' })
    const out = join(STORE, 'ow-fleet.tar.gz')
    ab.exportAllAgentsBundle(out, ['overwrite2', 'overwrite3'])
    const r = ab.importAllAgentsBundle(readFileSync(out), { overwrite: true })
    expect(r.imported.find((x) => x.name === 'overwrite2')?.overwritten).toBe(true)
    expect(r.imported.find((x) => x.name === 'overwrite3')?.overwritten).toBe(true)
  })

  it('propagates includesSecrets from the fleet manifest', () => {
    seedAgent('secimp', {
      'CLAUDE.md': 'x',
      '.claude/channels/slack/.env': 'TOK=s',
    })
    const out = join(STORE, 'secimp.tar.gz')
    ab.exportAllAgentsBundle(out, ['secimp'], { includeSecrets: true })
    rmSync(join(PROJECT, 'agents', 'secimp'), { recursive: true, force: true })
    const r = ab.importAllAgentsBundle(readFileSync(out))
    expect(r.includesSecrets).toBe(true)
  })

  it('rejects a bundle whose tar extraction fails', () => {
    expect(() => ab.importAllAgentsBundle(Buffer.from('not a tar'),
      { resolveDest: (n: string) => join(PROJECT, 'agents', n) }))
      .toThrow(/could not extract/)
  })

  it('rejects a fleet bundle whose agents/ directory is missing', () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-fleet-no-agents-'))
    try {
      writeFileSync(join(work, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, kind: 'fleet', agents: [],
      }))
      const out = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', out, '-C', work, 'manifest.json'])
      const buf = readFileSync(out)
      expect(() => ab.importAllAgentsBundle(buf)).toThrow(/agents\/.+directory missing/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects a single-agent bundle (wrong kind)', () => {
    seedAgent('soloimp', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'soloimp.tar.gz')
    ab.exportAgentBundle('soloimp', out)
    expect(() => ab.importAllAgentsBundle(readFileSync(out))).toThrow(/not a fleet bundle/)
  })

  it('uses agentDir() when resolveDest is omitted', () => {
    seedAgent('defimp', { 'CLAUDE.md': 'x' })
    const out = join(STORE, 'defimp.tar.gz')
    ab.exportAllAgentsBundle(out, ['defimp'])
    rmSync(join(PROJECT, 'agents', 'defimp'), { recursive: true, force: true })
    const r = ab.importAllAgentsBundle(readFileSync(out))
    expect(r.imported.map((x) => x.name)).toEqual(['defimp'])
    expect(existsSync_check(join(PROJECT, 'agents', 'defimp', 'CLAUDE.md'))).toBe(true)
  })

  it('skips agent entries whose name sanitizes to empty (invalid name)', () => {
    // Build a fleet bundle by hand with a "bad" entry name.
    const work = mkdtempSync(join(tmpdir(), 'marveen-fleet-bad-name-'))
    try {
      mkdirSync(join(work, 'agents', 'good'), { recursive: true })
      mkdirSync(join(work, 'agents', '!!!'), { recursive: true })
      writeFileSync(join(work, 'agents', 'good', 'CLAUDE.md'), 'ok')
      writeFileSync(join(work, 'agents', '!!!', 'CLAUDE.md'), 'should-be-skipped')
      writeFileSync(join(work, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, kind: 'fleet', agents: ['good', '!!!'],
      }))
      const out = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', out, '-C', work, 'manifest.json', 'agents'])
      const buf = readFileSync(out)
      const r = ab.importAllAgentsBundle(buf)
      expect(r.imported.map((x) => x.name)).toEqual(['good'])
      expect(r.skipped).toEqual([{ name: '!!!', reason: 'invalid name' }])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('skips agent entries that vanish between readdirSync and statSync (catch branch)', () => {
    // The catch branch on the per-entry statSync call in importAllAgentsBundle
    // only fires when statSync throws. We force that for one entry by
    // toggling the global fsState.statThrowFor flag -> the vi.mock below
    // intercepts statSync to honor it.
    const work = mkdtempSync(join(tmpdir(), 'marveen-fleet-disappeared-'))
    try {
      mkdirSync(join(work, 'agents', 'realone'), { recursive: true })
      writeFileSync(join(work, 'agents', 'realone', 'CLAUDE.md'), 'real')
      mkdirSync(join(work, 'agents', 'ghostentry'), { recursive: true })
      writeFileSync(join(work, 'agents', 'ghostentry', 'CLAUDE.md'), 'ghost')
      writeFileSync(join(work, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, kind: 'fleet', agents: ['realone', 'ghostentry'],
      }))
      const out = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', out, '-C', work, 'manifest.json', 'agents'])
      const buf = readFileSync(out)
      fsState.statThrowFor = 'ghostentry'
      try {
        const r = ab.importAllAgentsBundle(buf)
        expect(r.imported.map((x) => x.name).sort()).toEqual(['realone'])
      } finally {
        fsState.statThrowFor = null
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('skips entries in agents/ that are regular files, not directories', () => {
    // Drive the isDirectory()===false -> continue branch of the same try.
    const work = mkdtempSync(join(tmpdir(), 'marveen-fleet-rogue-file-'))
    try {
      mkdirSync(join(work, 'agents', 'realone'), { recursive: true })
      writeFileSync(join(work, 'agents', 'realone', 'CLAUDE.md'), 'real')
      writeFileSync(join(work, 'agents', 'rogue'), 'not a directory')
      writeFileSync(join(work, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, kind: 'fleet', agents: ['realone'],
      }))
      const out = join(work, 'bundle.tar.gz')
      execFileSync('tar', ['-czf', out, '-C', work, 'manifest.json', 'agents'])
      const buf = readFileSync(out)
      const r = ab.importAllAgentsBundle(buf)
      expect(r.imported.map((x) => x.name)).toEqual(['realone'])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// fleetBundleFilename
// ---------------------------------------------------------------------------
describe('fleetBundleFilename', () => {
  it('returns a stable, predictable name', () => {
    expect(ab.fleetBundleFilename()).toBe('marveen-fleet.tar.gz')
  })
})
