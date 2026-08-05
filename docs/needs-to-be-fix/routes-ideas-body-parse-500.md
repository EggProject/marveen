# routes/ideas: hibás JSON body 500-as generikus hibát ad 400 helyett

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/web/routes/ideas.ts:43`, `:86`, `:138`, `:152`, `:201` -- minden body-t olvasó ág

## Excerpt

Öt helyen fut nyers `JSON.parse` védelem nélkül:

```ts
const body = await readBody(req)
const data = JSON.parse(body.toString()) as { title: string; /* ... */ }   // :43  POST /api/ideas
const data = JSON.parse(body.toString()) as { title?: string; /* ... */ }  // :86  PUT  /api/ideas/:id
const { author, content } = JSON.parse(body.toString()) as { ... }         // :138 POST .../comments
const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan' }  // :152 POST .../promote
const { subtasks, success_criteria } = JSON.parse(body.toString()) as {...}// :201 POST .../promote-breakdown
```

A `tryHandleIdeas` egésze `try`/`catch` nélküli, tehát a dobás kifut a handlerből.

## Failure scenario

Két külön dobási mód van, mindkettő ugyanoda vezet:

1. **Szintaktikailag hibás body** (`nem json`, csonkolt kérés, üres body) --
   `JSON.parse` `SyntaxError`-t dob.
2. **Érvényes JSON, de `null`** (`Content-Type: application/json`, body: `null`) --
   a parse lefut, majd a `data.title` / destrukturálás `TypeError`-t dob
   (`Cannot destructure property 'author' of 'null'`).

Mindkettő a `src/web.ts:219` közös catch-ébe fut:

```ts
} catch (err) {
  logger.error({ err }, 'Web szerver hiba')
  json(res, { error: 'Szerver hiba' }, 500)
}
```

A kliens tehát **500 + "Szerver hiba"** választ kap egy tisztán kliensoldali hibára,
ami háromféleképpen rossz:

* A dashboard hibakezelése (és bármely ágens, ami curl-lel hív) nem tudja
  megkülönböztetni a saját rossz kérését a szerver leállásától, így értelmetlen
  újrapróbálkozásba kezd egy olyan kérésre, ami sosem fog sikerülni.
* Minden ilyen kérés `logger.error` szintű sort ír, azaz egy elgépelt curl
  hívás ugyanolyan súlyú riasztást generál, mint egy valódi szerverhiba.
* Az endpointok saját validációja következetesen 400-at ad (`title required`,
  `content required`, `impact must be 1-5 or null`) -- a parse-hiba kilóg ebből
  a szerződésből.

**Súlyosság:** alacsony. Nem ír adatot, nem szivárogtat: a hibás kérés egyszerűen
rossz státuszkóddal és félrevezető naplósorral zárul.

## Pinning test

`src/__tests__/ideas-routes.test.ts`, `describe('pinned defects')`:

- `throws out of the handler on a malformed body (%s %s)` -- mind az öt ágra
- `throws out of the handler on a literal null body (%s %s)` -- mind az öt ágra
- `throws out of the handler on an empty body`

A tesztek `rejects.toThrow(...)`-ot állítanak, azaz azt rögzítik, hogy a hiba
KIFUT a handlerből. Fix után ezeket 400-as válaszra kell átírni.

## Suggested direction

Egy közös helper a modul tetején, ami a null-t is elkapja:

```ts
function parseBody<T>(raw: Buffer): T | null {
  try {
    const v: unknown = JSON.parse(raw.toString())
    return v !== null && typeof v === 'object' ? (v as T) : null
  } catch { return null }
}
```

Majd minden ágon:

```ts
const data = parseBody<{ title: string /* ... */ }>(await readBody(req))
if (!data) { json(res, { error: 'érvénytelen JSON body' }, 400); return true }
```

Figyelendő: a `POST .../breakdown` ág (`ideas.ts:180`) szándékosan nem olvas body-t,
azt nem kell hozzányúlni.

Nyitott döntés a tulajdonosnak: ez a minta a `src/web/routes/` több moduljában
ismétlődik. Ha egységes megoldás kell, a `readBody` mellé érdemes egy
`readJsonBody(req, res)` helpert tenni a `http-helpers.ts`-be, ami maga írja ki a
400-at -- de az az egész routes mappát érinti, nem csak ezt a fájlt.
