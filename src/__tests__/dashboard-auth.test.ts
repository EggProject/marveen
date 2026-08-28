// 100% coverage test for src/web/dashboard-auth.ts.
//
// A single bearer token gates every /api/* route. The SUT exposes two
// functions:
//   - loadOrCreateDashboardToken: returns a token from env if set, else
//     reads <PROJECT_ROOT>/store/.dashboard-token; auto-generates and
//     persists (mode 0600) on first run.
//   - checkBearerToken: constant-time bearer comparison via
//     crypto.timingSafeEqual, with a length pre-check to avoid throwing.
//
// Branch inventory that must be covered here:
//   loadOrCreateDashboardToken
//     - DASHBOARD_TOKEN env set, non-empty (with surrounding whitespace) -> return env
//     - DASHBOARD_TOKEN env set, only whitespace -> trim -> empty -> regenerate
//     - DASHBOARD_TOKEN env unset -> regenerate
//     - .dashboard-token file exists with non-empty trimmed content -> return cached
//     - .dashboard-token file exists but is empty after trim -> regenerate
//     - .dashboard-token file does not exist -> regenerate
//     - existsSync throws -> catch -> regenerate
//     - readFileSync throws -> catch -> regenerate
//     - store dir does not exist (parent of file) -> mkdirSync recursive: true
//     - atomicWriteFileSync called with mode 0o600 (chmod is best-effort)
//   checkBearerToken
//     - header undefined -> false
//     - header empty string -> false
//     - header without "Bearer" prefix -> false
//     - header "Bearer" without trailing space -> false (no token captured)
//     - header "Bearer " (no value after space) -> false
//     - header "Bearer x" but expected has different length -> false
//     - header "Bearer x" and expected "x" -> true (timingSafeEqual)
//     - header "Bearer x" and expected "y" (same length) -> false
//     - header with surrounding whitespace around token value -> true (trim)
//
// Sandbox: DASHBOARD_TOKEN_PATH = join(PROJECT_ROOT, 'store', '.dashboard-token')
// (src/web/dashboard-auth.ts:12). PROJECT_ROOT is a module-scope constant
// frozen at SUT import time and is NOT routed through CLAUDECLAW_ENV_DIR
// (that hook is read by env.ts only, see src/env.ts:11). The redirect used
// here is `vi.mock('../config.js', ...)` -- overrides PROJECT_ROOT so the
// joined path lands inside the tmpdir sandbox returned by mkTempStore.
// vitest isolates module registries per test file, so the override cannot
// leak into sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// mkTempStore returns `<tmpdir>/<prefix>.../store`. The SUT's
// DASHBOARD_TOKEN_PATH is `join(PROJECT_ROOT, 'store', '.dashboard-token')`,
// so PROJECT_ROOT must be the PARENT of the temp store dir for the join() to
// land inside our sandbox.
const STORE = mkTempStore('dashboard-auth-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const DASHBOARD_TOKEN_PATH = join(STORE, '.dashboard-token')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST }
})

const { loadOrCreateDashboardToken, checkBearerToken } = await import('../web/dashboard-auth.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle: clean the store dir between cases (and tear it down at
// the end). The .dashboard-token file is removed in beforeEach so every test
// starts from a clean slate; env vars are scrubbed per case to keep the env
// precedence branches independent.
// ---------------------------------------------------------------------------
beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  delete process.env.DASHBOARD_TOKEN
})

afterEach(() => {
  rmTempDir(STORE)
  delete process.env.DASHBOARD_TOKEN
})

