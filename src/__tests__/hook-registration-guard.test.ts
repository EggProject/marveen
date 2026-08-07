import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isWorktreeRoot,
  isTemporaryRoot,
  shouldRegisterHooks,
  pruneStaleHookEntries,
  pruneStaleHooksFromSettingsFile,
  KNOWN_HOOK_SCRIPTS,
} from '../web/hook-registration-guard.js'

// 2026-07-11 incident: a WEB_ONLY smoke instance running from a git worktree
// registered UserPromptSubmit/SessionStart hooks into the user-global
// ~/.claude/settings.json with worktree-absolute paths. After the worktree was
// deleted, the hook exited 2 and BLOCKED every prompt (main agent deaf).
// These tests pin the guard (never register from a worktree / staging
// instance) and the self-heal (prune our stale entries, keep foreign ones).

const notAGitFile = () => false

describe('isWorktreeRoot', () => {
  it('detects a .claude/worktrees checkout by path', () => {
    expect(isWorktreeRoot('/home/user/app/.claude/worktrees/agent-abc123', { isGitFile: notAGitFile })).toBe(true)
  })
  it('detects a generic linked worktree via the .git-is-a-file signal', () => {
    expect(isWorktreeRoot('/tmp/some-linked-checkout', { isGitFile: () => true })).toBe(true)
  })
  it('treats a normal checkout (git dir, non-worktree path) as non-worktree', () => {
    expect(isWorktreeRoot('/opt/app', { isGitFile: notAGitFile })).toBe(false)
  })
  it('falls back to the real statSync when no isGitFile is injected and .git is missing', () => {
    // Exercises the catch block of gitEntryIsFile: statSync throws ENOENT
    // on a path with no .git entry, the catch returns false, and the
    // overall isWorktreeRoot call resolves to false (no worktree fragment).
    const dir = mkdtempSync(join(tmpdir(), 'no-git-entry-'))
    expect(isWorktreeRoot(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
  it('falls back to the real statSync and treats a real .git file as a worktree signal', () => {
    // Mirror case of the test above: the fallback gitEntryIsFile is called
    // when no isGitFile is injected, and an actual .git FILE (linked-
    // worktree gitdir pointer) makes isWorktreeRoot return true.
    const dir = mkdtempSync(join(tmpdir(), 'real-git-file-'))
    writeFileSync(join(dir, '.git'), 'gitdir: /tmp/wherever/.git/worktrees/abc\n')
    expect(isWorktreeRoot(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('shouldRegisterHooks', () => {
  it('registers for a normal root in normal mode', () => {
    const d = shouldRegisterHooks({ projectRoot: '/opt/app', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(true)
  })
  it('skips for a worktree root', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/opt/app/.claude/worktrees/agent-xyz',
      webOnly: false,
      isGitFile: notAGitFile,
    })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/worktree/)
  })
  it('skips in WEB_ONLY staging mode even from a normal root', () => {
    const d = shouldRegisterHooks({ projectRoot: '/opt/app', webOnly: true, isGitFile: notAGitFile })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/WEB_ONLY/)
  })
  // 2026-07-13 canary incident: a plain `git clone` under /private/tmp is NOT a
  // worktree (.git is a dir) and not WEB_ONLY, yet it registered hooks into the
  // user-global settings.json -- the same deaf-agent trap, one class wider.
  it('skips a plain clone under /private/tmp (canary/second-instance)', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/private/tmp/marveen-work',
      webOnly: false,
      isGitFile: notAGitFile,
    })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/temp dir/)
  })
  it('skips a clone under /tmp', () => {
    const d = shouldRegisterHooks({ projectRoot: '/tmp/marveen-work', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(false)
  })
  it('skips a clone under the injected OS tmpDir (e.g. macOS /var/folders/..)', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/var/folders/xy/abc/T/marveen-clone',
      webOnly: false,
      isGitFile: notAGitFile,
      tmpDir: '/var/folders/xy/abc/T',
    })
    expect(d.register).toBe(false)
  })
  it('still registers for a real install path that merely contains "tmp" mid-path', () => {
    const d = shouldRegisterHooks({ projectRoot: '/home/user/mytmpapp', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(true)
  })
})

describe('isTemporaryRoot', () => {
  it('true for /tmp and /private/tmp prefixes', () => {
    expect(isTemporaryRoot('/tmp/x')).toBe(true)
    expect(isTemporaryRoot('/private/tmp/x')).toBe(true)
    expect(isTemporaryRoot('/var/folders/a/b/T/x')).toBe(true)
  })
  it('false for a normal install root', () => {
    expect(isTemporaryRoot('/Users/marvin/ClaudeClaw')).toBe(false)
    expect(isTemporaryRoot('/opt/app')).toBe(false)
  })
  it('honours an injected OS tmpdir prefix (with or without trailing slash)', () => {
    expect(isTemporaryRoot('/custom/tmp/clone', { tmpDir: '/custom/tmp' })).toBe(true)
    expect(isTemporaryRoot('/custom/tmp/clone', { tmpDir: '/custom/tmp/' })).toBe(true)
  })
  it('does not match a path that merely contains a temp fragment mid-string', () => {
    expect(isTemporaryRoot('/home/tmpish/app')).toBe(false)
  })
})

function settingsFixture(): Record<string, unknown> {
  return {
    enabledPlugins: { 'telegram@claude-plugins-official': true },
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: 'python3 /opt/app/scripts/hooks/staleness-guard.py', timeout: 10 },
            { type: 'command', command: 'python3 /opt/app/.claude/worktrees/agent-dead/scripts/hooks/voice-reply-directive.py', timeout: 60 },
          ],
        },
        { hooks: [{ type: 'command', command: 'python3 /home/user/my-own-hook.py', timeout: 5 }] },
      ],
      SessionStart: [
        {
          matcher: 'compact|resume',
          hooks: [{ type: 'command', command: 'python3 /opt/app/.claude/worktrees/agent-dead/scripts/hooks/taskstate-replay.py', timeout: 15 }],
        },
      ],
      PreCompact: [
        { matcher: 'auto', hooks: [{ type: 'agent', prompt: 'save memories', timeout: 180 }] },
      ],
    },
  }
}

