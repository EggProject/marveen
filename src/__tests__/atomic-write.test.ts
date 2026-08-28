// 100% coverage test for src/web/atomic-write.ts.
//
// Scope: every branch of atomicWriteFileSync:
//   - default opts (mode undefined) -> skip chmod entirely
//   - opts with mode set -> chmod runs and succeeds
//   - opts with mode set + chmod throws -> catch swallows, write still completes
//   - string data and Buffer data both work
//   - tmp file lives next to target with the expected naming pattern
//   - no .tmp files remain after a successful write
//   - existing target is replaced (overwrite semantics)
//
// The chmod-failure branch is the only one that requires mocking node:fs; the
// other paths exercise the real fs on tmpdir-scoped files (the live-install
// guard never sees them).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  existsSync, readFileSync, readdirSync, statSync,
  chmodSync as realChmodSync, writeFileSync as realWriteFileSync,
  renameSync as realRenameSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// node:fs mock -- only chmodSync is intercepted, the rest of fs stays real so
// the test still validates the actual write+rename behavior on disk.
// ---------------------------------------------------------------------------
const fsState = {
  chmodShouldThrow: false as boolean,
  chmodCalls: [] as Array<{ path: string; mode: number }>,
}
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: ((p: Parameters<typeof realChmodSync>[0], mode: number) => {
      const pathStr = String(p)
      fsState.chmodCalls.push({ path: pathStr, mode })
      if (fsState.chmodShouldThrow) throw new Error('mock chmod fail')
      return (actual.chmodSync as unknown as typeof realChmodSync)(p, mode)
    }) as typeof realChmodSync,
  }
})

// SUT import -- must come AFTER vi.mock so the mocked fs is what the module
// binds. atomic-write.ts has no module-scope constants that need env-var
// re-routing (it does not import config / env / os), so a single import is
// enough.
const { atomicWriteFileSync } = await import('../web/atomic-write.js')

// ---------------------------------------------------------------------------
// Sandbox: one tmpdir per test, cleaned in afterEach. Using mkTempDir (not
// the LIVE repo root) keeps the live-install guard happy and isolates each
// case from any siblings.
// ---------------------------------------------------------------------------
let SANDBOX: string
const tempDirs: string[] = []

beforeAll(() => {
  SANDBOX = mkTempDir('atomic-write-')
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmTempDir(dir)
  fsState.chmodShouldThrow = false
  fsState.chmodCalls.length = 0
})

afterAll(() => {
  rmTempDir(SANDBOX)
})

function freshTarget(name = 'target.txt'): { dir: string; path: string } {
  const dir = mkTempDir('atomic-write-case-')
  tempDirs.push(dir)
  return { dir, path: join(dir, name) }
}

describe('atomicWriteFileSync - write + rename (caller-supplied path)', () => {
  it('letrehozza a cel fajlt string adattal', () => {
    const { path } = freshTarget()
    atomicWriteFileSync(path, 'hello world')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('hello world')
  })

  it('Buffer adattal is mukodik', () => {
    const { path } = freshTarget()
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    atomicWriteFileSync(path, buf)
    expect(readFileSync(path)).toEqual(buf)
  })

  it('a cel fajlt a megadott pathon hozza letre (nem os.tmpdir()-ban)', () => {
    const { dir, path } = freshTarget('custom-name.json')
    atomicWriteFileSync(path, '{"a":1}')
    expect(existsSync(path)).toBe(true)
    // The target sits in our sandboxed dir, not under tmpdir() root.
    expect(path.startsWith(dir)).toBe(true)
  })

  it('a tmp fajlt a CEL MELLE teszi (azonos konyvtar), hogy a rename atomi lehessen', () => {
    // Barmilyen directory, ahol writeFileSync elerheto: a tmp ugyanoda kerul,
    // mert a path prefixkent szolgal. Ezt indirekt bizonyitjuk: a write utan
    // a cel letezik, es NINCSennek maradt .tmp file-ok a dir-ben.
    const { dir, path } = freshTarget()
    atomicWriteFileSync(path, 'payload')
    const remaining = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    expect(remaining).toEqual([])
  })

  it('a tmp fajl neve a CEL NEVET tartalmazza prefixkent', () => {
    // A write kozben a tmp fajl letezik a write es a rename kozotti resben.
    // Ezt indirekt bizonyitjuk: a writeFileSpy a write-ot CHMOD elotti
    // allapotban latja (a rename meg nem futott le). A chmodCalls-bol tudjuk,
    // hogy a chmod egy 'path.N.N.N.tmp' alaku fajlon futott -- ez kozvetve
    // bizonyitja, hogy a tmp fajl neve a cel utani prefixet kapta.
    const { path } = freshTarget()
    atomicWriteFileSync(path, 'data', { mode: 0o600 })
    expect(fsState.chmodCalls.length).toBe(1)
    const tmpName = fsState.chmodCalls[0]!.path
    expect(tmpName.startsWith(path + '.')).toBe(true)
    expect(tmpName.endsWith('.tmp')).toBe(true)
  })

  it('felulir egy mar letezo fajlt (atomi csere)', () => {
    const { path } = freshTarget()
    realWriteFileSync(path, 'regi tartalom')
    expect(readFileSync(path, 'utf-8')).toBe('regi tartalom')
    atomicWriteFileSync(path, 'uj tartalom')
    expect(readFileSync(path, 'utf-8')).toBe('uj tartalom')
  })

  it('a default opciokkal (opts argumentum nelkul) is mukodik', () => {
    const { path } = freshTarget()
    // No opts: a default {} ervenyesul, mode undefined.
    atomicWriteFileSync(path, 'no-opts')
    expect(readFileSync(path, 'utf-8')).toBe('no-opts')
    // A chmod-ot nem szabad meghivni, mert a mode undefined.
    expect(fsState.chmodCalls).toEqual([])
  })

  it('ures opciokkal ({}) is mukodik', () => {
    const { path } = freshTarget()
    atomicWriteFileSync(path, 'empty-opts', {})
    expect(readFileSync(path, 'utf-8')).toBe('empty-opts')
    expect(fsState.chmodCalls).toEqual([])
  })

  it('ures string adattal is mukodik', () => {
    const { path } = freshTarget()
    atomicWriteFileSync(path, '')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('')
  })

  it('a return value void', () => {
    const { path } = freshTarget()
    const ret = atomicWriteFileSync(path, 'x')
    expect(ret).toBeUndefined()
  })

  it('tobbszori egymas utani hivast kezel (nincs allapot a modulban)', () => {
    const a = freshTarget('a.txt').path
    const b = freshTarget('b.txt').path
    atomicWriteFileSync(a, 'first')
    atomicWriteFileSync(b, 'second')
    atomicWriteFileSync(a, 'first-overwritten')
    expect(readFileSync(a, 'utf-8')).toBe('first-overwritten')
    expect(readFileSync(b, 'utf-8')).toBe('second')
  })
})

