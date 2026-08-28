// A default readCpuinfo (`() => { try { readFileSync('/proc/cpuinfo', 'utf-8') }
// catch { return '' } }`) a `readFileSync`-ot a `node:fs`-bol importalja. Mivel
// a node:fs exportjai nem konfiguralhatok ujradefinialhato property-kent, a
// spyOn-os megkozelites nem jarhato -- ehelyett a `vi.mock('node:fs', ...)`
// modul-cserejet hasznaljuk, ami a tesztfajl osszes tesztjere ervenyes. A
// default readCpuinfo csak akkor fut le, amikor a `claudeAgentRunnable` hivas
// nem ad at readCpuinfo-t -- ahol van readCpuinfo, ott a mockolt fs nincs hatassal.
import { afterEach, describe, expect, it, vi } from 'vitest'

// A vi.mock a fajl tetejere hoistolodik, ezert a `mockReadFileSync` referenciat
// elore el kell keszitenunk a vi.hoisted szamara, hogy a mock factory elerje.
const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn<(path: string, encoding: 'utf-8') => string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: mockReadFileSync as unknown as typeof actual.readFileSync,
  }
})

// A modul-toltott fuggvenyeket a mock utan importaljuk, hogy a modul-alapertelmezes
// a mockolt readFileSync-ot hasznalja.
import {
  cpuinfoHasAvx,
  claudeAgentRunnable,
} from '../update-agent-capability.js'

// x86 cpuinfo az AVX flaggel -- a flags sor a "flags : fpu ... avx avx2 ..." minta.
const X86_WITH_AVX = `processor\t: 0
vendor_id\t: GenuineIntel
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep avx avx2 fma
`

