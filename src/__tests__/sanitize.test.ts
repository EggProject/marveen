import { describe, it, expect, afterAll } from 'vitest'
import { resolve } from 'node:path'
import {
  sanitizeAgentName,
  sanitizeSkillName,
  sanitizeScheduleName,
  safeJoin,
  shellEscape,
} from '../web/sanitize.js'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

describe('sanitizeAgentName', () => {
  it('ures stringet uresre konvertal', () => {
    expect(sanitizeAgentName('')).toBe('')
  })

  it('csak whitespace-bol ures string lesz', () => {
    expect(sanitizeAgentName('   ')).toBe('')
    expect(sanitizeAgentName('\t\n  ')).toBe('')
  })

  it('kornyezo whitespace-et vag', () => {
    expect(sanitizeAgentName('  hello  ')).toBe('hello')
  })

  it('nagybetut kisbeture csereli', () => {
    expect(sanitizeAgentName('Hello')).toBe('hello')
    expect(sanitizeAgentName('HELLO')).toBe('hello')
  })

  it('szokozt stripeli (nem csereli dash-re, mert nincs szokoz->dash conversion)', () => {
    expect(sanitizeAgentName('Hello World')).toBe('helloworld')
  })

  it('tobb szokozt is stripeli', () => {
    expect(sanitizeAgentName('hello   world')).toBe('helloworld')
    expect(sanitizeAgentName('a  b  c')).toBe('abc')
  })

  it('nem alphanumerikus karaktereket torol', () => {
    expect(sanitizeAgentName('Hello!@#World')).toBe('helloworld')
    expect(sanitizeAgentName('a.b.c')).toBe('abc')
    expect(sanitizeAgentName('foo/bar')).toBe('foobar')
    expect(sanitizeAgentName('a$b%c')).toBe('abc')
  })

  it('tobbszorozott kotojelt egy kotojelre collapse-ol', () => {
    expect(sanitizeAgentName('hello---world')).toBe('hello-world')
    expect(sanitizeAgentName('a----b')).toBe('a-b')
  })

  it('a kotojelek kornyezo kotojeleit levagja', () => {
    expect(sanitizeAgentName('-hello-')).toBe('hello')
    expect(sanitizeAgentName('---hello---')).toBe('hello')
    expect(sanitizeAgentName('-a-b-')).toBe('a-b')
  })

  it('NFD normalizacio utan a magyar ekezetes karaktereket megorzi', () => {
    // Az NFD + combining-mark strip utan a "étrendíró" -> "etrendiro".
    // Az NFD lepes nelkul a "é","í","ó" mind nem [a-z0-9-], teham "trendr" lenne.
    expect(sanitizeAgentName('étrendíró')).toBe('etrendiro')
  })

  it('tobbszorozott ekezetes karaktert is kezel', () => {
    // 'álárééré' = a+acc, l, a+acc, r, e+acc, e+acc, r, e+acc (8 combining-eles)
    //   NFD + strip -> 'a','l','a','r','e','e','r','e' = 'alareere'.
    expect(sanitizeAgentName('álárééré')).toBe('alareere')
  })

  it('szamokat megorzi', () => {
    expect(sanitizeAgentName('agent-007')).toBe('agent-007')
    expect(sanitizeAgentName('12345')).toBe('12345')
  })

  it('50 karakterre vag', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeAgentName(long)).toBe('a'.repeat(50))
  })

  it('50 karakterre vag utolagos trimmelessel egyutt', () => {
    const input = 'a'.repeat(30) + '---' + 'b'.repeat(30)
    const result = sanitizeAgentName(input)
    expect(result.length).toBe(50)
    // 3 dashes collapse to 1, then slice to 50 keeps 30 a's, 1 dash, 19 b's.
    expect(result).toBe('a'.repeat(30) + '-' + 'b'.repeat(19))
  })

  it('underscore-t es egyeb specialis karaktert stripeli (nem konvertalja dash-re)', () => {
    expect(sanitizeAgentName('my-cool-agent_42')).toBe('my-cool-agent42')
  })

  it('uresre redukalja ha minden karaktert torolni kell', () => {
    expect(sanitizeAgentName('___')).toBe('')
    expect(sanitizeAgentName('!@#$%')).toBe('')
  })

  it('NFD utan ha minden combining mark utan nem marad alphanum, ures lesz', () => {
    // "́" egyetlen combining mark karakter (U+0301). NFD utan nincs mit levenni,
    // de ez amugy is torlesre kerul a kovetkezo [^a-z0-9-] lepesben.
    expect(sanitizeAgentName('́')).toBe('')
  })
})