describe('pruneStaleHookEntries', () => {
  const liveFiles = new Set(['/opt/app/scripts/hooks/staleness-guard.py'])
  const fileExists = (p: string) => liveFiles.has(p)

  it('prunes stale worktree entries and keeps valid + foreign entries', () => {
    const settings = settingsFixture()
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists })
    expect(changed).toBe(true)
    expect(removed).toHaveLength(2)
    expect(removed.join(' ')).toContain('voice-reply-directive.py')
    expect(removed.join(' ')).toContain('taskstate-replay.py')

    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command?: string; prompt?: string }> }>>
    // Valid our-entry kept.
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('staleness-guard.py')
    // Foreign entry kept even though its file does not exist.
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('/home/user/my-own-hook.py')
    // SessionStart group emptied by pruning: the whole event key is dropped.
    expect(hooks.SessionStart).toBeUndefined()
    // Agent-type (non-command) hooks are never touched.
    expect(hooks.PreCompact[0].hooks[0].prompt).toBe('save memories')
  })

  it('prunes a missing-file NON-worktree entry when it matches our script names', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'python3 /old/install/scripts/hooks/voice-reply-directive.py', timeout: 60 }] },
        ],
      },
    }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(true)
    expect(removed).toEqual(['python3 /old/install/scripts/hooks/voice-reply-directive.py'])
    expect((settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeUndefined()
  })

  it('keeps our entry when the script file exists', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'python3 /opt/app/scripts/hooks/staleness-guard.py', timeout: 10 }] },
        ],
      },
    }
    const before = JSON.stringify(settings)
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps a foreign hook whose file is missing (not ours, not worktree-pathed)', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /somewhere/else/custom-gate.mjs', timeout: 10 }] },
        ],
      },
    }
    const before = JSON.stringify(settings)
    const { changed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(false)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('prunes an unknown-named script when its path lies inside .claude/worktrees/', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'bash /x/.claude/worktrees/agent-1/scripts/some-future-hook.sh' }] },
        ],
      },
    }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(true)
    expect(removed).toHaveLength(1)
  })

  it('is a no-op on settings without a hooks block', () => {
    const settings: Record<string, unknown> = { permissions: { allow: [] } }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
  })

  it('covers the incident hook script names in KNOWN_HOOK_SCRIPTS', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('voice-reply-directive.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('taskstate-replay.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('staleness-guard.py')
    // channel-inbox-drain.py is app-registered (templates/settings.json.template),
    // so a missing-file entry must be prunable-as-ours, not treated as foreign.
    expect(KNOWN_HOOK_SCRIPTS).toContain('channel-inbox-drain.py')
  })

  it('keeps groups whose shape is malformed without crashing (the typeof / Array.isArray guard)', () => {
    // A settings.json from an older Claude Code version (or a hand-edit) may
    // contain a group that is not a plain object or whose `hooks` is not an
    // array. The pruner must preserve the entry byte-identically and skip
    // straight to the next group -- never throw, never silently drop it.
    const settings: Record<string, unknown> = {
      hooks: {
        UserPromptSubmit: [
          null,                 // !group true
          'not a group',        // typeof group !== 'object' true
          { hooks: 'oops' },    // !Array.isArray(group.hooks) true
          { hooks: null },      // same, null hooks
          // a valid sibling alongside the malformed ones -- must survive.
          { hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }
    const before = JSON.stringify(settings)
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => true })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
    // Nothing inside the UserPromptSubmit array was rewritten.
    expect(JSON.stringify(settings)).toBe(before)
    // The valid sibling is still present.
    const kept = (settings.hooks as Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>).UserPromptSubmit
    expect(kept).toHaveLength(5)
    expect(kept[4]?.hooks[0]?.command).toBe('echo hi')
  })

  it('skips events whose groups value is not an array (legacy / hand-edited shapes)', () => {
    // Some older Claude Code settings.json files had a different shape:
    // hooks.<event> was a plain object, not an array of groups. The pruner
    // must skip such an event with the !Array.isArray(groups) guard and
    // never crash.
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: 'legacy-string-not-array',
        SessionStart: { hooks: [{ type: 'command', command: 'echo legacy' }] },
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
      },
    }
    const before = JSON.stringify(settings)
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => true })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
    // Non-array events are preserved verbatim.
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('ourScriptPaths skips empty tokens (consecutive whitespace / empty quoted segments)', () => {
    // A command like `python3 "" /opt/.../staleness-guard.py` -- the middle
    // `""` is an empty token after the quote-strip, and the split(/\s+/)
    // yields empty strings between runs of whitespace. The empty-token
    // guard must skip them without ever throwing.
    const liveScript = join(mkdtempSync(join(tmpdir(), 'empty-tokens-')), 'staleness-guard.py')
    writeFileSync(liveScript, '# live')
    const settings: Record<string, unknown> = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `python3   ""   ${liveScript}` }] },
        ],
      },
    }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: (p) => p === liveScript })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
  })
})