// ---------------------------------------------------------------------------
// loadOrCreateDashboardToken -- env-var precedence.
// ---------------------------------------------------------------------------
describe('loadOrCreateDashboardToken (env precedence)', () => {
  it('a DASHBOARD_TOKEN env-t adja vissza, ha be van allitva es nem ures', () => {
    process.env.DASHBOARD_TOKEN = 'env-supplied-token-123'
    const tok = loadOrCreateDashboardToken()
    expect(tok).toBe('env-supplied-token-123')
    // Az env-bol jovo erteket NEM szabad lemezre irni -- az env a forras.
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(false)
  })

  it('a DASHBOARD_TOKEN env erteket trim-eli (kornyezo whitespace eltunik)', () => {
    process.env.DASHBOARD_TOKEN = '   trimmed-token   '
    const tok = loadOrCreateDashboardToken()
    expect(tok).toBe('trimmed-token')
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(false)
  })

  it('a DASHBOARD_TOKEN env-t NEM hasznalja, ha csak whitespace (trim utan ures)', () => {
    process.env.DASHBOARD_TOKEN = '     '
    // A env utan a fajl sem letezik, tehat regenerál: 64 hex char.
    const tok = loadOrCreateDashboardToken()
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    // A friss token a lemezre kerult (a regenerate ag).
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
    expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)
  })

  it('a DASHBOARD_TOKEN env hianyaban a fajlbol olvas vagy regenerál', () => {
    // Az env nincs beallitva; a fajl sem letezik, tehat regenerate.
    const tok = loadOrCreateDashboardToken()
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// loadOrCreateDashboardToken -- file cache.
// ---------------------------------------------------------------------------
describe('loadOrCreateDashboardToken (file cache)', () => {
  it('a letezo fajlbol adja vissza a cachelt tokent (env nelkul)', () => {
    // A SUT sorrendje: env -> fajl -> regenerate. Ha env nincs, a fajl-olvasas
    // jon, es a tartalmat trim-elve visszaadja.
    writeFileSync(DASHBOARD_TOKEN_PATH, 'cached-token-xyz\n')
    const tok = loadOrCreateDashboardToken()
    expect(tok).toBe('cached-token-xyz')
  })

  it('a fajl tartalmat is trim-eli (sorvege whitespace eltunik)', () => {
    writeFileSync(DASHBOARD_TOKEN_PATH, '   cached-with-padding   \n\n')
    const tok = loadOrCreateDashboardToken()
    expect(tok).toBe('cached-with-padding')
  })

  it('a fajlt UJRA_GENERALJA, ha letezik de ures (trim utan is ures)', () => {
    writeFileSync(DASHBOARD_TOKEN_PATH, '   \n\n')
    // A fajl letezik, existsSync true, de a cached "" -- az `if (cached)` ag
    // hamis, tehat a regenerate ag fut le.
    const tok = loadOrCreateDashboardToken()
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    // A friss token felulirja az ures fajlt.
    expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)
  })

  it('a fajlt UJRA_GENERALJA, ha nem letezik', () => {
    // A fajl-t nem hoztuk letre: existsSync false, tehat a regenerate ag.
    const tok = loadOrCreateDashboardToken()
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadOrCreateDashboardToken -- regenerate path (token persistence).
// ---------------------------------------------------------------------------
describe('loadOrCreateDashboardToken (regenerate + persist)', () => {
  it('a frissen generalt token 64 hex karakter (32 byte)', () => {
    const tok = loadOrCreateDashboardToken()
    expect(tok).toHaveLength(64)
    expect(tok).toMatch(/^[0-9a-f]+$/)
  })

  it('a frissen generalt tokent lemezre irja a store/.dashboard-token fajlba', () => {
    const tok = loadOrCreateDashboardToken()
    expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)
  })

  it('a store konyvtarat letrehozza ha meg nem letezik (mkdirSync recursive)', () => {
    // A STORE-t elozolag teljesen toroljuk, hogy biztosan ne legyen store/ se.
    rmSync(STORE, { recursive: true, force: true })
    expect(existsSync(STORE)).toBe(false)
    const tok = loadOrCreateDashboardToken()
    // A mkdirSync { recursive: true } utan a store/ letezik.
    expect(existsSync(STORE)).toBe(true)
    // A token fajl is a helyere kerult.
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
    expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)
  })

  it('a fajlt 0600 mode-ral hozza letre (atomicWriteFileSync mode opcio atadas)', () => {
    // A chmod umask-fuggo lenne, ezert a teszt fixalja az umask-ot, hogy a
    // write utan a mode 0600 legyen megakorodva.
    const previousUmask = process.umask(0o022)
    try {
      loadOrCreateDashboardToken()
    } finally {
      process.umask(previousUmask)
    }
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
    // A chmod a TMP fajlon fut, de a POSIX rename megtartja az inode-ot es
    // a chmod-ot: a cel fajl 0600 marad.
    expect(statSync(DASHBOARD_TOKEN_PATH).mode & 0o777).toBe(0o600)
  })
})

// ---------------------------------------------------------------------------
// loadOrCreateDashboardToken -- catch branch (existsSync / readFileSync throws).
//
// A catch akkor fut le, ha az existsSync VAGY a readFileSync kivetelt dob.
// Kétfeleképpen provokalható:
//   1. existsSync-et egy szandékosan dobo fake-re cseréljuk
//   2. a fajlt 0o000 chmod-dal tesszuk olvashatatlanna (a current user nem
//      tudja olvasni), es readFileSync EACCES-t dob
// A (2) OS-fuggo (a root user minden jogot megkerul), ezert az (1)-et
// hasznaljuk: a node:fs modult egy olyan wrapper-rel cseréljuk, ami a
// existsSync-et egyetlen egy hivasra eldobja.
//
// A vi.hoisted + vi.mock kombinacio az egesz fajlra ervenyes, de a catch
// teszt egyetlen hivasra triggereli a throw-t, a tobbiben visszaall a real
// fs-re. Ehhez a mockState.existsSyncCalls szamlalojat hasznaljuk: az
// ELSO hivas dob, a tobbi mar a real fs-t hasznalja.
// ---------------------------------------------------------------------------
describe('loadOrCreateDashboardToken (catch branch)', () => {
  // Lokalis szamlalo: csak az elso existsSync hivast catch-eljuk.
  let existsSyncCalls: number

  beforeEach(() => {
    existsSyncCalls = 0
  })

  it('ha az existsSync kivetelt dob, a catch ag lefut es a token regenerálódik', async () => {
    // doMock: csak erre a tesztre swap-oljuk a node:fs-t.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        existsSync: (() => {
          existsSyncCalls++
          throw new Error('mock existsSync failure')
        }) as typeof actual.existsSync,
      }
    })
    vi.resetModules()
    const { loadOrCreateDashboardToken: loadWithThrowingExists } = await import('../web/dashboard-auth.js')

    // Env-t toroljuk, hogy a file-cache ag ne legyen rovidebb, mint a catch.
    delete process.env.DASHBOARD_TOKEN
    const tok = loadWithThrowingExists()
    // A catch elkapta, a regenerate lefutott, a token letezo 64-hex string.
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    // Az existsSync-et MEGHIVTA a SUT (kulonben a catch nem futott volna le).
    expect(existsSyncCalls).toBe(1)
    // A lemezen levo fajl a frissen generalt token -- a catch utani write
    // sikeres volt.
    expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
    expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)

    // Mock visszaallitasa, hogy a kovetkezo test ne lasson mock fs-t.
    vi.doUnmock('node:fs')
    vi.resetModules()
    // Az ujraimportalt modul az eredeti config.js mock-ot hasznalja (a
    // top-level vi.mock marad, csak a node:fs unmock-olodott).
    await import('../web/dashboard-auth.js')
  })

  it('ha a readFileSync kivetelt dob (a fajl letezik de olvashatatlan), a catch ag regenerál', async () => {
    // Hozzunk letre egy fajlt, majd chmod-oljuk 0o000-vel, hogy readFileSync
    // EACCES-t dobjon. Ehhez eloszor tenylegesen letezo fajl kell -- az
    // existsSync true-t ad, de a readFileSync kivetelt dob.
    writeFileSync(DASHBOARD_TOKEN_PATH, 'valami')
    chmodSync(DASHBOARD_TOKEN_PATH, 0o000)

    // Ha a teszt root-kent fut, a 0o000 nem blokkolja az olvasast. Ilyenkor
    // a catch-et nem tudjuk ezzel a modszerrel kivaltani; ezt a path-t
    // kihagyjuk es csak akkor probalkozunk, ha az olvasas tenylegesen hibaba
    // utkozik.
    let threw = false
    try {
      readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')
    } catch {
      threw = true
    }

    if (threw) {
      // Valodi olvashatatlansag: a SUT catch-eli a readFileSync hibat.
      delete process.env.DASHBOARD_TOKEN
      const tok = loadOrCreateDashboardToken()
      expect(tok).toMatch(/^[0-9a-f]{64}$/)
      // A friss token felulirja a regit (es a chmod-ot is, mert a write
      // kozben a tmp fajlra chmod-olunk 0o600-at, majd rename).
      expect(existsSync(DASHBOARD_TOKEN_PATH)).toBe(true)
      expect(readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8')).toBe(tok)
    } else {
      // Root-kent futunk: a chmod nem ved. Ezt az esetet nem tudjuk itt
      // triggerelni; a masik catch teszt mar lefedte az existsSync utat.
      expect(threw).toBe(false)
    }

    // Takaritas: allitsuk vissza a jogokat, hogy a kovetkezo test torolni
    // tudja a fajlt.
    try { chmodSync(DASHBOARD_TOKEN_PATH, 0o600) } catch { /* ENOENT */ }
  })
})

