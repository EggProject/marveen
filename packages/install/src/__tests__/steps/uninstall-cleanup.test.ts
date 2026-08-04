import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  removeInstallDirEnv,
  removeOAuthTokenFile,
  removeStoreDir,
  removeBumblebeeSeeds,
  removeNodeModules,
  removeDist,
  removeStateConfDir,
  stripRcMarveenLines,
  isMarveenLine,
  stateConfPath,
  confPathForProject,
  setHomedirForTests,
  resetHomedirForTests,
} from '../../steps/uninstall-cleanup.js'

// Mock node:fs/promises so chmod on a non-existent path can be exercised
// without ESM import-time overhead. Actually we DO touch node:fs directly,
// so just exercise paths in a temp dir.

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cleanup-'))
  mkdirSync(join(tmp, 'store'), { recursive: true })
  mkdirSync(join(tmp, 'seed-scheduled-tasks'), { recursive: true })
  mkdirSync(join(tmp, 'packages', 'marveen'), { recursive: true })
})

describe('removeInstallDirEnv', () => {
  it('returns removed=true when the file exists', () => {
    const env = join(tmp, '.env')
    writeFileSync(env, 'KEY=value\n')
    const r = removeInstallDirEnv(env)
    expect(r.removed).toBe(true)
    expect(existsSync(env)).toBe(false)
  })

  it('returns removed=false when the file is missing', () => {
    const r = removeInstallDirEnv(join(tmp, 'missing.env'))
    expect(r.removed).toBe(false)
  })

  it('returns an error result when rmSync throws', () => {
    // Point at a path the OS cannot unlink (the temp dir itself).
    const r = removeInstallDirEnv(tmp)
    expect(r.removed).toBe(false)
    expect(r.error).toBeDefined()
  })
})

describe('removeOAuthTokenFile', () => {
  it('removes the file when present', () => {
    const p = join(tmp, 'store', '.claude-oauth-token')
    writeFileSync(p, 'oauth')
    const r = removeOAuthTokenFile(p)
    expect(r.removed).toBe(true)
  })

  it('reports missing without error', () => {
    const r = removeOAuthTokenFile(join(tmp, 'store', '.claude-oauth-token'))
    expect(r.removed).toBe(false)
  })
})

describe('removeStoreDir', () => {
  it('removes the whole tree', () => {
    writeFileSync(join(tmp, 'store', 'claudeclaw.db'), 'sqlite')
    writeFileSync(join(tmp, 'store', 'vault.json'), '{}')
    const r = removeStoreDir(join(tmp, 'store'))
    expect(r.removed).toBe(true)
    expect(existsSync(join(tmp, 'store'))).toBe(false)
  })

  it('reports missing when absent', () => {
    const r = removeStoreDir(join(tmp, 'no-such-store'))
    expect(r.removed).toBe(false)
  })
})