// x86 cpuinfo AVX nelkul -- az AVX-less QEMU-VPS eset (a PR-D hattere).
const X86_NO_AVX = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: QEMU Virtual CPU version 2.5+
flags\t\t: fpu de pse tsc msr pae mce cx8 apic sep mtrr sse sse2
`

// ARM cpuinfo: a "Features :" sor nem "flags :", ezert a kiertekelo lefutas nem szamit x86-nak.
const ARM = `processor\t: 0
BogoMIPS\t: 48.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32
CPU implementer\t: 0x41
`

describe('cpuinfoHasAvx', () => {
  it('felismeri az avx flag-et ha a flags sorban szerepel', () => {
    expect(cpuinfoHasAvx(X86_WITH_AVX)).toBe(true)
  })

  it('hamis ha a flags sor nem tartalmazza az avx flag-et', () => {
    expect(cpuinfoHasAvx(X86_NO_AVX)).toBe(false)
  })

  it('csak az onallo avx tokenre illeszkedik, nem resz-stringre', () => {
    // Valodi cpuinfo az onallo "avx" flaget kulon sorolja az avx512*-tol.
    expect(cpuinfoHasAvx('flags : fpu avx avx512f')).toBe(true)
    // avx512* onallo avx token nelkul NEM illeszkedik (szohatar).
    expect(cpuinfoHasAvx('flags : fpu avx512f')).toBe(false)
    // "xavxy" sem, mert a "x" megelozi az "avx"-et (nincs szohatar az elejen).
    expect(cpuinfoHasAvx('flags : fpu xavxy')).toBe(false)
  })

  it('ures stringre hamis (nincs flags sor)', () => {
    expect(cpuinfoHasAvx('')).toBe(false)
  })

  it('a "flags" szot kizarolag sor-eleji pozicioban fogadja el (multiline anchor)', () => {
    // A regex `/^flags\s*:.*\bavx\b/m` a "flags" szot CSAK sor-eleji pozicioban
    // ismeri fel. Ha "flags" nem sor-eleji, a regex nem illeszkedik.
    expect(cpuinfoHasAvx('  flags : fpu avx')).toBe(false)
    // de ha sor-eleji, es van avx, illeszkedik:
    expect(cpuinfoHasAvx('flags : fpu avx')).toBe(true)
  })
})

describe('claudeAgentRunnable', () => {
  afterEach(() => {
    mockReadFileSync.mockReset()
  })

  it('linux x86 AVX-szel -> futtathato', () => {
    expect(claudeAgentRunnable('linux', () => X86_WITH_AVX)).toBe(true)
  })

  it('linux x86 AVX nelkul -> NEM futtathato (az AVX-less VPS eset)', () => {
    expect(claudeAgentRunnable('linux', () => X86_NO_AVX)).toBe(false)
  })

  it('linux ARM (Features:, nincs flags sor) -> futtathato', () => {
    // Az ARM binary-nak nincs AVX fogalma, a "Features :" sort nem tekintjuk x86-nak.
    expect(claudeAgentRunnable('linux', () => ARM)).toBe(true)
  })

  it('linux ures cpuinfoval -> futtathato (bizonytalan probe, nem blokkolunk)', () => {
    expect(claudeAgentRunnable('linux', () => '')).toBe(true)
  })

  it('macOS (darwin) -> a cpuinfo-tol fuggetlenul futtathato', () => {
    // A platform-guard megelozi az osszes kovetkezo feldolgozast.
    expect(claudeAgentRunnable('darwin', () => X86_NO_AVX)).toBe(true)
  })

  it('win32 -> platform-guard, futtathato', () => {
    // "Anything else: runnable" -- nem blokkolunk ismeretlen platformot.
    expect(claudeAgentRunnable('win32', () => X86_NO_AVX)).toBe(true)
  })

  it('ures platform string -> szinten futtathato (platform-guard)', () => {
    // A platform-guard `!== "linux"` iranyu aga: barmi, ami nem "linux", atmegy.
    expect(claudeAgentRunnable('', () => X86_NO_AVX)).toBe(true)
  })

  it('alapertelmezett platform (platform()) -> a platform()-ot hasznalja, nem dob', () => {
    // A default `plat = platform()` kiertekeleset piszkalja: nem adunk at platformot.
    // A jelenlegi host platformja lehet "darwin" vagy "linux" -- barmelyik esetben
    // a platform-guard dont (linux eseten readCpuinfo-t is meghivja, nem linux
    // eseten visszater igazzal). Egyik sem dob kivetelt, es a return tipusa boolean.
    expect(() => claudeAgentRunnable()).not.toThrow()
    const result = claudeAgentRunnable()
    expect(typeof result).toBe('boolean')
  })

  it('alapertelmezett readCpuinfo catch-re esik (readFileSync dob) -> futtathato', () => {
    // A default readCpuinfo: `try { readFileSync('/proc/cpuinfo') } catch { return '' }`.
    // A mock-olt readFileSync-ot hibat dob, igy a catch fut le, ''-t ad vissza; a
    // `if (!info) return true` miatt a fuggveny futtathatot jelent. (Egyuttal ez
    // a try/catch defensiv agat is lecovi -- a `catch { return '' }` sort.)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no /proc/cpuinfo on this host')
    })
    expect(claudeAgentRunnable('linux')).toBe(true)
  })

  it('alapertelmezett readCpuinfo sikeres readFileSync-kal, x86+avx -> futtathato', () => {
    // A default readCpuinfo try-agat csak akkor erjuk el, ha readFileSync sikeresen
    // visszater. A mock most stringet ad vissza, igy a default arrow function a
    // try-agon fut le; a kiertekelo x86+avx mintat lat es futtathatot jelent.
    mockReadFileSync.mockReturnValue(X86_WITH_AVX)
    expect(claudeAgentRunnable('linux')).toBe(true)
  })

  it('alapertelmezett readCpuinfo sikeres readFileSync-kal, x86 AVX nelkul -> NEM futtathato', () => {
    // Ugyanaz, mint fent, de az AVX-less mintaval: a try-ag sikeres, a default
    // reader a X86_NO_AVX szoveggel ter vissza, a kiertekelo x86-de-nem-avx
    // dontest hoz, igy a fuggveny hamis.
    mockReadFileSync.mockReturnValue(X86_NO_AVX)
    expect(claudeAgentRunnable('linux')).toBe(false)
  })

  it('alapertelmezett readCpuinfo sikeres readFileSync-kal, ARM cpuinfo -> futtathato', () => {
    // A try-ag sikeres, de a tartalom ARM ("Features :" nem "flags :"); a
    // cpuinfoIsX86 hamis, a fuggveny futtathatot jelent.
    mockReadFileSync.mockReturnValue(ARM)
    expect(claudeAgentRunnable('linux')).toBe(true)
  })
})