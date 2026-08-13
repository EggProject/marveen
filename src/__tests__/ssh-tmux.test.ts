// 100% coverage test for src/web/ssh-tmux.ts.
//
// Every export is pure (no real network/subprocess/DB). Side-effecting exports
// (`ensureControlDir` -> mkdirSync, `cleanStaleSshSockets` -> execFileSync) are
// driven through vi.mock on node:fs.mkdirSync and node:child_process.execFileSync
// so no real `mkdir` or `ssh` ever runs.
//
// Sandbox: ssh-tmux.ts pulls in no config.js (no STORE_DIR / PROJECT_ROOT), so
// no redirect is needed. The assertions on `controlDir()` sweep the XDG_RUNTIME_DIR
// truthy / whitespace-only / empty / unset cases in-place (each call re-reads
// the env var). The `process.getuid` absence branch is hit by deleting the
// builtin and re-importing the module with `node:os.userInfo` mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

// CONTROL_PATH is a module-level const: ssh-tmux.ts computes it from
// controlDir() once, at import. The beforeEach below deletes XDG_RUNTIME_DIR,
// so every LATER controlDir() call takes the /tmp/marveen-ssh-<uid> branch --
// and on a host where XDG_RUNTIME_DIR is set in the ambient environment the two
// disagree, because the const was frozen with the XDG branch already taken.
//
// macOS never sets XDG_RUNTIME_DIR, so this was invisible locally. A GitHub
// ubuntu-latest runner sets XDG_RUNTIME_DIR=/run/user/1001 and the two
// CONTROL_PATH assertions failed there.
//
// vi.hoisted runs before the static imports are evaluated, so clearing the var
// here makes module-load time and every later call agree on the same branch,
// on every host. The env-var branch coverage further down still sets and
// restores the var per test; controlDir() re-reads it on every call.
//
// Regression check: XDG_RUNTIME_DIR=/run/user/1001 bun --bun vitest run src/__tests__/ssh-tmux.test.ts
vi.hoisted(() => {
  delete process.env.XDG_RUNTIME_DIR
})

// ---------------------------------------------------------------------------
// Mocks -- vi.hoisted so the spy fns exist before the hoisted vi.mock factories.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // execFileSync is the only ssh-tmux collaborator that escapes to disk.
  // Default to a no-op success; individual tests override to throw.
  execFileSync: vi.fn<(_file: string, _args: readonly string[], _opts: unknown) => Buffer>(() => Buffer.from('')),
}))

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  fork: vi.fn(),
}))

// `ensureControlDir` calls `mkdirSync(controlDir(), { recursive: true, mode: 0o700 })`.
// We never want mkdir to actually run against the real filesystem --
// controlDir() returns a /tmp/marveen-ssh-<uid> path that lives outside the
// sandbox. Mock the function so the tests stay deterministic AND we can drive
// both the success arm and the swallowing-the-throw arm in two lines.
const fsMocks = vi.hoisted(() => ({
  mkdirSyncImpl: undefined as ((p: string, opts?: unknown) => unknown) | undefined,
  mkdirSyncCalls: [] as Array<{ path: string; opts: unknown }>,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync: ((p: string | URL, opts?: unknown) => {
      fsMocks.mkdirSyncCalls.push({ path: String(p), opts })
      if (fsMocks.mkdirSyncImpl) return fsMocks.mkdirSyncImpl(String(p), opts)
      // Default real pass-through so any unrelated mkdir call (none expected)
      // stays safe.
      return (actual.mkdirSync as unknown as (p: string | URL, o?: unknown) => unknown)(p, opts)
    }) as typeof import('node:fs').mkdirSync,
  }
})

// ---------------------------------------------------------------------------
// Default imports (used by everything that doesn't need a fresh module).
// ---------------------------------------------------------------------------

import {
  shQuote,
  buildTmuxInvocation,
  buildSshExec,
  sessionInList,
  classifyRunState,
  classifyRunStateFromExit,
  buildRemoteLaunchCommand,
  buildContinueProbeCommand,
  ensureControlDir,
  cleanStaleSshSockets,
  SSH_OPTS,
  CONTROL_PATH,
  controlDir,
} from '../web/ssh-tmux.js'

