# Cycle 23 — schedules-expand-prompt-missing-answers fix

## Context

A `POST /api/schedules/expand-prompt` route (`src/web/routes/schedules.ts:84-87`) az `answers.map` TypeError-t dob, ha a body-ból hiányzik az `answers` mező (vagy nem tömb). A hívás a route try blockján kívül esik, ezért a szerver 500-as generikus hibát ad vissza 400-as validációs hiba helyett.

A MD-ben (`docs/needs-to-be-fix/schedules-expand-prompt-missing-answers.md`) van pinning test (`pins the missing answers array failure`), ami a jelenlegi TypeError viselkedést állítja — ezt át kell írni az új 400-as viselkedésre.

A cél: a hiányzó vagy hibás típusú `answers` 400-as validációs hibát kapjon, és a `runAgent` soha ne hívódjon ilyenkor. A `answers: []` (üres tömb) backward-compat maradjon — ez a meglévő másik tesztek alapján ma is érvényes bemenet.

## Approach

Egyetlen sor beszúrása a meglévő prompt-check után, közvetlenül az `answers.map` hívás elé. A guard ugyanazt a mintát követi, mint a fájl többi validációja (`PUT`, `POST /api/schedules`): `if (!Array.isArray(X)) { json(res, { error: '...' }, 400); return true }`. A sorrend: prompt-check előbb (elsődleges mező), answers-check utána (másodlagos mező).

A `JSON.parse(...) as { ... }` cast megtartása — a cast cseréje `unknown` + type guard-ra kiterjesztené a diff-et. Az `Array.isArray` maga type guard, amely a `answers` típusát a `map` hívás előtt `unknown[]`-re narrow-olja, így a `map` típusbiztonságos marad.

## Critical files

- `src/web/routes/schedules.ts:84-87` — 1 sor beszúrása (új `if (!Array.isArray(answers))` guard)
- `src/__tests__/routes-schedules.test.ts:363-371` — pinning test átírása: 1 régi `it` → 1 `it.each` (4 variánssal) + 1 új `it` (`answers: []` támogatás)
- `docs/needs-to-be-fix/INDEX.md` — `schedules-expand-prompt-missing-answers` sor → `Resolved: 2026-08-17 <SHA>`

## Meglévő minták (reuse)

- `src/web/http-helpers.ts` — `json` helper a 400-as válaszhoz (már használja a meglévő prompt-check)
- `src/web/routes/schedules.ts` többi validáció — `if (!X?.trim())` / `if (!Array.isArray(X))` mintát követi a PUT/POST más végpontokon
- A meglévő `expands a prompt with formatted answers`, `strips a language-tagged code fence`, `returns 500 for agent ...` tesztek mintája az új `it`-ekhez

## Implementation steps

1. **`src/web/routes/schedules.ts`** — 1 új sor a 85. sor után:
   ```ts
   if (!Array.isArray(answers)) { json(res, { error: 'Answers array is required' }, 400); return true }
   ```

2. **`src/__tests__/routes-schedules.test.ts:363-371`** — a "pins the missing answers array failure" teszt cseréje:
   - `it.each([{ label: 'omitted answers', body: { prompt: 'Brief' } }, { label: 'string answers', body: { prompt: 'Brief', answers: 'oops' } }, { label: 'object answers', body: { prompt: 'Brief', answers: { foo: 'bar' } } }, { label: 'null answers', body: { prompt: 'Brief', answers: null } }])('rejects $label with 400 and skips agent', async ({ body }) => { ... })` — 4 variáns, 400-as response + `runAgent` NOT called
   - Új `it('accepts an empty answers array and expands without Kerdes blocks', async () => { ... })` az üres tömb backward-compat biztosítására

3. **`docs/needs-to-be-fix/INDEX.md`** — a `schedules-expand-prompt-missing-answers` sor `Resolved` státuszra állítása a fix commit SHA-val

4. **Commit stack** (lokál `test/baseline`-on marad, push a user kezében):
   - `fix(routes-schedules): validate answers array before mapping (closes schedules-expand-prompt-missing-answers)`
   - `docs(needs-to-be-fix): mark schedules-expand-prompt-missing-answers resolved`

5. **Code review**: `/code-review xhigh --fix` skill

## Verification

- `bun --bun vitest run src/__tests__/routes-schedules.test.ts` — a 4 variánsos `it.each` + az `accepts an empty answers array` teszt mind zöld
- `bun --bun vitest run` — teljes sweep (11107+ teszt), nincs regresszió
- `bunx tsc --noEmit` — nincs új típushiba (a baseline 2255 zajszinten marad)
- `git status` clean a végén
- A `git rev-list --left-right --count test/baseline...origin/test/baseline` a lokál commitig 0\t0 marad

## Risk

- **Módosítás mérete**: 1 sor logikai bővítés + 1 teszt átírás + 2 új `it` (egyik `it.each` 4 variánssal) + 1 docs sor
- **Bukás kockázata**: alacsony
  - A guard a meglévő prompt-check szomszédságában fut, ugyanazt a `json` + `return true` mintát követi
  - A `Array.isArray` type guard a `answers` típusát a `map` előtt narrow-olja, így a `map` típusbiztonságos
  - A többi expand-prompt tesztet (`expands a prompt with formatted answers`, `strips a language-tagged code fence`, `returns 500 for agent ...`) nem érinti — mind `answers: []` tömbbel dolgoznak
  - Az `answers: []` backward-compat biztosítva van az új `accepts an empty answers array` teszttel
- **Érintett pinning teszt**: `pins the missing answers array failure` (átírva) + 2 új teszt
- **Lehetséges regresszió**: ha bármely kliens eddig `answers` nélkül küldte a kérést, most 400-at kap 500 helyett — ez a kívánt viselkedés
- **Következő fázisok**: a `memory-digest-empty-trim` (user override-val) és a `recall-dayofweek-noon-utc-far-east-skew` Cycle 24 jelöltként várnak