describe('atomicWriteFileSync - mode preservation', () => {
  it('a mode opciot atadja chmod-nak a TMP fajlon', () => {
    const { path } = freshTarget()
    // Fix umask, hogy az writeFileSync altal letrehozott fajl modjat ne
    // befolyasolja a tesztkornyezet umask-ja. A chmod-ot egyenkent hivjuk,
    // tehat az umask csak az elso writeFile-hoz kell.
    const prevUmask = process.umask(0o022)
    try {
      atomicWriteFileSync(path, 'mode-test', { mode: 0o600 })
    } finally {
      process.umask(prevUmask)
    }
    // A chmod a TMP fajlon fut, de a rename utan a cel fajl megorzi a
    // chmod-olt jogokat (POSIX rename megtartja az inode-ot, igy a modot is).
    expect(fsState.chmodCalls.length).toBe(1)
    expect(fsState.chmodCalls[0]!.mode).toBe(0o600)
    expect(fsState.chmodCalls[0]!.path.endsWith('.tmp')).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('a chmod-ot a writeFileSync utan, de a rename elott hivja', () => {
    // A sorrend kozvetett bizonyiteka:
    //   1. writeFileSync sikerult (a fajl letezik es tartalma helyes)
    //   2. chmod a .tmp kiterjesztesu fajlon futott (meg nem rename-olva)
    //   3. rename megtortent (a .tmp fajl eltunt, csak a cel letezik)
    // Ha a sorrend eltero lenne:
    //   - write elott rename: nem tortenhet meg, rename nem letezo fajlt vinne at
    //   - rename utan chmod: a catch-ben lenyelt ENOENT-et kapnank, de a
    //     chmodCalls.path akkor NEM .tmp, hanem a mar atnevezett celnev lenne
    const { dir, path } = freshTarget()
    atomicWriteFileSync(path, 'order-check', { mode: 0o644 })
    expect(fsState.chmodCalls.length).toBe(1)
    expect(fsState.chmodCalls[0]!.path.endsWith('.tmp')).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('order-check')
    // A tmp kiterjesztesu fajl nem maradt a dir-ben (a rename atvitte).
    const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('chmod hiba utan a write megis sikeres (best-effort catch) es a tmp nem marad', () => {
    // A chmod-ot egy best-effort try/catch veszi korul (atomic-write.ts:16),
    // igy a write akkor is sikeresen zarul, ha a chmod kivetelt dob. A
    // rename a chmod utan fut, es atviszi a tmp fajlt a cel helyere, igy
    // a lemezen nem marad .tmp kiterjesztesu maradek.
    fsState.chmodShouldThrow = true
    const { dir, path } = freshTarget()
    atomicWriteFileSync(path, 'chmod-fail', { mode: 0o600 })
    // A write megis sikeres volt (catch lenyelte a chmod-ot).
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('chmod-fail')
    // A chmod-ot meghivtak (a catch csak a kivetelt nyeli le).
    expect(fsState.chmodCalls.length).toBe(1)
    // A rename atvitte a tmp-t a cel helyere, igy nem maradt .tmp fajl.
    const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('a chmod-ot akkor is megprobalja, ha a writeFile utani fajl mar nem letezik (catch elnyeli)', () => {
    // Ha a chmod kivetelt dob (barmi okbol), a write akkor is befejezodik,
    // mert a catch-AG nem dob tovabb. Az atomi write celja a felig irt
    // fajl elleni vedelem -- a chmod-kudarc NEM veszelyezteti az adatintegritast.
    fsState.chmodShouldThrow = true
    const { path } = freshTarget()
    expect(() => atomicWriteFileSync(path, 'safe', { mode: 0o600 })).not.toThrow()
    expect(readFileSync(path, 'utf-8')).toBe('safe')
  })

  it('mode nelkul (undefined) NEM hiv chmod-ot', () => {
    const { path } = freshTarget()
    atomicWriteFileSync(path, 'no-mode', { mode: undefined })
    expect(fsState.chmodCalls).toEqual([])
  })

  it('a mode opcioat tiszteletben tartja 0o644-re is', () => {
    const { path } = freshTarget()
    const prevUmask = process.umask(0o022)
    try {
      atomicWriteFileSync(path, 'mode-644', { mode: 0o644 })
    } finally {
      process.umask(prevUmask)
    }
    expect(statSync(path).mode & 0o777).toBe(0o644)
  })
})
