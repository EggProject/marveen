# Cycle 21 — 3 needs-fix: notify chunk fallback + ideas 409 guard + ideas body-parse

## Context

A `test/baseline` branch tiszta, 0 commit ahead of origin, utolsó push után. A 16-17 korábbi ciklusban zárt bug (Cycle 17-20) után ez a 3 jelölt a legkisebb módosítással járó, még mindig lehetséges bukást hordozó needs-fix elem:

1. **`notify-fallback-repeats-head`** — `src/notify.ts:25`. A `notifyChannel` for-of ciklusban a fallback a `chunk` helyett az eredeti `outbound` első 4096 karakterét küldi újra minden iterációban → a többi chunk farka (pl. a "TAIL" marker) elveszik.
2. **`routes-ideas-promote-double`** — `src/web/routes/ideas.ts:158` (promote) és `:206` (promote-breakdown). A `POST /api/ideas/:id/promote` és `/promote-breakdown` nem ellenőrzi, hogy az idea már `kanban` státuszú-e → második promote új kanban-cardot készít, felülírja a `kanban_id`-t, az első card orphan marad, a `logIdeaStatusChange` `kanban → kanban` sort ír.
3. **`routes-ideas-body-parse-500`** — `src/web/routes/ideas.ts` 5 site: `:43, :87, :144, :159, :208`. Minden `JSON.parse(body.toString())` önmagában try/catch nélkül → `SyntaxError` (malformed) vagy `TypeError` (`null` body, destructure-nél közvetlenül a parse eredményen) kiszökik a handerből, az outer catch (`src/web.ts:219`) 500-at ír.

A korábbi ciklusokban (tool-log, skill-usage, background-tasks) az inline `try/catch` mintát vették át, de csak `'not-json{'` body-ra. Az ideas.ts pinned tesztje a `'null'` body-t is teszteli (`1027-1036` sor), ezért a `null`-őr is kell a teljes fixhez.

Várt eredmény: mindhárom bug lezárul, két fájl érintett (`notify.ts` + `ideas.ts`), három új commit, batch-elt docs commit, push a user kezében.

## Approach

**Commit-struktúra (2 kód + 1 batchelt docs):**

1. `fix(notify): re-send the failing chunk, not the full outbound head (closes notify-fallback-repeats-head)`
2. `fix(ideas): 409 on re-promote, try/catch JSON.parse at 5 sites (closes routes-ideas-promote-double + routes-ideas-body-parse-500)`
3. `docs(needs-to-be-fix): mark 3 cycle-21 items resolved`

A `routes-ideas-promote-double` és a `routes-ideas-body-parse-500` egy fájlba kerül, mert:
- Mindkettő `ideas.ts`-t módosítja → azonos commitban a line-számok nem driftelnek.
- A rollback egység a fájl (félig fixelt state nem marad).
- A cycle-20 minta (`780f126` background-tasks) is egy fájlban egy bugot záró atomicitás.

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/notify.ts` — 1 sor csere a `:25`-ön.
- `/Users/eggp/marveen-develop/test-baseline/src/web/routes/ideas.ts` — 2 guard insert + 5 try/catch insert + 1 destructure-site helper.
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/notify.test.ts` — pinned teszt flip a `:121-135`-ön.
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/ideas-routes.test.ts` — 1 pinned teszt flip (`:668-682`), 1 új pinning teszt (promote-breakdown), 3 pinned teszt flip (`:1015-1040`).
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` — sorok 42, 49, 78 update.

Reusable segédletek / minták (NEM újra feltalálni):
- A JSON.parse try/catch minta verbatim `src/web/routes/tool-log.ts:20`-ból, `src/web/routes/skill-usage.ts:17`-ből, `src/web/routes/background-tasks.ts:149`-ből. Nincs kiemelt helper — az 5 site-ot ismételjük a fájlban, követve a konvenciót.
- A 409/404 response test-minta `src/__tests__/ideas-routes.test.ts:994-1000`-ból (`routes-ideas-comment-orphan` 404 teszt).
- A `revert` guard a `src/web/routes/ideas.ts:258`-ban a polaritás-precedens (`!==` vs `===`).
- A Discord pinning teszt `src/__tests__/notify.test.ts:137-151` — változatlan marad, csak a 3000 char chunk → `chunk.slice(0, 4096)` visszaadja a 3000 char-t (mert 3000 < 4096), így nincs regresszió.

