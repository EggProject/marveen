// 100% coverage test for src/web/dashboard-settings.ts.
//
// Scope: every export and every branch of:
//   - getExternalProjectPaths / addExternalProjectPath / removeExternalProjectPath
//   - parseGitHubUrl (internal, exercised via installGitHubRepo)
//   - getGitHubRepos
//   - detectRequiredEnvVars (.mcp.json with env keys, malformed JSON, missing file)
//   - installGitHubRepo (cloning/installing/done + onProgress + envVars + error paths)
//   - removeGitHubRepo (ok + not found + missing dir)
//   - updateGitHubRepo (ok + not found + missing dir + execSync throws)
//
// Branch inventory that must be covered here:
//
//   addExternalProjectPath
//     - empty / non-absolute raw                -> error "Absolute path required"
//     - absolute path that does not exist       -> error "Directory does not exist"
//     - absolute file (not dir)                 -> error "Directory does not exist"
//     - new valid dir                           -> appended to list
//     - already in list                         -> list returned unchanged
//     - existing externalProjectPaths preserved -> merge
//
//   removeExternalProjectPath
//     - removes one, preserves others
//     - removes the only entry -> empty list
//     - missing key             -> empty list
//     - filter on a non-existent path -> list unchanged
//
//   parseGitHubUrl (via installGitHubRepo)
//     - invalid url             -> error
//     - https, http, with .git, with trailing slash, with subpath
//
//   installGitHubRepo
//     - already installed in store            -> "Already installed: ..."
//     - targetDir exists on disk but not in store -> rmSync + re-clone
//     - clone fails (execSync throws)         -> cleanup + error
//     - clone succeeds, no package.json       -> no npm install call
//     - clone succeeds, package.json present  -> npm install runs
//     - npm install throws                    -> warn, continue (still returns success)
//     - .mcp.json with env vars              -> requiredEnvVars populated
//     - .mcp.json missing                    -> requiredEnvVars undefined
//     - .mcp.json malformed                  -> requiredEnvVars undefined
//     - externalProjectPaths already contains targetDir -> not duplicated
//     - externalProjectPaths missing initially -> created
//     - envVars undefined                     -> repo.envVars is undefined
//     - envVars provided                      -> repo.envVars echoed
//     - onProgress provided                   -> emits cloning/installing/done
//     - onProgress omitted                    -> no throw, still succeeds
//
//   removeGitHubRepo
//     - repo missing                          -> error "Repo not found"
//     - repo present, repo.path missing on disk -> rmSync skipped (existsSync false)
//     - repo present, repo.path present       -> rmSync runs + removed from list + path removed from externalProjectPaths
//
//   updateGitHubRepo
//     - repo missing                          -> error "Repo not found"
//     - repo present, repo.path missing       -> error "Directory missing"
//     - repo present, no package.json         -> only git pull execSync
//     - repo present, with package.json       -> git pull + npm install
//     - execSync throws                       -> error with err.message
//
//   detectRequiredEnvVars
//     - .mcp.json missing                      -> []
//     - .mcp.json malformed JSON              -> []
//     - .mcp.json without mcpServers           -> []
//     - .mcp.json with servers but no env      -> []
//     - .mcp.json with servers + env keys      -> deduped list
//
// Sandbox: SETTINGS_PATH = STORE_DIR/dashboard-settings.json and
// GITHUB_REPOS_DIR = STORE_DIR/github-repos are baked into module-scope
// constants via `join(PROJECT_ROOT, 'store', ...)`. Mocking PROJECT_ROOT in
// `../config.js` makes both paths live under our tmpdir-scoped store dir.
// child_process (execSync) and node:fs are partially mocked: child_process is
// replaced wholesale with a vi.fn(), and node:fs keeps everything except
// existsSync/statSync/rmSync/mkdirSync which we route to the real impls so the
// store + .mcp.json files actually live on disk in the sandbox.
//
// vitest isolates module registries per test file; the PROJECT_ROOT mock and
// fs overrides cannot leak into sibling suites. vi.resetModules() + dynamic
// import gives us a fresh module-scope read of the (mocked) PROJECT_ROOT in
// case a test needs it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  statSync as realStatSync,
  rmSync as realRmSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted mock fns.
