import { describe, it, expect } from 'vitest'
import { parseMultipart } from '../web/multipart.js'

// A parser tiszta fuggveny: nincs filesystem, env vagy subprocess fuggosege,
// ezert a temp-sandbox helperek (mkTempDir / withTempEnv / snapshotEnv) itt
// nem alkalmazhatoak. Minden eset egy kezzel osszerakott wire-formatumu
// bufferrel hajtja meg a `parseMultipart`-ot.

const BOUNDARY = '----WebKitFormBoundaryABC123'
const CT = `multipart/form-data; boundary=${BOUNDARY}`

/** Osszerak egy multipart torzset a megadott resz-blokkokbol.
 *  Minden `part` a boundary utani nyers tartalom (headerek + torzs),
 *  a lezaro `--BOUNDARY--\r\n` epilogust automatikusan hozzafuzi. */
function buildBody(parts: string[], boundary = BOUNDARY): Buffer {
  const joined = parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')
  return Buffer.from(`${joined}--${boundary}--\r\n`, 'binary')
}

/** Egy szoveges mezo resz-blokkja. */
function fieldPart(name: string, value: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`
}

/** Egy fajl resz-blokkja. `mime` elhagyasa eseten nincs Content-Type header. */
function filePart(name: string, filename: string, data: string, mime?: string): string {
  const ctLine = mime === undefined ? '' : `Content-Type: ${mime}\r\n`
  return `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n${ctLine}\r\n${data}`
}

describe('parseMultipart - boundary felismerés', () => {
  it('boundary nelkuli content-type eseten ures fields-et ad vissza', () => {
    const body = buildBody([fieldPart('greeting', 'hello')])
    expect(parseMultipart(body, 'multipart/form-data')).toEqual({ fields: {} })
  })

  it('teljesen ures content-type eseten is ures fields', () => {
    expect(parseMultipart(Buffer.alloc(0), '')).toEqual({ fields: {} })
  })

  it('boundary= utani erteket hasznalja a szeteldarabolashoz', () => {
    const body = buildBody([fieldPart('greeting', 'hello')])
    expect(parseMultipart(body, CT).fields).toEqual({ greeting: 'hello' })
  })

  it('mas boundary-vel is mukodik (nem hardcode-olt a minta)', () => {
    const other = 'xyz-9'
    const body = buildBody([fieldPart('a', '1')], other)
    expect(parseMultipart(body, `multipart/form-data; boundary=${other}`).fields).toEqual({ a: '1' })
  })

  it('a Boundary= parameter nevet case-insensitive modon fogadja el (RFC 2045)', () => {
    const body = buildBody([fieldPart('a', '1')], BOUNDARY)
    const upperCT = `multipart/form-data; Boundary=${BOUNDARY}`
    expect(parseMultipart(body, upperCT).fields).toEqual({ a: '1' })
  })

  it('a quoted boundary utan a trailing parametert is helyesen lezarja (RFC 2045+2046)', () => {
    const body = buildBody([fieldPart('a', '1')], BOUNDARY)
    const combined = `multipart/form-data; boundary="${BOUNDARY}"; charset=utf-8`
    expect(parseMultipart(body, combined).fields).toEqual({ a: '1' })
  })

  it('a boundary utan levo whitespace-et levagja', () => {
    const body = buildBody([fieldPart('a', '1')], BOUNDARY)
    const trailingWS = `multipart/form-data; boundary=${BOUNDARY} `
    expect(parseMultipart(body, trailingWS).fields).toEqual({ a: '1' })
  })
})

describe('parseMultipart - szoveges mezok', () => {
  it('egy mezot kiolvas', () => {
    const body = buildBody([fieldPart('name', 'Marveen')])
    expect(parseMultipart(body, CT)).toEqual({ fields: { name: 'Marveen' } })
  })

  it('tobb mezot kiolvas', () => {
    const body = buildBody([
      fieldPart('name', 'agent-1'),
      fieldPart('overwrite', '1'),
      fieldPart('note', 'ketto szo'),
    ])
    expect(parseMultipart(body, CT).fields).toEqual({
      name: 'agent-1',
      overwrite: '1',
      note: 'ketto szo',
    })
  })

  it('ures erteku mezot is rogzit', () => {
    const body = buildBody([fieldPart('empty', '')])
    expect(parseMultipart(body, CT).fields).toEqual({ empty: '' })
  })

  it('azonos nevu mezobol az utolso nyer', () => {
    const body = buildBody([fieldPart('dup', 'elso'), fieldPart('dup', 'masodik')])
    expect(parseMultipart(body, CT).fields).toEqual({ dup: 'masodik' })
  })

  it('a torzs belsejeben levo CRLF-et megtartja, csak a lezarot vagja le', () => {
    const body = buildBody([fieldPart('multi', 'sor1\r\nsor2')])
    expect(parseMultipart(body, CT).fields.multi).toBe('sor1\r\nsor2')
  })

  it('a torzs vegerol csak EGY CRLF-et vag le', () => {
    // A wire-on a `\r\n--BOUNDARY` delimiter CRLF-je tartozik a hataroloohoz,
    // a mezo sajat zaro sortoresenek meg kell maradnia.
    const body = buildBody([fieldPart('trail', 'ertek\r\n')])
    expect(parseMultipart(body, CT).fields.trail).toBe('ertek\r\n')
  })

  it('fajl hianyaban a file kulcs definialatlan marad', () => {
    const body = buildBody([fieldPart('a', '1')])
    expect(parseMultipart(body, CT).file).toBeUndefined()
  })
})

describe('parseMultipart - fajl reszek', () => {
  it('fajlnevet, adatot es mime-ot kiolvas', () => {
    const body = buildBody([filePart('avatar', 'kep.png', 'PNGDATA', 'image/png')])
    const { file } = parseMultipart(body, CT)
    expect(file).toBeDefined()
    expect(file?.name).toBe('kep.png')
    expect(file?.mime).toBe('image/png')
    expect(file?.data.toString('binary')).toBe('PNGDATA')
  })

  it('a mime korul levo whitespace-t levagja', () => {
    const body = buildBody([filePart('avatar', 'a.png', 'D', '  image/png  ')])
    expect(parseMultipart(body, CT).file?.mime).toBe('image/png')
  })

  it('Content-Type header nelkul application/octet-stream a fallback', () => {
    const body = buildBody([filePart('bundle', 'agent.tar.gz', 'GZIPBYTES')])
    const { file } = parseMultipart(body, CT)
    expect(file?.name).toBe('agent.tar.gz')
    expect(file?.mime).toBe('application/octet-stream')
    expect(file?.data.toString('binary')).toBe('GZIPBYTES')
  })

  it('ures Content-Type ertek eseten is application/octet-stream a fallback', () => {
    // A `Content-Type: \r` header-ertekre a `(.+)` a maganyos `\r`-t fogja meg,
    // amit a `.trim()` ures stringre redukal, igy a `||` ag lep eletbe.
    const part =
      'Content-Disposition: form-data; name="f"; filename="a.bin"\r\nContent-Type: \r\r\n\r\nDATA'
    const body = Buffer.from(
      `--${BOUNDARY}\r\n${part}\r\n--${BOUNDARY}--\r\n`,
      'binary',
    )
    const { file } = parseMultipart(body, CT)
    expect(file?.name).toBe('a.bin')
    expect(file?.mime).toBe('application/octet-stream')
    expect(file?.data.toString('binary')).toBe('DATA')
  })

  it('a Content-Type header nevet kis-nagybetu fuggetlenul illeszti', () => {
    const part =
      'Content-Disposition: form-data; name="f"; filename="a.png"\r\ncontent-type: image/webp\r\n\r\nD'
    const body = Buffer.from(`--${BOUNDARY}\r\n${part}\r\n--${BOUNDARY}--\r\n`, 'binary')
    expect(parseMultipart(body, CT).file?.mime).toBe('image/webp')
  })

  it('fajlt es mezoket egyutt olvas ki', () => {
    const body = buildBody([
      fieldPart('name', 'uj-agent'),
      filePart('bundle', 'b.tar.gz', 'BYTES', 'application/gzip'),
      fieldPart('overwrite', 'true'),
    ])
    const { file, fields } = parseMultipart(body, CT)
    expect(fields).toEqual({ name: 'uj-agent', overwrite: 'true' })
    expect(file?.name).toBe('b.tar.gz')
    expect(file?.mime).toBe('application/gzip')
  })

  it('tobb fajl eseten az utolso nyer (egy fajlt tamogat a parser)', () => {
    const body = buildBody([
      filePart('f1', 'elso.png', 'A', 'image/png'),
      filePart('f2', 'masodik.png', 'B', 'image/jpeg'),
    ])
    const { file } = parseMultipart(body, CT)
    expect(file?.name).toBe('masodik.png')
    expect(file?.data.toString('binary')).toBe('B')
  })

  it('a fajl neve nem kerul be a fields-be', () => {
    const body = buildBody([filePart('avatar', 'kep.png', 'D', 'image/png')])
    expect(parseMultipart(body, CT).fields).toEqual({})
  })

  it('ures fajl torzset is elfogad', () => {
    const body = buildBody([filePart('avatar', 'ures.png', '', 'image/png')])
    const { file } = parseMultipart(body, CT)
    expect(file?.name).toBe('ures.png')
    expect(file?.data.length).toBe(0)
  })

  it('a binaris bajtokat vesztesegmentesen adja vissza (0x00-0xFF)', () => {
    const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f"; filename="all.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'binary',
    )
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'binary')
    const { file } = parseMultipart(Buffer.concat([head, raw, tail]), CT)
    expect(file?.data.equals(raw)).toBe(true)
  })
})

describe('parseMultipart - kihagyott reszek', () => {
  it('a lezaro "--\\r\\n" epilogust atugorja', () => {
    // buildBody minden torzset `--BOUNDARY--\r\n`-nel zar, igy a split
    // utolso eleme pontosan `--\r\n`.
    const body = buildBody([fieldPart('a', '1')])
    expect(body.toString('binary').endsWith(`--${BOUNDARY}--\r\n`)).toBe(true)
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('a CRLF nelkul lezart "--" epilogust atugorja', () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\n${fieldPart('a', '1')}\r\n--${BOUNDARY}--`,
      'binary',
    )
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('a boundary elotti preambulumot atugorja', () => {
    const body = Buffer.from(
      `Ez egy MIME preambulum.\r\n--${BOUNDARY}\r\n${fieldPart('a', '1')}\r\n--${BOUNDARY}--\r\n`,
      'binary',
    )
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('a Content-Disposition nelkuli reszt atugorja', () => {
    const body = buildBody([
      'X-Egyeb-Header: valami\r\n\r\nnincs diszpozicio',
      fieldPart('a', '1'),
    ])
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('a header-lezaro CRLFCRLF nelkuli reszt atugorja', () => {
    const body = buildBody([
      'Content-Disposition: form-data; name="csonka"',
      fieldPart('a', '1'),
    ])
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('a name="..." nelkuli reszt atugorja', () => {
    const body = buildBody([
      'Content-Disposition: form-data\r\n\r\nnevtelen torzs',
      fieldPart('a', '1'),
    ])
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('az ures nevu mezot (name="") atugorja, mert a [^"]+ legalabb egy karaktert kovetel', () => {
    const body = buildBody(['Content-Disposition: form-data; name=""\r\n\r\nertek'])
    expect(parseMultipart(body, CT)).toEqual({ fields: {} })
  })

  it('csak epilogust tartalmazo torzsbol ures eredmeny lesz', () => {
    const body = Buffer.from(`--${BOUNDARY}--\r\n`, 'binary')
    expect(parseMultipart(body, CT)).toEqual({ fields: {} })
  })

  it('ures buffer eseten ures eredmeny', () => {
    expect(parseMultipart(Buffer.alloc(0), CT)).toEqual({ fields: {} })
  })
})

// A kovetkezo blokk egyreszt javitott pinning teszteket tartalmaz (cim + expect
// atirva aktiv korrekciora a 4 egykori defect eseten), masreszt ket
// edge-case-t rogzit (case-insensitive Content-Disposition, forditott sorrendu
// filename/name).
describe('parseMultipart - ismert eltresek (pinning)', () => {
  it('a quoted-string boundary-rol leveszi az idezojeleket (RFC 2046)', () => {
    // RFC 2046 szerint a boundary lehet quoted-string. A regex a `boundary="..."`
    // formaban megadott boundary-rol levagja az idezojeleket, es csak a token-t
    // hasznalja a szeteldarabolashoz.
    const body = buildBody([fieldPart('greeting', 'hello')])
    const parsed = parseMultipart(body, `multipart/form-data; boundary="${BOUNDARY}"`)
    expect(parsed.fields.greeting).toBe('hello')
    expect(parsed.file).toBeUndefined()
  })

  it('a boundary-t a kovetkezo parameter elott lezarja (RFC 2045)', () => {
    const body = buildBody([fieldPart('greeting', 'hello')])
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${BOUNDARY}; charset=utf-8`)
    expect(parsed.fields.greeting).toBe('hello')
  })

  it('a szoveges mezoket UTF-8-kent dekodolja (RFC 7578)', () => {
    const value = 'árvíztűrő tükörfúrógép'
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="nev"\r\n\r\n`,
      'binary',
    )
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'binary')
    const body = Buffer.concat([head, Buffer.from(value, 'utf8'), tail])

    const parsed = parseMultipart(body, CT)
    expect(parsed.fields.nev).toBe(value)
  })

  it('a fajlnevet UTF-8-kent dekodolja (RFC 7578)', () => {
    const filename = 'árvíz.png'
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f"; filename="${filename}"\r\n` +
        `Content-Type: image/png\r\n\r\nD\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    )
    const name = parseMultipart(body, CT).file?.name
    expect(name).toBe(filename)
  })

  it('a Content-Disposition header nevet case-insensitive modon fogadja el (RFC 9110)', () => {
    // A HTTP header nevek RFC 9110 szerint case-insensitive-ek, es a parser
    // a `part.toLowerCase().includes('content-disposition')` mintat koveti.
    const body = buildBody(['content-disposition: form-data; name="a"\r\n\r\n1'])
    expect(parseMultipart(body, CT).fields).toEqual({ a: '1' })
  })

  it('forditott sorrendu filename/name eseten a fajlnevbol lesz a mezonev', () => {
    // A regex a name=" prefixet koveteli, igy a filename="..."-re nem illeszkedik;
    // a fajl-ág eldobja a fieldName-et, ezert a file.name helyes marad.
    const part =
      'Content-Disposition: form-data; filename="a.png"; name="avatar"\r\nContent-Type: image/png\r\n\r\nD'
    const body = Buffer.from(`--${BOUNDARY}\r\n${part}\r\n--${BOUNDARY}--\r\n`, 'binary')
    const { file, fields } = parseMultipart(body, CT)
    expect(file?.name).toBe('a.png')
    expect(fields).toEqual({})
  })
})
