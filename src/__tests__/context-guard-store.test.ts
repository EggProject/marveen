// 100% coverage test for src/web/context-guard-store.ts.
//
// context-guard-store.ts is a thin wrapper over store/context-guard.json --
// the same shape as auto-restart.json, one JSON map keyed by agent name:
//   - readAllContextGuardConfigs: every entry, each normalized
//   - readContextGuardConfig: one entry normalized, or DEFAULT_CONTEXT_GUARD
//     when absent (the guard is DEFAULT-OFF / opt-in)
//   - writeContextGuardConfig: normalize, persist atomically, return normalized
//
// Branch inventory that must be covered here:
//   readRaw()
//     - readFileSync throws (file missing)          -> catch -> {}
//     - JSON.parse throws (malformed JSON)          -> catch -> {}
//     - parsed === null                             -> falsy guard -> {}
//     - parsed is primitive (number/string/bool)    -> typeof !== 'object' -> {}
//     - parsed is truthy object ({} or [])          -> returns parsed
//   readAllContextGuardConfigs()
//     - raw has entries                             -> loop body fires
//     - raw has no entries                          -> loop body skipped
//   readContextGuardConfig(name)
//     - name in raw                                 -> normalize(raw[name])
//     - name not in raw                             -> spread DEFAULT_CONTEXT_GUARD
//   writeContextGuardConfig(name, cfg)
//     - normalize(cfg) for both normal and junk input
//     - raw merge preserves sibling entries
//     - atomicWriteFileSync lands on disk
//     - return value matches the persisted normalized value
//
// Sandbox: STORE_PATH = PROJECT_ROOT/store/context-guard.json
// (src/web/context-guard-store.ts:17). PROJECT_ROOT is frozen at the SUT's
// import time and is derived from import.meta.url inside src/config.ts --
// CLAUDECLAW_ENV_DIR cannot redirect it (only env.ts reads that hook). The
// redirect used here is `vi.mock('../config.js')`, overriding PROJECT_ROOT so
// the joined store path lands inside the tmpdir sandbox returned by
// mkTempStore. vitest isolates module registries per test file, so the hook
// cannot leak into sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'
import { DEFAULT_CONTEXT_GUARD } from '../context-guard.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's STORE_PATH is
// `join(PROJECT_ROOT, 'store', 'context-guard.json')`, so PROJECT_ROOT must be
// the PARENT of the temp store dir for the join() to land inside our sandbox.
const STORE = mkTempStore('context-guard-store-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const STORE_PATH = join(STORE, 'context-guard.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST }
})

