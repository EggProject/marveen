import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

// ENFORCED sandbox. The previous version of this file wrote fixtures into --
// and unlink'd -- the LIVE repo-root .env (snapshot/restore around each test),
// which in a production checkout recreated the real secrets file with default
// 0644 permissions (2026-07-27 incident). env.ts resolves its own PROJECT_ROOT
// (it cannot import config.js -- circular), so the redirect is the
// CLAUDECLAW_ENV_DIR hook read at module import; set it BEFORE the dynamic
// import below. vitest isolates module registries per test file, so the hook
// cannot leak into other suites.
const SANDBOX = mkdtempSync(join(tmpdir(), 'env-test-'))
const testEnvPath = join(SANDBOX, '.env')

beforeAll(() => {
  process.env.CLAUDECLAW_ENV_DIR = SANDBOX
})

afterAll(() => {
  delete process.env.CLAUDECLAW_ENV_DIR
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('readEnvFile', () => {
  it('ures objektumot ad vissza ha nincs .env', async () => {
    try { unlinkSync(testEnvPath) } catch { /* absent */ }
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result).toEqual({})
  })

  it('kulcs-ertek parokat parszol', async () => {
    writeFileSync(testEnvPath, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBe('qux')
  })

  it('idezojeleket kezel', async () => {
    writeFileSync(testEnvPath, 'KEY="value with spaces"\nKEY2=\'single\'\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('value with spaces')
    expect(result['KEY2']).toBe('single')
  })

  it('kommenteket atugorja', async () => {
    writeFileSync(testEnvPath, '# komment\nKEY=val\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('val')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('szurt kulcsokat ad vissza ha megadva', async () => {
    writeFileSync(testEnvPath, 'A=1\nB=2\nC=3\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile(['A', 'C'])
    expect(result['A']).toBe('1')
    expect(result['C']).toBe('3')
    expect(result['B']).toBeUndefined()
  })

  it('atugorja az `=` nelkuli sorokat es az ureseket', async () => {
    writeFileSync(testEnvPath, 'NOEQUALSHERE\n\n   \nKEY=val\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result).toEqual({ KEY: 'val' })
  })

  it('a felig idezojelezett erteket valtozatlanul hagyja', async () => {
    // Csak akkor strippel, ha az ELSO es az UTOLSO karakter is ugyanaz az
    // idezojel; a le nem zart parok mindket aganak false-t kell adnia.
    writeFileSync(testEnvPath, 'D="unclosed\nS=\'unclosed\nM="mixed\'\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['D']).toBe('"unclosed')
    expect(result['S']).toBe("'unclosed")
    expect(result['M']).toBe('"mixed\'')
  })
})

// updateEnvFile a .env-t a lemezen irja, ezert minden eset SAJAT temp dirt kap,
// amit az afterEach rmSync-el. env.ts a PROJECT_ROOT-ot IMPORT idoben olvassa
// ki (src/env.ts:11), igy a friss dir csak `vi.resetModules()` + ujra-import
// utan lep eletbe -- ezert megy a CLAUDECLAW_ENV_DIR beallitasa az import ELE.
describe('updateEnvFile', () => {
  const tempDirs: string[] = []
  let envSnapshot: { restore: () => void }

  beforeAll(() => {
    // A snapshot a beforeAll UTAN keszul, amikor a CLAUDECLAW_ENV_DIR mar a
    // fenti SANDBOX-ra mutat -- igy a restore() nem huzza ki a talajt a
    // fajlban korabban futo readEnvFile blokk alol.
    envSnapshot = snapshotEnv()
  })

  afterEach(() => {
    for (const dir of tempDirs) rmTempDir(dir)
    tempDirs.length = 0
    envSnapshot.restore()
    vi.resetModules()
  })

  async function loadEnv(seed?: string): Promise<{
    envPath: string
    readEnvFile: (keys?: string[]) => Record<string, string>
    updateEnvFile: (updates: Record<string, string>) => void
  }> {
    const dir = mkTempDir('env-update-')
    tempDirs.push(dir)
    const envPath = join(dir, '.env')
    if (seed !== undefined) writeFileSync(envPath, seed)
    process.env.CLAUDECLAW_ENV_DIR = dir
    vi.resetModules()
    const { readEnvFile, updateEnvFile } = await import('../env.js')
    return { envPath, readEnvFile, updateEnvFile }
  }

  it('letezo kulcsot felulir, a tobbi sort valtozatlanul hagyja', async () => {
    const { envPath, updateEnvFile } = await loadEnv(
      '# fejlec\nMAIN_AGENT_ID=regi\n\nCHANNEL_PROVIDER=telegram\n',
    )
    updateEnvFile({ MAIN_AGENT_ID: 'uj' })
    expect(readFileSync(envPath, 'utf-8')).toBe(
      '# fejlec\nMAIN_AGENT_ID=uj\n\nCHANNEL_PROVIDER=telegram\n',
    )
  })

  it('hianyzo kulcsot a vegere fuz', async () => {
    const { envPath, updateEnvFile } = await loadEnv('MEGLEVO=1\n')
    updateEnvFile({ UJKULCS: 'ertek' })
    expect(readFileSync(envPath, 'utf-8')).toBe('MEGLEVO=1\n\nUJKULCS=ertek')
  })

  it('a komment- es `=` nelkuli sorokat erintetlenul hagyja', async () => {
    const { envPath, updateEnvFile } = await loadEnv(
      '# komment\nSZEMETSOR\n   \nK=regi\n',
    )
    updateEnvFile({ K: 'uj' })
    const out = readFileSync(envPath, 'utf-8')
    expect(out).toContain('# komment')
    expect(out).toContain('SZEMETSOR')
    expect(out).toContain('K=uj')
  })

  it('idezojel nelkul ir (channels.sh `cut -d= -f2-` nem strippel)', async () => {
    const { envPath, updateEnvFile } = await loadEnv('K=regi\n')
    updateEnvFile({ K: 'ertek szokozzel' })
    expect(readFileSync(envPath, 'utf-8')).toBe('K=ertek szokozzel\n')
  })

  it('letrehozza a .env-t ha nem letezik', async () => {
    const { envPath, updateEnvFile } = await loadEnv()
    updateEnvFile({ FRISS: 'ertek' })
    expect(readFileSync(envPath, 'utf-8')).toBe('FRISS=ertek')
  })

  it('ures fajl eseten csak a beszurt kulcsot irja', async () => {
    const { envPath, updateEnvFile } = await loadEnv('')
    updateEnvFile({ A: '1' })
    expect(readFileSync(envPath, 'utf-8')).toBe('A=1')
  })

  it('no-op ha az updates ures -- a fajlt sem erinti', async () => {
    const { envPath, updateEnvFile } = await loadEnv('EREDETI=1\n')
    const before = statSync(envPath).mtimeMs
    updateEnvFile({})
    expect(readFileSync(envPath, 'utf-8')).toBe('EREDETI=1\n')
    expect(statSync(envPath).mtimeMs).toBe(before)
  })

  it('kiszuri az ures es a nem-string ertekeket', async () => {
    const { envPath, updateEnvFile } = await loadEnv('EREDETI=1\n')
    // A `typeof v === 'string'` ag csak nem-string ertekkel erheto el. A
    // JSON.parse visszaterese nem tipusos, igy `as`/`any` nelkul jut be a
    // szamertek -- pontosan ugy, ahogy egy JSON configbol erkezne.
    const numeric: Record<string, string> = JSON.parse('{"SZAM": 42}')
    updateEnvFile({ URES: '', ...numeric })
    expect(readFileSync(envPath, 'utf-8')).toBe('EREDETI=1\n')
  })

  it('tobb kulcsot egyszerre kezel: felulir es hozzafuz', async () => {
    const { envPath, updateEnvFile } = await loadEnv('A=regi\nB=marad\n')
    updateEnvFile({ A: 'uj', C: 'friss' })
    expect(readFileSync(envPath, 'utf-8')).toBe('A=uj\nB=marad\n\nC=friss')
  })

  // --- Rogzitett defektek (docs/needs-to-be-fix/) -------------------------
  // Mindketto a JELENLEGI, hibas viselkedest allitja. Fix utan ezek a tesztek
  // ELBUKNAK -- ez a szandek: a fix akkor keszult el, ha ezeket at kell irni.

  it('PINNED BUG env-update-duplicate-key-lost: csak az ELSO duplikalt kulcsot irja at', async () => {
    const { envPath, readEnvFile, updateEnvFile } = await loadEnv(
      'TOKEN=regi\nEGYEB=x\nTOKEN=regi\n',
    )
    updateEnvFile({ TOKEN: 'UJ' })

    // A masodik TOKEN sor ottmarad a regi ertekkel...
    expect(readFileSync(envPath, 'utf-8')).toBe('TOKEN=UJ\nEGYEB=x\nTOKEN=regi\n')
    // ...es mivel a readEnvFile az UTOLSO elofordulast nyeri, a frissites
    // csendben ELVESZIK: az iras utani olvasas a REGI erteket adja vissza.
    expect(readEnvFile()['TOKEN']).toBe('regi')
  })

  it('preserves 0600 across updateEnvFile (closes env-update-mode-downgrade)', async () => {
    const { envPath, updateEnvFile } = await loadEnv('SECRET=a\n')
    chmodSync(envPath, 0o600)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)

    // Az umask 0o022-re fixalasa biztositja, hogy a tmp fajl default modja
    // 0o644 legyen, es a { mode: 0o600 } tenylegesen gyakorolja a chmod-ot --
    // egy restrikt 0o077 dev umask mellett a tmp amugy is 0o600 lenne, es a
    // teszt a fix nelkul is atmenne.
    const previousUmask = process.umask(0o022)
    try {
      updateEnvFile({ SECRET: 'b' })
    } finally {
      process.umask(previousUmask)
    }

    // atomicWriteFileSync { mode: 0o600 } opcioval hivodik (src/env.ts:87): a
    // tmp fajl a write utan chmod 0o600-zal jon letre, majd rename. A 0600
    // jogosultsag a frissites utan is megmarad.
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })
})

// A PROJECT_ROOT fallback aga (src/env.ts:11, `?? join(__dirname, '..')`) csak
// akkor fut le, ha a CLAUDECLAW_ENV_DIR NINCS beallitva -- ilyenkor az env.ts a
// VALODI repo-gyokerre mutat.
//
// FIGYELEM: ebben az allapotban KIZAROLAG a readEnvFile hivhato. Az
// updateEnvFile az eles .env-t irna felul -- pontosan ez volt a 2026-07-27-i
// incidens. A blokk ezert csak olvas, es nem tamaszkodik a fajl tartalmara
// (worktree-ben nincs .env -> {}; barmely checkoutban objektumot kell adnia).
describe('PROJECT_ROOT fallback (CLAUDECLAW_ENV_DIR nincs beallitva)', () => {
  let envSnapshot: { restore: () => void }

  beforeAll(() => {
    envSnapshot = snapshotEnv()
  })

  afterEach(() => {
    envSnapshot.restore()
    vi.resetModules()
  })

  it('a repo-gyokerre esik vissza es olvashato marad', async () => {
    delete process.env.CLAUDECLAW_ENV_DIR
    vi.resetModules()
    const { readEnvFile } = await import('../env.js')

    const result = readEnvFile()
    expect(result).toBeTypeOf('object')
    expect(result).not.toBeNull()
  })
})