// ---------------------------------------------------------------------------
const mockExecSync = vi.fn()

// ---------------------------------------------------------------------------
// Sandbox: a tmpdir-scoped store dir. SETTINGS_PATH and GITHUB_REPOS_DIR both
// live under it (PROJECT_ROOT is mocked to point at its parent).
// ---------------------------------------------------------------------------
const STORE = mkTempStore('dashboard-settings-')
const SETTINGS_FILE = join(STORE, 'dashboard-settings.json')
const GITHUB_REPOS_DIR = join(STORE, 'github-repos')

// Parse `git clone --depth 1 <url> <targetDir>` from a string and return the
// targetDir. The SUT always invokes `git clone` with that exact shape; we
// rely on it to simulate the clone side-effect (creating targetDir) inside
// the execSync mock. Anything else (npm install, etc.) is matched separately.
function parseCloneTarget(cmd: unknown): string | null {
  const s = String(cmd)
  const m = s.match(/^git\s+clone\s+--depth\s+1\s+\S+\s+(\S+)/)
  return m ? m[1]! : null
}

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: dirname(STORE), STORE_DIR: STORE }
})

// Replace child_process wholesale -- the SUT only uses execSync.
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: vi.fn(),
}))

// node:fs -- we want real mkdir/rm/stat/existsSync behavior on the sandbox,
// but the SUT is the one driving them. No interception is needed: pass through.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// SUT import -- AFTER all the vi.mock() calls. Each test that needs a fresh
// store state uses `loadSUT()`, otherwise we use this initial import.
const sut = await import('../web/dashboard-settings.js')

async function loadSUT(): Promise<typeof import('../web/dashboard-settings.js')> {
  vi.resetModules()
  return await import('../web/dashboard-settings.js')
}

// ---------------------------------------------------------------------------
// Test lifecycle: reset the sandbox dirs and the mocks between cases.
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Wipe + recreate the store + github-repos dirs so each test starts clean.
  rmTempDir(STORE)
  realMkdirSync(GITHUB_REPOS_DIR, { recursive: true })
  mockExecSync.mockReset()
  // Default mock implementation: simulate the git clone side-effect by
  // creating the targetDir. npm install is a no-op. Individual tests can
  // override with mockImplementationOnce for failure paths.
  mockExecSync.mockImplementation((cmd: unknown) => {
    const target = parseCloneTarget(cmd)
    if (target) realMkdirSync(target, { recursive: true })
    return ''
  })
})

afterEach(() => {
  rmTempDir(STORE)
})

// ===========================================================================
// External project paths
// ===========================================================================
describe('getExternalProjectPaths', () => {
  it('returns [] when the settings file does not exist', async () => {
    const { getExternalProjectPaths } = await loadSUT()
    expect(getExternalProjectPaths()).toEqual([])
  })

  it('returns [] when the settings file is malformed JSON', async () => {
    realWriteFileSync(SETTINGS_FILE, '{ not json')
    const { getExternalProjectPaths } = await loadSUT()
    expect(getExternalProjectPaths()).toEqual([])
  })

  it('returns [] when externalProjectPaths is absent', async () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({ otherKey: 'value' }))
    const { getExternalProjectPaths } = await loadSUT()
    expect(getExternalProjectPaths()).toEqual([])
  })

  it('returns the persisted list when present', async () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      externalProjectPaths: ['/a', '/b'],
    }))
    const { getExternalProjectPaths } = await loadSUT()
    expect(getExternalProjectPaths()).toEqual(['/a', '/b'])
  })
})

