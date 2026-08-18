// 100% coverage test for src/web/openrouter-models.ts.
//
// Scope: every branch of the five exports (loadOpenRouterCatalog,
// fetchAllOpenRouterModels, loadCuratedManual, addCuratedManual,
// removeCuratedManual, resolveOpenRouterModel) plus the two module-scope
// constants they depend on (AUTO_PREFIX, OPENROUTER_MODELS_FILE,
// OPENROUTER_MANUAL_FILE).
//
// Branch inventory that must be covered here:
//
//   loadOpenRouterCatalog()
//     - file missing                                  -> DEFAULT_CATALOG
//     - JSON.parse throws (malformed)                 -> catch -> DEFAULT_CATALOG
//     - parsed === null                               -> falsy guard -> DEFAULT_CATALOG
//     - parsed is primitive (number)                  -> DEFAULT_CATALOG
//     - parsed.tiers not array                        -> DEFAULT_CATALOG
//     - parsed.tiers empty array                      -> length > 0 false -> DEFAULT_CATALOG
//     - valid catalog (tiers present)                 -> return parsed
//
//   fetchAllOpenRouterModels(nowMs)
//     - HTTP !ok                                      -> throw
//     - HTTP ok, data field missing                   -> []
//     - m.id missing                                  -> filtered out
//     - m.name missing                                -> falls back to m.id
//     - pricing.prompt/completion missing             -> free = true
//     - pricing.prompt/completion non-numeric         -> NaN -> 0 via isFinite guard
//     - pricing prompt only (free=false)              -> not free
//     - context_length missing                        -> 0
//     - alphabetical sort by id
//     - cache hit (nowMs - at < TTL)                  -> return cache, no fetch
//     - cache miss after TTL                          -> fetch again
//
//   loadCuratedManual()
//     - file missing                                  -> []
//     - JSON.parse throws (malformed)                 -> catch -> []
//     - parsed === null                               -> falsy guard -> []
//     - parsed.models not array                       -> []
//     - parsed.models array with valid entries        -> return filtered
//     - parsed.models array with non-string id entries-> filtered out
//
//   addCuratedManual(id, name)
//     - empty list                                    -> push, sort, save
//     - id already present                            -> no-op (no save)
//     - empty name                                    -> falls back to id
//     - multiple adds preserve alphabetical order     -> sort, save
//
//   removeCuratedManual(id)
//     - id present                                    -> filter, save
//     - id absent                                     -> no-op (no save)
//     - empty list                                    -> no-op
//
//   resolveOpenRouterModel(model)
//     - non-AUTO_PREFIX model                              -> return unchanged
//     - AUTO_PREFIX, valid tierKey                         -> return tier.auto
//     - AUTO_PREFIX, invalid tierKey, tier1 present        -> tier1.auto (warn)
//     - AUTO_PREFIX, invalid tierKey, tier1 absent         -> hardcoded fallback (warn)
//     - AUTO_PREFIX, valid tierKey, but tier.auto empty    -> warn + tier1.auto
//     - AUTO_PREFIX, invalid tierKey, tier1.auto=''        -> hardcoded fallback (warn)
//     - AUTO_PREFIX, valid tierKey, tier.auto='' AND tier1.auto='' -> hardcoded fallback (warn)
//
// Sandbox: OPENROUTER_MODELS_FILE = STORE_DIR/openrouter-models.json
// (src/web/openrouter-models.ts:26) and OPENROUTER_MANUAL_FILE = STORE_DIR
// /openrouter-manual.json (line 31). STORE_DIR = join(PROJECT_ROOT, 'store')
// in src/config.ts:13. The SUT imports `STORE_DIR` (already computed at
// config.ts load time), so the mock has to override STORE_DIR directly --
// overriding PROJECT_ROOT alone would leave STORE_DIR pointing at the live
// install dir. vitest isolates module registries per test file, so the
// override cannot leak into sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT joins
// STORE_DIR + 'openrouter-models.json' / 'openrouter-manual.json'. STORE_DIR
// = join(PROJECT_ROOT, 'store') in config.ts, so the temp store IS the value
// STORE_DIR must take.
const STORE = mkTempStore('openrouter-models-')
const MODELS_FILE = join(STORE, 'openrouter-models.json')
const MANUAL_FILE = join(STORE, 'openrouter-manual.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: STORE, PROJECT_ROOT: dirname(STORE) }
})

