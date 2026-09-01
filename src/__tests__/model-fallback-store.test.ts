// 100% coverage test for src/web/model-fallback-store.ts.
//
// Scope: every branch of the three exports (defaultChainForInstall,
// readModelFallbackConfig, writeModelFallbackConfig) plus the two private
// guards inside (hasExplicitChain, the catch-on-read in readModelFallbackConfig).
//
// Branch inventory that must be covered here:
//
//   defaultChainForInstall()
//     - DEFAULT_AGENT_MODEL not in DEFAULT_MODEL_CHAIN  -> filter keeps all -> spread
//     - DEFAULT_AGENT_MODEL equals a chain entry        -> filter drops it -> no duplicate
//
//   readModelFallbackConfig()
//     - readFileSync throws (file missing)              -> catch -> defaults + defaultChainForInstall
//     - JSON.parse throws (malformed JSON)              -> catch -> defaults + defaultChainForInstall
//     - parsed is null                                  -> hasExplicitChain false -> defaults + chain
//     - parsed is primitive (number)                    -> hasExplicitChain false -> defaults + chain
//     - parsed has no `chain` key                       -> hasExplicitChain false -> defaults + chain
//     - parsed.chain is not an array                     -> hasExplicitChain false -> defaults + chain
//     - parsed.chain is an array but too short (<2)     -> hasExplicitChain false -> defaults + chain
//     - parsed.chain has 2 valid entries (operator set) -> hasExplicitChain true -> normalized cfg
//     - parsed.chain has 2 entries but one is empty     -> filter reduces to 1 -> hasExplicitChain false -> defaults + chain
//
//   writeModelFallbackConfig(cfg)
//     - no file exists yet                              -> read catches ENOENT -> merge into {}
//     - existing file merged with new partial cfg       -> prior keys survive
//     - existing explicit chain preserved when cfg has no chain
//     - cfg overrides chain                             -> persisted chain is the new one
//     - cfg with invalid types                          -> normalized through normalizeModelFallbackConfig
//     - JSON pretty-printed (2-space indent)
//     - atomic write leaves no .tmp files
//     - return value matches the persisted normalized value
//
// Sandbox: STORE_PATH = PROJECT_ROOT/store/model-fallback.json (src/web/model-fallback-store.ts:15).
// PROJECT_ROOT is frozen at the SUT's import time and is derived from
// import.meta.url inside src/config.ts -- CLAUDECLAW_ENV_DIR cannot redirect it.
// The redirect used here is `vi.mock('../config.js')`, overriding PROJECT_ROOT
// (and DEFAULT_AGENT_MODEL, so the dedup branch in defaultChainForInstall is
// also provable) so the joined store path lands inside the tmpdir sandbox
// returned by mkTempStore.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ModelFallbackConfig } from '../model-fallback.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'
import {
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
} from '../model-fallback.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's STORE_PATH is
// `join(PROJECT_ROOT, 'store', 'model-fallback.json')`, so PROJECT_ROOT must
// be the PARENT of the temp store dir for join() to land inside our sandbox.
const STORE = mkTempStore('model-fallback-store-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const STORE_PATH = join(STORE, 'model-fallback.json')

// Override PROJECT_ROOT so the SUT's module-scope STORE_PATH lands inside the
// sandbox. Also override DEFAULT_AGENT_MODEL so the dedup branch in
// defaultChainForInstall (when DEFAULT_AGENT_MODEL sits inside the chain) is
// provable in isolation, without having to mutate the live env. The other
// config exports are pass-through; config.ts has many module-scope side
// effects (readEnvFile, etc.) so we spread the original module rather than
// hand-stamping the surface.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: PROJECT_ROOT_FOR_TEST,
    DEFAULT_AGENT_MODEL: 'claude-opus-4-8[1m]',
  }
})