describe('addExternalProjectPath', () => {
  it('rejects empty input with "Absolute path required"', () => {
    const r = sut.addExternalProjectPath('')
    expect(r.error).toBe('Absolute path required')
    expect(r.paths).toEqual([])
  })

  it('rejects a relative path with "Absolute path required"', () => {
    const r = sut.addExternalProjectPath('relative/path')
    expect(r.error).toBe('Absolute path required')
  })

  it('rejects a tilde-prefixed path (not absolute) with "Absolute path required"', () => {
    const r = sut.addExternalProjectPath('~/somewhere')
    expect(r.error).toBe('Absolute path required')
  })

  it('rejects a non-existent absolute path with "Directory does not exist"', () => {
    const r = sut.addExternalProjectPath('/this/does/not/exist/xyzzy')
    expect(r.error).toBe('Directory does not exist')
  })

  it('rejects an absolute path that points at a file, not a directory', () => {
    const tmpFile = join(STORE, 'a-file.txt')
    realWriteFileSync(tmpFile, 'x')
    const r = sut.addExternalProjectPath(tmpFile)
    expect(r.error).toBe('Directory does not exist')
  })

  it('appends a new valid directory and persists it', () => {
    const dir = join(STORE, 'project-A')
    realMkdirSync(dir, { recursive: true })
    const r = sut.addExternalProjectPath(dir)
    expect(r.error).toBeUndefined()
    expect(r.paths).toEqual([dir])
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.externalProjectPaths).toEqual([dir])
  })

  it('does not duplicate a path that is already in the list (no-op)', () => {
    const dir = join(STORE, 'project-B')
    realMkdirSync(dir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({ externalProjectPaths: [dir] }))
    const r = sut.addExternalProjectPath(dir)
    expect(r.error).toBeUndefined()
    expect(r.paths).toEqual([dir])
  })

  it('preserves existing entries and appends the new one', () => {
    const dirA = join(STORE, 'project-A')
    const dirB = join(STORE, 'project-B')
    realMkdirSync(dirA, { recursive: true })
    realMkdirSync(dirB, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({ externalProjectPaths: [dirA] }))
    const r = sut.addExternalProjectPath(dirB)
    expect(r.paths).toEqual([dirA, dirB])
  })

  it('creates the settings file from scratch on first add', () => {
    const dir = join(STORE, 'project-C')
    realMkdirSync(dir, { recursive: true })
    expect(realExistsSync(SETTINGS_FILE)).toBe(false)
    sut.addExternalProjectPath(dir)
    expect(realExistsSync(SETTINGS_FILE)).toBe(true)
  })
})

describe('removeExternalProjectPath', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(sut.removeExternalProjectPath('/anything')).toEqual([])
  })

  it('returns an empty list when externalProjectPaths is absent', () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({}))
    expect(sut.removeExternalProjectPath('/anything')).toEqual([])
  })

  it('removes the entry that matches', () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      externalProjectPaths: ['/keep', '/drop'],
    }))
    const r = sut.removeExternalProjectPath('/drop')
    expect(r).toEqual(['/keep'])
  })

  it('leaves the list unchanged when the path is not present', () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      externalProjectPaths: ['/keep'],
    }))
    const r = sut.removeExternalProjectPath('/never-added')
    expect(r).toEqual(['/keep'])
  })

  it('removes the only entry yielding an empty list', () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      externalProjectPaths: ['/only'],
    }))
    expect(sut.removeExternalProjectPath('/only')).toEqual([])
  })

  it('resolves a relative-or-non-canonical path before matching', () => {
    const dir = join(STORE, 'project-X')
    realMkdirSync(dir, { recursive: true })
    // Insert via trailing-dot form that resolves to the same absolute path.
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({ externalProjectPaths: [dir] }))
    // resolve() will normalize trailing dots / slashes.
    const r = sut.removeExternalProjectPath(`${dir}/`)
    expect(r).toEqual([])
  })
})

// ===========================================================================
// GitHub repos -- parseGitHubUrl / getGitHubRepos
// ===========================================================================
describe('getGitHubRepos', () => {
  it('returns [] when settings file does not exist', async () => {
    const { getGitHubRepos } = await loadSUT()
    expect(getGitHubRepos()).toEqual([])
  })

  it('returns [] when the file is malformed JSON', async () => {
    realWriteFileSync(SETTINGS_FILE, '{ broken')
    const { getGitHubRepos } = await loadSUT()
    expect(getGitHubRepos()).toEqual([])
  })

  it('returns [] when githubRepos is absent', async () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({ externalProjectPaths: ['/x'] }))
    const { getGitHubRepos } = await loadSUT()
    expect(getGitHubRepos()).toEqual([])
  })

  it('returns the persisted list', async () => {
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{ url: 'https://github.com/a/b', name: 'a--b', path: '/x/a--b', installedAt: '2026-01-01T00:00:00.000Z' }],
    }))
    const { getGitHubRepos } = await loadSUT()
    expect(getGitHubRepos()).toHaveLength(1)
    expect(getGitHubRepos()[0]!.name).toBe('a--b')
  })
})

