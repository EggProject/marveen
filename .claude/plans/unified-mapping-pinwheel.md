# Fix `routes-tool-log-uncaught-json-parse`

## Context

A `docs/needs-to-be-fix/routes-tool-log-uncaught-json-parse` MD-ben rögzített
defekt: `src/web/routes/tool-log.ts` két helyen (`POST /api/tool-log` és
`POST /api/tool-log/prune`) a kérés törzsét védelem nélkül `JSON.parse`
olvasza be. A `SyntaxError` kifut a `tryHandleToolLog`-ból, a `src/web.ts:219`
catch-e `HTTP 500 {"error":"Szerver hiba"}` választ küld — ez szerverhiba
státuszkód egy kliensoldali (szintaktikailag hibás body) problémára. A testvér
endpoint-ok (`agent-taskstate`, `agent-terminal`, `voice`, `agents`) már
mind a `try/catch -> {error: 'Invalid JSON'} 400` mintát használják.

A cél: a tool-log route-ok is ezt a mintát kövessék, így a rossz body 400-as
validációs hibát kapjon, és a dispatcher külső catch-e ne aktiválódjon.

Megjegyzés: az MD a jelenlegi viselkedést "502 / connection reset"-ként írja
le; a valóságban a throw szinkron (nem Promise rejection), így a külső
`src/web.ts:219` catch elkapja és `HTTP 500` megy ki. A szubsztancia (nincs
400) ugyanaz, csak a státuszkód rossz az MD-ben.

## Módosítás

Branch: `test/baseline`. Lokális commit. Push tilos.

### 1. `src/web/routes/tool-log.ts` — két JSON.parse try/catch wrap

**Site 1 — `:11` (`POST /api/tool-log`)** — cseréld ki a jelenlegi:

```ts
const data = JSON.parse(body.toString()) as {
  session_id: string
  tool_name: string
  input_summary?: string
  success?: boolean
  agent_id?: string
  trace_id?: string
  duration_ms?: number
}
```

sort erre (a `let data: { ... }` típust a `try` fölé deklaráljuk):

```ts
let data: {
  session_id: string
  tool_name: string
  input_summary?: string
  success?: boolean
  agent_id?: string
  trace_id?: string
  duration_ms?: number
}
try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
```

**Site 2 — `:59` (`POST /api/tool-log/prune`)** — cseréld ki:

```ts
const data = JSON.parse(body.toString()) as { older_than_secs?: number }
```

sort erre:

```ts
let data: { older_than_secs?: number }
try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
```

A minta (`let fields: ...; try { ... } catch { json(...); return true }`)
verbatim tükrözi `src/web/routes/agent-taskstate.ts:48-49`-et. Nem vezetünk
be új helper-t (`http-helpers.ts`-ben nincs `parseJsonBody`/`readJsonBody`,
és a szomszédos route-ok is mind inlinelnek — az inline konzisztens).

### 2. `src/__tests__/tool-log-routes.test.ts` — két pinning teszt

A `call()` helper, a `mkReq`, `mkRes`, `json()`, valamint a `mocks.logToolCall`
/ `mocks.pruneToolCallLog` reset az `beforeEach`-ben már megvan. Két új `it`
blokkot adunk hozzá:

- A `describe('POST /api/tool-log', ...)` blokkba (a :226-os záró `})` előtt),
  közvetlenül a `'returns 400 when tool_name is missing'` teszt (`:218-225`)
  után, egy új `it`:

  ```ts
  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/tool-log', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(mocks.logToolCall).not.toHaveBeenCalled()
  })
  ```

- A `describe('POST /api/tool-log/prune', ...)` blokkba (a :371-es záró `})`
  előtt), közvetlenül a `'returns ok=true even when there are no rows to delete'`
  teszt után, egy új `it`:

  ```ts
  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/tool-log/prune', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(mocks.pruneToolCallLog).not.toHaveBeenCalled()
  })
  ```

A két teszt közvetlen másolata a `src/__tests__/agent-taskstate-routes.test.ts:202-206`
mintának, plusz a `not.toHaveBeenCalled()` negatív-oldali assertáció (a `logToolCall` /
`pruneToolCallLog` mock-ok a `beforeEach`-ben resetelődnek, tehát frissek).