describe('pruneStaleHooksFromSettingsFile', () => {
  it('rewrites the file without stale entries and preserves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      // A real script file that must survive pruning.
      const liveScript = join(dir, 'staleness-guard.py')
      writeFileSync(liveScript, '# live')
      const settingsPath = join(dir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({
        enabledPlugins: { x: true },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: `python3 ${liveScript}`, timeout: 10 },
                { type: 'command', command: `python3 ${join(dir, '.claude', 'worktrees', 'agent-gone', 'voice-reply-directive.py')}`, timeout: 60 },
              ],
            },
          ],
        },
      }, null, 2))

      const removed = pruneStaleHooksFromSettingsFile(settingsPath)
      expect(removed).toHaveLength(1)
      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(JSON.stringify(after.hooks)).toContain(liveScript)
      expect(JSON.stringify(after.hooks)).not.toContain('agent-gone')
      expect(after.enabledPlugins).toEqual({ x: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a missing or unparseable file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      expect(pruneStaleHooksFromSettingsFile(join(dir, 'nope.json'))).toEqual([])
      const badPath = join(dir, 'settings.json')
      writeFileSync(badPath, '{ not json')
      expect(pruneStaleHooksFromSettingsFile(badPath)).toEqual([])
      expect(readFileSync(badPath, 'utf-8')).toBe('{ not json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to rewrite when the parsed JSON is not an object (null / string / array)', () => {
    // Valid JSON, parseable, but the top-level value is null / a string /
    // an array. The function must treat it as "not a settings file" and
    // return [] without touching the file. Silently nuking such a file
    // (overwriting with {}) would be a hostile failure mode -- the
    // upstream caller (settings-watcher) would re-write `{}` on the next
    // tick and lose user state.
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      const path = join(dir, 'settings.json')
      const payloads = ['null', '"a string"', '[1,2,3]', '42']
      for (const p of payloads) {
        writeFileSync(path, p)
        expect(pruneStaleHooksFromSettingsFile(path)).toEqual([])
        // File is untouched (no rewrite with {} or a default shape).
        expect(readFileSync(path, 'utf-8')).toBe(p)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT rewrite the file when the prune leaves nothing to remove (changed=false branch)', () => {
    // The "rewrites the file" test above exercises the changed=true path;
    // this one exercises the opposite: a fully valid settings.json must
    // not be rewritten at all. Without this test the `if (changed)`
    // branch's false arm is uncovered.
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      const liveScript = join(dir, 'staleness-guard.py')
      writeFileSync(liveScript, '# live')
      const settingsPath = join(dir, 'settings.json')
      const before = JSON.stringify({
        enabledPlugins: { x: true },
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `python3 ${liveScript}`, timeout: 10 }] },
          ],
        },
      }, null, 2)
      writeFileSync(settingsPath, before)
      // Record mtime before -- the atomicWriteFileSync branch must NOT fire.
      const mtimeBefore = statSyncSafe(settingsPath)
      // Tiny sleep so a stray rewrite would be detectable via mtime drift.
      sleepTiny()
      expect(pruneStaleHooksFromSettingsFile(settingsPath)).toEqual([])
      // Content and timestamp are unchanged.
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
      expect(statSyncSafe(settingsPath)).toBe(mtimeBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Tiny mtime helpers used by the rewrite-skip test. Imported lazily so the
// happy-path tests do not pay for them.
import { statSync as _statSync, utimesSync as _utimesSync } from 'node:fs'

function statSyncSafe(path: string): number {
  return _statSync(path).mtimeMs
}
function sleepTiny(): void {
  // ~5ms -- enough for utimes drift to register on coarse-grained filesystems.
  const until = Date.now() + 5
  while (Date.now() < until) { /* spin */ }
}
void _utimesSync // keep the import in case we extend the test
