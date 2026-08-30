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
//
// All three eager shapes land here:
//   1. resolveFromPath(<name>)                       -- pre-state hazard
//   2. new LazyBin(<name>).resolve()                 -- H.3 class hazard (HR5)
//   3. makeLazyBinResolver(<name>)()                 -- invoked factory, also eager
//
// Variant notes:
// - `new LazyBin` may carry an explicit type argument (`new LazyBin<'tmux'>(...)`)
//   -- the `TName` generic is part of the public API.
// - `new` may be wrapped in parens (`(new LazyBin(...)).resolve()`).
// - `new` may be awaited (`await new LazyBin(...).resolve()`).
// - The LHS may have a `() => <ret>` type annotation that contains `=`; the
//   `(?:=>[^=]+)*` repetition in the annotation group lets `=` inside `=>`
//   pass through without short-circuiting the type-annotation match.
// The LazyBin branch requires `.resolve()` to follow the constructor call, so
// a bare `new LazyBin('tmux')` at module scope (lazy constructor) is NOT
// flagged -- verified by the negative test at L82.
const TOP_LEVEL_RESOLVE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+(?:=>[^=]+)*)?=\s*(?:resolveFromPath\(|makeLazyBinResolver\([^)]*\)\s*\(|makeLazyBinResolver\([^)]*\)\s*\([^)]*\)|(?:await\s+)?\(?\s*new\s+LazyBin(?:\s*<[^>]+>)?\s*\(.*?\)\.resolve\(\))/

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
      'Use makeLazyBinResolver(name) instead (or `new LazyBin(name)` if you need invalidate()), or move the call inside a function so it runs at first use -- resolveFromPath / new LazyBin(...).resolve() / makeLazyBinResolver(...)() at module scope throws at import time when the binary is missing, which kills unrelated test suites and the dashboard boot.',
    ).toEqual([])
  })

  it('detects an offending line (proves the matcher is not vacuous)', () => {
    expect(TOP_LEVEL_RESOLVE.test("const TMUX = resolveFromPath('tmux')")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("export const CLAUDE = resolveFromPath('claude')")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("const TMUX: string = resolveFromPath('tmux')")).toBe(true)
    // LazyBin-shaped resolution must also be caught (HR5 / H.3): a module-scope
    // `const X = new LazyBin('tmux').resolve()` reproduces the 2026-08-13 CI
    // incident -- .resolve() runs at import time and throws on a missing binary.
    expect(TOP_LEVEL_RESOLVE.test("const X = new LazyBin('tmux').resolve()")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("export const X = new LazyBin('tmux').resolve()")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("const X: string = new LazyBin('tmux').resolve()")).toBe(true)
    // Explicit type argument (`new LazyBin<'tmux'>(...)`) -- the `TName` generic
    // is part of the public API and the idiomatic way to write a typed call.
    expect(TOP_LEVEL_RESOLVE.test("const X = new LazyBin<string>('tmux').resolve()")).toBe(true)
    // Parenthesized `new` -- common when grouping a constructor expression.
    expect(TOP_LEVEL_RESOLVE.test("const X = (new LazyBin('tmux')).resolve()")).toBe(true)
    // Awaited `new` -- legal at module top level in ESM (and the value is
    // synchronous so this is just sugar over `.resolve()`).
    expect(TOP_LEVEL_RESOLVE.test("const X = await new LazyBin('tmux').resolve()")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("const X = await (new LazyBin('tmux')).resolve()")).toBe(true)
    // Function-type annotation containing `=>` -- the annotation group must
    // span the `=` inside the arrow without short-circuiting.
    expect(TOP_LEVEL_RESOLVE.test("const X: () => string = new LazyBin('tmux').resolve()")).toBe(true)
    // Invoked factory: `makeLazyBinResolver(name)()` resolves at import time
    // exactly like `resolveFromPath(name)` does.
    expect(TOP_LEVEL_RESOLVE.test("const X = makeLazyBinResolver('tmux')()")).toBe(true)
    expect(TOP_LEVEL_RESOLVE.test("const X = makeLazyBinResolver('tmux')('foo')")).toBe(true)
    // Factory call is allowed (no .resolve() at module scope -> lazy).
    expect(TOP_LEVEL_RESOLVE.test("const X = makeLazyBinResolver('tmux')")).toBe(false)
    // `new LazyBin(...)` without `.resolve()` is harmless (constructor is no-I/O).
    expect(TOP_LEVEL_RESOLVE.test("const X = new LazyBin('tmux')")).toBe(false)
    // Indented = inside a function body = already lazy, must NOT be flagged.
    expect(TOP_LEVEL_RESOLVE.test("    const bin = resolveFromPath('claude')")).toBe(false)
    expect(TOP_LEVEL_RESOLVE.test("    const bin = new LazyBin('claude').resolve()")).toBe(false)
    expect(TOP_LEVEL_RESOLVE.test("    const bin = await new LazyBin('tmux').resolve()")).toBe(false)
    expect(TOP_LEVEL_RESOLVE.test("    const bin = makeLazyBinResolver('tmux')()")).toBe(false)
  })
})
