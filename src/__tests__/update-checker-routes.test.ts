// 100% coverage test for src/web/update-checker.ts.
//
// The update-checker module polls the GitHub remote that matches the current
// repo's `origin` for the latest commit on the tracked branch, compares it to
// local HEAD, and groups the deltas into upcoming / per-release buckets. Five
// surfaces are exercised:
//
//   - currentGitHead() / trackedBranch() / parseGitHubRemote(): thin wrappers
//     around `git rev-parse` / `git config` with detached-HEAD and missing-
//     remote fallbacks.
//   - getUpdateStatus(): returns the module-scope cache, re-resolving branch
//     live so a checkout switch is visible before the next refresh tick.
//   - refreshUpdateStatus(): orchestrates the two GitHub calls (commits/<br>
//     then compare/base...head), applies the result onto a fresh status, and
//     records a fork=false / fork=true state depending on whether the local
//     HEAD is on the upstream remote.
//   - startUpdateChecker(): schedules the first refresh after 10s and then
//     every 15 minutes via setInterval.
//
// Sandbox: all collaborators are mocked at the module boundary
// (child_process, config, tool-timeouts); fetch is stubbed per-test so the
// GitHub calls never hit the network. vitest isolates module registries per
// test file, and `vi.resetModules()` before each `loadSUT()` call gives the
// SUT a fresh `updateStatusCache`, which is module-scope state and would
// otherwise leak between tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock fns. The vi.mock() factories below reference these; vi.hoisted
// keeps the declarations available in the hoisted factory scope.
// ---------------------------------------------------------------------------
const {
  mockExecFileSync,
  mockProjectRoot,
  mockToolTimeouts,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockProjectRoot: '/fake/project',
  mockToolTimeouts: { github: 10_000 },
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: mockProjectRoot,
}))

vi.mock('../tool-timeouts.js', () => ({
  TOOL_TIMEOUTS: mockToolTimeouts,
}))

// ---------------------------------------------------------------------------
// Fresh-module helper. Each test calls loadSUT() to reset the SUT's module
// cache, which re-creates `updateStatusCache` to its initial empty values.
// ---------------------------------------------------------------------------
async function loadSUT(): Promise<typeof import('../web/update-checker.js')> {
  vi.resetModules()
  return await import('../web/update-checker.js')
}

function mkJsonResponse(body: unknown, ok = true, status = 200): Response {
  // When ok=false the caller wants a specific HTTP error status. Earlier
  // versions of this helper hardcoded 500 regardless of the status argument
  // and broke assertions like `-> 403`. Honor both knobs.
  return new Response(JSON.stringify(body), {
    status: ok ? status : (status === 200 ? 500 : status),
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Per-test mock reset.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  // Default: a clean git checkout on `main`. Tests override as needed.
  mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
    if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
    return ''
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ===========================================================================
// currentGitHead
// ===========================================================================

describe('currentGitHead', () => {
  it('returns the trimmed SHA from `git rev-parse HEAD`', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return '  deadbeefcafebabe1234567890abcdef00000000  \n'
      return ''
    })
    const { currentGitHead } = await loadSUT()
    expect(currentGitHead()).toBe('deadbeefcafebabe1234567890abcdef00000000')
  })

  it('returns "" when `git rev-parse HEAD` throws (no git binary or non-checkout cwd)', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo')
    })
    const { currentGitHead } = await loadSUT()
    expect(currentGitHead()).toBe('')
  })
})

// ===========================================================================
// trackedBranch
// ===========================================================================

describe('trackedBranch', () => {
  it('returns the trimmed branch name', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'develop\n'
      return ''
    })
    const { trackedBranch } = await loadSUT()
    expect(trackedBranch()).toBe('develop')
  })

  it('falls back to "main" on a detached HEAD (literal "HEAD")', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'HEAD\n'
      return ''
    })
    const { trackedBranch } = await loadSUT()
    expect(trackedBranch()).toBe('main')
  })

  it('falls back to "main" when git returns an empty string', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return '\n'
      return ''
    })
    const { trackedBranch } = await loadSUT()
    expect(trackedBranch()).toBe('main')
  })

  it('falls back to "main" when git throws', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no git')
    })
    const { trackedBranch } = await loadSUT()
    expect(trackedBranch()).toBe('main')
  })
})

// ===========================================================================
// parseGitHubRemote
// ===========================================================================

