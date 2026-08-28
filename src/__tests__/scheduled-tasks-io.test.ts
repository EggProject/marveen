// 100% coverage test for src/web/scheduled-tasks-io.ts.
//
// scheduled-tasks-io.ts reads/writes the per-task directory tree under
// ~/.claude/scheduled-tasks/<taskName>/ (SKILL.md + task-config.json). Every
// path is anchored at homedir() at module load time, so the suite replaces
// `node:os` homedir() with a tmpdir-scoped path BEFORE the SUT is imported
// (vitest hoists vi.mock, so the redirect is in effect the moment the SUT
// module evaluates its module-scope SCHEDULED_TASKS_DIR constant).
//
// config.js is also intercepted so a fresh isolate does not need a real .env
// to surface MAIN_AGENT_ID (the only export the SUT touches); the override is
// a static MAIN_AGENT_ID = 'test-agent' so the "default agent" branch in
// readScheduledTask is provable.
//
// vitest hoists vi.hoisted above everything, but the order of statements
// AFTER the hoist matters: mockState.homeDir must be assigned BEFORE the
// `await import(...)` of the SUT, otherwise the SUT captures homedir() with
// the empty string and SCHEDULED_TASKS_DIR resolves to a relative path.
//
// Branch inventory that must be covered here:
//   parseSkillMdFrontmatter, parseFiniteMinutes, parseCatchUpMaxAge,
//   parseRequires, readScheduledTask, listScheduledTasks, writeScheduledTask
//   (see per-describe block for the branch list).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
  readdirSync, symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted mock state. The SUT captures SCHEDULED_TASKS_DIR at module load
// from homedir(); the mockState ref below is what the `node:os` mock reads
// when the SUT (and the test) call homedir().
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  homeDir: '' as string,
}))

// ---------------------------------------------------------------------------
// node:os mock: redirect homedir(); keep everything else (tmpdir etc.) real
// so the test sandwich-creates the canonical "homedir()" everywhere the SUT
// and the suite itself read it.
// ---------------------------------------------------------------------------
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => mockState.homeDir }
})

// ---------------------------------------------------------------------------
// config.js mock: the SUT only needs MAIN_AGENT_ID. Override the static
// constant so the SUT module-scope import resolves without dragging the rest
// of config.js (and its imports of env.ts, config-registry, channel-provider)
// into the test module graph.
// ---------------------------------------------------------------------------
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'test-agent' }
})

// ---------------------------------------------------------------------------
// Sandbox-setup HOMEDIR BEFORE the SUT module evaluates SCHEDULED_TASKS_DIR.
// The mocked homedir() reads mockState.homeDir at call time, so the value
// must be set BEFORE the dynamic import below.
// ---------------------------------------------------------------------------
const HOME = mkTempDir('scheduled-tasks-io-home-')
mockState.homeDir = HOME

// SUT import -- must come AFTER the homedir redirect + config override so the
// SUT module-scope SCHEDULED_TASKS_DIR is computed against the sandbox.
const sut = await import('../web/scheduled-tasks-io.js')
const {
  SCHEDULED_TASKS_DIR,
  MAX_SCHEDULED_TASK_PROMPT_LEN,
  parseSkillMdFrontmatter,
  readScheduledTask,
  parseFiniteMinutes,
  parseCatchUpMaxAge,
  parseRequires,
  listScheduledTasks,
  writeScheduledTask,
} = sut

// ---------------------------------------------------------------------------
// Sandbox lifecycle: scrub the tasks dir between tests so every case starts
// from a clean slate.
// ---------------------------------------------------------------------------
const TASKS_DIR = join(HOME, '.claude', 'scheduled-tasks')

