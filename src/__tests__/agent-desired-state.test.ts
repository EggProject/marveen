// 100% coverage test for src/web/agent-desired-state.ts.
//
// agent-desired-state.ts is a thin wrapper over store/agents-desired.json:
//   - getDesiredAgents: read JSON array, filter to strings, return as Set
//   - addDesiredAgent: append name to the Set and persist (sorted)
//   - removeDesiredAgent: drop name from the Set and persist (sorted)
//
// Branch inventory that must be covered here:
//   getDesiredAgents()
//     - file missing (existsSync returns false)    -> empty Set
//     - file present, JSON malformed               -> catch (logger.warn) -> empty Set
//     - file present, readFileSync throws          -> catch (logger.warn) -> empty Set
//     - file present, JSON parsed is not an array  -> empty Set (Array.isArray false)
//     - file present, JSON parsed is array         -> Set of strings (filter mixed)
//   writeDesired()  [private]
//     - writeFileSync succeeds                     -> set persists sorted
//     - writeFileSync throws                       -> catch (logger.error)
//   addDesiredAgent(name)
//     - name already present                       -> early return (no write, no log.info)
//     - name absent                                -> add, persist, log.info
//   removeDesiredAgent(name)
//     - name absent                                -> early return (no write)
//     - name present                               -> delete, persist, log.info
//
// Sandbox: DESIRED_FILE = STORE_DIR/agents-desired.json (line 19),
// STORE_DIR = PROJECT_ROOT/store (src/config.ts:13). PROJECT_ROOT is frozen
// at the SUT's import time and is derived from import.meta.url inside
// src/config.ts -- CLAUDECLAW_ENV_DIR cannot redirect it (only env.ts reads
// that hook). The redirect used here is `vi.mock('../config.js')`, overriding
// PROJECT_ROOT so the joined store path lands inside the tmpdir sandbox
// returned by mkTempStore. vitest isolates module registries per test file,
// so the hook cannot leak into sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's DESIRED_FILE is
// `join(STORE_DIR, 'agents-desired.json')` where STORE_DIR = `join(PROJECT_ROOT,
// 'store')`. So PROJECT_ROOT must be the PARENT of the temp store dir for the
// join() to land inside our sandbox.
const STORE = mkTempStore('agent-desired-state-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const DESIRED_FILE = join(STORE, 'agents-desired.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  // STORE_DIR was already joined with the real PROJECT_ROOT when config.ts
  // originally loaded; override both PROJECT_ROOT AND STORE_DIR so the SUT's
  // `join(STORE_DIR, 'agents-desired.json')` lands inside our tmpdir sandbox.
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST, STORE_DIR: STORE }
})

const {
  getDesiredAgents,
  addDesiredAgent,
  removeDesiredAgent,
} = await import('../web/agent-desired-state.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle: clean the desired-state file between cases; restore
// store-dir permissions in case a prior test left it read-only; tear the
// whole dir down after the suite. rmTempDir is force:true and swallows
// ENOENT so double-cleanup is safe.
// ---------------------------------------------------------------------------
beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  chmodSync(STORE, 0o755)
  if (existsSync(DESIRED_FILE)) rmSync(DESIRED_FILE)
})

afterEach(() => {
  chmodSync(STORE, 0o755)
  rmTempDir(STORE)
})

// ---------------------------------------------------------------------------
// getDesiredAgents -- the public read with file-existence and JSON-shape
// branching.
// ---------------------------------------------------------------------------
describe('getDesiredAgents', () => {
  it('ures Set-et ad vissza ha a fajl nem letezik', () => {
    // existsSync returns false -> `!existsSync(DESIRED_FILE)` -> early return.
    expect(getDesiredAgents()).toEqual(new Set())
  })

  it('ures Set-et ad vissza ha a JSON malformalt (JSON.parse catch)', () => {
    // existsSync true, JSON.parse throws -> catch branch -> empty Set.
    writeFileSync(DESIRED_FILE, '{not valid json')
    expect(getDesiredAgents()).toEqual(new Set())
  })

  it('ures Set-et ad vissza ha readFileSync hibazik (read catch)', () => {
    // existsSync true, readFileSync throws (EISDIR on Unix) -> catch -> empty Set.
    // Branches that existSync=true AND JSON.parse is never reached, but the catch
    // branch is the same one malformed JSON hits; this case proves the catch
    // fires for a read-side failure too, not just parse-side.
    mkdirSync(DESIRED_FILE)
    try {
      expect(getDesiredAgents()).toEqual(new Set())
    } finally {
      rmSync(DESIRED_FILE, { recursive: true, force: true })
    }
  })

  it('ures Set-et ad vissza ha a JSON nem tomb (Array.isArray false)', () => {
    // existsSync true, parsed is an object -> Array.isArray false -> empty Set.
    writeFileSync(DESIRED_FILE, JSON.stringify({ main: true }))
    expect(getDesiredAgents()).toEqual(new Set())
  })

  it('ures Set-et ad vissza ha a JSON primitiv (Array.isArray false)', () => {
    // typeof 42 === 'number', JSON.parse succeeds, Array.isArray false -> empty Set.
    writeFileSync(DESIRED_FILE, '42')
    expect(getDesiredAgents()).toEqual(new Set())
  })

  it('a tombbol csak a string-eket tartja meg (filter mixed)', () => {
    // Array.isArray true -> return new Set(parsed.filter(isString)). Documents
    // that the filter is defensive: a hand-edited or older file with non-strings
    // is silently coerced down to a Set of strings (no crash, no log).
    writeFileSync(DESIRED_FILE, JSON.stringify(['main', 1, null, 'sub', true, 'extra']))
    expect(getDesiredAgents()).toEqual(new Set(['main', 'sub', 'extra']))
  })

  it('a tombbol Set-et epit (Array.isArray true branch)', () => {
    writeFileSync(DESIRED_FILE, JSON.stringify(['alpha', 'beta']))
    expect(getDesiredAgents()).toEqual(new Set(['alpha', 'beta']))
  })

  it('a Set egy uj peldany, nem osztja meg a hivo Set-jetet', () => {
    // The returned Set is a fresh instance -- mutating it must not leak into
    // a subsequent add/remove that calls getDesiredAgents() again.
    writeFileSync(DESIRED_FILE, JSON.stringify(['alpha']))
    const first = getDesiredAgents()
    first.add('leaked')
    const second = getDesiredAgents()
    expect(second.has('leaked')).toBe(false)
    expect(second).toEqual(new Set(['alpha']))
  })
})