describe('parseGitHubRemote', () => {
  it('normalizes a git@github.com:Owner/Repo.git URL to "Owner/Repo"', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Acme/Marvin.git\n'
      return ''
    })
    const { parseGitHubRemote } = await loadSUT()
    expect(parseGitHubRemote()).toBe('Acme/Marvin')
  })

  it('normalizes an https://github.com/Owner/Repo.git URL to "Owner/Repo"', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') return 'https://github.com/Acme/Marvin.git\n'
      return ''
    })
    const { parseGitHubRemote } = await loadSUT()
    expect(parseGitHubRemote()).toBe('Acme/Marvin')
  })

  it('normalizes an https URL without a .git suffix', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') return 'https://github.com/Acme/Marvin\n'
      return ''
    })
    const { parseGitHubRemote } = await loadSUT()
    expect(parseGitHubRemote()).toBe('Acme/Marvin')
  })

  it('falls back to the default "Szotasz/marveen" when the remote URL is non-GitHub', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') return 'git@gitlab.example.com:foo/bar.git\n'
      return ''
    })
    const { parseGitHubRemote } = await loadSUT()
    expect(parseGitHubRemote()).toBe('Szotasz/marveen')
  })

  it('falls back to the default when git config throws (no remote)', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no remote')
    })
    const { parseGitHubRemote } = await loadSUT()
    expect(parseGitHubRemote()).toBe('Szotasz/marveen')
  })
})

// ===========================================================================
// getUpdateStatus
// ===========================================================================

describe('getUpdateStatus', () => {
  it('returns the default empty cache on first call, with branch resolved live', async () => {
    const { getUpdateStatus } = await loadSUT()
    const status = getUpdateStatus()
    expect(status.current).toBe('')
    expect(status.latest).toBe('')
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.remote).toBe('Szotasz/marveen')
    expect(status.lastChecked).toBe(0)
    expect(status.branch).toBe('main')
  })

  it('returns a copy of the cache (mutating top-level fields does not affect later reads)', async () => {
    const { getUpdateStatus } = await loadSUT()
    const first = getUpdateStatus()
    first.current = 'MUTATED'
    first.latest = 'MUTATED'
    first.behind = 99
    const second = getUpdateStatus()
    expect(second.current).toBe('')
    expect(second.latest).toBe('')
    expect(second.behind).toBe(0)
    // NOTE: nested arrays (commits) are a SHARED reference (shallow spread).
    // Documenting the actual behavior here so a future change to deep-copy
    // either shows up as a deliberate test update or breaks this assertion.
  })

  it('reflects the cache populated by refreshUpdateStatus (latest/behind/commits), plus live branch', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) return mkJsonResponse({ ahead_by: 0, commits: [] })
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus, getUpdateStatus } = await loadSUT()
    await refreshUpdateStatus()
    const status = getUpdateStatus()
    expect(status.current).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(status.latest).toBe('remotesha1234remotesha1234remotesha1234')
    expect(status.lastChecked).toBeGreaterThan(0)
    expect(status.branch).toBe('main')
    expect(status.remote).toBe('Owner/Repo')
  })
})

// ===========================================================================
// refreshUpdateStatus -- not a git checkout
// ===========================================================================