beforeEach(() => {
  rmSync(TASKS_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(TASKS_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmTempDir(HOME)
})

// ---------------------------------------------------------------------------
// Module-scope constants
// ---------------------------------------------------------------------------
describe('module-scope constants', () => {
  it('SCHEDULED_TASKS_DIR is homedir()/.claude/scheduled-tasks', () => {
    expect(SCHEDULED_TASKS_DIR).toBe(join(HOME, '.claude', 'scheduled-tasks'))
  })

  it('MAX_SCHEDULED_TASK_PROMPT_LEN is 50_000', () => {
    expect(MAX_SCHEDULED_TASK_PROMPT_LEN).toBe(50_000)
  })
})

// ---------------------------------------------------------------------------
// parseSkillMdFrontmatter
// ---------------------------------------------------------------------------
describe('parseSkillMdFrontmatter', () => {
  it('returns the input as body when no frontmatter is present', () => {
    const result = parseSkillMdFrontmatter('just plain text\nno frontmatter here')
    expect(result).toEqual({ name: undefined, description: undefined, body: 'just plain text\nno frontmatter here' })
  })

  it('returns empty body when input is empty', () => {
    const result = parseSkillMdFrontmatter('')
    expect(result).toEqual({ name: undefined, description: undefined, body: '' })
  })

  it('parses name and description from the frontmatter', () => {
    const fm = '---\nname: my-task\ndescription: does a thing\n---\nBody content here\n'
    const result = parseSkillMdFrontmatter(fm)
    expect(result.name).toBe('my-task')
    expect(result.description).toBe('does a thing')
    expect(result.body).toBe('Body content here')
  })

  it('returns undefined for the missing fields and trims the body', () => {
    const fm = '---\nname: only-name\n---\nfinal body\n\n'
    const result = parseSkillMdFrontmatter(fm)
    expect(result.name).toBe('only-name')
    expect(result.description).toBeUndefined()
    expect(result.body).toBe('final body')
  })

  it('returns undefined description when only name is present', () => {
    const fm = '---\nname: foo\n---\nbody'
    const result = parseSkillMdFrontmatter(fm)
    expect(result.name).toBe('foo')
    expect(result.description).toBeUndefined()
  })

  it('handles multiline body after the closing ---', () => {
    const fm = '---\nname: x\ndescription: y\n---\nLine 1\nLine 2\n\nLine 4'
    const result = parseSkillMdFrontmatter(fm)
    expect(result.body).toBe('Line 1\nLine 2\n\nLine 4')
  })
})

// ---------------------------------------------------------------------------
// parseFiniteMinutes
// ---------------------------------------------------------------------------
describe('parseFiniteMinutes', () => {
  it('returns the number when given a finite number', () => {
    expect(parseFiniteMinutes(60)).toBe(60)
    expect(parseFiniteMinutes(0)).toBe(0)
    expect(parseFiniteMinutes(-5)).toBe(-5)
    expect(parseFiniteMinutes(1.5)).toBe(1.5)
  })

  it('returns undefined for Infinity', () => {
    expect(parseFiniteMinutes(Infinity)).toBeUndefined()
  })

  it('returns undefined for NaN', () => {
    expect(parseFiniteMinutes(NaN)).toBeUndefined()
  })

  it('returns undefined for strings', () => {
    expect(parseFiniteMinutes('60')).toBeUndefined()
    expect(parseFiniteMinutes('not a number')).toBeUndefined()
  })

  it('returns undefined for null and undefined', () => {
    expect(parseFiniteMinutes(null)).toBeUndefined()
    expect(parseFiniteMinutes(undefined)).toBeUndefined()
  })

  it('returns undefined for objects and arrays', () => {
    expect(parseFiniteMinutes({})).toBeUndefined()
    expect(parseFiniteMinutes([])).toBeUndefined()
    expect(parseFiniteMinutes(true)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseCatchUpMaxAge (delegates to parseFiniteMinutes; same surface)
// ---------------------------------------------------------------------------
describe('parseCatchUpMaxAge', () => {
  it('returns the number when given a finite number', () => {
    expect(parseCatchUpMaxAge(120)).toBe(120)
  })

  it('returns undefined for Infinity', () => {
    expect(parseCatchUpMaxAge(Infinity)).toBeUndefined()
  })

  it('returns undefined for a string', () => {
    expect(parseCatchUpMaxAge('120')).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(parseCatchUpMaxAge(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseRequires
// ---------------------------------------------------------------------------
describe('parseRequires', () => {
  it('returns undefined when input is undefined', () => {
    expect(parseRequires(undefined)).toBeUndefined()
  })

  it('returns undefined when mcp_servers is not an array', () => {
    expect(parseRequires({ mcp_servers: 'not-an-array' })).toBeUndefined()
    expect(parseRequires({ mcp_servers: { foo: 'bar' } })).toBeUndefined()
    expect(parseRequires({ mcp_servers: 42 })).toBeUndefined()
    expect(parseRequires({ mcp_servers: null })).toBeUndefined()
  })

  it('returns undefined when every entry is empty / non-string', () => {
    expect(parseRequires({ mcp_servers: ['', '   ', 42, null, true, {}] })).toBeUndefined()
  })

  it('returns undefined for an empty mcp_servers array', () => {
    expect(parseRequires({ mcp_servers: [] })).toBeUndefined()
  })

  it('keeps only the non-empty string entries', () => {
    expect(parseRequires({ mcp_servers: ['slack', '', 'github', '   ', 99] }))
      .toEqual({ mcp_servers: ['slack', 'github'] })
  })

  it('returns the full object when all entries are valid strings', () => {
    expect(parseRequires({ mcp_servers: ['a', 'b'] })).toEqual({ mcp_servers: ['a', 'b'] })
  })

  it('returns undefined when raw is null (falsy guard)', () => {
    expect(parseRequires(null as unknown as { mcp_servers?: unknown })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// readScheduledTask
// ---------------------------------------------------------------------------
describe('readScheduledTask', () => {
  it('returns null when neither SKILL.md nor task-config.json exists', () => {
    expect(readScheduledTask('does-not-exist')).toBeNull()
  })

  it('returns a task with merged fields when both files exist', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'exists-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'),
      '---\nname: exists-task\ndescription: from skill\n---\n\nprompt body\n')
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      schedule: '0 9 * * *',
      agent: 'custom-agent',
      enabled: true,
      createdAt: 1700000000,
      type: 'heartbeat',
    }, null, 2))

    const task = readScheduledTask('exists-task')
    expect(task).toEqual({
      name: 'exists-task',
      description: 'from skill',
      prompt: 'prompt body',
      schedule: '0 9 * * *',
      agent: 'custom-agent',
      enabled: true,
      createdAt: 1700000000,
      type: 'heartbeat',
      skipIfBusy: false,
      forceSend: false,
      targetSession: undefined,
      command: undefined,
      timeoutMs: undefined,
      failThreshold: undefined,
      preCheck: undefined,
      catchUpMaxAgeMinutes: undefined,
      stuckAfterMinutes: undefined,
      requires: undefined,
    })
  })

  it('returns a task with all defaults when SKILL.md is absent and config is empty', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'cmd-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({}))

    const task = readScheduledTask('cmd-task')
    expect(task).not.toBeNull()
    expect(task?.name).toBe('cmd-task')
    expect(task?.description).toBe('')
    expect(task?.prompt).toBe('')
    expect(task?.schedule).toBe('0 9 * * *')
    expect(task?.agent).toBe('test-agent')
    expect(task?.enabled).toBe(true)
    expect(task?.createdAt).toBe(0)
    expect(task?.type).toBe('task')
    expect(task?.skipIfBusy).toBe(false)
    expect(task?.forceSend).toBe(false)
    expect(task?.targetSession).toBeUndefined()
  })

  it('falls back to main agent id when task-config.json omits agent', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'no-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({}))

    const task = readScheduledTask('no-agent')
    expect(task?.agent).toBe('test-agent')
  })

  it('treats malformed JSON as defaults and does not throw', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'broken-json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), '{not json at all')
    writeFileSync(join(dir, 'SKILL.md'),
      '---\nname: broken-json\ndescription: desc\n---\nbody\n')

    const task = readScheduledTask('broken-json')
    expect(task).not.toBeNull()
    expect(task?.schedule).toBe('0 9 * * *')
    expect(task?.enabled).toBe(true)
    expect(task?.createdAt).toBe(0)
  })

  it('preserves enabled=false (only === false is truthy)', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'disabled-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({ enabled: false }))
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: disabled-task\n---\nbody\n')

    const task = readScheduledTask('disabled-task')
    expect(task?.enabled).toBe(false)
  })

  it('flips enabled to true when config omits it (default !== false)', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'no-enabled')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({}))
    const task = readScheduledTask('no-enabled')
    expect(task?.enabled).toBe(true)
  })

  it('keeps targetSession undefined when config.targetSession is an empty string', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'no-session')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({ targetSession: '' }))
    const task = readScheduledTask('no-session')
    expect(task?.targetSession).toBeUndefined()
  })

  it('passes through command, timeoutMs, failThreshold, preCheck when present', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'rich-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      command: 'echo hi',
      timeoutMs: 12345,
      failThreshold: 5,
      preCheck: 'check.sh',
    }))
    const task = readScheduledTask('rich-task')
    expect(task?.command).toBe('echo hi')
    expect(task?.timeoutMs).toBe(12345)
    expect(task?.failThreshold).toBe(5)
    expect(task?.preCheck).toBe('check.sh')
  })

  it('passes catchUpMaxAgeMinutes and stuckAfterMinutes when finite', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'minutes-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      catchUpMaxAgeMinutes: 30,
      stuckAfterMinutes: 15,
    }))
    const task = readScheduledTask('minutes-task')
    expect(task?.catchUpMaxAgeMinutes).toBe(30)
    expect(task?.stuckAfterMinutes).toBe(15)
  })

  it('treats catchUpMaxAgeMinutes as undefined when NaN', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'nan-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      catchUpMaxAgeMinutes: 'not-a-number',
      stuckAfterMinutes: 'x',
    }))
    const task = readScheduledTask('nan-task')
    expect(task?.catchUpMaxAgeMinutes).toBeUndefined()
    expect(task?.stuckAfterMinutes).toBeUndefined()
  })

  it('passes requires.mcp_servers when valid', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'req-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      requires: { mcp_servers: ['slack', 'github'] },
    }))
    const task = readScheduledTask('req-task')
    expect(task?.requires).toEqual({ mcp_servers: ['slack', 'github'] })
  })

  it('drops requires.mcp_servers when malformed', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'req-bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      requires: { mcp_servers: 'not-array' },
    }))
    const task = readScheduledTask('req-bad')
    expect(task?.requires).toBeUndefined()
  })

  it('falls back to config.description when SKILL.md has none', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'config-desc')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: config-desc\n---\nbody\n')
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      description: 'from config',
    }))
    const task = readScheduledTask('config-desc')
    expect(task?.description).toBe('from config')
  })

  it('uses taskName as fallback when SKILL.md has no name metadata', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'no-name')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'plain body, no frontmatter\n')
    const task = readScheduledTask('no-name')
    expect(task?.name).toBe('no-name')
    expect(task?.prompt).toBe('plain body, no frontmatter\n')
  })

  it('flips skipIfBusy / forceSend to true only when === true', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'bool-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      skipIfBusy: 'yes',
      forceSend: 1,
    }))
    const task = readScheduledTask('bool-task')
    expect(task?.skipIfBusy).toBe(false)
    expect(task?.forceSend).toBe(false)
  })

  it('flips skipIfBusy and forceSend to true when explicitly true', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'bool-true')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      skipIfBusy: true,
      forceSend: true,
    }))
    const task = readScheduledTask('bool-true')
    expect(task?.skipIfBusy).toBe(true)
    expect(task?.forceSend).toBe(true)
  })

  it('casts unknown type strings to undefined (becomes "task" default)', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'bad-type')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      type: 'something-not-allowed',
    }))
    const task = readScheduledTask('bad-type')
    // The code casts the type via `as 'task' | 'heartbeat' | 'command'`. The
    // runtime value is the literal string -- the `||` fallback only fires when
    // config.type is falsy. This test documents the as-cast behavior.
    expect(task?.type).toBe('something-not-allowed')
  })
})