describe('sanitizeSkillName', () => {
  it('azonos szabalyokat kovet mint a sanitizeAgentName (szokozt stripeli, nem dash-re csereli)', () => {
    expect(sanitizeSkillName('Hello World')).toBe('helloworld')
    expect(sanitizeSkillName('  --foo--  ')).toBe('foo')
    expect(sanitizeSkillName('Foo!Bar')).toBe('foobar')
  })

  it('50 karakterre vag', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeSkillName(long)).toBe('x'.repeat(50))
  })

  it('NFD es combining-mark strip-et alkalmaz', () => {
    expect(sanitizeSkillName('étrendíró')).toBe('etrendiro')
  })

  it('ures inputbol ures kimenet', () => {
    expect(sanitizeSkillName('')).toBe('')
    expect(sanitizeSkillName('   ')).toBe('')
  })

  it('path traversal mintakat normalizalja', () => {
    expect(sanitizeSkillName('../../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeSkillName('..\\windows\\system32')).toBe('windowssystem32')
  })
})

describe('sanitizeScheduleName', () => {
  it('ures stringet uresre konvertal', () => {
    expect(sanitizeScheduleName('')).toBe('')
  })

  it('whitespace-bol ures stringet csinal', () => {
    expect(sanitizeScheduleName('   ')).toBe('')
    expect(sanitizeScheduleName('\t \n')).toBe('')
  })

  it('kornyezo whitespace-et levag', () => {
    expect(sanitizeScheduleName('  hello  ')).toBe('hello')
  })

  it('nagybetut kisbeture', () => {
    expect(sanitizeScheduleName('Daily Backup')).toBe('daily-backup')
  })

  it('tobbszorozott whitespace-et egy kotojelre collapse-ol', () => {
    expect(sanitizeScheduleName('hello   world')).toBe('hello-world')
    expect(sanitizeScheduleName('a\nb\tc')).toBe('a-b-c')
  })

  it('nem alphanumerikus karaktereket torli', () => {
    expect(sanitizeScheduleName('Hello!@#')).toBe('hello')
    expect(sanitizeScheduleName('a.b.c')).toBe('abc')
    expect(sanitizeScheduleName('foo/bar')).toBe('foobar')
  })

  it('tobbszorozott kotojelt egy kotojelre collapse-ol', () => {
    expect(sanitizeScheduleName('hello---world')).toBe('hello-world')
  })

  it('kornyezo kotojelet levag', () => {
    expect(sanitizeScheduleName('-hello-')).toBe('hello')
    expect(sanitizeScheduleName('---foo---')).toBe('foo')
  })

  it('NEM alkalmaz NFD-t - az ekezetes karakterek torlodnek', () => {
    // Az NFD lepes hianya miatt "é","í","ó" mind nem [a-z0-9-] es torlodnek.
    // Ezzel szemben sanitizeAgentName megtartaná az alapbetűket.
    expect(sanitizeScheduleName('étrendíró')).toBe('trendr')
  })

  it('NEM vag 50 karakterre (különbözik a sanitizeAgentName-től)', () => {
    const long = 'a'.repeat(200)
    expect(sanitizeScheduleName(long).length).toBe(200)
  })

  it('megorzi a szamokat', () => {
    expect(sanitizeScheduleName('backup-2024-01-15')).toBe('backup-2024-01-15')
  })

  it('path traversal mintakat normalizalja', () => {
    expect(sanitizeScheduleName('../../etc/passwd')).toBe('etcpasswd')
  })

  it('uresre redukalja ha minden karaktert torolni kell', () => {
    expect(sanitizeScheduleName('!@#$%')).toBe('')
    expect(sanitizeScheduleName('---')).toBe('')
  })
})