// ===========================================================================
// detectRequiredEnvVars
// ===========================================================================
describe('detectRequiredEnvVars', () => {
  it('returns [] when .mcp.json is missing', () => {
    const dir = join(STORE, 'no-mcp')
    realMkdirSync(dir, { recursive: true })
    expect(sut.detectRequiredEnvVars(dir)).toEqual([])
  })

  it('returns [] when .mcp.json is malformed JSON', () => {
    const dir = join(STORE, 'bad-mcp')
    realMkdirSync(dir, { recursive: true })
    realWriteFileSync(join(dir, '.mcp.json'), '{ not json')
    expect(sut.detectRequiredEnvVars(dir)).toEqual([])
  })

  it('returns [] when .mcp.json has no mcpServers key', () => {
    const dir = join(STORE, 'empty-mcp')
    realMkdirSync(dir, { recursive: true })
    realWriteFileSync(join(dir, '.mcp.json'), JSON.stringify({}))
    expect(sut.detectRequiredEnvVars(dir)).toEqual([])
  })

  it('returns [] when mcpServers has no env keys', () => {
    const dir = join(STORE, 'no-env-mcp')
    realMkdirSync(dir, { recursive: true })
    realWriteFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { gh: { command: 'gh', args: ['auth'] } },
    }))
    expect(sut.detectRequiredEnvVars(dir)).toEqual([])
  })

  it('returns the union of env keys across multiple servers, deduped', () => {
    const dir = join(STORE, 'multi-env-mcp')
    realMkdirSync(dir, { recursive: true })
    realWriteFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        gh: { env: { GITHUB_TOKEN: 'x', SHARED: '1' } },
        slack: { env: { SLACK_TOKEN: 'y', SHARED: '2' } },
      },
    }))
    const result = sut.detectRequiredEnvVars(dir)
    expect(new Set(result)).toEqual(new Set(['GITHUB_TOKEN', 'SHARED', 'SLACK_TOKEN']))
    expect(result).toHaveLength(3)
  })
})