// ---------------------------------------------------------------------------
// checkBearerToken -- pure bearer comparison (constant-time, no I/O).
// ---------------------------------------------------------------------------
describe('checkBearerToken (undefined / falsy header)', () => {
  it('undefined header -> false', () => {
    expect(checkBearerToken(undefined, 'whatever')).toBe(false)
  })

  it('ures string header -> false', () => {
    expect(checkBearerToken('', 'whatever')).toBe(false)
  })
})

describe('checkBearerToken (Bearer prefix)', () => {
  it('"Basic xyz" header (nem Bearer) -> false', () => {
    expect(checkBearerToken('Basic xyz', 'xyz')).toBe(false)
  })

  it('"bearer xyz" (kis B) -> false (a regex case-sensitive, csak "Bearer")', () => {
    // A regex /^Bearer\s+(.+)$/ csak a nagy B-s "Bearer"-t fogadja el.
    // A case-sensitivity fontos: ha egy kliens kisbetus "bearer"-t kuldd,
    // a check NEM fogadja el.
    expect(checkBearerToken('bearer xyz', 'xyz')).toBe(false)
  })

  it('"Bearer" szó utan nincs whitespace -> false', () => {
    // A regex \s+ requires at least 1 whitespace.
    expect(checkBearerToken('Bearerxyz', 'xyz')).toBe(false)
  })

  it('"Bearer " utan nincs token (ures value) -> false', () => {
    // A regex `.+` requires at least 1 char a capture groupban. Tehat
    // "Bearer " (Bearer + 1 space, no token) NEM illeszkedik.
    expect(checkBearerToken('Bearer ', 'whatever')).toBe(false)
  })
})

