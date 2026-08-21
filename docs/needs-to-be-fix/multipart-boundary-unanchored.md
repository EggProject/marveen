# multipart.ts: a boundary regex unanchored, captures the WRONG boundary when a hijack parameter precedes the real one

## Location

`src/web/multipart.ts`, line 13 (a `parseMultipart` body elején):

```ts
// Elotte (a 2026-08-21 fix elott):
const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
```

## Excerpt

A regex literal `boundary=` illeszkedik a substringre `myboundary=` belsejében
is, mert nincs anchor. Egy kliens, amely `multipart/form-data;
myboundary=WRONG; boundary=REAL` content-type-ot kuld, a parser a
`WRONG`-ot fogja meg boundary-nek, a valodi `REAL` soha nem kerul kiertekelesre.

A forditott eset (a valodi boundary jon eloszor) mukodik, mert
`.match()` az elso illeszkedest adja vissza, de a WRONG boundaryvel
feldolgozott buffer soha nem tartalmazza a `--REAL` delimitert, igy a
parser `{ fields: {} }`-t ad vissza csendben, mint egy ures multipart body.

## Failure scenario

1. Egy kliens (curl script, reverse proxy, HTTP/2 intermediary, vagy
   hibasan konfiguralt framework) kuld egy content-type-ot:
   `multipart/form-data; myboundary=WRONG; boundary=REAL`
2. `parseMultipart` a `boundaryMatch[2]`-be `WRONG`-ot rak.
3. `buf.toString('latin1').split('--WRONG')` egyetlen elemet ad (a
   valodi delimiter a `--REAL`, ami soha nem fordul elo).
4. Az egesz buffer egyetlen part-kent kerul feldolgozasra; a
   `Content-Disposition` header megtalalhato, igy a parser kinyeri a
   `greeting` mezonevet, de a body-hoz hozzaadodik a `--REAL--` delimiter
   szemet (`hello\r\n--REAL--`).
5. A parser `{ fields: { greeting: 'hello\r\n--REAL--' } }`-t ad vissza,
   `file` viszont `undefined` marad (nincs `filename=` parameter).

Akovetkezmeny: `POST /api/agents/import` (`src/web/routes/agents.ts:1916`)
a `No bundle uploaded` (400) uzenetet adja, pedig a bundle a body-ban
volt (a `file` kulcs hianya miatt a `bundle` lokalis valtozo soha nem
kap erteket). Ugyanez erinti `src/web/routes/marveen.ts:193`,
`skills.ts:387`, `agents-skills.ts:79`-et.

## Pinning test

`src/__tests__/multipart.test.ts` ujonnan hozzaadott teszt a fix
mellet (megtalalhato a `parseMultipart - boundary felismerés`
describe blokkban):

```ts
it('a boundary-t csak akkor fogadja el, ha parameter-eleje boundary (nem myboundary)', () => {
  const body = buildBody([fieldPart('greeting', 'hello')])
  const hijackCT = `multipart/form-data; myboundary=WRONG; boundary=${BOUNDARY}`
  expect(parseMultipart(body, hijackCT).fields).toEqual({ greeting: 'hello' })
})
```

A pinning a REGEX valtozasat rogziti: a `(?<=^|[;,])` lookbehind kizarja
a parameter-kozepepu illeszkedest.

## Suggested direction (mar alkalmazva)

A fix mar megtortent:

```ts
const boundaryMatch = contentType.match(
  /(?<=^|[;,])\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
)
```

A lookbehind `(?<=^|[;,])` kotelezi, hogy a `boundary=` egy uj parameter
elejen vagy a string elejen alljon. A `\s*=\s*` megengedi a whitespace-t
az `=` korul (RFC 2045 §5.1 `linear-white-space`).

A chaining egyetlen atomic regex modositassal oldja meg az unanchored
match (Finding #1) + a linear whitespace (Finding #5) problemait egyutt.

**Status:** RESOLVED 2026-08-21 be69fc8cf4e36a1a6025c4282da45ae36c4937f6 -- boundary regex anchored,
whitespace around `=` accepted per RFC 2045 §5.1.
