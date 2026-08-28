// 100% coverage test for src/web/auto-restart-store.ts.
//
// auto-restart-store.ts is a thin wrapper over store/auto-restart.json:
//   - readAllAutoRestartConfigs: every entry, each normalized
//   - readAutoRestartConfig: one entry normalized, or DEFAULT_AUTO_RESTART when absent
//   - writeAutoRestartConfig: normalize, persist atomically, return normalized
//
// Branch inventory that must be covered here:
//   readRaw()
//     - readFileSync throws (file missing)        -> catch -> {}
//     - JSON.parse throws (malformed JSON)        -> catch -> {}
//     - parsed === null                            -> falsy guard -> {}
//     - parsed is primitive (number, string)       -> typeof !== 'object' -> {}
//     - parsed is truthy object ({} or [])         -> returns parsed
//   readAllAutoRestartConfigs()
//     - raw has entries                            -> loop body fires
//     - raw has no entries                         -> loop body skipped
//   readAutoRestartConfig(name)
//     - name in raw                                -> normalize(raw[name])
//     - name not in raw                            -> spread DEFAULT_AUTO_RESTART
//   writeAutoRestartConfig(name, cfg)
//     - normalize(cfg) for both normal and junk input
//     - raw merge preserves sibling entries
//     - atomicWriteFileSync lands on disk
//     - return value matches the persisted normalized value
//
// Sandbox: STORE_PATH = PROJECT_ROOT/store/auto-restart.json (src/web/auto-restart-store.ts:15).
// PROJECT_ROOT is frozen at the SUT's import time and is derived from
// import.meta.url inside src/config.ts -- CLAUDECLAW_ENV_DIR cannot redirect it
// (only env.ts reads that hook). The redirect used here is `vi.mock('../config.js')`,
// overriding PROJECT_ROOT so the joined store path lands inside the tmpdir sandbox
// returned by mkTempStore. vitest isolates module registries per test file, so the
// hook cannot leak into sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'
import { DEFAULT_AUTO_RESTART } from '../auto-restart.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's STORE_PATH is
// `join(PROJECT_ROOT, 'store', 'auto-restart.json')`, so PROJECT_ROOT must be
// the PARENT of the temp store dir for the join() to land inside our sandbox.
const STORE = mkTempStore('auto-restart-store-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const STORE_PATH = join(STORE, 'auto-restart.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST }
})