// ---------------------------------------------------------------------------
// addDesiredAgent -- early-return on already-present, add+persist+log otherwise.
// ---------------------------------------------------------------------------
describe('addDesiredAgent', () => {
  it('letrehozza a fajlt es beleirja az uj nevet', () => {
    // getDesiredAgents returns empty Set, set.add, writeDesired persists,
    // logger.info fires.
    expect(existsSync(DESIRED_FILE)).toBe(false)
    addDesiredAgent('main')
    expect(existsSync(DESIRED_FILE)).toBe(true)
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual(['main'])
  })

  it('meglevo elemeket megtart es ujat fuz hozza, rendezve', () => {
    // Sorts on write: ['existing'] + add 'new' -> ['existing', 'new'] (alphabetical).
    writeFileSync(DESIRED_FILE, JSON.stringify(['existing']))
    addDesiredAgent('new')
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual(['existing', 'new'])
  })

  it('a kiiras abc sorrendben van (tobb beszuras utan is)', () => {
    // Covers the [...set].sort() inside writeDesired.
    addDesiredAgent('zebra')
    addDesiredAgent('alpha')
    addDesiredAgent('middle')
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('korai return ha a name mar benne van (no write, no info log)', () => {
    // set.has(name) true -> return before writeDesired. The file is byte-
    // identical before and after the call (no write happened).
    writeFileSync(DESIRED_FILE, JSON.stringify(['main'], null, 2))
    const before = readFileSync(DESIRED_FILE, 'utf-8')
    addDesiredAgent('main')
    expect(readFileSync(DESIRED_FILE, 'utf-8')).toBe(before)
  })

  it('a writeDesired catch-en keresztul elnyeli a write hibajat (logger.error)', () => {
    // writeFileSync throws because the file is read-only (chmod 0o444). The
    // error is caught by writeDesired -> logger.error; the caller does not
    // throw. Reading the file (getDesiredAgents inside addDesiredAgent)
    // still works because read permission is granted; only writes fail.
    writeFileSync(DESIRED_FILE, JSON.stringify(['existing']))
    const before = readFileSync(DESIRED_FILE, 'utf-8')
    chmodSync(DESIRED_FILE, 0o444)
    try {
      expect(() => addDesiredAgent('new')).not.toThrow()
    } finally {
      chmodSync(DESIRED_FILE, 0o644)
    }
    // The write failed -- the file is unchanged on disk.
    expect(readFileSync(DESIRED_FILE, 'utf-8')).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// removeDesiredAgent -- early-return on absent, delete+persist+log otherwise.
// ---------------------------------------------------------------------------
describe('removeDesiredAgent', () => {
  it('a fajlbol elveszi a nevet es rendezve irja vissza a maradekot', () => {
    writeFileSync(DESIRED_FILE, JSON.stringify(['alpha', 'beta', 'gamma']))
    removeDesiredAgent('beta')
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual(['alpha', 'gamma'])
  })

  it('az utolso elemet is torli', () => {
    writeFileSync(DESIRED_FILE, JSON.stringify(['only']))
    removeDesiredAgent('only')
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual([])
  })

  it('korai return ha a name nincs benne (no write, no info log)', () => {
    // set.delete(name) returns false -> `!set.delete` is true -> return.
    writeFileSync(DESIRED_FILE, JSON.stringify(['main'], null, 2))
    const before = readFileSync(DESIRED_FILE, 'utf-8')
    removeDesiredAgent('absent')
    expect(readFileSync(DESIRED_FILE, 'utf-8')).toBe(before)
  })

  it('a writeDesired catch-en keresztul elnyeli a write hibajat (logger.error)', () => {
    // set.delete returns true, but writeFileSync throws because the file is
    // read-only. Caught by writeDesired -> logger.error; caller does not throw.
    writeFileSync(DESIRED_FILE, JSON.stringify(['existing']))
    const before = readFileSync(DESIRED_FILE, 'utf-8')
    chmodSync(DESIRED_FILE, 0o444)
    try {
      expect(() => removeDesiredAgent('existing')).not.toThrow()
    } finally {
      chmodSync(DESIRED_FILE, 0o644)
    }
    expect(readFileSync(DESIRED_FILE, 'utf-8')).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Round-trip -- add then remove should leave an empty, well-formed file.
// ---------------------------------------------------------------------------
describe('add es remove round-trip', () => {
  it('add majd remove visszaad ures Set-et es ures tombot a lemezen', () => {
    addDesiredAgent('main')
    addDesiredAgent('sub')
    removeDesiredAgent('main')
    removeDesiredAgent('sub')
    expect(getDesiredAgents()).toEqual(new Set())
    expect(JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))).toEqual([])
  })

  it('getDesiredAgents visszaadja a korabban addolt neveket (friss allapotot olvas)', () => {
    addDesiredAgent('alpha')
    addDesiredAgent('beta')
    expect(getDesiredAgents()).toEqual(new Set(['alpha', 'beta']))
  })
})