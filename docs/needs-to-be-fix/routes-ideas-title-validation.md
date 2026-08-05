# routes/ideas: a title sem trimmelve, sem típusellenőrizve nincs

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/web/routes/ideas.ts:51` -- `POST /api/ideas`

## Excerpt

```ts
if (!data.title) { json(res, { error: 'title required' }, 400); return true }
```

Ugyanebben a fájlban a komment-endpoint (`ideas.ts:139`) háromlépcsős ellenőrzést végez
pontosan ugyanerre a problémára:

```ts
if (!content || typeof content !== 'string' || !content.trim()) {
  json(res, { error: 'content required' }, 400); return true
}
```

A `title` a `!data.title` guardon kívül semmilyen ellenőrzést nem kap, és a `PUT`
ág (`ideas.ts:86-88`) még ennyit sem: ott a `title` bármi lehet.

## Failure scenario

**a) Csak whitespace cím.** `{"title":"   "}` -- a `"   "` truthy, tehát átmegy.
Az ötlet létrejön üresnek látszó címmel. A kanban-promotálás ezt viszi tovább
(`ideas.ts:161`), így a boardon `[Részlet kidolgozás]` szövegű, tartalom nélküli
kártya jelenik meg. Onnantól az ötlet gyakorlatilag azonosíthatatlan a UI-on.

**b) Nem string cím.** `{"title":{"hu":"objektum"}}` -- az objektum truthy, átmegy a
guardon, és nyersen `createIdea`-ba kerül (`ideas.ts:66`), onnan a `better-sqlite3`
`.run()` 11 pozicionális argumentumába (`src/db.ts:2621-2624`). A driver a sima
objektum-argumentumot **névvel megadott paraméterek zsákjának** nézi, nem egy
pozicionális értéknek, így a `?` helyőrzők közül eggyel kevesebbet tölt ki:

```
RangeError: Too few parameter values were provided
```

Ellenőrizve a projekt saját `better-sqlite3` buildjével (v13):
`prepare('INSERT INTO t (a,b,c) VALUES (?,?,?)').run('id', {hu:'x'}, 'z')`.
Boolean címnél (`{"title":true}`) a driver másik hibája jön:
`TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null`.

Mindkét dobás kifut a handlerből a `src/web.ts:219` közös catch-ébe, tehát a kliens
**500 "Szerver hiba"** választ kap egy tisztán kliensoldali hibára. (Ez a
`routes-ideas-body-parse-500` bug testvére: ugyanaz a rossz státuszkód, más forrásból.)

Számot (`{"title":42}`) a driver elfogad, tehát az csendben `42` címmel létrejön.

**Súlyosság:** alacsony. Szándékos rombolást nem tesz lehetővé (a hívó a saját
ötletét rontja el), de a validáció következetlen a szomszédos endpointtal, és a
b) eset félrevezető 500-at ad.

## Pinning test

`src/__tests__/ideas-routes.test.ts`, `describe('pinned defects')`:

- `creates an idea whose title is only whitespace`
- `creates an idea whose title is not a string`

Mindkettő a mai 200-as választ állítja. A második teszt mockolt `createIdea`-val fut,
ezért a driver dobása nem látszik benne -- a mockolt hívás argumentuma rögzíti,
hogy a nyers objektum jut el a DB rétegig.

## Suggested direction

A komment-ág mintája, plusz a már trimmelt érték tárolása:

```ts
const title = typeof data.title === 'string' ? data.title.trim() : ''
if (!title) { json(res, { error: 'title required' }, 400); return true }
// ...
createIdea({ id, title, /* ... */ })
```

Ugyanez kell a `PUT` ágra is (`ideas.ts:86`), ahol jelenleg nulla ellenőrzés van:
ott a `data.title !== undefined` esetén kell ugyanezt lefuttatni.

Nyitott döntés a tulajdonosnak: a `description` / `category` / `source` mezők
ugyanígy ellenőrizetlenek. Ha az egész body-t sémával akarod validálni, az nagyobb
lépés (és a `routes-ideas-body-parse-500`-zal együtt érdemes megcsinálni), mint a
`title` pontszerű javítása. Nem döntöttem el helyetted.