describe('refreshUpdateStatus -- not a git checkout', () => {
  it('sets error="Not a git checkout" and skips GitHub calls when currentGitHead returns ""', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ''
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
      return ''
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.error).toBe('Not a git checkout')
    expect(status.current).toBe('')
    expect(status.latest).toBe('')
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// refreshUpdateStatus -- already up-to-date
// ===========================================================================

describe('refreshUpdateStatus -- up-to-date branch', () => {
  it('returns behind=0 with no commits when local HEAD matches remote latest', async () => {
    const sameSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: sameSha })
      // If a compare were issued it would be a bug -- must not be.
      if (url.includes('/compare/')) {
        throw new Error('compare should not be called when local HEAD === latest')
      }
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.current).toBe(sameSha)
    expect(status.latest).toBe(sameSha)
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.error).toBeUndefined()
    expect(status.fork).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// refreshUpdateStatus -- commits ahead (upstream reachable, normal path)
// ===========================================================================

describe('refreshUpdateStatus -- commits ahead', () => {
  it('populates commits and behind, with newest-first ordering and release grouping', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) {
        return mkJsonResponse({
          ahead_by: 3,
          commits: [
            { sha: '1111111oldest111111111111111111111111111', commit: { message: 'feat: oldest\n\nbody', author: { name: 'A', date: '2026-01-01T00:00:00Z' } } },
            { sha: '2222222middle22222222222222222222222222', commit: { message: 'chore(release): v1.20.0 -- newer release', author: { name: 'B', date: '2026-01-02T00:00:00Z' } } },
            { sha: '3333333newest333333333333333333333333333', commit: { message: 'fix: newest', author: { name: 'C', date: '2026-01-03T00:00:00Z' } } },
          ],
        })
      }
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.behind).toBe(3)
    expect(status.commits.map(c => c.short)).toEqual(['3333333', '2222222', '1111111'])
    expect(status.commits[0].message).toBe('fix: newest')
    expect(status.commits[0].author).toBe('C')
    expect(status.commits[0].date).toBe('2026-01-03T00:00:00Z')
    // Release grouping: upcoming=[3333], v1.20.0=[1111] (commits older than
    // the release marker; the marker itself is the group boundary, not a
    // member of the group).
    expect(status.releases).toBeDefined()
    expect(status.releases![0].version).toBe('')
    expect(status.releases![0].commits.map(c => c.short)).toEqual(['3333333'])
    expect(status.releases![1].version).toBe('v1.20.0')
    expect(status.releases![1].commits.map(c => c.short)).toEqual(['1111111'])
    // Subject summary on the release commit: falls back to "newer release".
    expect(status.releases![1].summary).toBe('newer release')
  })

  it('handles compare responses missing ahead_by and commits fields (defaults to 0/[])', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) return mkJsonResponse({})
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
  })

  it('handles commits missing author/date/message fields (defaults to empty)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) {
        return mkJsonResponse({
          ahead_by: 1,
          commits: [{ sha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde00', commit: {} }],
        })
      }
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.commits).toHaveLength(1)
    expect(status.commits[0].short).toBe('abcdef0')
    expect(status.commits[0].message).toBe('')
    expect(status.commits[0].author).toBe('')
    expect(status.commits[0].date).toBe('')
  })

  it('returns null compare (no error) when fetchCompare hits a non-404, non-OK status', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) return mkJsonResponse({}, false, 500)
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    // When the compare fails entirely (500) the status still has behind=0 and
    // no commits, but no error string is recorded -- the outer try arm leaves
    // the status silently empty.
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.error).toBeUndefined()
    expect(status.fork).toBeUndefined()
  })
})

// ===========================================================================
// refreshUpdateStatus -- fork path (404 on direct compare, fall back to merge-base)
// ===========================================================================

describe('refreshUpdateStatus -- fork path', () => {
  it('marks fork=true and uses merge-base when local HEAD is not on GitHub remote, base has upstream commits', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      // First compare (raw local HEAD ... latest) 404s because the local HEAD
      // is a fork-only commit.
      if (url.includes('/localsha1234localsha1234localsha1234...')) {
        return mkJsonResponse({}, false, 404)
      }
      // Second compare (merge-base ... latest) succeeds with one upstream commit.
      if (url.includes('/compare/')) {
        return mkJsonResponse({
          ahead_by: 1,
          commits: [
            { sha: 'cccccccccccccccccccccccccccccccccccccccc', commit: { message: 'fix: upstream-only commit', author: { name: 'U', date: '2026-02-02T00:00:00Z' } } },
          ],
        })
      }
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'localsha1234localsha1234localsha1234\n'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
      if (args[0] === 'merge-base') return 'mergebasesha1234mergebasesha1234mergebase\n'
      return ''
    })

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.error).toBeUndefined()
    expect(status.behind).toBe(1)
    expect(status.commits).toHaveLength(1)
    expect(status.commits[0].short).toBe('ccccccc')
  })

  it('marks fork=true with behind=0 when the merge-base is the upstream tip (no new upstream commits)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'mergebasesha1234mergebasesha1234mergebase' })
      if (url.includes('/compare/')) return mkJsonResponse({}, false, 404)
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'localsha1234localsha1234localsha1234\n'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
      if (args[0] === 'merge-base') return 'mergebasesha1234mergebasesha1234mergebase\n'
      return ''
    })

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.error).toBeUndefined()
  })

  it('marks fork=true with behind=0 when `git merge-base` returns empty (no local upstream ref)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) return mkJsonResponse({}, false, 404)
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'localsha1234localsha1234localsha1234\n'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
      if (args[0] === 'merge-base') throw new Error('no upstream configured')
      return ''
    })

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.error).toBeUndefined()
  })

  it('records the fork error message when the merge-base compare also 404s', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'remotesha1234remotesha1234remotesha1234' })
      if (url.includes('/compare/')) return mkJsonResponse({}, false, 404)
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'localsha1234localsha1234localsha1234\n'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
      if (args[0] === 'config' && args[1] === '--get') return 'git@github.com:Owner/Repo.git\n'
      if (args[0] === 'merge-base') return 'mergebasesha1234mergebasesha1234mergebase\n'
      return ''
    })

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.error).toBe('Local HEAD not found on GitHub -- different fork or unpushed commits?')
    expect(status.behind).toBe(0)
  })
})