// ---------------------------------------------------------------------------
// Per-test env snapshot. controlDir reads process.env.XDG_RUNTIME_DIR fresh on
// every call, so we just mutate the env for the env-var coverage and restore.
// ---------------------------------------------------------------------------

let savedXdg: string | undefined

beforeEach(() => {
  savedXdg = process.env.XDG_RUNTIME_DIR
  delete process.env.XDG_RUNTIME_DIR
  fsMocks.mkdirSyncCalls.length = 0
  fsMocks.mkdirSyncImpl = undefined
  mocks.execFileSync.mockReset()
  mocks.execFileSync.mockImplementation(() => Buffer.from(''))
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = savedXdg
})

// ---------------------------------------------------------------------------
// shQuote -- pure quoting.
// ---------------------------------------------------------------------------

describe('shQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shQuote('hello')).toBe("'hello'")
  })

  it('escapes an embedded single quote with the POSIX dance', () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it('keeps glob/bracket characters literal (inside single quotes)', () => {
    expect(shQuote('claude-opus-4-8[1m]')).toBe("'claude-opus-4-8[1m]'")
  })

  it('keeps shell metacharacters literal', () => {
    expect(shQuote('a; rm -rf / && echo $HOME')).toBe("'a; rm -rf / && echo $HOME'")
  })

  it('escapes multiple embedded single quotes back-to-back', () => {
    // Each single quote becomes the 4-char sequence '\'' (close, escaped, open).
    // Input has 4 quotes around 'a' and 'b' -> 4 escape segments inside one wrapper.
    expect(shQuote("'a''b'")).toBe("''\\''a'\\'''\\''b'\\'''")
  })
})

// ---------------------------------------------------------------------------
// controlDir -- pick the private ControlMaster socket dir.
// ---------------------------------------------------------------------------

describe('controlDir', () => {
  it('uses XDG_RUNTIME_DIR when set (leading/trailing whitespace trimmed)', () => {
    process.env.XDG_RUNTIME_DIR = '  /run/user/1000  '
    expect(controlDir()).toBe('/run/user/1000/marveen-ssh')
  })

  it('falls back to /tmp/marveen-ssh-<uid> when XDG_RUNTIME_DIR is empty string', () => {
    process.env.XDG_RUNTIME_DIR = ''
    expect(controlDir()).toMatch(/^\/tmp\/marveen-ssh-\d+$/)
  })

  it('falls back when XDG_RUNTIME_DIR is whitespace only (trim().truthy == false)', () => {
    process.env.XDG_RUNTIME_DIR = '    '
    expect(controlDir()).toMatch(/^\/tmp\/marveen-ssh-\d+$/)
  })

  it('falls back to /tmp/marveen-ssh-<uid> when XDG_RUNTIME_DIR is unset', () => {
    delete process.env.XDG_RUNTIME_DIR
    expect(controlDir()).toMatch(/^\/tmp\/marveen-ssh-\d+$/)
  })

  it('matches the marveen-ssh suffix in every code path', () => {
    expect(controlDir()).toMatch(/marveen-ssh/)
  })
})

// ---------------------------------------------------------------------------
// process.getuid absence branch -- non-POSIX fallback to userInfo().
// ---------------------------------------------------------------------------