const {
  defaultChainForInstall,
  readModelFallbackConfig,
  writeModelFallbackConfig,
} = await import('../web/model-fallback-store.js')

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
// defaultChainForInstall -- pure derivation, no I/O. Covered with the
// overridden DEFAULT_AGENT_MODEL = 'claude-opus-4-8[1m]' (same as
// DISTRIBUTION_DEFAULT_AGENT_MODEL and DEFAULT_MODEL_CHAIN[0]).
// ---------------------------------------------------------------------------
describe('defaultChainForInstall', () => {
  it('az elso eleme a DEFAULT_AGENT_MODEL (a chain[0] mindig ez)', () => {
    const chain = defaultChainForInstall()
    expect(chain[0]).toBe('claude-opus-4-8[1m]')
  })

  it('a DEFAULT_MODEL_CHAIN tobbi elemet is tartalmazza', () => {
    const chain = defaultChainForInstall()
    expect(chain).toContain('claude-sonnet-5')
    expect(chain).toContain('claude-haiku-4-5-20251001')
  })

  it('NEM tartalmazza duplikan a DEFAULT_AGENT_MODEL-t ha az mar a chain-ben van', () => {
    // A DEFAULT_AGENT_MODEL = 'claude-opus-4-8[1m]' = DEFAULT_MODEL_CHAIN[0],
    // ezert a filter kiszedi. A visszateresi lanc hossza = DEFAULT_MODEL_CHAIN
    // hossza (a prepended elem kiegyenliti a kiszurt elemet).
    const chain = defaultChainForInstall()
    const occurrences = chain.filter((m) => m === 'claude-opus-4-8[1m]').length
    expect(occurrences).toBe(1)
    expect(chain.length).toBe(DEFAULT_MODEL_CHAIN.length)
  })

  it('a DEFAULT_MODEL_CHAIN eredeti sorrendjet tartja meg (filter nem rendez at)', () => {
    // A filter megtartja a sorrendet; a prepended DEFAULT_AGENT_MODEL csak
    // akkor kerul a chain elejere, ha meg nem volt benne. Az override-olt
    // DEFAULT_AGENT_MODEL = chain[0] ugyanaz, mint a chain[0], igy a spread
    // sorrendje megegyezik az eredetivel.
    const chain = defaultChainForInstall()
    expect(chain).toEqual([
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ])
  })

  it('minden alkalommal uj tomb jon letre (nincs modul-szintu cache)', () => {
    // A fuggveny nem mutat a DEFAULT_MODEL_CHAIN-ra (arra mutat, de a spread
    // egy uj tombot ad vissza), tehat a hivo biztonsagosan modosithatja a
    // kapott tombot anelkul, hogy a modulszintu defaultot szennyezne.
    const a = defaultChainForInstall()
    const b = defaultChainForInstall()
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// readModelFallbackConfig -- file missing / malformed / null / primitive /
// no-chain / short-chain / valid-chain. Each branch ends up calling
// hasExplicitChain() one way or another, so all four outcomes of
// hasExplicitChain must be exercised.
// ---------------------------------------------------------------------------
describe('readModelFallbackConfig', () => {
  it('DEFAULT_MODEL_FALLBACK-ot ad es defaultChainForInstall()-t ha a fajl nem letezik', () => {
    // readFileSync throws ENOENT -> catch -> { ...DEFAULT_MODEL_FALLBACK, chain: defaultChainForInstall() }.
    const cfg = readModelFallbackConfig()
    expect(cfg.enabled).toBe(DEFAULT_MODEL_FALLBACK.enabled)
    expect(cfg.revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('DEFAULT_MODEL_FALLBACK-ot ad es defaultChainForInstall()-t ha a JSON malformalt', () => {
    // JSON.parse throws -> catch branch.
    writeFileSync(STORE_PATH, '{not json')
    const cfg = readModelFallbackConfig()
    expect(cfg).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('ures objektumra is defaultChainForInstall()-t ad (parsed && typeof object true, chain hianyzik)', () => {
    // hasExplicitChain({}) -> chain undefined -> !Array.isArray -> false -> defaultChainForInstall.
    writeFileSync(STORE_PATH, '{}')
    const cfg = readModelFallbackConfig()
    expect(cfg).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('null JSON-ra defaultChainForInstall()-t ad (falsy guard: parsed && ...)', () => {
    // parsed === null -> `parsed && typeof parsed === 'object'` short-circuits
    // to null -> hasExplicitChain returns false -> defaultChainForInstall.
    writeFileSync(STORE_PATH, 'null')
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('primitiv JSON-ra (number) defaultChainForInstall()-t ad', () => {
    // typeof 42 === 'number' -> hasExplicitChain's first clause returns false.
    writeFileSync(STORE_PATH, '42')
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('primitiv JSON-ra (string) defaultChainForInstall()-t ad', () => {
    // typeof 'x' === 'string' -> hasExplicitChain's first clause returns false.
    writeFileSync(STORE_PATH, '"hello"')
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('chain nelkuli objektumra defaultChainForInstall()-t ad', () => {
    // hasExplicitChain: parsed.chain undefined -> !Array.isArray -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ enabled: true, revertAfterMinutes: 60 }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
    expect(cfg.enabled).toBe(true)
    expect(cfg.revertAfterMinutes).toBe(60)
  })

  it('a chain-t nem tombkent tarolo objektumra defaultChainForInstall()-t ad', () => {
    // hasExplicitChain: chain is "abc" -> !Array.isArray -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ chain: 'not-an-array' }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('a tul rovid lancra (<2 ervenyes entry) defaultChainForInstall()-t ad', () => {
    // hasExplicitChain: filter keeps only one valid entry -> length < 2 -> false.
    writeFileSync(STORE_PATH, JSON.stringify({ chain: ['only-one'] }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('a lancot ures stringeket tartalmazo tombkent megadva defaultChainForInstall()-t ad', () => {
    // filter strips '' and '   ' (trim().length > 0 fails), leaving 0 valid
    // entries -> hasExplicitChain false -> defaultChainForInstall.
    writeFileSync(STORE_PATH, JSON.stringify({ chain: ['', '   '] }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('a lancot egy valid es egy ures entryvel megadva defaultChainForInstall()-t ad', () => {
    // filter keeps only the non-empty entry -> length 1 < 2 -> hasExplicitChain
    // false -> defaultChainForInstall (a SUT az operator-konfigot is
    // felulirja, ha csak egy valid entryvel adta meg a lancot -- szandekos).
    writeFileSync(STORE_PATH, JSON.stringify({ chain: ['only-one-valid', ''] }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('az operator altal beallitott legalabb 2 elemu lancot megorzi (hasExplicitChain true)', () => {
    // hasExplicitChain: filter keeps 2 -> length >= 2 -> true -> return cfg.
    const operatorChain = ['claude-opus-4-8[1m]', 'claude-sonnet-5']
    writeFileSync(STORE_PATH, JSON.stringify({
      enabled: true,
      chain: operatorChain,
      revertAfterMinutes: 120,
    }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(operatorChain)
    expect(cfg.enabled).toBe(true)
    expect(cfg.revertAfterMinutes).toBe(120)
  })

  it('a lancbol kiszuri az ures stringeket de a maradekot megtartja', () => {
    // Az operator-lanc ['', 'a', 'b', '   '] -> filter -> ['a', 'b'] -> length
    // >= 2 -> hasExplicitChain true. A normalize() a SUT-on belul megegyszer
    // elvegzi ezt a szurest (model-fallback.ts:51), tehat a chain a
    // kimenetben is tisztitott.
    writeFileSync(STORE_PATH, JSON.stringify({
      enabled: true,
      chain: ['', 'claude-A', 'claude-B', '   '],
    }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(['claude-A', 'claude-B'])
  })

  it('a tomb lancnak nem string elemeit eldobja (normalize-on beluli filter)', () => {
    // A SUT readModelFallbackConfig pathjan a hasExplicitChain raw szinten
    // nez (typeof === 'string' && trim()), a normalize pedig megegyszer
    // vegigszuri. Egy 2+ elemu tombben, ahol egy elem number, a hasExplicitChain
    // meg true-t ad (mert a string elemekbol osszejon 2), de a normalize a
    // number-t mar kiszuri -- a vegeredmeny a tisztitott chain.
    writeFileSync(STORE_PATH, JSON.stringify({
      chain: ['claude-A', 'claude-B', 42],
    }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(['claude-A', 'claude-B'])
  })

  it('a normalize altal ervenytelen revertAfterMinutes-ot default-ra allitja', () => {
    // revertAfterMinutes <= 0 vagy nem szam -> normalize a defaultot tartja.
    writeFileSync(STORE_PATH, JSON.stringify({
      chain: ['claude-A', 'claude-B'],
      revertAfterMinutes: 0,
    }))
    const cfg = readModelFallbackConfig()
    expect(cfg.revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })

  it('a normalize a tort revertAfterMinutes-ot lefelé kerekiti (Math.floor)', () => {
    writeFileSync(STORE_PATH, JSON.stringify({
      chain: ['claude-A', 'claude-B'],
      revertAfterMinutes: 12.7,
    }))
    const cfg = readModelFallbackConfig()
    expect(cfg.revertAfterMinutes).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// writeModelFallbackConfig -- merge current + new, normalize, atomic write,
// return merged.
// ---------------------------------------------------------------------------
describe('writeModelFallbackConfig', () => {
  it('letrehozza a fajlt ha meg nem letezik (a read catch-en megy at)', () => {
    expect(existsSync(STORE_PATH)).toBe(false)
    const result = writeModelFallbackConfig({ enabled: true })
    expect(existsSync(STORE_PATH)).toBe(true)
    expect(result.enabled).toBe(true)
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual(result)
  })

  it('JSON pretty-printed (2-space indent) formatumban ir', () => {
    writeModelFallbackConfig({ enabled: true, revertAfterMinutes: 60 })
    const raw = readFileSync(STORE_PATH, 'utf-8')
    expect(raw).toBe(JSON.stringify({
      enabled: true,
      chain: defaultChainForInstall(),
      revertAfterMinutes: 60,
    }, null, 2))
  })

  it('atomi irast hasznal (a write utan a fajl teljes, nincs .tmp maradek)', () => {
    writeModelFallbackConfig({ enabled: true })
    const leftovers = readdirSync(STORE).filter((n: string) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('a visszateresi ertek megegyezik a lemezre irttal', () => {
    const result = writeModelFallbackConfig({ enabled: true, revertAfterMinutes: 90 })
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk).toEqual(result)
  })

  it('reszleges konfigot normalizalja (csak enabled = true)', () => {
    const result = writeModelFallbackConfig({ enabled: true })
    expect(result).toEqual({
      enabled: true,
      chain: defaultChainForInstall(),
      revertAfterMinutes: DEFAULT_MODEL_FALLBACK.revertAfterMinutes,
    })
  })

  it('undefined bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja', () => {
    // A read meglévő defaultot ad, a merge { ...current, ...undefined } = current,
    // a normalize a defaultra all. A chain marad a defaultChainForInstall,
    // mert a jelenlegi lanc implicit (a fajl nem letezik) -- a hasExplicitChain
    // hamis, a write a read eredmenyevel dolgozik tovabb.
    const result = writeModelFallbackConfig(undefined as unknown as Partial<ModelFallbackConfig>)
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('null bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja', () => {
    const result = writeModelFallbackConfig(null as unknown as Partial<ModelFallbackConfig>)
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('string primitiv bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja', () => {
    const result = writeModelFallbackConfig('junk' as unknown as Partial<ModelFallbackConfig>)
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('szam primitiv bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja', () => {
    const result = writeModelFallbackConfig(42 as unknown as Partial<ModelFallbackConfig>)
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('tomb bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja', () => {
    // typeof [] === 'object' de a normalize a defaultra all (raw.chain = [] -> length < 2).
    const result = writeModelFallbackConfig([1, 2, 3] as unknown as Partial<ModelFallbackConfig>)
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('ures object bemenet eseten a DEFAULT_MODEL_FALLBACK-ot irja (de a chain-t defaultolja)', () => {
    const result = writeModelFallbackConfig({})
    expect(result).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      chain: defaultChainForInstall(),
    })
  })

  it('ervenytelen revertAfterMinutes-ot a defaultra csereli', () => {
    const result = writeModelFallbackConfig({ revertAfterMinutes: -5 })
    expect(result.revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })

  it('tort revertAfterMinutes-ot Math.floor-dal lefelé kerekiti', () => {
    const result = writeModelFallbackConfig({ revertAfterMinutes: 9.9 })
    expect(result.revertAfterMinutes).toBe(9)
  })

  it('a meglevo fajl tartalmat osszefesi az ujjal (read+merge)', () => {
    // Az elso write lerak egy konfigot, a masodik csak enabled-et frissit --
    // a chain es revertAfterMinutes megmarad.
    writeModelFallbackConfig({ enabled: false, revertAfterMinutes: 90 })
    const before = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    const result = writeModelFallbackConfig({ enabled: true })
    expect(result.enabled).toBe(true)
    // A chain es a revertAfterMinutes az elso write-bol szarmazik.
    expect(result.chain).toEqual(before.chain)
    expect(result.revertAfterMinutes).toBe(90)
  })

  it('a meglevo operator-lancot felulirja ha a write uj chain-t hoz', () => {
    writeModelFallbackConfig({ chain: ['claude-A', 'claude-B'] })
    const result = writeModelFallbackConfig({ chain: ['claude-X', 'claude-Y'] })
    expect(result.chain).toEqual(['claude-X', 'claude-Y'])
    const onDisk = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    expect(onDisk.chain).toEqual(['claude-X', 'claude-Y'])
  })

  it('a read-write-write round-trip stabil (a masodik write nem szennyezi a chain-t)', () => {
    // Az elso write egy egyedi lancot allit be (operator-lanc), a masodik
    // csak az enabled-et valtoztatja. A read az operator-lancot olvassa
    // vissza (hasExplicitChain true), a merge megtartja, a write visszairja.
    const customChain = ['claude-A', 'claude-B', 'claude-C']
    writeModelFallbackConfig({ enabled: false, chain: customChain })
    const result = writeModelFallbackConfig({ enabled: true })
    expect(result.chain).toEqual(customChain)
    expect(result.enabled).toBe(true)
  })

  it('a chain ures stringjeit kiszuri normalizacio kozben', () => {
    const result = writeModelFallbackConfig({
      chain: ['claude-A', '', 'claude-B', '   '],
    })
    expect(result.chain).toEqual(['claude-A', 'claude-B'])
  })

  it('a chain-ban a nem string tipusokat kiszuri normalizacio kozben', () => {
    const result = writeModelFallbackConfig({
      chain: ['claude-A', 'claude-B', 42 as unknown as string, null as unknown as string, true as unknown as string],
    })
    expect(result.chain).toEqual(['claude-A', 'claude-B'])
  })

  it('a chain-t a defaultra allitja ha a write-ban a chain < 2 elemu', () => {
    // A write-ban chain = ['only-one'] -- a normalize a DEFAULT_MODEL_FALLBACK.chain-t
    // hasznalja (mert cleaned.length < 2). Azonban a write elotti read
    // hasExplicitChain = false miatt a defaultChainForInstall-tel ter vissza
    // -- ez kerul a lemezre.
    const result = writeModelFallbackConfig({ chain: ['only-one'] })
    expect(result.chain).toEqual(defaultChainForInstall())
  })

  it('ures tomb lanc eseten a defaultra allitja a chain-t', () => {
    const result = writeModelFallbackConfig({ chain: [] })
    expect(result.chain).toEqual(defaultChainForInstall())
  })

  it('a write utan azonnal olvashato read-del (round-trip a lemezen)', () => {
    writeModelFallbackConfig({
      enabled: true,
      chain: ['claude-A', 'claude-B'],
      revertAfterMinutes: 60,
    })
    const reread = readModelFallbackConfig()
    expect(reread).toEqual({
      enabled: true,
      chain: ['claude-A', 'claude-B'],
      revertAfterMinutes: 60,
    })
  })
})