// ===========================================================================
// refreshUpdateStatus -- outer catch arm
// ===========================================================================

describe('refreshUpdateStatus -- outer error arm', () => {
  it('records a non-Error throw as a string error', async () => {
    const fetchMock = vi.fn(async () => {
      // fetch() rejections get surfaced through await: throw a non-Error.
      throw 'plain string failure'
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.error).toBe('plain string failure')
    expect(status.current).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(status.latest).toBe('')
    expect(status.commits).toEqual([])
  })

  it('records the Error message when /commits/<branch> returns a non-OK status', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({}, false, 403)
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.error).toBe('GitHub /commits/main -> 403')
  })

  it('records an error when /commits/<branch> returns OK but with no sha', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({})
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshUpdateStatus } = await loadSUT()
    const status = await refreshUpdateStatus()

    expect(status.error).toBe('No sha on commits/main response')
  })
})

// ===========================================================================
// startUpdateChecker
// ===========================================================================

describe('startUpdateChecker', () => {
  it('schedules the first refresh after ~10s and returns the recurring interval handle', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main')) return mkJsonResponse({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
      if (url.includes('/compare/')) return mkJsonResponse({ ahead_by: 0, commits: [] })
      return mkJsonResponse({}, false, 500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { startUpdateChecker } = await loadSUT()
    const handle = startUpdateChecker()

    // No fetch yet -- the first refresh is at +10s
    expect(fetchMock).not.toHaveBeenCalled()

    // Advance just before the first refresh -- still no fetch
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).not.toHaveBeenCalled()

    // Cross the 10s threshold -- the initial setTimeout fires
    await vi.advanceTimersByTimeAsync(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 15-minute interval -- cross one cycle
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Another 15-minute interval
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    clearInterval(handle)
  })

  it('does not surface refresh errors as unhandled rejections when fetch throws', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { startUpdateChecker } = await loadSUT()
    const handle = startUpdateChecker()

    // Both scheduled ticks should fire without throwing uncaught.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchMock).toHaveBeenCalled()

    clearInterval(handle)
  })
})

// ===========================================================================
// groupByRelease -- additional edge cases beyond update-release-grouping
// ===========================================================================

describe('groupByRelease -- body-summary + trailer-stripping edges', () => {
  function c(short: string, message: string) {
    return { sha: short.padEnd(40, '0'), short, message, author: 'Dev', date: '2026-07-09T00:00:00Z' }
  }

  it('uses the body summary after stripping Signed-off-by and Co-authored-by trailers', async () => {
    const fullMsg = [
      'chore(release): v2.0.0 -- subject summary',
      '',
      '- alpha',
      '- beta',
      '',
      'Signed-off-by: Dev <dev@example.com>',
      'Co-authored-by: Bot <bot@example.com>',
    ].join('\n')
    const commits = [c('rel', 'chore(release): v2.0.0 -- subject summary')]
    const { groupByRelease } = await loadSUT()
    const groups = groupByRelease(commits, [fullMsg])
    expect(groups[0].summary).toBe('- alpha\n- beta')
  })

  it('uses the body summary when the body has only trailers (no body lines beyond subject)', async () => {
    const fullMsg = [
      'chore(release): v2.0.1 -- subject',
      '',
      'Co-Authored-By: x <y@z>',
    ].join('\n')
    const commits = [c('rel', 'chore(release): v2.0.1 -- subject')]
    const { groupByRelease } = await loadSUT()
    const groups = groupByRelease(commits, [fullMsg])
    expect(groups[0].summary).toBe('subject')
  })

  it('handles a release commit with no full message recorded (empty body summary)', async () => {
    const commits = [c('rel', 'chore(release): v2.0.2 -- lone')]
    const { groupByRelease } = await loadSUT()
    const groups = groupByRelease(commits, [''])
    expect(groups[0].summary).toBe('lone')
  })

  it('falls back to the empty summary when the release subject has no `--` separator and no text after the version', async () => {
    // Subject is exactly `chore(release): v2.0.3` -- m[2] is the empty
    // string, so the `(m[2] || '')` short-circuit hits its right branch.
    const commits = [c('rel', 'chore(release): v2.0.3')]
    const { groupByRelease } = await loadSUT()
    const groups = groupByRelease(commits, [''])
    expect(groups[0].version).toBe('v2.0.3')
    expect(groups[0].summary).toBe('')
  })
})