## Per-fix specs

### Fix 1 — `notify-fallback-repeats-head`

`src/notify.ts:25`, egyetlen sor csere:

```diff
       try {
-        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, outbound.slice(0, 4096))
+        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk.slice(0, 4096))
       } catch { /* last resort, give up */ }
```

A `chunk` a for-of ciklusváltozó (`for (const chunk of chunks)` a `:19`-en), scope-ban van a fallback helyén. A `slice(0, 4096)` megmarad (belt-and-suspenders, mert egyedi provider-ek saját splitMessage-t adhatnak). A `notify-fallback-hardcodes-telegram-limit` (ugyanaz a sor) NEM lesz javítva — szándékosan.

### Fix 2 — `routes-ideas-promote-double` (mindkét endpoint)

`src/web/routes/ideas.ts:158`-on (promote) és `:206`-on (promote-breakdown). Mindkét helyen a `409` Conflict guard kerül be a meglévő `404` existence-check után, közvetlenül azelőtt, hogy bármilyen body parse vagy DB write történne.

**Promote (`:163` után, `:165` előtt):**
```ts
    if (idea.status === 'kanban') {
      json(res, { error: 'Ötlet már kanban státuszban van', kanban_id: idea.kanban_id }, 409)
      return true
    }
```

**Promote-breakdown (`:206` után, `:207` előtt — tehát a `readBody` ELŐTT, hogy ne fogyasszunk felesleges body parse-t 409 esetén):**
```ts
    if (idea.status === 'kanban') {
      json(res, { error: 'Ötlet már kanban státuszban van', kanban_id: idea.kanban_id }, 409)
      return true
    }
```

A `kanban_id` body-ban való visszaadása segít a UI-nak dedupolni extra GET nélkül. A polaritás (`===` vs a `revert` `!==` precedense) és a 409 (vs a `revert` 400) a user döntése: re-promote egy state CONFLICT, nem client-hiba.

### Fix 3 — `routes-ideas-body-parse-500` (5 site)

A meglévő closed siblings minta + null-őr kiegészítés, hogy a `'null'` body is 400-at adjon (nem 500-at TypeError-ön).

**Általános forma (`:43, :87, :159` site-okra, ahol `data` van):**
```ts
    let data: { /* fields */ }
    try {
      const parsed: unknown = JSON.parse(body.toString())
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        json(res, { error: 'Invalid JSON' }, 400); return true
      }
      data = parsed as { /* fields */ }
    } catch {
      json(res, { error: 'Invalid JSON' }, 400); return true
    }
```

**Destructure site-okra (`:144, :208`):** a `data` változót `parsed`-re nevezzük át, hogy ne ütközzön a későbbi `const { ... } = parsed` mintával:
```ts
    let parsed: { /* fields */ }
    try {
      const v: unknown = JSON.parse(body.toString())
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        json(res, { error: 'Invalid JSON' }, 400); return true
      }
      parsed = v as { /* fields */ }
    } catch {
      json(res, { error: 'Invalid JSON' }, 400); return true
    }
    const { /* destructure fields */ } = parsed
```

**A 6 típus-helyőrző (site-onként):**
- `:43` (POST /api/ideas): `{ title: string; description?: string; category?: string; source?: string; impact?: number | null; effort?: number | null }`
- `:87` (PUT /api/ideas/:id): `{ title?: string; description?: string; category?: string; status?: IdeaRow['status']; kanban_id?: string; impact?: number | null; effort?: number | null }`
- `:144` (POST comments): `{ author?: string; content?: string }` — destructure
- `:159` (POST promote): `{ phase?: 'detail' | 'plan' }`
- `:208` (POST promote-breakdown): `{ subtasks: Array<{...}>; success_criteria?: string }` — destructure

A `as { /* fields */ }` cast a type declaration-re kerül (`let data: {...}`), ahol a TypeScript az assignment-ből inferálja a típust — a cast maga eltűnik.

## Per-fix test specs

### Test A — notify pinned teszt flip (`notify.test.ts:121-135`)

A jelenlegi pinned teszt (`re-sends the same first 4096 chars for every failing chunk, dropping the tail`) → átfordítva:

