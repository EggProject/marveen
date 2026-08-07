import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { provisionMemoryBoundaryDir } from '../web/memory-boundary.js'

describe('provisionMemoryBoundaryDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-boundary-'))
  })

  afterEach(() => {
    // Some tests leave the dir read-only (chmod 0o500); rmSync refuses those,
    // so restore writable first to avoid spurious teardown failures.
    try { chmodSync(dir, 0o755) } catch { /* dir may be gone */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a stub git root with an ignore-everything exclude', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toBe('*\n')
    // the boundary is a real git root: rev-parse resolves to the agent dir itself
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(top).toBe(execFileSync('realpath', [dir], { encoding: 'utf-8' }).trim())
  })

  it('keeps the working tree clean: git status reports nothing despite files', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# agent instructions\n')
    mkdirSync(join(dir, 'workspace'))
    writeFileSync(join(dir, 'workspace', 'note.txt'), 'data\n')
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })
    expect(status).toBe('')
  })

  it('is idempotent and repairs a missing exclude on re-run', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    rmSync(join(dir, '.git', 'info', 'exclude'))
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toBe('*\n')
  })

  it('does not re-init an existing repo (preserves .git contents)', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    writeFileSync(join(dir, '.git', 'marker'), 'keep me\n')
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(readFileSync(join(dir, '.git', 'marker'), 'utf-8')).toBe('keep me\n')
  })

  it('returns false for a missing dir without throwing', () => {
    expect(provisionMemoryBoundaryDir(join(dir, 'does-not-exist'))).toBe(false)
  })

  it('falls back to the shared auto-memory key when provisioning throws', () => {
    // Pin the contract documented in the catch block: when anything in the
    // git-stub dance fails (git init failure, mkdir/writeFile failure), the
    // function returns false and logs the failure. The agent keeps the
    // shared fleet-wide MEMORY.md instead of a per-agent one -- a noisy but
    // reversible degradation, never a crash.
    //
    // We force the catch path by pre-creating `.git` as a REGULAR FILE.
    // existsSync('.git') returns true so git init is skipped, then
    // mkdirSync('.git/info', { recursive: true }) throws ENOTDIR because
    // .git is a file, not a directory.
    writeFileSync(join(dir, '.git'), 'not a directory')
    expect(provisionMemoryBoundaryDir(dir)).toBe(false)
    // The function must not have replaced the file with a real git dir.
    expect(readFileSync(join(dir, '.git'), 'utf-8')).toBe('not a directory')
  })
})