// ===========================================================================
// installGitHubRepo
//
// The default mock (set in beforeEach) parses the git clone command and
// creates the targetDir on disk so subsequent `existsSync(...package.json)`
// checks behave like a real clone. Individual tests override the mock only
// when they need to control behaviour (throw, create extra files).
// ===========================================================================
describe('installGitHubRepo', () => {
  it('rejects an invalid GitHub URL', async () => {
    const r = await sut.installGitHubRepo('https://example.com/foo/bar')
    expect(r.error).toBe('Invalid GitHub URL')
  })

  it('rejects a non-URL input', async () => {
    const r = await sut.installGitHubRepo('not-a-url')
    expect(r.error).toBe('Invalid GitHub URL')
  })

  it('accepts https://github.com/<owner>/<repo> without .git', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/widget')
    expect(r.error).toBeUndefined()
    expect(r.repo?.name).toBe('acme--widget')
  })

  it('accepts https://github.com/<owner>/<repo>.git', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/widget.git')
    expect(r.repo?.name).toBe('acme--widget')
  })

  it('accepts http://github.com/<owner>/<repo>/tree/main/subpath (extra path ignored)', async () => {
    const r = await sut.installGitHubRepo('http://github.com/acme/widget/tree/main/sub')
    expect(r.repo?.name).toBe('acme--widget')
  })

  it('returns "Already installed" when the repo is already registered and targetDir exists', async () => {
    const first = await sut.installGitHubRepo('https://github.com/acme/dup')
    expect(first.error).toBeUndefined()
    // After the first call, the default mock has created targetDir on disk
    // AND the repo is persisted in the settings file. The second call must
    // therefore short-circuit with "Already installed".
    const second = await sut.installGitHubRepo('https://github.com/acme/dup')
    expect(second.error).toBe(`Already installed: acme--dup`)
  })

  it('clears a stale targetDir on disk (rmSync + re-clone) when not registered', async () => {
    // Pre-create the targetDir WITHOUT registering it in the store: simulates
    // a leftover dir from a previous failed install.
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--stale')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(join(targetDir, 'marker.txt'), 'leftover')

    const r = await sut.installGitHubRepo('https://github.com/acme/stale')
    expect(r.error).toBeUndefined()
    // The stale marker should be gone because install removed + recreated it.
    expect(realExistsSync(join(targetDir, 'marker.txt'))).toBe(false)
  })

  it('returns a clone failure with stderr when execSync throws', async () => {
    const err = new Error('git exploded') as Error & { stderr?: string }
    err.stderr = 'fatal: repository not found'
    mockExecSync.mockImplementationOnce(() => { throw err })

    const r = await sut.installGitHubRepo('https://github.com/acme/broken')
    expect(r.error).toBe('Clone failed: fatal: repository not found')
    // The clone failure path must rmSync the targetDir.
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--broken')
    expect(realExistsSync(targetDir)).toBe(false)
  })

  it('returns a clone failure with err.message when stderr is absent', async () => {
    const err = new Error('bare failure')
    mockExecSync.mockImplementationOnce(() => { throw err })

    const r = await sut.installGitHubRepo('https://github.com/acme/alsobroken')
    expect(r.error).toBe('Clone failed: bare failure')
  })

  it('skips npm install when no package.json is present after clone', async () => {
    await sut.installGitHubRepo('https://github.com/acme/nopkg')
    // Only one execSync (the clone). No `npm install` call.
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    expect(String(mockExecSync.mock.calls[0]![0])).toContain('git clone')
  })

  it('runs npm install when package.json is present after clone', async () => {
    // Override the clone call so the simulated clone leaves a package.json
    // behind. The persistent default then handles npm install (returns '').
    mockExecSync.mockImplementationOnce((cmd: unknown) => {
      const target = parseCloneTarget(cmd)
      if (target) {
        realMkdirSync(target, { recursive: true })
        realWriteFileSync(join(target, 'package.json'), '{}')
      }
      return ''
    })
    await sut.installGitHubRepo('https://github.com/acme/withpkg')
    expect(mockExecSync).toHaveBeenCalledTimes(2)
    expect(String(mockExecSync.mock.calls[1]![0])).toContain('npm install')
    // npm install is run with cwd = targetDir.
    const opts = mockExecSync.mock.calls[1]![1] as { cwd: string }
    expect(opts.cwd).toBe(join(GITHUB_REPOS_DIR, 'acme--withpkg'))
  })

  it('warns and continues when npm install throws', async () => {
    mockExecSync.mockImplementationOnce((cmd: unknown) => {
      const target = parseCloneTarget(cmd)
      if (target) {
        realMkdirSync(target, { recursive: true })
        realWriteFileSync(join(target, 'package.json'), '{}')
      }
      return ''
    })
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('npm exploded')
    })
    const r = await sut.installGitHubRepo('https://github.com/acme/badpkg')
    expect(r.error).toBeUndefined()
    // repo is still installed (warn-and-continue).
    expect(r.repo?.name).toBe('acme--badpkg')
  })

  it('populates requiredEnvVars from .mcp.json (env keys found)', async () => {
    mockExecSync.mockImplementationOnce((cmd: unknown) => {
      const target = parseCloneTarget(cmd)
      if (target) {
        realMkdirSync(target, { recursive: true })
        realWriteFileSync(join(target, '.mcp.json'), JSON.stringify({
          mcpServers: { gh: { env: { GITHUB_TOKEN: 'x', EXTRA: 'y' } } },
        }))
      }
      return ''
    })
    const r = await sut.installGitHubRepo('https://github.com/acme/envy')
    expect(r.requiredEnvVars).toBeDefined()
    expect(new Set(r.requiredEnvVars!)).toEqual(new Set(['GITHUB_TOKEN', 'EXTRA']))
  })

  it('omits requiredEnvVars when none are required (.mcp.json absent)', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/plain')
    expect(r.requiredEnvVars).toBeUndefined()
  })

  it('omits requiredEnvVars when .mcp.json is malformed', async () => {
    mockExecSync.mockImplementationOnce((cmd: unknown) => {
      const target = parseCloneTarget(cmd)
      if (target) {
        realMkdirSync(target, { recursive: true })
        realWriteFileSync(join(target, '.mcp.json'), '{ broken')
      }
      return ''
    })
    const r = await sut.installGitHubRepo('https://github.com/acme/badmcp')
    expect(r.requiredEnvVars).toBeUndefined()
  })

  it('records envVars when provided by the caller', async () => {
    const r = await sut.installGitHubRepo(
      'https://github.com/acme/secrets',
      { GH_TOKEN: 'vault-1', NPM_TOKEN: 'vault-2' },
    )
    expect(r.repo?.envVars).toEqual({ GH_TOKEN: 'vault-1', NPM_TOKEN: 'vault-2' })
  })

  it('omits envVars when not provided by the caller', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/nosecrets')
    expect(r.repo?.envVars).toBeUndefined()
  })

  it('persists the repo + adds targetDir to externalProjectPaths', async () => {
    await sut.installGitHubRepo('https://github.com/acme/persist')
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.githubRepos).toHaveLength(1)
    expect(onDisk.githubRepos[0].name).toBe('acme--persist')
    expect(onDisk.externalProjectPaths).toContain(join(GITHUB_REPOS_DIR, 'acme--persist'))
  })

  it('does not duplicate targetDir when externalProjectPaths already has it', async () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--preexisting')
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      externalProjectPaths: [targetDir],
    }))
    await sut.installGitHubRepo('https://github.com/acme/preexisting')
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.externalProjectPaths.filter((p: string) => p === targetDir)).toHaveLength(1)
  })

  it('emits cloning + done via onProgress when no package.json (no installing stage)', async () => {
    const events: Array<{ stage: string; message: string }> = []
    await sut.installGitHubRepo('https://github.com/acme/prog', undefined, (p) => {
      events.push({ stage: p.stage, message: p.message })
    })
    expect(events.map((e) => e.stage)).toEqual(['cloning', 'done'])
    expect(events[0]!.message).toContain('Cloning')
    expect(events[1]!.message).toContain('Installed')
  })

  it('emits cloning + installing + done via onProgress when package.json is present', async () => {
    mockExecSync.mockImplementationOnce((cmd: unknown) => {
      const target = parseCloneTarget(cmd)
      if (target) {
        realMkdirSync(target, { recursive: true })
        realWriteFileSync(join(target, 'package.json'), '{}')
      }
      return ''
    })
    const events: Array<{ stage: string; message: string }> = []
    await sut.installGitHubRepo('https://github.com/acme/progfull', undefined, (p) => {
      events.push({ stage: p.stage, message: p.message })
    })
    expect(events.map((e) => e.stage)).toEqual(['cloning', 'installing', 'done'])
    expect(events[1]!.message).toContain('npm install')
  })

  it('still works without an onProgress callback', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/nocb')
    expect(r.error).toBeUndefined()
  })

  it('uses deep=1 in the git clone command', async () => {
    await sut.installGitHubRepo('https://github.com/acme/depth')
    expect(String(mockExecSync.mock.calls[0]![0])).toContain('--depth 1')
  })

  it('produces an ISO installedAt timestamp', async () => {
    const r = await sut.installGitHubRepo('https://github.com/acme/iso')
    expect(r.repo?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

// ===========================================================================
// removeGitHubRepo
// ===========================================================================
describe('removeGitHubRepo', () => {
  it('returns "Repo not found" when the name is unknown', () => {
    const r = sut.removeGitHubRepo('does-not-exist')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Repo not found')
  })

  it('removes the repo + its externalProjectPaths entry when present', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--gone')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/gone',
        name: 'acme--gone',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
      externalProjectPaths: [targetDir, '/some/other'],
    }))

    const r = sut.removeGitHubRepo('acme--gone')
    expect(r.ok).toBe(true)
    expect(realExistsSync(targetDir)).toBe(false)
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.githubRepos).toEqual([])
    expect(onDisk.externalProjectPaths).toEqual(['/some/other'])
  })

  it('skips rmSync when repo.path does not exist on disk', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--missingdir')
    // Don't mkdir -- path is absent on disk.
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/missingdir',
        name: 'acme--missingdir',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
      externalProjectPaths: [],
    }))
    const r = sut.removeGitHubRepo('acme--missingdir')
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.githubRepos).toEqual([])
  })

  it('preserves other repos when removing one', () => {
    const dir1 = join(GITHUB_REPOS_DIR, 'acme--one')
    const dir2 = join(GITHUB_REPOS_DIR, 'acme--two')
    realMkdirSync(dir1, { recursive: true })
    realMkdirSync(dir2, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [
        { url: 'https://github.com/acme/one', name: 'acme--one', path: dir1, installedAt: '2026-01-01T00:00:00.000Z' },
        { url: 'https://github.com/acme/two', name: 'acme--two', path: dir2, installedAt: '2026-01-01T00:00:00.000Z' },
      ],
      externalProjectPaths: [dir1, dir2],
    }))
    const r = sut.removeGitHubRepo('acme--one')
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.githubRepos).toHaveLength(1)
    expect(onDisk.githubRepos[0].name).toBe('acme--two')
    expect(onDisk.externalProjectPaths).toEqual([dir2])
  })

  it('tolerates externalProjectPaths being absent (defaults to [])', () => {
    // When externalProjectPaths is undefined, the (|| []) short-circuit
    // must kick in so the filter() call never throws on undefined.
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--noextern')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/noextern',
        name: 'acme--noextern',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
      // No externalProjectPaths key on purpose.
    }))
    const r = sut.removeGitHubRepo('acme--noextern')
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(realReadFileSync(SETTINGS_FILE, 'utf-8'))
    expect(onDisk.githubRepos).toEqual([])
  })
})