```ts
  // Pinned defect (resolved 2026-08-17) -- notify-fallback-repeats-head
  it('re-sends the failing chunk (not the full outbound head) on each fallback attempt', async () => {
    const long = 'x'.repeat(4096) + 'TAIL'
    markIfTestRun.mockReturnValue(long)
    providerMock.splitMessage.mockReturnValue(['chunk-1', 'chunk-2', 'chunk-3'])
    providerMock.sendMessage.mockImplementation(async (_t, _c, _text, parseMode) => {
      if (parseMode === 'HTML') throw new Error('parse error')
    })

    await notifyChannel(long)

    const fallbacks = providerMock.sendMessage.mock.calls.filter((call) => call[3] === undefined)
    expect(fallbacks).toHaveLength(3)
    // Minden fallback a SAJÁT chunkjét küldi, nem az outbound első 4096 karakterét.
    expect(fallbacks.map((call) => call[2])).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
    // Az outbound TAIL része a chunk-3-ban utazik — a bug eldobta.
    expect(fallbacks[2]?.[2]).toContain('TAIL')
    expect(fallbacks[0]?.[2]).not.toContain('TAIL')
  })
```

A `:137-151` (Discord, 3000-char) pinning teszt VÁLTOZATLAN — `chunk.slice(0, 4096)` a 3000 char-os chunkból 3000 char-t ad vissza, így a `expect(call[2]).toHaveLength(3000)` zöld marad.

### Test B — promote pinned teszt flip (`ideas-routes.test.ts:668-682`)

```ts
  // PINNED DEFECT (resolved 2026-08-17) -- routes-ideas-promote-double
  it('returns 409 with the existing kanban_id when re-promoting a kanban idea', async () => {
    seedIdea({ id: 'idea-1', status: 'kanban', kanban_id: 'regi-kartya' })

    const r = await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({}))

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ kanban_id: 'regi-kartya' })
    // A guard a card/idea write-ok ELŐTT rövidre zár — az eredeti card megmarad.
    expect(db.createKanbanCard).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })
```

### Test C — ÚJ promote-breakdown pinning teszt

A `describe('POST /api/ideas/:id/promote-breakdown')` blokkba, az `it('404s for an unknown idea')` (~`:753`) után:

```ts
  // PINNED DEFECT (resolved 2026-08-17) -- routes-ideas-promote-double (sibling)
  it('returns 409 with the existing kanban_id when re-promoting a kanban idea via breakdown', async () => {
    seedIdea({ id: 'idea-1', status: 'kanban', kanban_id: 'regi-kartya' })

    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A' }],
    }))

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ kanban_id: 'regi-kartya' })
    expect(db.createKanbanCard).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })
```

A guard placement BEFORE `readBody` miatt a body soha nem parse-olódik 409 esetén.

### Test D — body-parse 3 pinned teszt flip (`ideas-routes.test.ts:1015-1040`)

**Block 1 (`:1016-1025`, `'nem json'` body — SyntaxError):**
```ts
  // routes-ideas-body-parse-500 (resolved 2026-08-17)
  it.each([
    ['POST', '/api/ideas'],
    ['PUT', '/api/ideas/idea-1'],
    ['POST', '/api/ideas/idea-1/comments'],
    ['POST', '/api/ideas/idea-1/promote'],
    ['POST', '/api/ideas/idea-1/promote-breakdown'],
  ])('returns 400 Invalid JSON on a malformed body (%s %s)', async (method, path) => {
    seedIdea({ id: 'idea-1' })
    const r = await call(method, path, 'nem json')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
    expect(db.createIdea).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
  })
```

**Block 2 (`:1027-1036`, `'null'` body — TypeError null-őr által):**
```ts
  it.each([
    ['POST', '/api/ideas'],
    ['PUT', '/api/ideas/idea-1'],
    ['POST', '/api/ideas/idea-1/comments'],
    ['POST', '/api/ideas/idea-1/promote'],
    ['POST', '/api/ideas/idea-1/promote-breakdown'],
  ])('returns 400 Invalid JSON on a literal null body (%s %s)', async (method, path) => {
    seedIdea({ id: 'idea-1' })
    const r = await call(method, path, 'null')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
    expect(db.createIdea).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
  })
```