describe('safeJoin', () => {
  const baseDir = mkTempDir('marveen-safejoin-')

  afterAll(() => {
    rmTempDir(baseDir)
  })

  it('ures parts listaval a base-t adja vissza', () => {
    expect(safeJoin(baseDir)).toBe(resolve(baseDir))
  })

  it('egy egyszeru al-utat hozza fűz', () => {
    expect(safeJoin(baseDir, 'sub')).toBe(resolve(baseDir, 'sub'))
  })

  it('tobb al-utat joinol', () => {
    expect(safeJoin(baseDir, 'a', 'b', 'c')).toBe(resolve(baseDir, 'a', 'b', 'c'))
  })

  it('path traversal-t eldob relative ".." szegmensre', () => {
    expect(() => safeJoin(baseDir, '..', 'etc')).toThrow(/Path traversal rejected/)
  })

  it('path traversal-t eldob amikor az eredmeny teljesen kívül esik', () => {
    expect(() => safeJoin(baseDir, '../escaped')).toThrow(/Path traversal rejected/)
  })

  it('path traversal-t eldob amikor a rokon konyvtar prefix-egyezik de nem separator utan', () => {
    // A "baseDir2" prefix-egyezik a baseDir-rel, de NEM baseDir + sep-vel.
    // Pl. ha baseDir = "/tmp/foo", akkor "/tmp/foo2" cel az "/tmp/foo2",
    // ami nem "/tmp/foo" és nem is "/tmp/foo/" -re kezdodik.
    const sibling = baseDir + '-sibling'
    expect(() => safeJoin(baseDir, '..', sibling.split('/').pop()!)).toThrow(/Path traversal rejected/)
  })

  it('nem dob ha a cel megegyezik a base-szel (resolve("../base") = base)', () => {
    // safeJoin(base, "..", "<basename>") feloldodik base-re, ezert egyenlo base-szel.
    const basename = baseDir.split('/').pop()!
    const parent = baseDir.split('/').slice(0, -1).join('/')
    // safeJoin(parent + "/<basename>", "..", "<basename>") = parent + "/<basename>"
    expect(() => safeJoin(parent + '/' + basename, '..', basename)).not.toThrow()
  })

  it('a throw-ban a parts join-ja szerepel "/" delimiterrel', () => {
    expect(() => safeJoin(baseDir, '..', 'a', 'b')).toThrow(/Path traversal rejected: \.\.\/a\/b/)
  })

  it('abszolut parts-ra is tilt (resolve felülírja a base-t)', () => {
    expect(() => safeJoin(baseDir, '/etc/passwd')).toThrow(/Path traversal rejected/)
  })

  it('abszolut parts-ra is tilt amikor az cel-útvonalként "/"-re kezdodik', () => {
    // resolve(baseDir, "/tmp/other") a /tmp/other-t adja, ami nincs a base alatt.
    expect(() => safeJoin(baseDir, '/tmp/other')).toThrow(/Path traversal rejected/)
  })

  it('mélyen beágyazott legális útvonalat elfogad', () => {
    const deep = resolve(baseDir, 'a', 'b', 'c', 'd')
    expect(safeJoin(baseDir, 'a', 'b', 'c', 'd')).toBe(deep)
  })

  it('ures string parts-ot megengedi (resolve alapertelmezetten "." kezeli)', () => {
    // Az ures string a resolve-ban nem változtat — megegyezik base-szel.
    expect(safeJoin(baseDir, '')).toBe(resolve(baseDir))
  })
})

describe('shellEscape', () => {
  it("ures stringet '' -ra csereli", () => {
    expect(shellEscape('')).toBe("''")
  })

  it('egyszeru szöveget single quote-ok koze zár', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  it('szokozt tartalmazo stringet helyesen escape-el', () => {
    expect(shellEscape('hello world')).toBe("'hello world'")
  })

  it("egyetlen aposztrofot '...' modon escape-el", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'")
  })

  it('tobbszorozott aposztrofot egyenkent escape-el', () => {
    expect(shellEscape("''")).toBe("''\\'''\\'''")
  })

  it('csak aposztrofot tartalmazo string', () => {
    expect(shellEscape("'")).toBe("''\\'''")
  })

  it('shell-veszelyes karaktereket ($, `, \\, ") atengedi egy quoting szinten belul', () => {
    // A single-quote-os escape nem külön escape-el ilyeneket — a single-quote
    // shell-kontextusban mindent literalisan tart, ami kozte van.
    expect(shellEscape('$VAR')).toBe("'$VAR'")
    expect(shellEscape('`cmd`')).toBe("'`cmd`'")
    expect(shellEscape('a\\b')).toBe("'a\\b'")
    expect(shellEscape('"q"')).toBe("'\"q\"'")
  })

  it('hosszabb, aposztrofot is tartalmazo szöveget helyesen kezel', () => {
    expect(shellEscape("don't 'quote' me")).toBe("'don'\\''t '\\''quote'\\'' me'")
  })

  it('sortorest is literalisan tartja a single-quote-on belul', () => {
    expect(shellEscape('line1\nline2')).toBe("'line1\nline2'")
  })
})