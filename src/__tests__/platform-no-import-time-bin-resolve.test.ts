import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Structural guard for the CI incident of 2026-08-13.
//
// Ten modules resolved their binaries at MODULE SCOPE:
//
//   const TMUX = resolveFromPath('tmux')
//   const CLAUDE = resolveFromPath('claude')
//
// resolveFromPath throws when the binary is absent, so the throw happened at
// IMPORT time. On a dev machine with tmux and claude installed this is
// invisible; on a clean GitHub ubuntu-latest runner it killed 11 test suites
// outright with "Required binary not found on PATH: claude" - not one of which
// had anything to do with tmux or claude. The same import-time throw takes the
// live dashboard down during a transient PATH gap (see platform.ts,
// makeLazyBinResolver).
//
// The fix is makeLazyBinResolver, which defers resolution to first use. This
// test pins the fix structurally instead of behaviourally: a behavioural test
// would need a machine without the binaries, which is exactly the machine we
// do not have locally. Scanning the source catches the regression everywhere.

const SRC = join(fileURLToPath(new URL('../..', import.meta.url)), 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...tsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

// A top-level call is one that starts at column 0: an indented call sits inside
// a function body and is therefore already lazy.
const TOP_LEVEL_RESOLVE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*resolveFromPath\(/

describe('no import-time binary resolution', () => {
  const files = tsFiles(SRC)

  it('finds source files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no src module calls resolveFromPath at module scope', () => {
    const offenders: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, i) => {
        if (TOP_LEVEL_RESOLVE.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      'Use makeLazyBinResolver(name) instead - resolveFromPath at module scope throws at import time when the binary is missing, which kills unrelated test suites and the dashboard boot.',
    ).toEqual([])
  })

  it('detects an offending line (proves the matcher is not vacuous)', () => {
    expect(TOP_LEVEL_RESOLVE.test("const TMUX = resolveFromPath('tmux')")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("export const CLAUDE = resolveFromPath('claude')")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("const TMUX: string = resolveFromPath('tmux')")).toBe(true)
    // Indented = inside a function body = already lazy, must NOT be flagged.
    expect(TOP_LEVEL_RESOLVE.test("    const bin = resolveFromPath('claude')")).toBe(false)
  })
})
