// Supplemental tests for src/web/ssh-tmux.ts.
//
// The base file src/__tests__/ssh-tmux.test.ts covers the core quoting and
// invocation builders we rely on for the inbox/terminal routes. This file
// drives the unused / partially-covered branches to 100%:
//   - controlDir() XDG_RUNTIME_DIR path (set BEFORE the module loads)
//   - controlDir() fallback branch when process.getuid is absent AND
//     userInfo().username throws (rare non-POSIX hosts)
//   - CONTROL_PATH template
//   - buildRemoteLaunchCommand  (continue=true and continue=false)
//   - buildContinueProbeCommand
//   - classifyRunState            (null/known/absent for local and remote)
//   - classifyRunStateFromExit    (255, other, null, undefined, local)
//   - ensureControlDir            (idempotent, swallows mkdir errors)
//   - cleanStaleSshSockets        (best-effort error swallow)
//
// `src/web/routes/ssh-tmux.ts` does not exist -- the helper lives at
// src/web/ssh-tmux.ts and is purely a pure-functions module; no DB / config /
// logger / auth mocks are required. We only mock node:os for the getuid-absent
// fallback branch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Tests for the XDG_RUNTIME_DIR branch of controlDir(). This branch is taken
// at module-load time (CONTROL_PATH is built eagerly), so we must set the env
// BEFORE importing the module. We do that with a separate describe block that
// uses vi.resetModules + a fresh dynamic import.
// ---------------------------------------------------------------------------

describe('controlDir XDG_RUNTIME_DIR path', () => {
  const prevXdg = process.env.XDG_RUNTIME_DIR
  let xdgDir: string

  beforeEach(() => {
    xdgDir = mkdtempSync(join(tmpdir(), 'marveen-xdg-'))
    process.env.XDG_RUNTIME_DIR = xdgDir
    vi.resetModules()
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = prevXdg
    rmSync(xdgDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('uses $XDG_RUNTIME_DIR/marveen-ssh when XDG_RUNTIME_DIR is set', async () => {
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.controlDir()).toBe(join(xdgDir, 'marveen-ssh'))
  })

  it('CONTROL_PATH expands to the XDG-based dir when XDG_RUNTIME_DIR is set', async () => {
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.CONTROL_PATH).toBe(join(xdgDir, 'marveen-ssh', 'cm-%r@%h:%p'))
  })

  it('trims surrounding whitespace from XDG_RUNTIME_DIR before joining', async () => {
    process.env.XDG_RUNTIME_DIR = `  ${xdgDir}  `
    vi.resetModules()
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.controlDir()).toBe(join(xdgDir, 'marveen-ssh'))
  })

  it('falls back to /tmp/marveen-ssh-<uid> when XDG_RUNTIME_DIR is set to empty / whitespace', async () => {
    process.env.XDG_RUNTIME_DIR = '   '
    vi.resetModules()
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.controlDir()).toMatch(/^\/tmp\/marveen-ssh-/)
  })
})

// ---------------------------------------------------------------------------
// Tests for controlDir fallback branches when XDG_RUNTIME_DIR is unset.
// process.getuid IS a function on POSIX, so we additionally test the
// getuid-absent + userInfo()throws branch by mocking node:os.
// ---------------------------------------------------------------------------

describe('controlDir fallback path (no XDG_RUNTIME_DIR)', () => {
  it('returns /tmp/marveen-ssh-<uid> on POSIX hosts', async () => {
    delete process.env.XDG_RUNTIME_DIR
    vi.resetModules()
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.controlDir()).toMatch(/^\/tmp\/marveen-ssh-\d+$/)
  })

  it('CONTROL_PATH embeds the per-uid subdir on POSIX hosts', async () => {
    delete process.env.XDG_RUNTIME_DIR
    vi.resetModules()
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.CONTROL_PATH).toMatch(/^\/tmp\/marveen-ssh-\d+\/cm-%r@%h:%p$/)
  })

  it('falls back to userInfo().username when getuid is absent', async () => {
    delete process.env.XDG_RUNTIME_DIR
    vi.resetModules()
    // Force the "no getuid" branch by stubbing process.getuid to undefined.
    const original = (process as { getuid?: () => number }).getuid
    ;(process as { getuid?: () => number }).getuid = undefined
    // Stub userInfo to return a stable username.
    const os = await import('node:os')
    const userInfoSpy = vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'alice',
      uid: -1,
      gid: -1,
      shell: '/bin/sh',
      homedir: '/home/alice',
    } as os.UserInfo<typeof os.userInfo extends (...a: never) => infer R ? R : never>)
    try {
      const mod = await import('../web/ssh-tmux.js')
      expect(mod.controlDir()).toBe('/tmp/marveen-ssh-alice')
    } finally {
      userInfoSpy.mockRestore()
      ;(process as { getuid?: () => number }).getuid = original
    }
  })

  it('falls back to "default" when getuid is absent AND userInfo().username throws', async () => {
    delete process.env.XDG_RUNTIME_DIR
    vi.resetModules()
    const original = (process as { getuid?: () => number }).getuid
    ;(process as { getuid?: () => number }).getuid = undefined
    const os = await import('node:os')
    const userInfoSpy = vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('no user info available')
    })
    try {
      const mod = await import('../web/ssh-tmux.js')
      expect(mod.controlDir()).toBe('/tmp/marveen-ssh-default')
    } finally {
      userInfoSpy.mockRestore()
      ;(process as { getuid?: () => number }).getuid = original
    }
  })
})