describe('checkBearerToken (value comparison)', () => {
  it('egyezo token -> true (timingSafeEqual)', () => {
    expect(checkBearerToken('Bearer correct-token', 'correct-token')).toBe(true)
  })

  it('a Bearer resz utan whitespace-elheto: "Bearer  correct-token" (tobb space) is true', () => {
    // A regex \s+ egy VAGY tobb whitespace-et fogad el, es a m[1] " correct-token"
    // (leading space), amit a .trim() levag.
    expect(checkBearerToken('Bearer  correct-token', 'correct-token')).toBe(true)
  })

  it('a Bearer resz utan whitespace, es a token korul whitespace: "Bearer  correct-token  " is true', () => {
    // A .trim() a capture groupon is lefut, tehat a koruli szokozok is
    // eltunnek.
    expect(checkBearerToken('Bearer  correct-token  ', 'correct-token')).toBe(true)
  })

  it('kulonbozo token, de azonos hosszusag -> false (timingSafeEqual false)', () => {
    // Mindkettő 6 karakter, tehat a length pre-check átenged, es a
    // timingSafeEqual osszehasonlitja a byte-okat -> false.
    expect(checkBearerToken('Bearer aaaaaa', 'bbbbbb')).toBe(false)
  })

  it('kulonbozo hosszusagu token -> false (length pre-check, timingSafeEqual nem fut le)', () => {
    // A wanted hosszabb, mint a provided. A length check elkapja, es a
    // timingSafeEqual SOHA NEM hivodik meg -- kulonben az kivetelt dobna
    // (crypto.timingSafeEqual kotelezoen egyforma hosszusagu buffereket var).
    expect(checkBearerToken('Bearer abc', 'abcdef')).toBe(false)
  })

  it('a provided rovidebb, mint a wanted -> false', () => {
    expect(checkBearerToken('Bearer abc', 'abcd')).toBe(false)
  })

  it('egyetlen karakteres token-egyezes -> true', () => {
    expect(checkBearerToken('Bearer x', 'x')).toBe(true)
  })

  it('egyetlen karakteres token-eltérés -> false', () => {
    expect(checkBearerToken('Bearer x', 'y')).toBe(false)
  })
})