const {
  AUTO_PREFIX,
  OPENROUTER_MODELS_FILE,
  OPENROUTER_MANUAL_FILE,
  loadOpenRouterCatalog,
  fetchAllOpenRouterModels,
  loadCuratedManual,
  addCuratedManual,
  removeCuratedManual,
  resolveOpenRouterModel,
} = await import('../web/openrouter-models.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle: clean store files between cases; tear the whole dir down
// after each case. rmTempDir is force:true and swallows ENOENT so double-
// cleanup is safe. vi.unstubAllGlobals restores any global we stubbed via
// vi.stubGlobal (fetch, etc.) for the fetch test block.
// ---------------------------------------------------------------------------
beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  for (const f of [MODELS_FILE, MANUAL_FILE]) {
    if (existsSync(f)) rmSync(f)
  }
})

afterEach(() => {
  rmTempDir(STORE)
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Module-scope constants: prove the SUT reads STORE_DIR from the mocked
// config and the two file names are joined correctly. The names themselves
// are documented in the header so this is also a sanity guard against an
// upstream rename.
// ---------------------------------------------------------------------------
describe('module-scope constants', () => {
  it('AUTO_PREFIX = "openrouter-auto:"', () => {
    expect(AUTO_PREFIX).toBe('openrouter-auto:')
  })

  it('OPENROUTER_MODELS_FILE a STORE_DIR alatti openrouter-models.json', () => {
    expect(OPENROUTER_MODELS_FILE).toBe(MODELS_FILE)
  })

  it('OPENROUTER_MANUAL_FILE a STORE_DIR alatti openrouter-manual.json', () => {
    expect(OPENROUTER_MANUAL_FILE).toBe(MANUAL_FILE)
  })
})

// ---------------------------------------------------------------------------
// loadOpenRouterCatalog -- file missing / malformed / null / primitive /
// empty-tiers / valid.
// ---------------------------------------------------------------------------
describe('loadOpenRouterCatalog', () => {
  it('DEFAULT_CATALOG-ot ad ha a fajl meg nem letezik', () => {
    // existsSync false -> skip the read entirely -> DEFAULT_CATALOG.
    expect(existsSync(MODELS_FILE)).toBe(false)
    const cat = loadOpenRouterCatalog()
    expect(cat.updated).toMatch(/default/)
    expect(cat.tiers.length).toBe(5)
    expect(cat.tiers.map((t) => t.key)).toEqual(['tier0', 'tier1', 'tier2', 'tier3', 'tier4'])
  })

  it('DEFAULT_CATALOG-ot ad es figyelmeztet ha a JSON malformalt', () => {
    // JSON.parse throws -> catch -> DEFAULT_CATALOG.
    writeFileSync(MODELS_FILE, '{not json')
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('DEFAULT_CATALOG-ot ad ha a JSON null (falsy guard: parsed && ...)', () => {
    // parsed === null -> `(parsed && Array.isArray(...))` short-circuits to null
    // -> DEFAULT_CATALOG.
    writeFileSync(MODELS_FILE, 'null')
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('DEFAULT_CATALOG-ot ad ha a JSON primitiv (number)', () => {
    // parsed is a primitive -> `(parsed && Array.isArray(...))` short-circuits
    // -> DEFAULT_CATALOG.
    writeFileSync(MODELS_FILE, '42')
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('DEFAULT_CATALOG-ot ad ha a JSON primitiv (string)', () => {
    writeFileSync(MODELS_FILE, '"hello"')
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('DEFAULT_CATALOG-ot ad ha a tiers nem tomb', () => {
    // Array.isArray('xxx') false -> DEFAULT_CATALOG.
    writeFileSync(MODELS_FILE, JSON.stringify({ tiers: 'not-an-array' }))
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('DEFAULT_CATALOG-ot ad ha a tiers ures tomb (length > 0 feltetel hamis)', () => {
    // parsed.tiers = [] -> length > 0 false -> DEFAULT_CATALOG.
    writeFileSync(MODELS_FILE, JSON.stringify({ updated: 'x', tiers: [] }))
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
  })

  it('visszaadja a lemezen levo katalogust ha ervenyes', () => {
    const onDisk = {
      updated: '2026-08-01',
      tiers: [
        { key: 'tier1', label: 'Custom 1', auto: 'foo/bar-1', manual: ['foo/bar-1', 'baz/qux-1'] },
        { key: 'tier2', label: 'Custom 2', auto: 'foo/bar-2', manual: ['foo/bar-2', 'baz/qux-2'] },
      ],
    }
    writeFileSync(MODELS_FILE, JSON.stringify(onDisk))
    const cat = loadOpenRouterCatalog()
    expect(cat.updated).toBe('2026-08-01')
    expect(cat.tiers.length).toBe(2)
    expect(cat.tiers[0].auto).toBe('foo/bar-1')
  })

  it('a read kivetelt dob a fajl olvasasakor -- catch elfogja, DEFAULT_CATALOG jon', () => {
    // readFileSync kivetelt dob: a fajl konyvtarat toroljuk, igy a read
    // ENOENT-et kap. A try/catch catch-re fut, DEFAULT_CATALOG jon vissza.
    rmSync(STORE, { recursive: true, force: true })
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBe(5)
    mkdirSync(STORE, { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// fetchAllOpenRouterModels -- cache + body shape + sort.
//
// The SUT keeps a module-scope cache (allModelsCache) with a 6h TTL. To keep
// each fetch test independent of the others we use strictly-increasing
// timestamps that are each >TTL past the previous test's write -- so every
// test starts with a cache miss. Inside one test, multiple calls share the
// cache and exercise the hit path.
// ---------------------------------------------------------------------------
describe('fetchAllOpenRouterModels', () => {
  const TTL = 6 * 60 * 60 * 1000
  // Egymast követő timestampek: mindegyik TTL+1 tavolsagra az elozo fajta
  // mockolas-vege-tol (vagy az előző teszt legutolso cache-iro irasatol), igy
  // minden teszt cache miss-sel indul.
  let baseTime = 0

  function nextT(): number {
    baseTime += TTL + 1
    return baseTime
  }

  function makeJsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('HTTP !ok eseten kivetelt dob a statusz kodot tartalmazva', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(500, { error: 'server' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchAllOpenRouterModels(nextT())).rejects.toThrow(/HTTP 500/)
  })

  it('ures tombot ad ha a data mezo hianyzik (data ?? [] fallback)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models).toEqual([])
  })

  it('a modellek id-jét, nevet, context_length-jet, promptPrice-jet es completionPrice-jet helyesen dolgozza fel', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [
        {
          id: 'foo/bar',
          name: 'Foo Bar',
          context_length: 8192,
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'foo/bar',
      name: 'Foo Bar',
      contextLength: 8192,
      promptPrice: 1,    // 0.000001 * 1e6
      completionPrice: 2, // 0.000002 * 1e6
      free: false,
    })
  })

  it('a modelt kidobja ha nincs id (filter m => m.id)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [
        { name: 'No-Id Model', context_length: 4096 }, // no id
        { id: 'foo/bar', name: 'Foo Bar', context_length: 4096 },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models.map((m) => m.id)).toEqual(['foo/bar'])
  })

  it('a name hianyaban az id-t hasznalja (m.name ?? m.id)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [{ id: 'foo/bar', context_length: 4096 }], // no name
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models[0].name).toBe('foo/bar')
  })

  it('a name es id is hianyzik -- a map lefut, mindket ag ures-re fut (name ?? m.id ?? "" utolso ag)', async () => {
    // A filter utan ez a bejegyzés kiesik, de a .map callback lefut, es a
    // `m.name ?? m.id ?? ''` harmadik agat is ki kell hasznalni a 100%
    // branch coverage-höz. Egy masik ervenyes bejegyzessel egyutt kuldjuk,
    // hogy az eredmeny ne legyen ures, de a map-en belul lefusson a kodag.
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [
        { id: 'foo/bar', name: 'Foo Bar' },                 // normal
        { id: 'baz/qux', context_length: 4096 },            // csak id, name hianyzik
        { context_length: 2048 },                            // mindketto hianyzik (filter utan kiesik)
        { id: '', name: '' },                                // mindketto ures string (filter utan kiesik)
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    // A ket normal bejegyzés marad (foo/bar, baz/qux); a masik ketto kiesik
    // a `filter(m => m.id)` miatt.
    expect(models.map((m) => m.id).sort()).toEqual(['baz/qux', 'foo/bar'])
    expect(models.find((m) => m.id === 'baz/qux')?.name).toBe('baz/qux') // m.name ?? m.id
  })

  it('a pricing.prompt es pricing.completion hianyaban free=true (mindkettő 0)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [{ id: 'foo/bar', name: 'Free Foo', context_length: 4096 }], // no pricing
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models[0].free).toBe(true)
    expect(models[0].promptPrice).toBe(0)
    expect(models[0].completionPrice).toBe(0)
  })

  it('a pricing.prompt nem szam ertek eseten Number.isFinite hamis -> 0 lesz', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [{
        id: 'foo/bar',
        name: 'NaN Foo',
        context_length: 4096,
        pricing: { prompt: 'not-a-number', completion: '0.000001' },
      }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models[0].promptPrice).toBe(0)
    expect(models[0].completionPrice).toBe(1)
    // prompt === 0 && completion !== 0 -> free === false
    expect(models[0].free).toBe(false)
  })

  it('a pricing.completion nem szam ertek eseten Number.isFinite hamis -> 0 lesz', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [{
        id: 'foo/bar',
        name: 'NaN Foo 2',
        context_length: 4096,
        pricing: { prompt: '0.000001', completion: 'also-bad' },
      }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models[0].promptPrice).toBe(1)
    expect(models[0].completionPrice).toBe(0)
    expect(models[0].free).toBe(false)
  })

  it('a context_length hianyaban 0 lesz (m.context_length ?? 0)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [{ id: 'foo/bar', name: 'No Ctx' }], // no context_length
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models[0].contextLength).toBe(0)
  })

  it('a modellek id szerint novekvo sorrendbe rendezve jelennek meg (localeCompare)', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, {
      data: [
        { id: 'zeta/zzz', name: 'Z' },
        { id: 'alpha/aaa', name: 'A' },
        { id: 'mid/mmm', name: 'M' },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await fetchAllOpenRouterModels(nextT())
    expect(models.map((m) => m.id)).toEqual(['alpha/aaa', 'mid/mmm', 'zeta/zzz'])
  })

  it('a masodik hivas TTL-en belul a cache-bol ad vissza, fetch-et nem hiv', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return makeJsonResponse(200, { data: [{ id: 'foo/bar', name: 'Foo' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const t = nextT()
    const first = await fetchAllOpenRouterModels(t)
    expect(calls).toBe(1)
    // Most egy más mock-ot adunk vissza -- ha a cache-rol olvas, ezt soha
    // nem lâtjuk, és az eredmény még mindig az első hívás eredménye.
    vi.stubGlobal('fetch', vi.fn(async () => makeJsonResponse(200, {
      data: [{ id: 'different/model', name: 'Different' }],
    })))
    const second = await fetchAllOpenRouterModels(t + 1) // 1ms mulva, TTL-en belul
    expect(calls).toBe(1)
    expect(second).toEqual(first)
  })

  it('TTL lejarasa utan ujra fetch-el (cache miss)', async () => {
    let calls = 0
    let body: unknown = { data: [{ id: 'foo/bar', name: 'Foo' }] }
    const fetchMock = vi.fn(async () => {
      calls++
      return makeJsonResponse(200, body)
    })
    vi.stubGlobal('fetch', fetchMock)
    const t = nextT()
    await fetchAllOpenRouterModels(t)
    expect(calls).toBe(1)
    // TTL + 1ms mulva: a kulonbseg >= TTL, tehat cache miss, uj fetch.
    body = { data: [{ id: 'baz/qux', name: 'Baz' }] }
    await fetchAllOpenRouterModels(t + TTL + 1)
    expect(calls).toBe(2)
    const models = await fetchAllOpenRouterModels(t + TTL + 2)
    expect(models.map((m) => m.id)).toEqual(['baz/qux'])
  })
})

// ---------------------------------------------------------------------------
// loadCuratedManual -- file missing / malformed / null / no-models / valid /
// non-string id filter.
// ---------------------------------------------------------------------------
describe('loadCuratedManual', () => {
  it('ures tombot ad ha a fajl meg nem letezik', () => {
    expect(existsSync(MANUAL_FILE)).toBe(false)
    expect(loadCuratedManual()).toEqual([])
  })

  it('ures tombot ad es figyelmeztet ha a JSON malformalt', () => {
    writeFileSync(MANUAL_FILE, '{not json')
    expect(loadCuratedManual()).toEqual([])
  })

  it('ures tombot ad ha a JSON null (parsed && Array.isArray hamis)', () => {
    writeFileSync(MANUAL_FILE, 'null')
    expect(loadCuratedManual()).toEqual([])
  })

  it('ures tombot ad ha a JSON primitiv (number)', () => {
    writeFileSync(MANUAL_FILE, '42')
    expect(loadCuratedManual()).toEqual([])
  })

  it('ures tombot ad ha a models mezo nem tomb', () => {
    writeFileSync(MANUAL_FILE, JSON.stringify({ models: 'not-an-array' }))
    expect(loadCuratedManual()).toEqual([])
  })

  it('visszaadja az ervenyes modelleket ha a models tomb jo', () => {
    writeFileSync(MANUAL_FILE, JSON.stringify({
      models: [
        { id: 'a/a', name: 'A' },
        { id: 'b/b', name: 'B' },
      ],
    }))
    expect(loadCuratedManual()).toEqual([
      { id: 'a/a', name: 'A' },
      { id: 'b/b', name: 'B' },
    ])
  })

  it('a nem string id-ju bejegyzeseket kiszuri (filter m.id typeof string)', () => {
    writeFileSync(MANUAL_FILE, JSON.stringify({
      models: [
        { id: 'a/a', name: 'A' },
        { id: 42, name: 'Numeric' },
        { id: null, name: 'Null id' },
        { name: 'No id' }, // nincs id mezo egyaltalan
        { id: 'b/b', name: 'B' },
      ],
    }))
    expect(loadCuratedManual()).toEqual([
      { id: 'a/a', name: 'A' },
      { id: 'b/b', name: 'B' },
    ])
  })

  it('az ures string id-ju bejegyzeseket is kiszuri (typeof string de truthy hamis)', () => {
    writeFileSync(MANUAL_FILE, JSON.stringify({
      models: [
        { id: '', name: 'Empty' },
        { id: 'a/a', name: 'A' },
      ],
    }))
    expect(loadCuratedManual()).toEqual([
      { id: 'a/a', name: 'A' },
    ])
  })

  it('a read kivetelt dob a fajl olvasasakor -- catch elfogja, [] jon', () => {
    // readFileSync kivetelt dob: a konyvtarat toroljuk, ENOENT jon.
    rmSync(STORE, { recursive: true, force: true })
    expect(loadCuratedManual()).toEqual([])
    mkdirSync(STORE, { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// addCuratedManual -- empty list / duplicate (no-op) / empty-name fallback /
// sort + persist / multiple-add round trip.
// ---------------------------------------------------------------------------
describe('addCuratedManual', () => {
  it('ures listaba az elsot beszurja es elmenti', () => {
    const list = addCuratedManual('foo/bar', 'Foo Bar')
    expect(list).toEqual([{ id: 'foo/bar', name: 'Foo Bar' }])
    expect(existsSync(MANUAL_FILE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(MANUAL_FILE, 'utf-8'))
    expect(onDisk).toEqual({ models: [{ id: 'foo/bar', name: 'Foo Bar' }] })
  })

  it('duplikatum eseten nem ir ujra (no-op, de a listat visszaadja)', () => {
    addCuratedManual('foo/bar', 'Foo Bar')
    const sizeBefore = readFileSync(MANUAL_FILE).length
    const list = addCuratedManual('foo/bar', 'Foo Bar Different')
    expect(list).toEqual([{ id: 'foo/bar', name: 'Foo Bar' }]) // regi nev maradt
    // Nem irt ujra: a fajl merete es tartalma azonos.
    const sizeAfter = readFileSync(MANUAL_FILE).length
    expect(sizeAfter).toBe(sizeBefore)
  })

  it('ures name eseten az id-t hasznalja name-kent (name || id)', () => {
    const list = addCuratedManual('foo/bar', '')
    expect(list).toEqual([{ id: 'foo/bar', name: 'foo/bar' }])
  })

  it('tobb hozzaadas utan a lista id szerint rendezve van (sort)', () => {
    addCuratedManual('zeta/zzz', 'Z')
    addCuratedManual('alpha/aaa', 'A')
    addCuratedManual('mid/mmm', 'M')
    const list = addCuratedManual('beta/bbb', 'B')
    expect(list.map((m) => m.id)).toEqual(['alpha/aaa', 'beta/bbb', 'mid/mmm', 'zeta/zzz'])
    const onDisk = JSON.parse(readFileSync(MANUAL_FILE, 'utf-8'))
    expect(onDisk.models.map((m: { id: string }) => m.id)).toEqual(['alpha/aaa', 'beta/bbb', 'mid/mmm', 'zeta/zzz'])
  })

  it('a persistence JSON pretty-printed (2-space indent)', () => {
    addCuratedManual('foo/bar', 'Foo Bar')
    const raw = readFileSync(MANUAL_FILE, 'utf-8')
    expect(raw).toBe(JSON.stringify({ models: [{ id: 'foo/bar', name: 'Foo Bar' }] }, null, 2))
  })
})

// ---------------------------------------------------------------------------
// removeCuratedManual -- present / absent / empty list.
// ---------------------------------------------------------------------------
describe('removeCuratedManual', () => {
  it('a jelenlevo elemet kiszuri es elmenti az uj listat', () => {
    addCuratedManual('a/a', 'A')
    addCuratedManual('b/b', 'B')
    const list = removeCuratedManual('a/a')
    expect(list).toEqual([{ id: 'b/b', name: 'B' }])
    const onDisk = JSON.parse(readFileSync(MANUAL_FILE, 'utf-8'))
    expect(onDisk.models).toEqual([{ id: 'b/b', name: 'B' }])
  })

  it('a hianyzo elemre no-op (a fajlt nem irja ujra)', () => {
    addCuratedManual('a/a', 'A')
    const sizeBefore = readFileSync(MANUAL_FILE).length
    const list = removeCuratedManual('z/z')
    expect(list).toEqual([{ id: 'a/a', name: 'A' }])
    const sizeAfter = readFileSync(MANUAL_FILE).length
    expect(sizeAfter).toBe(sizeBefore)
  })

  it('ures listabol is no-op (next.length === list.length feltetel)', () => {
    expect(existsSync(MANUAL_FILE)).toBe(false)
    const list = removeCuratedManual('a/a')
    expect(list).toEqual([])
    expect(existsSync(MANUAL_FILE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveOpenRouterModel -- non-AUTO / valid tier / invalid tier (fallback to
// tier1) / invalid tier without tier1 (hardcoded) / tier with empty auto.
// ---------------------------------------------------------------------------
describe('resolveOpenRouterModel', () => {
  it('nem AUTO_PREFIX modellt valtoztatas nelkul ad vissza', () => {
    expect(resolveOpenRouterModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]')
    expect(resolveOpenRouterModel('foo/bar')).toBe('foo/bar')
    expect(resolveOpenRouterModel('')).toBe('')
  })

  it('ervenyes AUTO_PREFIX tierKey-et a tier auto model-jere old', () => {
    // A DEFAULT_CATALOG tier2.auto = 'qwen/qwen3-coder'.
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}tier2`)).toBe('qwen/qwen3-coder')
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}tier3`)).toBe('anthropic/claude-sonnet-5')
  })

  it('ervenytelen tierKey eseten a tier1.auto-hoz fall-back-el (warn)', () => {
    // DEFAULT_CATALOG tier1.auto = 'deepseek/deepseek-chat-v3.1'.
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}does-not-exist`)).toBe('deepseek/deepseek-chat-v3.1')
  })

  it('ervenytelen tierKey es ures tierKey egyarant a warn-agon keresztul megy', () => {
    // Az ures tierKey utan a tiers.find nem talál egyezest -> warn + fallback.
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}`)).toBe('deepseek/deepseek-chat-v3.1')
  })

  it('a tier megtalalhato de tier.auto ures -- warn + tier1.auto fallback', () => {
    // Egyedi katalog: tier1.auto = 'one/one', tier2.auto = '' (falsy).
    writeFileSync(MODELS_FILE, JSON.stringify({
      updated: 'test',
      tiers: [
        { key: 'tier1', label: 't1', auto: 'one/one', manual: ['one/one', 'one/two'] },
        { key: 'tier2', label: 't2', auto: '', manual: ['two/one', 'two/two'] },
      ],
    }))
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}tier2`)).toBe('one/one')
  })

  it('ervenytelen tierKey es nincs tier1 -- a hardcoded "deepseek/deepseek-chat-v3.1" fallback jon', () => {
    // Egyedi katalog: nincs tier1.
    writeFileSync(MODELS_FILE, JSON.stringify({
      updated: 'test',
      tiers: [
        { key: 'tierX', label: 'x', auto: 'x/x', manual: ['x/a', 'x/b'] },
      ],
    }))
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}does-not-exist`)).toBe('deepseek/deepseek-chat-v3.1')
  })

  it('ervenytelen tierKey es ures tier1.auto -- hardcoded deepseek defaultra esik vissza', () => {
    writeFileSync(MODELS_FILE, JSON.stringify({
      updated: 'test',
      tiers: [
        { key: 'tier1', label: 't1', auto: '', manual: ['a', 'b'] },
      ],
    }))
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}does-not-exist`)).toBe('deepseek/deepseek-chat-v3.1')
  })

  it('ervenyes tierKey + ures tier.auto + ures tier1.auto -- || a hardcoded fallbackra old', () => {
    // Ez a `??` -> `||` valtozas egyetlen olyan bemenete, ahol a ket operator
    // kulonbozik: ervenyes tierKey, mind a keresett tier.auto, mind a
    // tier1.auto ures. Korabban `??`-szel ez a kod a `''`-t adta volna vissza.
    // A regresszio elleni pin (2026-08-18, 63d62da).
    writeFileSync(MODELS_FILE, JSON.stringify({
      updated: 'test',
      tiers: [
        { key: 'tier1', label: 't1', auto: '', manual: ['a', 'b'] },
        { key: 'tier2', label: 't2', auto: '', manual: ['c', 'd'] },
      ],
    }))
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}tier2`)).toBe('deepseek/deepseek-chat-v3.1')
  })
})