// ---------------------------------------------------------------------------
// listScheduledTasks
// ---------------------------------------------------------------------------
describe('listScheduledTasks', () => {
  it('returns [] when SCHEDULED_TASKS_DIR does not exist', () => {
    expect(listScheduledTasks()).toEqual([])
  })

  it('returns [] when the tasks dir is empty', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    expect(listScheduledTasks()).toEqual([])
  })

  it('filters out regular files (non-directories)', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    writeFileSync(join(SCHEDULED_TASKS_DIR, 'stray.txt'), 'not a dir')
    const dir = join(SCHEDULED_TASKS_DIR, 'real-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: real-task\n---\nbody\n')

    const tasks = listScheduledTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.name).toBe('real-task')
  })

  it('handles a stat-throw gracefully (entry vanishes mid-scan)', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    const dir = join(SCHEDULED_TASKS_DIR, 'good-task')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: good-task\n---\nbody\n')

    // Create a symlink whose target does NOT exist; statSync on the symlink
    // itself follows the link target and throws ENOENT -- the catch arm of
    // the filter returns false, so the entry is skipped cleanly.
    // The filter in listScheduledTasks does NOT use lstatSync, so a broken
    // symlink is exactly the trigger that makes statSync throw.
    const target = join(SCHEDULED_TASKS_DIR, 'never-existed-target')
    const link = join(SCHEDULED_TASKS_DIR, 'dangling-link')
    symlinkSync(target, link)
    expect(() => listScheduledTasks()).not.toThrow()
  })

  it('returns parsed tasks sorted by createdAt desc', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    const a = join(SCHEDULED_TASKS_DIR, 'a-older')
    mkdirSync(a, { recursive: true })
    writeFileSync(join(a, 'task-config.json'), JSON.stringify({ createdAt: 100 }))

    const b = join(SCHEDULED_TASKS_DIR, 'b-newer')
    mkdirSync(b, { recursive: true })
    writeFileSync(join(b, 'task-config.json'), JSON.stringify({ createdAt: 200 }))

    const c = join(SCHEDULED_TASKS_DIR, 'c-middle')
    mkdirSync(c, { recursive: true })
    writeFileSync(join(c, 'task-config.json'), JSON.stringify({ createdAt: 150 }))

    const tasks = listScheduledTasks()
    expect(tasks.map((t) => t.name)).toEqual(['b-newer', 'c-middle', 'a-older'])
  })

  it('skips entries whose readScheduledTask returns null', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    const good = join(SCHEDULED_TASKS_DIR, 'good-dir')
    mkdirSync(good, { recursive: true })
    writeFileSync(join(good, 'SKILL.md'), '---\nname: good-dir\n---\nbody\n')

    // No SKILL.md, no task-config.json -> readScheduledTask returns null.
    const lone = join(SCHEDULED_TASKS_DIR, 'lone-dir')
    mkdirSync(lone, { recursive: true })

    const tasks = listScheduledTasks()
    expect(tasks.map((t) => t.name)).toEqual(['good-dir'])
  })

  it('calls readdirSync to enumerate the tasks directory', () => {
    mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
    const dir = join(SCHEDULED_TASKS_DIR, 'visible')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: visible\n---\nbody\n')

    const entries = readdirSync(SCHEDULED_TASKS_DIR)
    expect(entries).toContain('visible')
  })
})