### 3. `docs/needs-to-be-fix/INDEX.md` — Resolved oszlop kitöltése

A `routes-tool-log-uncaught-json-parse` sor (line 171) `Resolved` cellája
jelenleg `—`. Töltsd ki `<YYYY-MM-DD> <commit-sha>` formátumban a fix
commit SHA-jával, a többi `Resolved: 2026-08-XX <sha>` sor formátumát
követve.

## Referenciák (reuse, ne írj újat)

- **Minta forrás:** `src/web/routes/agent-taskstate.ts:44-49` — `let fields: ...; try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }`
- **Minta teszt:** `src/__tests__/agent-taskstate-routes.test.ts:202-206` — `expect(res.statusCode).toBe(400); expect(json()).toEqual({ error: 'Invalid JSON' })`
- **Harness (már megvan):** `src/__tests__/tool-log-routes.test.ts:96-113` (`call()`), `:20-29` (`mocks`), `:115-124` (`beforeEach` reset)
- **Dispatcher kontextus:** `src/web.ts:206` (hívás), `:219-222` (külső catch — ez aktiválódik ma, a fix után nem)

## Fájlok, amiket módosítunk

- `src/web/routes/tool-log.ts` — 2× try/catch bevezetése a két JSON.parse helyen (6 új sor, 0 törölt sor)
- `src/__tests__/tool-log-routes.test.ts` — 2× `it` pinning teszt hozzáadása (~10 sor)
- `docs/needs-to-be-fix/INDEX.md` — 1 cella frissítése a `Resolved` oszlopban

## Végrehajtás workflow

A felhasználó jóváhagyta, hogy a fix egy workflow-ban fusson le subagent-ekkel
(approval gate nélkül). A workflow a következő fázisokból áll:

1. **Apply** — subagent alkalmazza a két try/catch módosítást a
   `src/web/routes/tool-log.ts`-ban és hozzáadja a két pinning tesztet a
   `src/__tests__/tool-log-routes.test.ts`-hoz. Nincs helper-extrakció, nincs
   refaktor.
2. **Verify** — subagent futtatja:
   - `bunx vitest run src/__tests__/tool-log-routes.test.ts` — az új
     pinning tesztek átmennek, a többi teszt nem törik el
   - `bunx tsc --noEmit` — a hiba-szám nem nő (baseline: 1703 az INDEX.md
     szerint)
   - Ha bármelyik elbukik, a workflow megáll és jelenti a hibát; nem commitol
3. **Commit** — subagent lokálisan commitol `test/baseline`-ra a meglévő
   commit-message konvencióval:
   `fix(tool-log): wrap JSON.parse in try/catch returning 400 (closes routes-tool-log-uncaught-json-parse)`
4. **Docs** — subagent frissíti az INDEX.md `Resolved` celláját és commitolja
   egy második commit-ban: `docs(needs-to-be-fix): mark routes-tool-log-uncaught-json-parse resolved`

A workflow NEM pushol — kizárólag lokális commitok. A push a user kiváltsága.

## Verification

A workflow végén:

- `git -C test-baseline log --oneline -3` mutatja a két új commitot
- `git -C test-baseline status` clean
- A `tool-log-routes.test.ts` lefutott, minden teszt zöld (36/36 — a
  jelenlegi 34 + 2 új pinning)
- A `bunx tsc --noEmit` kimenet megegyezik a baseline 1703 hibával
- A `keychain.test.ts` (30 teszt) és a `vault.test.ts` (25 teszt) továbbra
  is zöld — ezek a Cycle 17 referenciái

Kockázatok és mitigáció:

- A `let data: { ... }` típus-deklaráció TypeScript strict módban megköveteli,
  hogy a `try` blokk mindenképp hozzárendeljen — a `try { data = ... }` forma
  ezt garantálja. Ha a strict mód ezt jelölné, a `Record<string, unknown>`
  típus az `agent-taskstate.ts:48`-cal azonos fallback.
- Ha egy jövőbeli caller szintén hibás body-t küld, a `mocks.logToolCall`
  `.not.toHaveBeenCalled()` negatív assertió megvéd attól, hogy a fix
  regresszáljon.