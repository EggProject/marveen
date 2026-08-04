// 100% coverage test for src/web/terminal-input-store.ts.
//
// Scope: every branch of the two exports (readTerminalInputEnabled,
// writeTerminalInputEnabled) plus the JSON.parse / optional-chain guards
// inside the try block.
//
// Branch inventory that must be covered here:
//
//   readTerminalInputEnabled()
//     - readFileSync throws (file missing)            -> catch -> DEFAULT.enabled (false)
//     - JSON.parse throws (malformed JSON)            -> catch -> false
//     - parsed === null                               -> optional-chain undefined -> false
//     - parsed is primitive (number/string)           -> optional-chain undefined -> false
//     - parsed is an empty object {}                  -> parsed.enabled undefined -> false
//     - parsed.enabled === false (boolean)            -> false
//     - parsed.enabled === true (boolean)             -> true
//     - parsed.enabled === null                       -> optional-chain short-circuit -> false
//     - parsed.enabled === undefined                  -> optional-chain undefined -> false
//     - parsed.enabled is the string "true"           -> "true" !== true -> false
//     - parsed.enabled is the number 1                -> 1 !== true -> false
//     - parsed.enabled is the string "false"          -> "false" !== true -> false
//     - parsed is an array []                         -> optional-chain undefined -> false
//
//   writeTerminalInputEnabled(enabled)
//     - enabled === true                              -> writes {enabled:true}, returns true
//     - enabled === false                             -> writes {enabled:false}, returns false
//     - enabled is truthy non-boolean (e.g. 1)        -> enabled === true is false -> writes false
//     - enabled is "true" (string)                    -> "true" === true is false -> writes false
//     - enabled is null / undefined                   -> writes false
//     - enabled is an object {}                       -> writes false
//     - enabled is an array []                        -> writes false
//     - JSON pretty-printed (2-space indent) format
//     - atomic write leaves no .tmp files
//     - return value matches the persisted value
//     - read after write round-trips the value
//
// Sandbox: STORE_PATH = PROJECT_ROOT/store/terminal-input.json
// (src/web/terminal-input-store.ts:17). PROJECT_ROOT is frozen at the SUT's
// import time and is derived from import.meta.url inside src/config.ts --
// CLAUDECLAW_ENV_DIR cannot redirect it. The redirect used here is
// `vi.mock('../config.js')`, overriding PROJECT_ROOT so the joined store path
// lands inside the tmpdir sandbox returned by mkTempStore. vitest isolates
// module registries per test file, so the hook cannot leak across suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's STORE_PATH is
// `join(PROJECT_ROOT, 'store', 'terminal-input.json')`, so PROJECT_ROOT must be
// the PARENT of the temp store dir for the join() to land inside our sandbox.
const STORE = mkTempStore('terminal-input-store-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const STORE_PATH = join(STORE, 'terminal-input.json')

// Override PROJECT_ROOT so the SUT's module-scope STORE_PATH lands inside the
// sandbox. config.ts has many module-scope side effects (readEnvFile, etc.)
// so we spread the original module rather than hand-stamping the surface.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST }
})

const {
  readTerminalInputEnabled,
  writeTerminalInputEnabled,
} = await import('../web/terminal-input-store.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle: clean store file between cases; tear the whole dir down
// after the suite. rmTempDir is force:true and swallows ENOENT so double-
// cleanup is safe.
// ---------------------------------------------------------------------------
beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(STORE_PATH)) rmSync(STORE_PATH)
})

afterEach(() => {
  rmTempDir(STORE)
})