**Block 3 (`:1038-1040`, üres body — SyntaxError):**
```ts
  it('returns 400 Invalid JSON on an empty body', async () => {
    const r = await call('POST', '/api/ideas', '')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
  })
```

A `seedIdea({ id: 'idea-1' })` a block 1 és 2-ben marad — a comments (`:148`) és promote-breakdown (`:206`) endpoint-ok existence check-je a body parse előtt fut, így a seed számít.

## Workflow phases

A workflow script 4 fázisa (mindegyik fail-fast):

| Phase | Szerkesztés | Teszt | Commit |
|---|---|---|---|
| A | `src/notify.ts:25` (1 sor) + `notify.test.ts:121-135` pinned flip | `bun --bun vitest run src/__tests__/notify.test.ts` | `fix(notify): ...` |
| B | `src/web/routes/ideas.ts`: 2 promote guard + 5 JSON.parse try/catch (null-őrrel) + 1 promote pinned flip + 1 új promote-breakdown pinning + 3 body-parse pinned flip | `bun --bun vitest run src/__tests__/ideas-routes.test.ts` | `fix(ideas): ...` |
| C | `docs/needs-to-be-fix/INDEX.md` sorok 42, 49, 78 → `Resolved: 2026-08-17 <sha>` (Phase A és B SHÁ-i) | nincs | `docs(needs-to-be-fix): mark 3 cycle-21 items resolved` |
| D | teljes sweep | `bun --bun vitest run` + `bunx tsc --noEmit \| wc -l` | nincs |

**Sikertelen phase esetén** (Pattern 88): a workflow megáll, manuális vizsgálat (pre-fix vs post-fix baseline), ha a fix valóban helyes, manuális commit. A Phase A/B fix kódja a terv alapján triviális, így a FAIL magas valószínűséggel baseline-drift vagy flaky test.

**Phase C függősége:** az A és B phase-ek SHÁ-it `git rev-parse HEAD` után olvassa ki, és ezeket írja az INDEX.md-be.

## Verification matrix

| Check | Parancs | Elvárt |
|---|---|---|
| Phase A target | `bun --bun vitest run src/__tests__/notify.test.ts` | minden zöld, ~13 teszt |
| Phase B target | `bun --bun vitest run src/__tests__/ideas-routes.test.ts` | minden zöld, ~80+ teszt (1 pinned flip + 1 új pinning + 3 pinned flip = +5 módosítás, bruttó +2 új teszt a promote-breakdown és a body-parse változások miatt) |
| Phase D full | `bun --bun vitest run` | nincs új failure; a teljes count megegyezik a baseline-vel + az újonnan hozzáadott/flippelt pinning tesztek számával |
| Phase D typecheck | `bunx tsc --noEmit \| wc -l` | marad ~2255 (az INDEX.md:60-ban lévő 1703 elavult, ne azt használjuk) |
| Commit shape | `git log --oneline -5` | 3 új commit (notify fix, ideas fix, docs batch) |
| INDEX.md | manual: sor 42, 49, 78 | `Resolved: 2026-08-17 <sha>` kitöltve, SHÁ-k egyeznek |
| Git state | `git status` | clean |
| Branch sync | `git rev-list --left-right --count test/baseline...origin/test/baseline` | `3\t0` (3 commit ahead — user pushol, ha kész) |

## Out of scope (explicit)

- `notify-fallback-hardcodes-telegram-limit` — ugyanaz a `:25`-ös sor, de más bug. A pinning teszt a `:137-151`-en VÁLTOZATLAN.
- `routes-ideas-breakdown-nonerror` — már lezárt (2026-08-16, 8bdb2cd).
- `routes-ideas-title-validation` — már lezárt (2026-08-17, cfb72db).
- `routes-ideas-comment-orphan` — már lezárt (2026-08-17, c7c974f).
- `tsc --noEmit` baseline drift — nem bajszgatjuk, csak mérünk.
- INDEX.md row 60 (stale `tsc` count 1703) és a row 49/78 title-ok (`File:Line` elavult) — docs debt, nem Cycle 21.
- Defensive-branch safe-delete-k (retention posture).
- Push — user joga (TILOS pusholni).
- Közös `tryParseBody` helper kiemelése `tool-log.ts`/`skill-usage.ts`/`background-tasks.ts`/`ideas.ts` közé — a konvenció 4 külön inline minta.