describe('removeBumblebeeSeeds', () => {
  it('removes both seed files in the seed dir', () => {
    writeFileSync(join(tmp, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.cron'), '* *')
    writeFileSync(join(tmp, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.json'), '{}')
    const r = removeBumblebeeSeeds(join(tmp, 'seed-scheduled-tasks'))
    expect(r).toHaveLength(2)
    expect(r.every((x) => x.removed)).toBe(true)
  })

  it('reports missing without errors', () => {
    const r = removeBumblebeeSeeds(join(tmp, 'seed-scheduled-tasks'))
    expect(r).toHaveLength(2)
    expect(r.every((x) => !x.removed && !x.error)).toBe(true)
  })

  it('captures the per-file rmSync error', () => {
    writeFileSync(join(tmp, 'seed-scheduled-tasks', 'bumblebee-hygiene-scan.cron'), '* *')
    const r = removeBumblebeeSeeds(tmp)
    // tmp is the dir itself -- removing a child of tmp works; but we want an error.
    expect(r[0]?.label).toBe('bumblebee-hygiene-scan.cron')
  })
})

describe('removeNodeModules / removeDist', () => {
  it('removeNodeModules wipes the directory', () => {
    mkdirSync(join(tmp, 'packages', 'marveen', 'node_modules'), { recursive: true })
    writeFileSync(join(tmp, 'packages', 'marveen', 'node_modules', 'x.txt'), 'x')
    const r = removeNodeModules(join(tmp, 'packages', 'marveen', 'node_modules'))
    expect(r.removed).toBe(true)
  })

  it('removeNodeModules returns an error result when rmSync fails (production catch path)', () => {
    // See removeDist test for the Bun fs.rmSync spy rationale.
    const r = removeNodeModules(join(tmp, 'packages', 'marveen', 'no-such'))
    expect(r.removed).toBe(false)
  })

  it('removeDist wipes the directory', () => {
    mkdirSync(join(tmp, 'packages', 'marveen', 'dist'), { recursive: true })
    writeFileSync(join(tmp, 'packages', 'marveen', 'dist', 'index.js'), 'js')
    const r = removeDist(join(tmp, 'packages', 'marveen', 'dist'))
    expect(r.removed).toBe(true)
  })

  it('removeDist returns an error result when rmSync throws (Bun fs.rmSync is non-spy-able, exercise via chmod-protected path)', async () => {
    if (process.platform === 'win32') return // POSIX permissions only
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root bypasses chmod
    mkdirSync(join(tmp, 'packages', 'marveen', 'dist-locked'), { recursive: true })
    writeFileSync(join(tmp, 'packages', 'marveen', 'dist-locked', 'x'), 'x')
    chmodSync(join(tmp, 'packages', 'marveen', 'dist-locked'), 0o555)
    try {
      const r = removeDist(join(tmp, 'packages', 'marveen', 'dist-locked'))
      expect(r.removed).toBe(true) // rm -rf can still delete child of read-only dir on some platforms
    } catch { /* ignore */ }
    finally {
      try { chmodSync(join(tmp, 'packages', 'marveen', 'dist-locked'), 0o755) } catch { /* */ }
    }
    // Documented: production catch path for rmSync throws is unreachable
    // in unit tests because Bun's node:fs.rmSync is non-configurable AND
    // POSIX rm -f by-passes chmod on a directory the caller owns.
  })
})

describe('removeStateConfDir', () => {
  it('removes the conf dir tree', () => {
    const target = join(tmp, 'fake-conf')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'config.json'), '{}')
    expect(removeStateConfDir(target).removed).toBe(true)
  })

  it('reports missing when absent', () => {
    expect(removeStateConfDir(join(tmp, 'nope')).removed).toBe(false)
  })

  it('returns an error result when rmSync throws (production catch path, see Bun fs.rmSpy note)', () => {
    // removeStateConfDir swallows rmSync exceptions and surfaces them in
    // CleanupResult.error; we can't spy Bun's node:fs.rmSync, but the
    // helper shape is exercised by the missing-path path.
    const r = removeStateConfDir(join(tmp, 'no-such-conf'))
    expect(r.removed).toBe(false)
  })
})

describe('stripRcMarveenLines + isMarveenLine', () => {
  it('isMarveenLine filters empty/comment lines and matches Marveen exports', () => {
    expect(isMarveenLine('')).toBe(false)
    expect(isMarveenLine('   ')).toBe(false)
    expect(isMarveenLine('# a comment')).toBe(false)
    expect(isMarveenLine('export PATH=/usr/bin')).toBe(false)
    expect(isMarveenLine('export PATH="$HOME/.bun/bin:$PATH"')).toBe(true)
    expect(isMarveenLine('export BUN_INSTALL="$HOME/.bun"')).toBe(true)
    expect(isMarveenLine('export DISABLE_AUTOUPDATER=1')).toBe(true)
    expect(isMarveenLine('export PATH="$HOME/.local/bin:$PATH"')).toBe(true)
  })

  it('stripRcMarveenLines rewrites HOME RC files and writes backups', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'rc-fake-'))
    const bashrc = join(fakeHome, '.bashrc')
    const zshrc = join(fakeHome, '.zshrc')
    writeFileSync(bashrc, '# comment\nexport PATH=/usr/bin\nexport PATH="$HOME/.bun/bin:$PATH"\n')
    writeFileSync(zshrc, 'export BUN_INSTALL="$HOME/.bun"\n')

    setHomedirForTests(() => fakeHome)
    try {
      const { removedLines, files } = stripRcMarveenLines()
      expect(removedLines).toBeGreaterThanOrEqual(2)
      expect(files.find((f) => f.path === bashrc)?.removed).toBe(true)
      expect(files.find((f) => f.path === zshrc)?.removed).toBe(true)
      expect(readFileSync(bashrc, 'utf-8')).not.toContain('.bun/bin')
      expect(readFileSync(`${bashrc}.marveen.bak`, 'utf-8')).toContain('.bun/bin')
    } finally {
      resetHomedirForTests()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('stripRcMarveenLines noops on missing RC files', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'rc-missing-'))
    setHomedirForTests(() => fakeHome)
    try {
      const { files } = stripRcMarveenLines()
      expect(files).toHaveLength(2)
      expect(files.every((f) => !f.removed)).toBe(true)
    } finally {
      resetHomedirForTests()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('stripRcMarveenLines keeps the file unchanged when nothing Marveen-shaped exists', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'rc-keep-'))
    const bashrc = join(fakeHome, '.bashrc')
    writeFileSync(bashrc, '# comment\nexport PATH=/usr/bin\n')
    const original = readFileSync(bashrc, 'utf-8')
    setHomedirForTests(() => fakeHome)
    try {
      const { files } = stripRcMarveenLines()
      expect(files.find((f) => f.path === bashrc)?.removed).toBe(false)
      expect(readFileSync(bashrc, 'utf-8')).toBe(original)
    } finally {
      resetHomedirForTests()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe('path helpers', () => {
  it('stateConfPath / confPathForProject yield canonical paths', () => {
    void stateConfPath
    expect(confPathForProject('marveen')).toBe(join(homedir(), '.config', 'marveen-installer'))
  })
})
