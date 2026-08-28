import { describe, it, expect } from 'vitest'
import { formatForTelegram, escapeHtml, splitMessage } from '../format.js'
import { formatForSlackMrkdwn } from '../channel-provider.js'

describe('formatForTelegram', () => {
  it('felcimeket vastagit (h1)', () => {
    expect(formatForTelegram('# Cim')).toBe('<b>Cim</b>')
  })

  it('felcimeket vastagit (h2-h6)', () => {
    expect(formatForTelegram('## Sub')).toBe('<b>Sub</b>')
    expect(formatForTelegram('### Tri')).toBe('<b>Tri</b>')
    expect(formatForTelegram('#### Negy')).toBe('<b>Negy</b>')
    expect(formatForTelegram('##### Ot')).toBe('<b>Ot</b>')
    expect(formatForTelegram('###### Hat')).toBe('<b>Hat</b>')
  })

  it('felcimet csak sor elejen ismeri fel', () => {
    expect(formatForTelegram('szoveg # nem cim')).toBe('szoveg # nem cim')
  })

  it('vastagitast konvertal (**-al)', () => {
    expect(formatForTelegram('ez **vastag** szoveg')).toBe('ez <b>vastag</b> szoveg')
  })

  it('vastagitast konvertal (__-al)', () => {
    expect(formatForTelegram('ez __vastag__ szoveg')).toBe('ez <b>vastag</b> szoveg')
  })

  it('doltbetut konvertal (*-al)', () => {
    expect(formatForTelegram('ez *dolt* szoveg')).toBe('ez <i>dolt</i> szoveg')
  })

  it('doltbetut konvertal (_-al)', () => {
    expect(formatForTelegram('ez _dolt_ szoveg')).toBe('ez <i>dolt</i> szoveg')
  })

  it('inline kodot konvertal', () => {
    expect(formatForTelegram('hasznald a `parancs` kodot')).toBe(
      'hasznald a <code>parancs</code> kodot'
    )
  })

  it('tobb inline kodot is kezel', () => {
    expect(formatForTelegram('`a` es `b`')).toBe('<code>a</code> es <code>b</code>')
  })

  it('kodblokkot konvertal nyelvvel', () => {
    const input = '```js\nconsole.log("hello")\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre><code class="language-js">')
    expect(result).toContain('console.log')
    expect(result).toContain('</code></pre>')
  })

  it('kodblokkot konvertal nyelv nelkul', () => {
    const input = '```\nplain text\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('plain text')
    expect(result).not.toContain('language-')
    expect(result).toContain('</pre>')
  })

  it('kodblokk tartalmat HTML-escape-eli', () => {
    const input = '```js\n<div>&x</div>\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('&lt;div&gt;')
    expect(result).toContain('&amp;')
    expect(result).not.toContain('<div>')
  })

  it('kodblokk trailing whitespace-et levagja', () => {
    const input = '```\nhello   \n```'
    expect(formatForTelegram(input)).toContain('hello')
    expect(formatForTelegram(input)).not.toContain('hello   ')
  })

  it('inline kod tartalmat HTML-escape-eli', () => {
    expect(formatForTelegram('`<a>&b</a>`')).toBe(
      '<code>&lt;a&gt;&amp;b&lt;/a&gt;</code>'
    )
  })

  it('inline kod megorzi a markdown szintaxist', () => {
    expect(formatForTelegram('`ez **nem** vastag`')).toBe(
      '<code>ez **nem** vastag</code>'
    )
  })

  it('kodblokk megorzi a markdown szintaxist', () => {
    const input = '```\n*nem* **vastag**\n```'
    expect(formatForTelegram(input)).toContain('*nem*')
    expect(formatForTelegram(input)).toContain('**vastag**')
  })

  it('athuzast konvertal', () => {
    expect(formatForTelegram('ez ~~torolt~~ szoveg')).toBe('ez <s>torolt</s> szoveg')
  })

  it('linkeket konvertal', () => {
    expect(formatForTelegram('[szoveg](https://pelda.hu)')).toBe(
      '<a href="https://pelda.hu">szoveg</a>'
    )
  })

  it('tobb linket is kezel', () => {
    expect(formatForTelegram('[a](u1) [b](u2)')).toBe(
      '<a href="u1">a</a> <a href="u2">b</a>'
    )
  })

  it('HTML karaktereket escape-el', () => {
    expect(formatForTelegram('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('& elobb escape-el mint < vagy >', () => {
    expect(formatForTelegram('&<>')).toBe('&amp;&lt;&gt;')
  })

  it('ures szoveget uresre konvertal', () => {
    expect(formatForTelegram('')).toBe('')
  })

  it('csak whitespace-bol ures string lesz', () => {
    expect(formatForTelegram('   \n\n  ')).toBe('')
  })

  it('whitespace-et vag a vegen', () => {
    expect(formatForTelegram('  hello  ')).toBe('hello')
  })

  it('plain szoveget atenged', () => {
    expect(formatForTelegram('hello world')).toBe('hello world')
  })

  it('jelolonegyzetet ures allapotra csereli', () => {
    expect(formatForTelegram('- [ ] teendo')).toBe('☐ teendo')
  })

  it('jelolonegyzetet pipa allapotra csereli', () => {
    expect(formatForTelegram('- [x] kesz')).toBe('☑ kesz')
  })

  it('--- elvalaszto vonalat eltavolitja', () => {
    expect(formatForTelegram('felette\n---\nalatta')).toBe('felette\n\nalatta')
  })

  it('*** elvalaszto vonalat eltavolitja', () => {
    expect(formatForTelegram('felette\n***\nalatta')).toBe('felette\n\nalatta')
  })

  it('tobb elvalasztot is eltavolit', () => {
    expect(formatForTelegram('a\n---\nb\n***\nc')).toBe('a\n\nb\n\nc')
  })

  it('sor vegi elvalaszto is eltunik', () => {
    expect(formatForTelegram('szoveg\n---')).not.toContain('---')
  })

  it('inline kod elotti szoveget megorzi', () => {
    expect(formatForTelegram('prefix `code` suffix')).toBe(
      'prefix <code>code</code> suffix'
    )
  })

  it('kodblokk elotti es utani szoveget megorzi', () => {
    const input = 'prefix\n```js\nx\n```\nsuffix'
    const result = formatForTelegram(input)
    expect(result).toContain('prefix')
    expect(result).toContain('<pre>')
    expect(result).toContain('suffix')
  })

  it('tobb kodblokkot is kezel', () => {
    const input = '```\na\n```\n中间的\n```\nb\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('a')
    expect(result).toContain('b')
  })
})

describe('escapeHtml', () => {
  it('ures stringet uresre csereli', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('specialis karakter nelkuli szoveget atenged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })

  it('&-t &amp;-ra csereli', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('<-t &lt;-re csereli', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b')
  })

  it('>-t &gt;-re csereli', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  it('mind harom karaktert egyszerre escape-eli', () => {
    expect(escapeHtml('&<>')).toBe('&amp;&lt;&gt;')
  })

  it('&-t elobb dolgozza fel mint < vagy > (nincs dupla escape)', () => {
    // Ha '&' utoljara dolgozod fel, '&lt;' '&amp;lt;' lenne. Helyes sorrend: '&amp;lt;'.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('tobb & jelet is kezel', () => {
    expect(escapeHtml('a && b')).toBe('a &amp;&amp; b')
  })
})

describe('splitMessage', () => {
  it('rovid uzenetet egy darabban ad vissza', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('ures uzenetet egy darabban ad vissza', () => {
    expect(splitMessage('')).toEqual([''])
  })

  it('pont limit hosszu uzenetet egy darabban ad vissza', () => {
    expect(splitMessage('x'.repeat(4096))).toEqual(['x'.repeat(4096)])
  })

  it('hosszu uzenetet sortoresnel bontja', () => {
    const long = 'A '.repeat(2500) // >4096 karakter
    const chunks = splitMessage(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('hosszu uzenetet szokoznel bontja ha nincs sortores', () => {
    const long = 'a'.repeat(5000)
    const chunks = splitMessage(long, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })

  it('ha nincs se sortores se szokoz, limitnel vag', () => {
    // Nincs \n se ' ', tehat a splitAt = limit fallback-re megy.
    const text = 'X'.repeat(1000)
    const chunks = splitMessage(text, 50)
    expect(chunks.length).toBe(20)
    for (const chunk of chunks) {
      expect(chunk.length).toBe(50)
    }
  })

  it('ha nincs szokoz, de van sortores a limit utan, megis szokoznel vag', () => {
    // Szokoz a limit elejen (<30%), tehat a space-search is limit-re esik.
    const text = 'X XXXXXXXX'.repeat(50)
    const chunks = splitMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10)
    }
  })

  it('ha a sortores nagyon koran van, szokozot keres', () => {
    // \n az 1-es pozicion, de a space-search egyedul marad -> limit-re esik.
    const text = 'X\n' + 'X'.repeat(100)
    const chunks = splitMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10)
    }
  })

  it('egyeni limitet hasznal', () => {
    const text = 'abc\ndef\nghi\njkl'
    const chunks = splitMessage(text, 8)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('sortoresnel bont ha az eleg kozel van a limithoz', () => {
    // \n a 4. pozicion, limit=10: 4 >= 0.3*10=3, tehat splitAt=4.
    const text = 'XXXX\nYYYYYYY'
    const chunks = splitMessage(text, 10)
    expect(chunks).toEqual(['XXXX', 'YYYYYYY'])
  })

  it('chunk-okat trim-eli (nincs leading whitespace)', () => {
    const text = 'alma\n\n  kortefa'
    const chunks = splitMessage(text, 6)
    // Az elso chunk utan a kovetkezo nem space-vel kezdodik.
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trimStart())
    }
  })

  it('a vegen levo utolso chunk megmarad akkor is ha kisebb mint limit', () => {
    const text = 'a'.repeat(100)
    const chunks = splitMessage(text, 30)
    expect(chunks.length).toBe(4) // 30 + 30 + 30 + 10
    expect(chunks[chunks.length - 1]?.length).toBe(10)
  })

  it('default limit a MAX_MESSAGE_LENGTH (4096)', () => {
    const text = 'a'.repeat(4097)
    const chunks = splitMessage(text)
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.length).toBe(4096)
    expect(chunks[1]?.length).toBe(1)
  })
})

describe('formatForSlackMrkdwn', () => {
  it('converts markdown headers to bold', () => {
    expect(formatForSlackMrkdwn('# Hello')).toBe('*Hello*')
    expect(formatForSlackMrkdwn('## Section')).toBe('*Section*')
    expect(formatForSlackMrkdwn('### Sub')).toBe('*Sub*')
  })

  it('converts **bold** to mrkdwn bold', () => {
    expect(formatForSlackMrkdwn('ez **vastag** szoveg')).toBe('ez *vastag* szoveg')
  })

  it('converts __bold__ to mrkdwn bold', () => {
    expect(formatForSlackMrkdwn('ez __vastag__ szoveg')).toBe('ez *vastag* szoveg')
  })

  it('converts markdown links to Slack format', () => {
    expect(formatForSlackMrkdwn('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('converts strikethrough to single tilde', () => {
    expect(formatForSlackMrkdwn('~~torolt~~')).toBe('~torolt~')
  })

  it('converts checkboxes to Slack emojis', () => {
    expect(formatForSlackMrkdwn('- [ ] teendo')).toContain(':white_square:')
    expect(formatForSlackMrkdwn('- [x] kesz')).toContain(':white_check_mark:')
  })

  it('removes horizontal rules', () => {
    expect(formatForSlackMrkdwn('above\n---\nbelow')).not.toContain('---')
    expect(formatForSlackMrkdwn('above\n***\nbelow')).not.toContain('***')
  })

  it('preserves inline code', () => {
    expect(formatForSlackMrkdwn('use `cmd` here')).toBe('use `cmd` here')
  })

  it('preserves code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```'
    expect(formatForSlackMrkdwn(input)).toContain('```')
  })

  it('trims whitespace from output', () => {
    expect(formatForSlackMrkdwn('  hello  ')).toBe('hello')
  })
})