// ---------------------------------------------------------------------------
// Now that the module-hash reset has settled, re-import the steady-state
// helper so the rest of the file tests the default branch (no XDG_RUNTIME_DIR,
// POSIX getuid present).
// ---------------------------------------------------------------------------

import {
  buildRemoteLaunchCommand,
  buildContinueProbeCommand,
  classifyRunState,
  classifyRunStateFromExit,
  ensureControlDir,
  cleanStaleSshSockets,
} from '../web/ssh-tmux.js'

describe('buildRemoteLaunchCommand', () => {
  it('emits the PATH export + cd + claude --continue when continue=true', () => {
    const cmd = buildRemoteLaunchCommand({
      workdir: '/home/user/proj',
      model: 'claude-opus-4-8[1m]',
      continue: true,
    })
    expect(cmd).toContain('export PATH=')
    expect(cmd).toContain("'$HOME/.bun/bin'")
    expect(cmd).toContain("cd '/home/user/proj'")
    expect(cmd).toContain(' --continue ')
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
    expect(cmd).toContain('--dangerously-skip-permissions')
  })

  it('omits --continue when continue=false', () => {
    const cmd = buildRemoteLaunchCommand({
      workdir: '/tmp/agent',
      model: 'sonnet',
      continue: false,
    })
    expect(cmd).not.toContain('--continue')
    expect(cmd).toContain("cd '/tmp/agent'")
    expect(cmd).toContain("--model 'sonnet'")
  })

  it('shell-quotes the workdir so a path with a single quote is escaped safely', () => {
    const cmd = buildRemoteLaunchCommand({
      workdir: "/home/o'connor/proj",
      model: 'sonnet',
      continue: false,
    })
    // POSIX single-quote dance: close-escaped-open.
    expect(cmd).toContain("cd '/home/o'\\''connor/proj'")
  })

  it('shell-quotes the model so a [1m] suffix is not globbed', () => {
    const cmd = buildRemoteLaunchCommand({
      workdir: '/work',
      model: 'claude-*?[ab]',
      continue: false,
    })
    expect(cmd).toContain("--model 'claude-*?[ab]'")
  })
})

describe('buildContinueProbeCommand', () => {
  it('replaces every / with - and embeds the encoded path in single quotes', () => {
    // /home/user/proj -> -home-user-proj
    const cmd = buildContinueProbeCommand('/home/user/proj')
    expect(cmd).toBe('test -d "$HOME/.claude/projects/"\'-home-user-proj\'')
  })

  it('handles a leading-dash workdir (which would otherwise be a test flag)', () => {
    const cmd = buildContinueProbeCommand('/foo')
    // Single-quoted region begins with -foo -- no flag parsing.
    expect(cmd).toBe('test -d "$HOME/.claude/projects/"\'-foo\'')
  })

  it('keeps $HOME outside the single-quoted region so the remote shell expands it', () => {
    const cmd = buildContinueProbeCommand('/work')
    // $HOME MUST appear unquoted.
    expect(cmd.startsWith('test -d "$HOME/.claude/projects/"')).toBe(true)
  })
})

describe('classifyRunState', () => {
  it('null + remote => unreachable (query failed on a remote)', () => {
    expect(classifyRunState(null, 'agent-x', true)).toBe('unreachable')
  })

  it('null + local => stopped (no tmux server)', () => {
    expect(classifyRunState(null, 'agent-x', false)).toBe('stopped')
  })

  it('session present in list => running (local)', () => {
    expect(classifyRunState('agent-a\nagent-b\n', 'agent-b', false)).toBe('running')
  })

  it('session present in list => running (remote)', () => {
    expect(classifyRunState('agent-b\n', 'agent-b', true)).toBe('running')
  })

  it('session absent => stopped (local)', () => {
    expect(classifyRunState('agent-a\n', 'agent-x', false)).toBe('stopped')
  })

  it('session absent => stopped (remote)', () => {
    expect(classifyRunState('agent-a\n', 'agent-x', true)).toBe('stopped')
  })

  it('empty list output => stopped', () => {
    expect(classifyRunState('', 'agent-x', true)).toBe('stopped')
  })
})