describe('controlDir (getuid absent -> userInfo fallback)', () => {
  let savedGetuid: (() => number) | undefined

  beforeEach(() => {
    savedGetuid = process.getuid
    // Simulate a non-POSIX runtime where process.getuid is not defined.
    // The function checks `typeof === 'function'` so deleting the slot is enough.
    delete (process as { getuid?: () => number }).getuid
  })

  afterEach(() => {
    if (savedGetuid) (process as { getuid?: () => number }).getuid = savedGetuid
  })

  it('uses "default" when userInfo() throws', async () => {
    vi.resetModules()
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>()
      return { ...actual, userInfo: () => { throw new Error('no user info') } }
    })
    const { controlDir: freshControlDir } = await import('../web/ssh-tmux.js')
    expect(freshControlDir()).toBe('/tmp/marveen-ssh-default')
  })

  it('uses the username when userInfo() succeeds', async () => {
    vi.resetModules()
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>()
      return { ...actual, userInfo: () => ({ username: 'alice' }) }
    })
    const { controlDir: freshControlDir } = await import('../web/ssh-tmux.js')
    expect(freshControlDir()).toBe('/tmp/marveen-ssh-alice')
  })
})

// ---------------------------------------------------------------------------
// CONTROL_PATH -- computed once at module load from controlDir().
// ---------------------------------------------------------------------------

describe('CONTROL_PATH', () => {
  it('joins the live controlDir() output with the cm-%r@%h:%p template', () => {
    expect(CONTROL_PATH).toBe(join(controlDir(), 'cm-%r@%h:%p'))
  })

  it('lives under a private dir, never the bare /tmp/<file> world-writable form', () => {
    expect(CONTROL_PATH).toMatch(/marveen-ssh/)
    expect(CONTROL_PATH).not.toMatch(/^\/tmp\/[^/]+$/)
  })
})

// ---------------------------------------------------------------------------
// SSH_OPTS -- the shared argv invariant. If a future edit adds/removes an
// option, every consumer of ssh-tmux breaks; we lock the shape here.
// ---------------------------------------------------------------------------

describe('SSH_OPTS', () => {
  it('bounds an alive-but-unresponsive remote (ServerAlive), not just TCP connect', () => {
    expect(SSH_OPTS).toContain('ServerAliveInterval=2')
    expect(SSH_OPTS).toContain('ServerAliveCountMax=2')
    expect(SSH_OPTS).toContain('ConnectTimeout=5')
    expect(SSH_OPTS).toContain('BatchMode=yes')
  })

  it('multiplexes via ControlMaster + ControlPersist so the watcher loop reuses one conn', () => {
    expect(SSH_OPTS).toContain('ControlMaster=auto')
    expect(SSH_OPTS).toContain('ControlPersist=60')
  })

  it('every flag is passed as a single -o arg pair (no broken -o X -o Y interleaving)', () => {
    for (let i = 0; i < SSH_OPTS.length; i += 1) {
      if (SSH_OPTS[i] === '-o') {
        expect(SSH_OPTS[i + 1]).toBeDefined()
        expect(SSH_OPTS[i + 1]).toContain('=')
      }
    }
  })

  it('uses a private ControlMaster socket dir, not a bare world-writable /tmp path', () => {
    const controlPathOpt = SSH_OPTS.find(o => o.startsWith('ControlPath='))
    expect(controlPathOpt).toBeDefined()
    expect(controlPathOpt).toContain(controlDir())
    expect(controlPathOpt).toBe(`ControlPath=${CONTROL_PATH}`)
    expect(controlPathOpt).not.toMatch(/ControlPath=\/tmp\/[^/]+%/)
  })

  it('is typed readonly (TypeScript compile-time guard; runtime mutation is the consumer responsibility)', () => {
    // The runtime array IS mutable -- the readonly modifier is TS-only -- but the
    // SSH module itself never mutates it. The contract we lock down here: length
    // is locked to its declared size, because any test that grows the array
    // would break every consumer.
    expect(SSH_OPTS.length).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// buildTmuxInvocation -- the cross-process injection boundary.
// ---------------------------------------------------------------------------

describe('buildTmuxInvocation', () => {
  it('host=null returns the bare local binary + args (byte-identical to a direct local call)', () => {
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['list-sessions'])).toEqual({
      file: '/usr/bin/tmux',
      args: ['list-sessions'],
    })
  })

  it('host set wraps every tmux arg in one shell-quoted ssh command string', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', "a'b c"])
    expect(inv.file).toBe('ssh')
    expect(inv.args.length).toBe(SSH_OPTS.length + 2)
    expect(inv.args.slice(0, SSH_OPTS.length)).toEqual([...SSH_OPTS])
    expect(inv.args[SSH_OPTS.length]).toBe('devbox')
    expect(inv.args[SSH_OPTS.length + 1]).toBe(
      "tmux 'send-keys' '-t' 'agent-x' '-l' 'a'\\''b c'",
    )
  })

  it('uses a custom remoteTmuxBin verbatim (default param is "tmux", this proves the binding)', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['list-sessions'], '/opt/homebrew/bin/tmux')
    expect(inv.args[SSH_OPTS.length + 1].startsWith('/opt/homebrew/bin/tmux ')).toBe(true)
  })

  it('a full new-session launch command rides as a SINGLE argv element with brackets kept literal', () => {
    const cmd = "cd '/home/user/p' && claude --continue --model 'claude-opus-4-8[1m]'"
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['new-session', '-d', '-s', 'agent-x', cmd])
    expect(inv.file).toBe('ssh')
    expect(inv.args.length).toBe(SSH_OPTS.length + 2)
    const remote = inv.args[SSH_OPTS.length + 1]
    expect(remote.startsWith("tmux 'new-session' '-d' '-s' 'agent-x' ")).toBe(true)
    expect(remote).toContain('claude-opus-4-8[1m]')
  })

  it('preserves a slid leading-dash chunk (Hungarian suffix) verbatim', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', ' -szal'])
    const remote = inv.args[SSH_OPTS.length + 1]
    expect(remote.endsWith("' -szal'")).toBe(true)
  })

  it('quotes args containing semicolons so a remote agent message cannot chain commands', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-l', 'a; rm -rf / && echo $HOME'])
    expect(inv.args[SSH_OPTS.length + 1]).toBe(
      "tmux 'send-keys' '-l' 'a; rm -rf / && echo $HOME'",
    )
  })

  it('an empty tmuxArgs list still produces a valid remote invocation', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', [])
    expect(inv.file).toBe('ssh')
    expect(inv.args[SSH_OPTS.length + 1]).toBe('tmux')
  })
})