// ---------------------------------------------------------------------------
// readTerminalInputEnabled -- single boolean read, fail-closed on every error.
// ---------------------------------------------------------------------------
describe('readTerminalInputEnabled', () => {
  it('false-t ad ha a fajl meg nem letezik (readFileSync ENOENT catch)', () => {
    // readFileSync throws ENOENT -> try block is skipped -> catch returns
    // DEFAULT.enabled (false). Documents the fail-closed posture: the toggle
    // must default to OFF when the store file is absent, never to ON.
    expect(existsSync(STORE_PATH)).toBe(false)
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a JSON malformalt (JSON.parse throw catch)', () => {
    // JSON.parse throws SyntaxError -> catch -> false.
    writeFileSync(STORE_PATH, '{not valid json at all')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a JSON ures fajl (readFileSync ok, parse ok)', () => {
    // readFileSync succeeds, JSON.parse('') throws -> catch -> false.
    writeFileSync(STORE_PATH, '')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a parsed ertek null (optional-chain undefined)', () => {
    // JSON.parse('null') -> null. `parsed?.enabled` -> undefined (optional
    // chaining short-circuits on null). `undefined === true` is false.
    writeFileSync(STORE_PATH, 'null')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a parsed primitiv number (optional-chain undefined)', () => {
    // JSON.parse('42') -> 42 (number, no `.enabled`). optional-chain -> undefined.
    writeFileSync(STORE_PATH, '42')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a parsed primitiv string (optional-chain undefined)', () => {
    // JSON.parse('"hello"') -> string, no `.enabled`. optional-chain -> undefined.
    writeFileSync(STORE_PATH, '"hello"')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a parsed boolean (optional-chain undefined)', () => {
    // JSON.parse('true') -> boolean true, no `.enabled`. optional-chain -> undefined.
    writeFileSync(STORE_PATH, 'true')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled undefined (ures object)', () => {
    // JSON.parse('{}') -> object with no `enabled` key. parsed?.enabled -> undefined.
    writeFileSync(STORE_PATH, '{}')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: null (optional-chain undefined)', () => {
    // parsed.enabled === null -> parsed?.enabled === undefined (optional
    // chaining returns undefined for null and undefined access).
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: null }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: false (boolean explicit OFF)', () => {
    // parsed.enabled === false -> false === true is false.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: false }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('true-t ad ha az enabled: true (boolean explicit ON)', () => {
    // parsed.enabled === true -> true === true -> true. The only path that
    // flips the toggle on -- the strict-equality guard exists so a stray
    // `enabled: "true"` / `enabled: 1` / `enabled: {}` cannot.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: true }))
    expect(readTerminalInputEnabled()).toBe(true)
  })

  it('false-t ad ha az enabled: "true" (string, NEM boolean)', () => {
    // The strict-equality guard (`=== true`) rejects string truthy values:
    // "true" !== true. Documents the defensive posture -- an operator who
    // hand-edits the store file with `enabled: "true"` cannot accidentally
    // turn the keystroke-injection endpoint on.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: 'true' }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: "false" (string, NEM boolean)', () => {
    // "false" !== true -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: 'false' }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: 1 (number, NEM boolean)', () => {
    // 1 !== true -> false. Strict-equality means the JS truthy coercion does
    // NOT apply -- `1` would normally be truthy in an `if (x)` check.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: 1 }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: 0 (number, NEM boolean)', () => {
    // 0 !== true -> false. Documents that the strict-equality guard is
    // symmetric -- the OFF path is also guarded against truthy-coercion.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: 0 }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: {} (object, NEM boolean)', () => {
    // {} !== true -> false. Even an empty object cannot flip the toggle on.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: {} }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha az enabled: [] (array, NEM boolean)', () => {
    // [] !== true -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: [] }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('false-t ad ha a parsed tomb (optional-chain undefined)', () => {
    // JSON.parse('[]') -> array. Arrays are objects but no `.enabled` key.
    writeFileSync(STORE_PATH, '[]')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('true-t ad ha az enabled: true egyeb mezok mellett (csak az enabled szamit)', () => {
    // Demonstrates the read is narrow: only the `enabled` key matters.
    // Sibling keys are ignored, which is what lets future fields (audit,
    // last-flipper, etc.) be added without changing the read.
    writeFileSync(STORE_PATH, JSON.stringify({
      enabled: true,
      lastFlipAt: '2026-08-04T12:34:56Z',
      flippedBy: 'owner@local',
      futureField: { ignored: true },
    }))
    expect(readTerminalInputEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// writeTerminalInputEnabled -- normalize, persist atomically, return new state.
// ---------------------------------------------------------------------------
describe('writeTerminalInputEnabled', () => {
  it('true bemenetre true-t ir es true-t ad vissza', () => {
    // enabled === true -> next = { enabled: true } -> returns true.
    const result = writeTerminalInputEnabled(true)
    expect(result).toBe(true)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: true })
  })

  it('false bemenetre false-t ir es false-t ad vissza', () => {
    // enabled === false -> next = { enabled: false } -> returns false.
    const result = writeTerminalInputEnabled(false)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('JSON pretty-printed (2-space indent) formatumban ir', () => {
    // The exact on-disk format is observable to operators who hand-inspect
    // the file; this test pins it so a change to the JSON serializer is
    // caught in code review.
    writeTerminalInputEnabled(true)
    const raw = readFileSync(STORE_PATH, 'utf-8')
    expect(raw).toBe(JSON.stringify({ enabled: true }, null, 2))
  })

  it('true iras utan olvasva true-t ad vissza (round-trip ON)', () => {
    // End-to-end: write true, read returns true. Covers the happy path
    // through both functions with the same sandbox state.
    writeTerminalInputEnabled(true)
    expect(readTerminalInputEnabled()).toBe(true)
  })

  it('false iras utan olvasva false-t ad vissza (round-trip OFF)', () => {
    // End-to-end: write false, read returns false.
    writeTerminalInputEnabled(false)
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('toggle irast tamogat (true -> false -> true) meglevo fajlon', () => {
    // Two sequential writes overwrite the previous value, no merge.
    writeTerminalInputEnabled(true)
    expect(readTerminalInputEnabled()).toBe(true)
    writeTerminalInputEnabled(false)
    expect(readTerminalInputEnabled()).toBe(false)
    writeTerminalInputEnabled(true)
    expect(readTerminalInputEnabled()).toBe(true)
  })

  it('letrehozza a fajlt ha meg nem letezik', () => {
    // atomicWriteFileSync is unconditional -- the file is created on every
    // write, regardless of whether it existed before.
    expect(existsSync(STORE_PATH)).toBe(false)
    writeTerminalInputEnabled(true)
    expect(existsSync(STORE_PATH)).toBe(true)
  })

  it('felulirja a meglevo fajlt teljesen (csak az enabled mezo, nincs merge)', () => {
    // Pre-existing file with extra keys; the write REPLACES the whole
    // content with the new minimal {enabled} object (no merge layer). This
    // is the documented behaviour -- the schema is intentionally tiny.
    writeFileSync(STORE_PATH, JSON.stringify({
      enabled: false,
      legacyField: 'should be dropped',
      anotherLegacy: 42,
    }))
    writeTerminalInputEnabled(true)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: true })
    expect('legacyField' in onDisk).toBe(false)
  })

  it('az 1 (number) bemenetet false-ra normalizalja (strict equality)', () => {
    // 1 === true is false -> next.enabled = false. The strict-equality
    // normalization is the same one used on read, so an upstream caller
    // that passes a non-boolean never accidentally turns the toggle ON.
    const result = writeTerminalInputEnabled(1 as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('a "true" string bemenetet false-ra normalizalja', () => {
    // "true" === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled('true' as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('a "false" string bemenetet false-ra normalizalja', () => {
    // "false" === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled('false' as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('a 0 (number) bemenetet false-ra normalizalja', () => {
    // 0 === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled(0 as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('a null bemenetet false-ra normalizalja', () => {
    // null === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled(null as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('az undefined bemenetet false-ra normalizalja', () => {
    // undefined === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled(undefined as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('az {} (object) bemenetet false-ra normalizalja', () => {
    // {} === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled({} as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('a [] (array) bemenetet false-ra normalizalja', () => {
    // [] === true is false -> next.enabled = false.
    const result = writeTerminalInputEnabled([] as unknown as boolean)
    expect(result).toBe(false)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ enabled: false })
  })

  it('atomi irast hasznal (a write utan a fajl teljes, nincs .tmp maradek)', () => {
    // atomicWriteFileSync uses a sibling .tmp + rename; if the rename fails
    // or the test catches the SUT mid-write, a .tmp file could leak. This
    // test pins that no .tmp file survives a successful write.
    writeTerminalInputEnabled(true)
    const dirEntries = readdirSync(STORE)
    const tmpLeftovers = dirEntries.filter((n: string) => n.endsWith('.tmp'))
    expect(tmpLeftovers).toEqual([])
  })
})