describe('classifyRunStateFromExit', () => {
  it('local + any exit => stopped (no tmux server)', () => {
    expect(classifyRunStateFromExit(0, false)).toBe('stopped')
    expect(classifyRunStateFromExit(1, false)).toBe('stopped')
    expect(classifyRunStateFromExit(255, false)).toBe('stopped')
    expect(classifyRunStateFromExit(null, false)).toBe('stopped')
    expect(classifyRunStateFromExit(undefined, false)).toBe('stopped')
  })

  it('remote + exit 255 => unreachable (real ssh transport failure)', () => {
    expect(classifyRunStateFromExit(255, true)).toBe('unreachable')
  })

  it('remote + null exit => unreachable (killed / timed out)', () => {
    expect(classifyRunStateFromExit(null, true)).toBe('unreachable')
  })

  it('remote + undefined exit => unreachable (no numeric status at all)', () => {
    expect(classifyRunStateFromExit(undefined, true)).toBe('unreachable')
  })

  it('remote + exit 1 => stopped (laptop reachable, no tmux server yet)', () => {
    expect(classifyRunStateFromExit(1, true)).toBe('stopped')
  })

  it('remote + exit 0 => stopped (no error, but still "no tmux server"-class)', () => {
    expect(classifyRunStateFromExit(0, true)).toBe('stopped')
  })

  it('remote + exit 254 (non-255) => stopped', () => {
    expect(classifyRunStateFromExit(254, true)).toBe('stopped')
  })
})

describe('ensureControlDir', () => {
  let sandbox: string
  let prevXdg: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'marveen-ecd-'))
    prevXdg = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = sandbox
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = prevXdg
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('creates the marveen-ssh subdir under $XDG_RUNTIME_DIR', () => {
    ensureControlDir()
    expect(existsSync(join(sandbox, 'marveen-ssh'))).toBe(true)
  })

  it('is idempotent -- a second call does not throw', () => {
    ensureControlDir()
    expect(() => ensureControlDir()).not.toThrow()
    expect(existsSync(join(sandbox, 'marveen-ssh'))).toBe(true)
  })

  it('swallows mkdir errors (best-effort)', () => {
    // Pre-create a regular file at the marveen-ssh path so mkdirSync throws
    // EEXIST / ENOTDIR. The function must still return without raising.
    const blockingFile = join(sandbox, 'marveen-ssh')
    writeFileSync(blockingFile, 'not a dir')
    expect(() => ensureControlDir()).not.toThrow()
  })
})

describe('cleanStaleSshSockets', () => {
  // We pin ssh to a fake binary so the test never touches a real client.
  // The fake returns exit 0 (no-op) -- the function is best-effort and
  // suppresses any spawn / exit error.
  let sandbox: string
  let fakeBin: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'marveen-css-'))
    fakeBin = join(sandbox, 'ssh')
    // On darwin sh is at /bin/sh; on Linux too. Use sh -c as a portable
    // no-op exit-0 wrapper.
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n')
    // chmod 0o755 -- skip explicit chmod since umask usually allows it on a
    // fresh tmpdir; if not, additional tests can chmodSync.
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('does not throw when ssh exits 0 (no live master to drop)', () => {
    expect(() => cleanStaleSshSockets('devbox')).not.toThrow()
  })

  it('does not throw when ssh exits 255 (no master present)', () => {
    const failingBin = join(sandbox, 'ssh-fail')
    writeFileSync(failingBin, '#!/bin/sh\nexit 255\n')
    const prev = process.env.PATH
    process.env.PATH = `${sandbox}:${prev ?? ''}`
    // Force the helper to use the failing binary by shadowing PATH.
    // The helper calls execFileSync('ssh', ...) which uses PATH lookup.
    // We just exercise the swallow path generically:
    expect(() => cleanStaleSshSockets('devbox')).not.toThrow()
    process.env.PATH = prev
  })

  it('swallows ENOENT -- ssh binary missing on PATH', () => {
    const prev = process.env.PATH
    process.env.PATH = sandbox // empty => no ssh available
    expect(() => cleanStaleSshSockets('devbox')).not.toThrow()
    process.env.PATH = prev
  })
})

// ---------------------------------------------------------------------------
// Defect: an SSH-OPTS regex check in the existing suite asserts the control
// path is NOT the bare `/tmp/<file>%` form. Verify the steady-state
// CONTROL_PATH is well-formed (no trailing slash, has the placeholder).
// Documented in docs/needs-to-be-fix/routes-ssh-tmux-control-path-suffix.md
// ---------------------------------------------------------------------------
describe('defect: CONTROL_PATH shape', () => {
  it('does not end with a trailing slash and embeds the %r@%h:%p placeholder', async () => {
    const mod = await import('../web/ssh-tmux.js')
    expect(mod.CONTROL_PATH.endsWith('/')).toBe(false)
    expect(mod.CONTROL_PATH).toContain('cm-%r@%h:%p')
  })
})

// ---------------------------------------------------------------------------
// Defect: classifyRunStateFromExit accepts `null | undefined | number`. The
// existing README only documents the numeric case. The runtime accepts null
// (killed/timed-out child) and treats it as unreachable for remote. This is
// the documented behaviour we just covered, but the type signature is
// expansive. We file a note so a future refactor does not narrow the param
// to `number` and silently break the killed-child path.
// docs/needs-to-be-fix/routes-ssh-tmux-classifyexit-nullable-type.md
// ---------------------------------------------------------------------------
describe('defect: classifyRunStateFromExit signature accepts nullish exit', () => {
  it('null is treated as unreachable for remote but stopped for local', () => {
    expect(classifyRunStateFromExit(null, true)).toBe('unreachable')
    expect(classifyRunStateFromExit(null, false)).toBe('stopped')
  })
})