// ---------------------------------------------------------------------------
// buildSshExec -- a shell-trusted remote command (no extra quoting).
// ---------------------------------------------------------------------------

describe('buildSshExec', () => {
  it('builds an ssh invocation with SSH_OPTS + host + the raw remote command', () => {
    const inv = buildSshExec('devbox', 'which claude')
    expect(inv.file).toBe('ssh')
    expect(inv.args).toEqual([...SSH_OPTS, 'devbox', 'which claude'])
  })

  it('does NOT wrap the remote command in single quotes (caller must shQuote any data)', () => {
    const inv = buildSshExec('devbox', 'echo literal')
    expect(inv.args[SSH_OPTS.length + 1]).toBe('echo literal')
    expect(inv.args[SSH_OPTS.length + 1].startsWith("'")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sessionInList -- exact-line match against tmux list-sessions output.
// ---------------------------------------------------------------------------

describe('sessionInList', () => {
  it('matches an exact session line', () => {
    expect(sessionInList('agent-a\nagent-b\n', 'agent-b')).toBe(true)
  })

  it('is false when the session is absent', () => {
    expect(sessionInList('agent-a\n', 'agent-x')).toBe(false)
  })

  it('does not match on a substring of a longer session name', () => {
    expect(sessionInList('agent-bbb\n', 'agent-b')).toBe(false)
  })

  it('trims every line before compare so `agent-a  \\n` matches `agent-a`', () => {
    expect(sessionInList('  agent-a  \n', 'agent-a')).toBe(true)
  })

  it('does NOT trim the searched session name (caller pre-trimmed intent)', () => {
    // Per-agent trim is on the LIST side only; the right-hand session arg is
    // matched verbatim so a stray whitespace in the caller is detected as a miss.
    expect(sessionInList('agent-a\n', '  agent-a  ')).toBe(false)
  })

  it('handles empty output without crashing', () => {
    expect(sessionInList('', 'anything')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classifyRunState -- the listOutput=null vs content branch.
// ---------------------------------------------------------------------------

describe('classifyRunState', () => {
  it('remote + listOutput=null => unreachable (session may still be alive on the laptop)', () => {
    expect(classifyRunState(null, 'agent-x', true)).toBe('unreachable')
  })

  it('local + listOutput=null => stopped (no tmux server)', () => {
    expect(classifyRunState(null, 'agent-x', false)).toBe('stopped')
  })

  it('listOutput present + session in list => running (both local and remote)', () => {
    expect(classifyRunState('agent-x\n', 'agent-x', false)).toBe('running')
    expect(classifyRunState('agent-x\n', 'agent-x', true)).toBe('running')
  })

  it('listOutput present + session absent => stopped (both local and remote)', () => {
    expect(classifyRunState('agent-a\n', 'agent-x', false)).toBe('stopped')
    expect(classifyRunState('agent-a\n', 'agent-x', true)).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// classifyRunStateFromExit -- the exit-status decider for a thrown probe.
// ---------------------------------------------------------------------------

describe('classifyRunStateFromExit', () => {
  it('local failures are always "stopped" regardless of exitStatus', () => {
    expect(classifyRunStateFromExit(undefined, false)).toBe('stopped')
    expect(classifyRunStateFromExit(null, false)).toBe('stopped')
    expect(classifyRunStateFromExit(0, false)).toBe('stopped')
    expect(classifyRunStateFromExit(1, false)).toBe('stopped')
    expect(classifyRunStateFromExit(255, false)).toBe('stopped')
  })

  it('remote + exitStatus=null (killed/timed-out) => unreachable', () => {
    expect(classifyRunStateFromExit(null, true)).toBe('unreachable')
    expect(classifyRunStateFromExit(undefined, true)).toBe('unreachable')
  })

  it('remote + exitStatus=255 (ssh transport failure) => unreachable', () => {
    expect(classifyRunStateFromExit(255, true)).toBe('unreachable')
  })

  it('remote + exitStatus 0..254 => stopped (REACHABLE laptop, just no tmux server yet)', () => {
    expect(classifyRunStateFromExit(0, true)).toBe('stopped')
    expect(classifyRunStateFromExit(1, true)).toBe('stopped')
    expect(classifyRunStateFromExit(2, true)).toBe('stopped')
    expect(classifyRunStateFromExit(127, true)).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// buildRemoteLaunchCommand -- the `tmux new-session -d <cmd>` payload.
// ---------------------------------------------------------------------------

describe('buildRemoteLaunchCommand', () => {
  it('continue=false omits --continue so the launch always starts fresh', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/u/p', model: 'claude-opus-4-8', continue: false })
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain("--model 'claude-opus-4-8'")
    expect(cmd).toContain("cd '/home/u/p'")
    expect(cmd).not.toContain('--continue')
  })

  it('continue=true includes --continue (must come BEFORE --dangerously-skip-permissions)', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/u/p', model: 'claude', continue: true })
    const contIdx = cmd.indexOf('--continue')
    const skipIdx = cmd.indexOf('--dangerously-skip-permissions')
    expect(contIdx).toBeGreaterThan(-1)
    expect(skipIdx).toBeGreaterThan(-1)
    expect(contIdx).toBeLessThan(skipIdx)
  })

  it('quotes the model token so [1m] and other brackets do not glob', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'claude-opus-4-8[1m]', continue: false })
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
  })

  it('quotes the workdir so paths with spaces or shell metas survive intact', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/u/p with space', model: 'claude', continue: false })
    expect(cmd).toContain("cd '/home/u/p with space' && claude ")
  })

  it('sets PATH to cover macOS (/opt/homebrew) and Linux ($HOME/.local) binary locations', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'claude', continue: false })
    expect(cmd.startsWith('export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildContinueProbeCommand -- the `test -d "$HOME/.claude/projects/..."` probe.
// ---------------------------------------------------------------------------

describe('buildContinueProbeCommand', () => {
  it('replaces every "/" in the absWorkdir with "-" so the encoded segment is a single test word', () => {
    expect(buildContinueProbeCommand('/home/u/p'))
      .toBe('test -d "$HOME/.claude/projects/"\'-home-u-p\'')
  })

  it('keeps $HOME outside the single-quoted region (remote shell expands it)', () => {
    const cmd = buildContinueProbeCommand('/home/u/p')
    const homeIdx = cmd.indexOf('$HOME')
    const quoteIdx = cmd.indexOf("'-home-u-p'")
    expect(homeIdx).toBeGreaterThan(-1)
    expect(quoteIdx).toBeGreaterThan(homeIdx)
  })

  it('leaves room for `$HOME` to be expanded to ANY user (no `$USER`-style prefix baked in)', () => {
    const cmd = buildContinueProbeCommand('/home/u/p')
    expect(cmd).not.toContain('$USER')
    expect(cmd).not.toContain("'/home/")
  })
})

// ---------------------------------------------------------------------------
// ensureControlDir -- the one-time mkdirSync(0o700) guard.
// ---------------------------------------------------------------------------

describe('ensureControlDir', () => {
  it('first call mkdirSync(controlDir(), { recursive: true, mode: 0o700 })', async () => {
    vi.resetModules()
    const { ensureControlDir: fresh } = await import('../web/ssh-tmux.js')
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
    expect(fsMocks.mkdirSyncCalls[0]).toEqual({
      path: controlDir(),
      opts: { recursive: true, mode: 0o700 },
    })
  })

  it('second call short-circuits (controlDirEnsured = true); mkdirSync is NOT called again', async () => {
    vi.resetModules()
    const { ensureControlDir: fresh } = await import('../web/ssh-tmux.js')
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
  })

  it('swallows mkdirSync throws (a missing dir only costs connection multiplexing)', async () => {
    vi.resetModules()
    const { ensureControlDir: fresh } = await import('../web/ssh-tmux.js')
    fsMocks.mkdirSyncImpl = () => { throw new Error('EACCES') }
    expect(() => fresh()).not.toThrow()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
  })

  it('after a throw, the next call retries mkdirSync (flag stays false)', async () => {
    vi.resetModules()
    const { ensureControlDir: fresh } = await import('../web/ssh-tmux.js')
    fsMocks.mkdirSyncImpl = () => { throw new Error('EACCES') }
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(1)
    fsMocks.mkdirSyncImpl = () => undefined
    fresh()
    expect(fsMocks.mkdirSyncCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// cleanStaleSshSockets -- the best-effort `ssh -O exit` hint.
// ---------------------------------------------------------------------------

describe('cleanStaleSshSockets', () => {
  it('issues `ssh -O exit -o ControlPath=<CONTROL_PATH> <host>` with timeout=3000, stdio=ignore', () => {
    cleanStaleSshSockets('devbox')
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'ssh',
      ['-O', 'exit', '-o', `ControlPath=${CONTROL_PATH}`, 'devbox'],
      { timeout: 3000, stdio: 'ignore' },
    )
  })

  it('does not throw when ssh -O exit fails (no live master to drop -- expected on the common path)', () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error('unix: no matching socket') })
    expect(() => cleanStaleSshSockets('devbox')).not.toThrow()
  })

  it('does not throw when ssh -O exit returns a non-zero code', () => {
    const err = Object.assign(new Error('exit code'), { status: 255 })
    mocks.execFileSync.mockImplementation(() => { throw err })
    expect(() => cleanStaleSshSockets('laptop')).not.toThrow()
  })

  it('uses the same ControlPath SSH_OPTS uses (cleanup must target the same socket)', () => {
    cleanStaleSshSockets('laptop')
    const call = mocks.execFileSync.mock.calls[0]
    if (!call) throw new Error('execFileSync was not called')
    const args = call[1]
    const controlIdx = args.findIndex(a => a.startsWith('ControlPath='))
    expect(args[controlIdx]).toBe(`ControlPath=${CONTROL_PATH}`)
  })
})