const {
  readAllContextGuardConfigs,
  readContextGuardConfig,
  writeContextGuardConfig,
} = await import('../web/context-guard-store.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle: clean store file between cases; tear the whole dir down
// after each case. rmTempDir is force:true and swallows ENOENT so double-
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
// readAllContextGuardConfigs -- the public all-agents read.
// ---------------------------------------------------------------------------
describe('readAllContextGuardConfigs', () => {
  it('ures objektumot ad vissza ha a fajl meg nem letezik', () => {
    // readRaw catches ENOENT from readFileSync, returns {}.
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('ures objektumot ad vissza ha a JSON malformalt', () => {
    // JSON.parse throws -> catch branch in readRaw -> {}.
    writeFileSync(STORE_PATH, '{not json at all')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('ures objektumot ad vissza ha a fajl ures', () => {
    // '' is not valid JSON -> JSON.parse throws -> catch -> {}.
    writeFileSync(STORE_PATH, '')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('ures objektumot ad vissza ha a JSON tomb (truthy object, de ures az entries)', () => {
    // typeof [] === 'object' && [] is truthy -> readRaw returns the array.
    // Object.entries([]) = [], so the for-loop body never executes -> {}.
    writeFileSync(STORE_PATH, '[]')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('a tomb numeric indexeit default-okra normalizalja (truthy object branch)', () => {
    // typeof [1,2,3] === 'object' && truthy -> readRaw returns the array.
    // Object.entries yields ['0',1], ['1',2], ['2',3]; each value (a number)
    // normalizes through DEFAULT_CONTEXT_GUARD. Documents that readRaw does
    // NOT defend against arrays: the truthy-object branch is what keeps this
    // from crashing, but the output keyset mirrors the array indices.
    writeFileSync(STORE_PATH, '[1, 2, 3]')
    expect(readAllContextGuardConfigs()).toEqual({
      '0': DEFAULT_CONTEXT_GUARD,
      '1': DEFAULT_CONTEXT_GUARD,
      '2': DEFAULT_CONTEXT_GUARD,
    })
  })

  it('a null JSON-t ures objektumma alakitja (falsy guard)', () => {
    // null is falsy, so `(parsed && typeof parsed === 'object')` short-circuits
    // to null -> readRaw returns {}.
    writeFileSync(STORE_PATH, 'null')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('a primitiv JSON-t (number) ures objektumma alakitja', () => {
    // typeof 42 === 'number', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, '42')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('a primitiv JSON-t (string) ures objektumma alakitja', () => {
    // typeof 'hello' === 'string', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, '"hello"')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('a boolean JSON-t ures objektumma alakitja', () => {
    // typeof true === 'boolean', not 'object' -> readRaw returns {}.
    writeFileSync(STORE_PATH, 'true')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('ures objektum fajl eseten a loop nem fut le', () => {
    // readRaw returns {} (truthy object), but Object.entries({}) = [] so the
    // for-of body is skipped.
    writeFileSync(STORE_PATH, '{}')
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('egyetlen bejegyzest is normalizal', () => {
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true } }))
    expect(readAllContextGuardConfigs()).toEqual({
      main: { ...DEFAULT_CONTEXT_GUARD, enabled: true },
    })
  })

  it('tobb bejegyzest kulon-kulon normalizal', () => {
    writeFileSync(STORE_PATH, JSON.stringify({
      main: { enabled: true, actPct: 0.8, hardPct: 0.95, cooldownMinutes: 30 },
      sub: { enabled: false, saturationRestart: false, limitTokens: 500_000 },
    }))
    expect(readAllContextGuardConfigs()).toEqual({
      main: {
        enabled: true,
        saturationRestart: true,
        actPct: 0.8,
        hardPct: 0.95,
        limitTokens: null,
        cooldownMinutes: 30,
        handoffTimeoutMinutes: 20,
      },
      sub: {
        enabled: false,
        saturationRestart: false,
        actPct: 0.90,
        hardPct: 0.97,
        limitTokens: 500_000,
        cooldownMinutes: 15,
        handoffTimeoutMinutes: 20,
      },
    })
  })

  it('a zavart ertekeket is default-okra normalizalja', () => {
    // A kulcs jelen van, de az ertek egy string -- a normalizeContextGuardConfig
    // ilyenkor DEFAULT_CONTEXT_GUARD-ot ad vissza, mert `(raw && typeof === 'object')`
    // hamis. A SUT ezt az egyes bejegyzesekre alkalmazza, nem a fajl egeszere.
    writeFileSync(STORE_PATH, JSON.stringify({ bad: 'not an object' }))
    expect(readAllContextGuardConfigs()).toEqual({ bad: DEFAULT_CONTEXT_GUARD })
  })

  it('a null erteku bejegyzest is normalizalja, nem adja vissza nyersen', () => {
    writeFileSync(STORE_PATH, JSON.stringify({ main: null }))
    expect(readAllContextGuardConfigs()).toEqual({ main: DEFAULT_CONTEXT_GUARD })
  })
})

// ---------------------------------------------------------------------------
// readContextGuardConfig -- single-agent read with `name in raw` branching.
// ---------------------------------------------------------------------------
describe('readContextGuardConfig', () => {
  it('DEFAULT_CONTEXT_GUARD-ot ad ha a fajl nem letezik', () => {
    // readRaw catches ENOENT -> {}, `name in {}` -> false -> spread default.
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('a default DEFAULT-OFF: enabled false, saturationRestart true', () => {
    // A store dokumentalt szerzodese (context-guard-store.ts:11-16): bejegyzes
    // nelkul az agent proaktiv oreje KI van kapcsolva, de a szaturacios halo
    // fegyverben marad.
    const cfg = readContextGuardConfig('never-configured')
    expect(cfg.enabled).toBe(false)
    expect(cfg.saturationRestart).toBe(true)
  })

  it('DEFAULT_CONTEXT_GUARD-ot ad ha a JSON malformalt', () => {
    // JSON.parse throws -> catch -> {} -> `name in {}` -> false -> default.
    writeFileSync(STORE_PATH, 'garbage')
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('DEFAULT_CONTEXT_GUARD-ot ad ha a JSON primitiv (number)', () => {
    // typeof 42 !== 'object' -> readRaw returns {} -> `name in {}` -> false.
    writeFileSync(STORE_PATH, '42')
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('DEFAULT_CONTEXT_GUARD-ot ad ha a JSON null', () => {
    writeFileSync(STORE_PATH, 'null')
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('DEFAULT_CONTEXT_GUARD-ot ad ha a name nincs a raw-ban', () => {
    // Truthy object branch in readRaw (returns the parsed object), but the
    // requested name is absent -- covers `name in raw` -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ other: { enabled: true } }))
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('ures string nevvel is DEFAULT_CONTEXT_GUARD-ot ad ha a kulcs hianyzik', () => {
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true } }))
    expect(readContextGuardConfig('')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('a normalizalt configot adja ha a name jelen van', () => {
    // Covers `name in raw` -> true: normalizeContextGuardConfig runs on raw[name].
    writeFileSync(STORE_PATH, JSON.stringify({
      main: {
        enabled: true,
        saturationRestart: false,
        actPct: 0.85,
        hardPct: 0.99,
        limitTokens: 1_000_000,
        cooldownMinutes: 5,
        handoffTimeoutMinutes: 12,
      },
    }))
    expect(readContextGuardConfig('main')).toEqual({
      enabled: true,
      saturationRestart: false,
      actPct: 0.85,
      hardPct: 0.99,
      limitTokens: 1_000_000,
      cooldownMinutes: 5,
      handoffTimeoutMinutes: 12,
    })
  })

  it('a jelenlevo kulcs erteket normalizalja akkor is ha az null', () => {
    // normalizeContextGuardConfig(null) -> DEFAULT_CONTEXT_GUARD. Verifies the
    // `name in raw` branch normalizes the value rather than returning it
    // verbatim (would have crashed when raw[name] is null and the caller
    // treated it as a config object).
    writeFileSync(STORE_PATH, JSON.stringify({ main: null }))
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('az explicit undefined ertek is a `name in raw` agat viszi', () => {
    // JSON.stringify eldobja az undefined erteket, ezert kezzel irjuk a fajlt:
    // a kulcs jelen van `null` ertekkel -- a `in` operator a sajat kulcsokra
    // igaz, fuggetlenul az ertektol.
    writeFileSync(STORE_PATH, '{"main": null, "sub": {"enabled": true}}')
    expect(readContextGuardConfig('main')).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(readContextGuardConfig('sub')).toEqual({ ...DEFAULT_CONTEXT_GUARD, enabled: true })
  })

  it('a spread DEFAULT_CONTEXT_GUARD-ot adja vissza, nem ugyanazt a referenciat', () => {
    // A fuggveny `{ ...DEFAULT_CONTEXT_GUARD }`-ot ad vissza, nem magat a
    // modulszintu DEFAULT_CONTEXT_GUARD-ot -- a hivo modosithatja a sajat
    // masolatat anelkul, hogy a modul-szintu defaultot szennyezne.
    writeFileSync(STORE_PATH, JSON.stringify({ main: { enabled: true } }))
    const result = readContextGuardConfig('absent')
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(result).not.toBe(DEFAULT_CONTEXT_GUARD)
  })
})

// ---------------------------------------------------------------------------
// writeContextGuardConfig -- normalize, merge, persist, return.
// ---------------------------------------------------------------------------
describe('writeContextGuardConfig', () => {
  it('a bemenetet eloszor normalizalja, aztan irja', () => {
    const result = writeContextGuardConfig('main', {
      enabled: true,
      saturationRestart: false,
      actPct: 0.8,
      hardPct: 0.95,
      limitTokens: 200_000,
      cooldownMinutes: 30,
      handoffTimeoutMinutes: 45,
    })
    expect(result).toEqual({
      enabled: true,
      saturationRestart: false,
      actPct: 0.8,
      hardPct: 0.95,
      limitTokens: 200_000,
      cooldownMinutes: 30,
      handoffTimeoutMinutes: 45,
    })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(result)
  })

  it('a lemezre irt config megegyezik a visszateresi ertekkel', () => {
    const result = writeContextGuardConfig('main', { enabled: true })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(result)
  })

  it('JSON pretty-printed (2-space indent) formatumban ir', () => {
    writeContextGuardConfig('main', { enabled: true })
    const raw = readFileSync(STORE_PATH, 'utf-8')
    expect(raw).toBe(JSON.stringify(
      { main: { ...DEFAULT_CONTEXT_GUARD, enabled: true } },
      null, 2,
    ))
  })

  it('letrehozza a fajlt ha meg nem letezik (readRaw ENOENT catch + write)', () => {
    // readRaw catches ENOENT -> {}; the new key is set on {}; the file is
    // written fresh.
    expect(existsSync(STORE_PATH)).toBe(false)
    writeContextGuardConfig('main', { enabled: true })
    expect(existsSync(STORE_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ main: { ...DEFAULT_CONTEXT_GUARD, enabled: true } })
  })

  it('megorzi a meglevo bejegyzeseket (merge, NEM feluliras)', () => {
    // A SUT csak az uj kulcsot normalizalja; a meglevo bejegyzesek a fajlban
    // bit-pontosan maradnak, mert a readRaw nem normalizal.
    writeFileSync(STORE_PATH, JSON.stringify({ existing: { enabled: true } }))
    writeContextGuardConfig('new', { enabled: true, actPct: 0.5 })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['existing']).toEqual({ enabled: true })
    expect(onDisk['new']).toEqual({ ...DEFAULT_CONTEXT_GUARD, enabled: true, actPct: 0.5 })
  })

  it('romlott fajl folott is ir (readRaw catch -> {} -> csak az uj kulcs marad)', () => {
    // Dokumentalja az adatvesztes-jellegu, de szandekolt viselkedest: egy
    // olvashatatlan store-t a write NEM orzi meg, hanem tiszta lappal indul.
    writeFileSync(STORE_PATH, '{broken')
    writeContextGuardConfig('main', { enabled: true })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual({ main: { ...DEFAULT_CONTEXT_GUARD, enabled: true } })
  })

  it('felulirja a meglevo bejegyzest ugyanazzal a kulccsal', () => {
    writeContextGuardConfig('main', { enabled: false, actPct: 0.5 })
    writeContextGuardConfig('main', { enabled: true, actPct: 0.75 })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual({ ...DEFAULT_CONTEXT_GUARD, enabled: true, actPct: 0.75 })
  })

  it('undefined bemenet eseten DEFAULT_CONTEXT_GUARD-ot ir es ad vissza', () => {
    // normalizeContextGuardConfig(undefined) -> {} guarded -> DEFAULT_CONTEXT_GUARD.
    const result = writeContextGuardConfig('main', undefined)
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('null bemenet eseten is DEFAULT_CONTEXT_GUARD-ot ir es ad vissza', () => {
    const result = writeContextGuardConfig('main', null)
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('string primitiv bemenet eseten is DEFAULT_CONTEXT_GUARD-ot ir', () => {
    const result = writeContextGuardConfig('main', 'junk')
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('number primitiv bemenet eseten is DEFAULT_CONTEXT_GUARD-ot ir', () => {
    const result = writeContextGuardConfig('main', 42)
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('ures object bemenet eseten is DEFAULT_CONTEXT_GUARD-ot ir', () => {
    const result = writeContextGuardConfig('main', {})
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('tomb bemenet eseten is DEFAULT_CONTEXT_GUARD-ot ir', () => {
    // typeof [] === 'object', igy a normalize objektumkent kezeli, de egyetlen
    // vart mezoje sincs -> minden default-ra all.
    const result = writeContextGuardConfig('main', [1, 2, 3])
    expect(result).toEqual(DEFAULT_CONTEXT_GUARD)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main']).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('a hardPct-t felhuzza az actPct-re ha alatta lenne', () => {
    // normalizeContextGuardConfig: `if (hardPct < actPct) hardPct = actPct`.
    // A store ezt a mar javitott erteket perzisztalja, nem a nyers bemenetet.
    const result = writeContextGuardConfig('main', { actPct: 0.9, hardPct: 0.5 })
    expect(result.actPct).toBe(0.9)
    expect(result.hardPct).toBe(0.9)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main'].hardPct).toBe(0.9)
  })

  it('a tartomanyon kivuli pct ertekeket eldobja', () => {
    // pct() csak (0,1) nyilt intervallumot fogad el; 1.5 es -0.2 default-ra all.
    const result = writeContextGuardConfig('main', { actPct: 1.5, hardPct: -0.2 })
    expect(result.actPct).toBe(DEFAULT_CONTEXT_GUARD.actPct)
    expect(result.hardPct).toBe(DEFAULT_CONTEXT_GUARD.hardPct)
  })

  it('a 10000 alatti limitTokens-t null-ra allitja', () => {
    const result = writeContextGuardConfig('main', { limitTokens: 9_999 })
    expect(result.limitTokens).toBeNull()
  })

  it('a tort limitTokens-t lefele kerekiti', () => {
    const result = writeContextGuardConfig('main', { limitTokens: 250_000.9 })
    expect(result.limitTokens).toBe(250_000)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk['main'].limitTokens).toBe(250_000)
  })

  it('a nem-pozitiv perc ertekeket default-ra allitja', () => {
    const result = writeContextGuardConfig('main', {
      cooldownMinutes: 0,
      handoffTimeoutMinutes: -5,
    })
    expect(result.cooldownMinutes).toBe(DEFAULT_CONTEXT_GUARD.cooldownMinutes)
    expect(result.handoffTimeoutMinutes).toBe(DEFAULT_CONTEXT_GUARD.handoffTimeoutMinutes)
  })

  it('csak az explicit false kapcsolja ki a saturationRestart-ot', () => {
    // `o.saturationRestart !== false` -- barmi mas (0, null, 'no') bekapcsolva hagyja.
    expect(writeContextGuardConfig('a', { saturationRestart: false }).saturationRestart).toBe(false)
    expect(writeContextGuardConfig('b', { saturationRestart: 0 }).saturationRestart).toBe(true)
    expect(writeContextGuardConfig('c', { saturationRestart: null }).saturationRestart).toBe(true)
  })

  it('csak az explicit true kapcsolja be az enabled-t (opt-in)', () => {
    // `o.enabled === true` -- a truthy-de-nem-true ertekek nem engedelyeznek.
    expect(writeContextGuardConfig('a', { enabled: true }).enabled).toBe(true)
    expect(writeContextGuardConfig('b', { enabled: 1 }).enabled).toBe(false)
    expect(writeContextGuardConfig('c', { enabled: 'yes' }).enabled).toBe(false)
  })

  it('a visszaadott config ugyanaz, mint amit a read visszaolvas', () => {
    // Round-trip: write -> read ugyanazt a normalizalt objektumot adja.
    const written = writeContextGuardConfig('main', { enabled: true, actPct: 0.7 })
    expect(readContextGuardConfig('main')).toEqual(written)
    expect(readAllContextGuardConfigs()).toEqual({ main: written })
  })

  it('atomi irast hasznal (a write utan a fajl teljes, nincs .tmp maradek)', () => {
    writeContextGuardConfig('main', { enabled: true })
    const tmpLeftovers = readdirSync(STORE).filter((n: string) => n.endsWith('.tmp'))
    expect(tmpLeftovers).toEqual([])
  })
})