const {
  readAllAutoRestartConfigs,
  readAutoRestartConfig,
  writeAutoRestartConfig,
} = await import('../web/auto-restart-store.js')

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
// readAllAutoRestartConfigs -- the public all-agents read.
// ---------------------------------------------------------------------------
describe('readAllAutoRestartConfigs', () => {
  it('ures objektumot ad vissza ha a fajl meg nem letezik', () => {
    // readRaw catches ENOENT from readFileSync, returns {}.
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('ures objektumot ad vissza ha a JSON malformalt', () => {
    // JSON.parse throws -> catch branch in readRaw -> {}.
    writeFileSync(STORE_PATH, '{not json at all')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('ures objektumot ad vissza ha a JSON tomb (truthy object, de ures az entries)', () => {
    // typeof [] === 'object' && [] is truthy -> readRaw returns the array.
    // Object.entries([]) = [], so the for-loop body never executes -> {}.
    writeFileSync(STORE_PATH, '[]')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('a tomb numeric indexeit default-okra normalizalja (truthy object branch)', () => {
    // typeof [1,2,3] === 'object' && [1,2,3] truthy -> readRaw returns the array.
    // Object.entries yields ['0',1], ['1',2], ['2',3]; each value (a number)
    // normalizes through DEFAULT_AUTO_RESTART. Documents that readRaw does
    // NOT defend against arrays: the truthy-object branch is what makes this
    // resilient (no crash) but the output keyset mirrors the array indices.
    writeFileSync(STORE_PATH, '[1, 2, 3]')
    expect(readAllAutoRestartConfigs()).toEqual({
      '0': DEFAULT_AUTO_RESTART,
      '1': DEFAULT_AUTO_RESTART,
      '2': DEFAULT_AUTO_RESTART,
    })
  })

  it('a null JSON-t ures objektumma alakitja (falsy guard)', () => {
    // null is falsy, so `(parsed && typeof parsed === 'object')` short-circuits
    // to null -> readRaw returns {}.
    writeFileSync(STORE_PATH, 'null')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('a primitiv JSON-t (number) ures objektumma alakitja', () => {
    // typeof 42 === 'number', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, '42')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('a primitiv JSON-t (string) ures objektumma alakitja', () => {
    // typeof 'x' === 'string', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, '"hello"')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('a boolean JSON-t ures objektumma alakitja', () => {
    // typeof true === 'boolean', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, 'true')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('egyetlen bejegyzest is normalizal', () => {
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true, mode: 'fresh' } }))
    expect(readAllAutoRestartConfigs()).toEqual({
      main: { enabled: true, mode: 'fresh', dailyTime: null, intervalHours: null, handoff: false },
    })
  })

  it('tobb bejegyzest kulon-kulon normalizal', () => {
    writeFileSync(STORE_PATH, JSON.stringify({
      main: { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 5, handoff: true },
      sub: { enabled: true, intervalHours: 8 },
    }))
    expect(readAllAutoRestartConfigs()).toEqual({
      main: { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true },
      sub: { enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, handoff: false },
    })
  })

  it('a zavart ertekeket is default-okra normalizalja', () => {
    // A kulcs jelen van, de az ertek egy string -- a normalizeAutoRestartConfig
    // ilyenkor DEFAULT_AUTO_RESTART-ot ad vissza, mert `(raw && typeof === 'object')`
    // hamis. A SUT ezt az egyes bejegyzesekre alkalmazza, nem a fajl egeszere.
    writeFileSync(STORE_PATH, JSON.stringify({ bad: 'not an object' }))
    expect(readAllAutoRestartConfigs()).toEqual({ bad: DEFAULT_AUTO_RESTART })
  })

  it('ures objektum fajl eseten a loop nem fut le', () => {
    // readRaw returns {} (truthy object), but Object.entries({}) = [] so the
    // for-of body is skipped. Covers the "loop body never executes" branch.
    writeFileSync(STORE_PATH, '{}')
    expect(readAllAutoRestartConfigs()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// readAutoRestartConfig -- single-agent read with `name in raw` branching.
// ---------------------------------------------------------------------------
describe('readAutoRestartConfig', () => {
  it('DEFAULT_AUTO_RESTART-ot ad ha a fajl nem letezik', () => {
    // readRaw catches ENOENT -> {}, `name in {}` -> false -> spread default.
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('DEFAULT_AUTO_RESTART-ot ad ha a JSON malformalt', () => {
    // JSON.parse throws -> catch -> {} -> `name in {}` -> false -> default.
    writeFileSync(STORE_PATH, 'garbage')
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('DEFAULT_AUTO_RESTART-ot ad ha a JSON primitiv (number)', () => {
    // typeof 42 !== 'object' -> readRaw returns {} -> `name in {}` -> false.
    writeFileSync(STORE_PATH, '42')
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('DEFAULT_AUTO_RESTART-ot ad ha a JSON null', () => {
    writeFileSync(STORE_PATH, 'null')
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('DEFAULT_AUTO_RESTART-ot ad ha a name nincs a raw-ban', () => {
    // Truthy object branch in readRaw (returns the parsed object), but the
    // requested name is absent -- covers `name in raw` -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ other: { enabled: true } }))
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('ures string nevvel is DEFAULT_AUTO_RESTART-ot ad ha a kulcs hianyzik', () => {
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true } }))
    expect(readAutoRestartConfig('')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('a normalizalt configot adja ha a name jelen van', () => {
    // Covers `name in raw` -> true: normalizeAutoRestartConfig runs on raw[name].
    writeFileSync(STORE_PATH, JSON.stringify({
      main: { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 5, handoff: true },
    }))
    expect(readAutoRestartConfig('main')).toEqual({
      enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true,
    })
  })

  it('a jelenlevo kulcs erteket normalizalja akkor is ha az null', () => {
    // normalizeAutoRestartConfig(null) -> DEFAULT_AUTO_RESTART. Verifies the
    // `name in raw` branch normalizes the value rather than returning it
    // verbatim (would have crashed when raw[name] is null and the caller
    // treated it as a config object).
    writeFileSync(STORE_PATH, JSON.stringify({ main: null }))
    expect(readAutoRestartConfig('main')).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('a spread DEFAULT_AUTO_RESTART-ot adja vissza, nem ugyanaz a referenciat', () => {
    // A függvény `{ ...DEFAULT_AUTO_RESTART }`-ot ad vissza, nem magát a
    // modulszintű DEFAULT_AUTO_RESTART-ot -- a hívó módosíthatja a saját
    // másolatát anélkül, hogy a modul-szintű defaultot szennyezné.
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true } }))
    const result = readAutoRestartConfig('absent')
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    expect(result).not.toBe(DEFAULT_AUTO_RESTART)
  })
})

// ---------------------------------------------------------------------------
// writeAutoRestartConfig -- normalize, merge, persist, return.
// ---------------------------------------------------------------------------
describe('writeAutoRestartConfig', () => {
  it('a bemenetet eloszor normalizalja, aztan irja', () => {
    const result = writeAutoRestartConfig('main', {
      enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 5, handoff: true,
    })
    expect(result).toEqual({
      enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true,
    })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(result)
  })

  it('a lemezre irt config megegyezik a visszateresi ertekkel', () => {
    const result = writeAutoRestartConfig('main', { enabled: true })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(result)
  })

  it('JSON pretty-printed (2-space indent) formatumban ir', () => {
    writeAutoRestartConfig('main', { enabled: true })
    const raw = readFileSync(STORE_PATH, 'utf-8')
    expect(raw).toBe(JSON.stringify(
      { main: { enabled: true, mode: 'continue', dailyTime: null, intervalHours: null, handoff: false } },
      null, 2,
    ))
  })

  it('letrehozza a fajlt ha meg nem letezik (readRaw ENOENT catch + write)', () => {
    // readRaw catches ENOENT -> {}; the new key is set on {}; the file is
    // written fresh.
    expect(existsSync(STORE_PATH)).toBe(false)
    writeAutoRestartConfig('main', { enabled: true })
    expect(existsSync(STORE_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({
      main: { enabled: true, mode: 'continue', dailyTime: null, intervalHours: null, handoff: false },
    })
  })

  it('megorzi a meglevo bejegyzeseket (merge, NEM feluliras)', () => {
    // A SUT csak az uj kulcsot normalizalja; a meglevo bejegyzesek a fajlban
    // bit-pontosan maradnak (a readRaw nem normalizal, csak a write elotti
    // egyetlen kulcsot allitja be a writeAutoRestartConfig). Ez a korrekt
    // viselkedes: a meglevo bejegyzesek mar normalizaltak (vagy legalabbis
    // a korabbi write-ok odaig irtak oket).
    writeFileSync(STORE_PATH, JSON.stringify({ existing: { enabled: true } }))
    writeAutoRestartConfig('new', { enabled: true, mode: 'fresh' })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['existing']).toEqual({ enabled: true })
    expect(onDisk['new']).toEqual({
      enabled: true, mode: 'fresh', dailyTime: null, intervalHours: null, handoff: false,
    })
  })

  it('felulirja a meglevo bejegyzest ugyanazzal a kulccsal', () => {
    writeAutoRestartConfig('main', { enabled: false, mode: 'continue' })
    writeAutoRestartConfig('main', { enabled: true, mode: 'fresh' })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual({
      enabled: true, mode: 'fresh', dailyTime: null, intervalHours: null, handoff: false,
    })
  })

  it('undefined bemenet eseten DEFAULT_AUTO_RESTART-ot ir es ad vissza', () => {
    // normalizeAutoRestartConfig(undefined) -> {} guarded -> DEFAULT_AUTO_RESTART.
    const result = writeAutoRestartConfig('main', undefined)
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('null bemenet eseten is DEFAULT_AUTO_RESTART-ot ir es ad vissza', () => {
    const result = writeAutoRestartConfig('main', null)
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('string primitiv bemenet eseten is DEFAULT_AUTO_RESTART-ot ir', () => {
    const result = writeAutoRestartConfig('main', 'junk')
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('number primitiv bemenet eseten is DEFAULT_AUTO_RESTART-ot ir', () => {
    const result = writeAutoRestartConfig('main', 42)
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('ures object bemenet eseten is DEFAULT_AUTO_RESTART-ot ir', () => {
    const result = writeAutoRestartConfig('main', {})
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('tomb bemenet eseten is DEFAULT_AUTO_RESTART-ot ir', () => {
    // typeof [] === 'object' but normalize treats it as non-object -> default.
    const result = writeAutoRestartConfig('main', [1, 2, 3])
    expect(result).toEqual(DEFAULT_AUTO_RESTART)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('reszleges konfigot normalizalja (csak enabled = true)', () => {
    // Csak az enabled: true megy be; minden mas mezo default-ra all.
    const result = writeAutoRestartConfig('main', { enabled: true })
    expect(result).toEqual({
      enabled: true, mode: 'continue', dailyTime: null, intervalHours: null, handoff: false,
    })
  })

  it('ervenytelen dailyTime-ot eldobja es intervalHours-ra all', () => {
    // A dailyTime '99:99' parseHHMM-re null-t ad, ezert a normalize null-ra allitja,
    // es az intervalHours (8) megmarad.
    const result = writeAutoRestartConfig('main', {
      enabled: true, dailyTime: '99:99', intervalHours: 8,
    })
    expect(result).toEqual({
      enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, handoff: false,
    })
  })

  it('atomi irast hasznal (a write utan a fajl teljes, nincs .tmp maradek)', () => {
    writeAutoRestartConfig('main', { enabled: true })
    const dirEntries = readdirSync(STORE)
    const tmpLeftovers = dirEntries.filter((n: string) => n.endsWith('.tmp'))
    expect(tmpLeftovers).toEqual([])
  })
})