// ===========================================================================
// updateGitHubRepo
// ===========================================================================
describe('updateGitHubRepo', () => {
  it('returns "Repo not found" when the name is unknown', () => {
    const r = sut.updateGitHubRepo('nope')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Repo not found')
  })

  it('returns "Directory missing" when repo.path is absent on disk', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--vanished')
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/vanished',
        name: 'acme--vanished',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    const r = sut.updateGitHubRepo('acme--vanished')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Directory missing')
    // No execSync should have run.
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('runs only git pull when no package.json is present', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--pullonly')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/pullonly',
        name: 'acme--pullonly',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    mockExecSync.mockReturnValue('')
    const r = sut.updateGitHubRepo('acme--pullonly')
    expect(r.ok).toBe(true)
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    expect(String(mockExecSync.mock.calls[0]![0])).toContain('git pull')
  })

  it('runs git pull + npm install when package.json is present', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--pullpkg')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(join(targetDir, 'package.json'), '{}')
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/pullpkg',
        name: 'acme--pullpkg',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    mockExecSync.mockReturnValue('')
    const r = sut.updateGitHubRepo('acme--pullpkg')
    expect(r.ok).toBe(true)
    expect(mockExecSync).toHaveBeenCalledTimes(2)
    expect(String(mockExecSync.mock.calls[0]![0])).toContain('git pull')
    expect(String(mockExecSync.mock.calls[1]![0])).toContain('npm install')
    // Both should run with cwd = repo.path.
    for (const call of mockExecSync.mock.calls) {
      const opts = call[1] as { cwd: string }
      expect(opts.cwd).toBe(targetDir)
    }
  })

  it('returns the err.stderr message when execSync throws (stderr populated)', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--failupdate')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/failupdate',
        name: 'acme--failupdate',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    const err = new Error('git pull failed') as Error & { stderr?: string }
    err.stderr = 'fatal: not a git repository'
    mockExecSync.mockImplementationOnce(() => { throw err })
    const r = sut.updateGitHubRepo('acme--failupdate')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('fatal: not a git repository')
  })

  it('returns the err.message when execSync throws with no stderr', () => {
    const targetDir = join(GITHUB_REPOS_DIR, 'acme--failmsg')
    realMkdirSync(targetDir, { recursive: true })
    realWriteFileSync(SETTINGS_FILE, JSON.stringify({
      githubRepos: [{
        url: 'https://github.com/acme/failmsg',
        name: 'acme--failmsg',
        path: targetDir,
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    mockExecSync.mockImplementationOnce(() => { throw new Error('bare') })
    const r = sut.updateGitHubRepo('acme--failmsg')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('bare')
  })
})