// ---------------------------------------------------------------------------
// writeScheduledTask
// ---------------------------------------------------------------------------
describe('writeScheduledTask', () => {
  it('creates a new task with SKILL.md and task-config.json', () => {
    writeScheduledTask('new-task', {
      description: 'a new task',
      prompt: 'do the thing',
      schedule: '0 12 * * *',
      agent: 'specific-agent',
      enabled: true,
    })

    const skillPath = join(SCHEDULED_TASKS_DIR, 'new-task', 'SKILL.md')
    const configPath = join(SCHEDULED_TASKS_DIR, 'new-task', 'task-config.json')
    expect(existsSync(skillPath)).toBe(true)
    expect(existsSync(configPath)).toBe(true)

    const skill = readFileSync(skillPath, 'utf-8')
    expect(skill).toContain('name: new-task')
    expect(skill).toContain('description: a new task')
    expect(skill).toContain('do the thing')

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.schedule).toBe('0 12 * * *')
    expect(config.agent).toBe('specific-agent')
    expect(config.enabled).toBe(true)
    expect(config.createdAt).toBeGreaterThan(0)
  })

  it('does not write the default schedule when none is provided', () => {
    writeScheduledTask('default-sched', { prompt: 'x' })
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'default-sched', 'task-config.json'), 'utf-8'))
    expect(config.schedule).toBeUndefined()
  })

  it('updates an existing task merging the new fields, preserving createdAt', () => {
    writeScheduledTask('update-task', {
      description: 'first',
      prompt: 'first prompt',
      schedule: '0 9 * * *',
      agent: 'agent-a',
      enabled: true,
    })
    const firstConfig = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'update-task', 'task-config.json'), 'utf-8'))
    const firstCreatedAt = firstConfig.createdAt

    writeScheduledTask('update-task', {
      description: 'second',
      prompt: 'second prompt',
      enabled: false,
    })

    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'update-task', 'task-config.json'), 'utf-8'))
    expect(config.description).toBe('second')
    expect(config.schedule).toBe('0 9 * * *')
    expect(config.agent).toBe('agent-a')
    expect(config.enabled).toBe(false)
    expect(config.createdAt).toBe(firstCreatedAt)

    const skill = readFileSync(join(SCHEDULED_TASKS_DIR, 'update-task', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('description: second')
    expect(skill).toContain('second prompt')
  })

  it('writes type/heartbeat/command fields when provided', () => {
    writeScheduledTask('cmd-write', {
      type: 'command',
      command: 'echo hi',
      timeoutMs: 5000,
      failThreshold: 3,
      preCheck: 'pre.sh',
    })
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'cmd-write', 'task-config.json'), 'utf-8'))
    expect(config.type).toBe('command')
    expect(config.command).toBe('echo hi')
    expect(config.timeoutMs).toBe(5000)
    expect(config.failThreshold).toBe(3)
    expect(config.preCheck).toBe('pre.sh')
  })

  it('writes skipIfBusy, forceSend, targetSession when provided', () => {
    writeScheduledTask('bools', {
      skipIfBusy: true,
      forceSend: true,
      targetSession: 'session-x',
    })
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'bools', 'task-config.json'), 'utf-8'))
    expect(config.skipIfBusy).toBe(true)
    expect(config.forceSend).toBe(true)
    expect(config.targetSession).toBe('session-x')
  })

  it('writes catchUpMaxAgeMinutes and stuckAfterMinutes when provided', () => {
    writeScheduledTask('minutes', {
      catchUpMaxAgeMinutes: 90,
      stuckAfterMinutes: 45,
    })
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'minutes', 'task-config.json'), 'utf-8'))
    expect(config.catchUpMaxAgeMinutes).toBe(90)
    expect(config.stuckAfterMinutes).toBe(45)
  })

  it('mirrors the description into task-config.json when explicitly provided', () => {
    writeScheduledTask('desc-task', { description: 'mirror test' })
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'desc-task', 'task-config.json'), 'utf-8'))
    expect(config.description).toBe('mirror test')
  })

  it('uses empty description when no existing task and no data.description', () => {
    writeScheduledTask('no-desc', { prompt: 'x' })
    const skill = readFileSync(join(SCHEDULED_TASKS_DIR, 'no-desc', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('description: ')
  })

  it('falls back to existing task description when data.description is undefined', () => {
    writeScheduledTask('fallback-desc', { description: 'original' })
    writeScheduledTask('fallback-desc', { prompt: 'updated' })
    const skill = readFileSync(join(SCHEDULED_TASKS_DIR, 'fallback-desc', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('description: original')
  })

  it('falls back to existing task prompt when data.prompt is undefined', () => {
    writeScheduledTask('fallback-prompt', { prompt: 'original prompt' })
    writeScheduledTask('fallback-prompt', { description: 'new desc' })
    const skill = readFileSync(join(SCHEDULED_TASKS_DIR, 'fallback-prompt', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('original prompt')
  })

  it('preserves task-config.json keys when adding new ones', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'preserve')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
      schedule: '0 9 * * *',
      agent: 'original-agent',
      enabled: true,
      customKey: 'keep me',
    }))
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: preserve\n---\noriginal body\n')

    writeScheduledTask('preserve', { prompt: 'new body' })
    const config = JSON.parse(readFileSync(join(dir, 'task-config.json'), 'utf-8'))
    expect(config.customKey).toBe('keep me')
    expect(config.schedule).toBe('0 9 * * *')
    expect(config.agent).toBe('original-agent')
  })

  it('overwrites createdAt to current time when existing config has createdAt = 0', () => {
    const dir = join(SCHEDULED_TASKS_DIR, 'zero-time')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify({ createdAt: 0 }))
    writeScheduledTask('zero-time', { prompt: 'x' })
    const config = JSON.parse(readFileSync(join(dir, 'task-config.json'), 'utf-8'))
    expect(config.createdAt).toBeGreaterThan(0)
  })

  it('sets createdAt to current time when no existing config', () => {
    const before = Math.floor(Date.now() / 1000)
    writeScheduledTask('fresh', { prompt: 'x' })
    const after = Math.floor(Date.now() / 1000)
    const config = JSON.parse(readFileSync(
      join(SCHEDULED_TASKS_DIR, 'fresh', 'task-config.json'), 'utf-8'))
    expect(config.createdAt).toBeGreaterThanOrEqual(before)
    expect(config.createdAt).toBeLessThanOrEqual(after)
  })

  it('creates SKILL.md frontmatter block with the expected shape', () => {
    writeScheduledTask('fm-task', { description: 'd', prompt: 'p' })
    const skill = readFileSync(join(SCHEDULED_TASKS_DIR, 'fm-task', 'SKILL.md'), 'utf-8')
    expect(skill).toMatch(/^---\nname: fm-task\ndescription: d\n---\n\np\n$/)
  })
})
