# routes/ideas: nem-Error dobás esetén a breakdown 500 üres törzzsel válaszol

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/web/routes/ideas.ts:186-189` -- `POST /api/ideas/:id/breakdown`

## Excerpt

```ts
try {
  const result = await generateBreakdown(idea.title, idea.description)
  json(res, { subtasks: result.subtasks })
} catch (err) {
  logger.error({ err, ideaId }, 'Idea breakdown generation failed')
  json(res, { error: (err as Error).message }, 500)
}
```

Az `err` típusa `unknown`, a `as Error` cast pedig csak a fordítót hallgattatja el --
futásidőben semmi nem garantálja, hogy van `.message` mezője.

## Failure scenario

Ha a `generateBreakdown` nem `Error` példánnyal utasít el, `(err as Error).message`
`undefined` lesz, és `JSON.stringify({ error: undefined })` a kulcsot **kihagyja**:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/json; charset=utf-8

{}
```

A kliens így egy 500-at kap, aminek a törzsében nulla információ van. A dashboard
hibakiírása az `error` mezőre épül, tehát üres hibaüzenetet mutat a felhasználónak.

Hogy jöhet nem-Error dobás ebből a hívási láncból (`src/web/llm-breakdown.ts`):

* `runAgent` (`src/agent.ts`) az Agent SDK-t hajtja; az SDK stream-hibái és a
  `Promise.reject(<string>)` mintát követő rétegek nem garantálják az `Error`-t.
* Bármely `throw 'valami'` a láncban (harmadik féltől jövő modul, JSON-hiba
  kézzel dobva) ugyanezt eredményezi.
* Egy `AggregateError` esetén van `.message`, de az üres string szokott lenni --
  akkor `{"error":""}` megy ki, ami ugyanolyan használhatatlan.

**Súlyosság:** alacsony. A `logger.error` a teljes `err`-t kiírja, tehát a
diagnosztika nem vész el, csak a kliens marad üres kézzel.

## Pinning test

`src/__tests__/ideas-routes.test.ts`, `describe('POST /api/ideas/:id/breakdown')`:

- `returns an empty 500 body when a non-Error value is thrown` -- a mai `{}` törzset állítja
- `500s and logs when the generator rejects` -- az `Error` ág, ez fix után is zöld marad

## Suggested direction

Normalizálás cast helyett:

```ts
const message = err instanceof Error && err.message ? err.message : String(err)
json(res, { error: message }, 500)
```

Ez a projekt `as`-tilalmával is összhangban van (CLAUDE.md 7. pont): a `as Error`
pont az a fajta cast, ami elrejti a típushibát ahelyett, hogy kezelné.

Nyitott döntés a tulajdonosnak: a nyers `String(err)` kiszivárogtathat belső
részletet (stack-részlet, prompt-töredék) a kliens felé. Ha ez nem kívánatos,
állandó szöveget kell visszaadni (`'Az ötlet-bontás nem sikerült'`) és a részletet
csak a naplóban hagyni. Nem döntöttem el helyetted.
