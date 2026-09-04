# Terv: 5 db `as any` → típus-szűkítés, CLAUDE.md §7 tisztítás

## Context

A `docs/needs-to-be-fix/INDEX.md` összes valódi code-fix sora vagy "NEVER modify X" task-rule által blokkolt (`message-router.ts`, `keychain.ts`, `heartbeat.ts`, `schedule-mcp-precheck.ts`), vagy "Deferred to next cycle" (lefedettségi gap-ek 149/192/193/195). Nyitott, alacsony kockázatú code-fix elem ezért kívül esik az INDEX-en: a `src/`-ben maradt `as any` cast-ok (CLAUDE.md §7 explicit tiltás).

A terv 5 darab tiszta type-annotation cserét von össze egy commitba (`fix(types): drop `as any` in favor of narrowed types (CLAUDE.md §7)`). Mindegyik:
- 1-2 soros,
- runtime viselkedést nem változtat (ugyanaz az adat, csak a TS-típus szűkül),
- meglévő tesztek változatlanul átmennek,
- bármelyik külön is revertálható.

User döntés (AskUserQuestion):
- **Scope**: csak A1-A5 (A6 `src/agent.ts` `sessionId` → `session_id` valódi bug külön marad, mert teszt mock javítást igényel és más kategória).
- **Dupla ellenőrzés**: két review subagent párhuzamosan (recommended).

## Scope: 5 darab tiszta típus-csere

### A1 — `src/web/dashboard-settings.ts:85`

**Előtte:**
```ts
for (const cfg of Object.values(servers) as any[]) {
  for (const key of Object.keys(cfg?.env || {})) vars.add(key)
}
```
**Utána:**
```ts
for (const cfg of Object.values(servers) as Record<string, unknown>[]) {
  for (const key of Object.keys((cfg as { env?: Record<string, unknown> })?.env || {})) vars.add(key)
}
```
**Indoklás:** a loop body `cfg?.env`-et olvas; `Record<string, unknown>[]` megtartja a `?.` optional chaining biztonságát, és a belső `env`-re való szűkítés típusbiztos. Runtime: nulla változás.

### A2 — `src/db.ts:1673`

**Előtte:**
```ts
return db
  .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
  .all() as any[]
```
**Utána:**
```ts
return db
  .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
  .all() as { status: string; title: string; assignee: string | null; priority: string; id: string }[]
```
**Indoklás:** a függvény return típusa (1670. sor) pontosan deklarálja a sor alakját; az `as any[]` az explicit típust `any`-ra downcastolja. Visszaállítás a deklarált alakba. Runtime: nulla változás.

### A3 — `src/web/token-usage.ts:505` (+ szomszédos callback annotáció)

**Előtte (505. sor):**
```ts
).all(row.agent, row.agent, row.minTs, row.maxTs) as any[]
```
**Utána (505. sor):**
```ts
).all(row.agent, row.agent, row.minTs, row.maxTs) as unknown[]
```

**Előtte (508. sor, szomszédos callback):**
```ts
const nextCard = cards.find((c: any) => c.updated_at > card.updated_at)
```
**Utána (508. sor):**
```ts
const nextCard = cards.find((c: unknown) => (c as { updated_at: number }).updated_at > card.updated_at)
```
**Indoklás:** a `cards` típusa `unknown[]`; a callback paramétert keskenyíteni kell, hogy hozzáférjünk `updated_at`-hoz. Runtime: nulla változás (ugyanaz a comparator).

### A4 — `src/web/routes/kanban.ts:357`

**Előtte:**
```ts
priority: (st.priority as any) ?? 'normal',
```
**Utána:**
```ts
priority: st.priority ?? 'normal',
```
**Indoklás:** a `subtasks` típusa a 341. sorban explicit deklarált: `Array<{ title: string; description: string; assignee: string | null; priority: string }>`. Az `as any` felesleges, `st.priority` már `string`. A `?? 'normal'` defensive fallback marad (TS-típus `string` nem `string|null`, de a cast megszüntetése után a `??` a fordító figyelmeztetését váltaná ki — emiatt a `?? 'normal'` megtartása `string | null` típusúvá teszi a kifejezést; ha a kód TS-szinten szigorúan veszi, typeguard írható, de a legkisebb módosításhoz a fallback megtartása a cél).

Megjegyzés: ha a TS fordító `?? 'normal'`-t nem fogadja el `string` típuson, a sort pontosítjuk `priority: st.priority as string ?? 'normal'` nélkül, vagy type predikátumot írunk. A workflow-ban ez azonnal kiderül a typecheck lépésnél.

### A5 — `src/web/routes/connectors.ts:49` (+ szomszédos `Map<string, any>`)

**Előtte (49. sor):**
```ts
const central = JSON.parse(readFileSync(join(PROJECT_ROOT, 'mcp-catalog.json'), 'utf-8')) as any[]
```
**Utána (49. sor):**
```ts
const central = JSON.parse(readFileSync(join(PROJECT_ROOT, 'mcp-catalog.json'), 'utf-8')) as unknown[]
```

**Előtte (50. sor):**
```ts
const byId = new Map<string, any>()
```
**Utána (50. sor):**
```ts
const byId = new Map<string, unknown>()
```

**Indoklás:** a `JSON.parse` típusa `any`; `unknown[]`-re szűkítés biztonságos, és a `Map<string, unknown>` típusú lokális index megegyezik a function return-jének módosításával konzisztenssé.

**A `loadMcpCatalog` return típusát (`any[]`) is módosítjuk `unknown[]`-re**, hogy a function signature konzisztens legyen. A function consumer (a `for (const item of readLocalCatalog())` loop a 52. sorban, illetve a hívók) `String(item.id)` pattern-t használ, ami `unknown` típuson is működik (mert `String()` bármit elfogad). Ellenőrizendő a hívók típuskompatibilitása a workflow-ban.

## Files to modify

| Fájl | Sor | Változás |
|---|---|---|
| `src/web/dashboard-settings.ts` | 85 | `as any[]` → `as Record<string, unknown>[]` + belső cast |
| `src/db.ts` | 1673 | `as any[]` → `as { ... }[]` (deklarált típus) |
| `src/web/token-usage.ts` | 505, 508 | `as any[]` → `as unknown[]`; `(c: any)` → `(c: unknown) as { updated_at: number }` |
| `src/web/routes/kanban.ts` | 357 | `(st.priority as any)` → `st.priority` |
| `src/web/routes/connectors.ts` | 49, 50 | `as any[]` → `as unknown[]`; `Map<string, any>` → `Map<string, unknown>` |

## Verification

### 1. Typecheck (TypeScript `--noEmit`)
A módosítás célja a TS-típusok szűkítése, ezért a typechecknek MUSZÁJ átmennie. Ha bármelyik cast szűkebb a kelleténél, a TS fordító azonnal jelzi.

```bash
cd /tmp/claw-test && bun --bun tsc --noEmit -p tsconfig.json 2>&1 | head -100
```

### 2. Vitest a worktree-ben
A CLAUDE.md §8 szabály szerint: `git worktree add --detach /tmp/claw-test test/baseline` + `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test/node_modules`, majd `bun --bun vitest run`.

Célzott subset-eket futtatunk (teljes suite túl lassú):
- `bun --bun vitest run src/web/__tests__/dashboard-settings.test.ts` (ha létezik)
- `bun --bun vitest run src/__tests__/db-*.test.ts` (a kanban summary-t is lefedő)
- `bun --bun vitest run src/web/__tests__/token-usage.test.ts`
- `bun --bun vitest run src/web/__tests__/routes-kanban.test.ts`
- `bun --bun vitest run src/web/__tests__/routes-connectors.test.ts`

Ha bármelyik fail, a CLAUDE.md §8 második szabálya szerint automatikusan a `a330462` baseline-on is lefuttatjuk ugyanazt a subset-et, és a két outputot összehasonlítjuk. Ha a baseline-on is fail, pre-existing regression — bizonyítjuk a usernek.

### 3. Baseline diff
A `git diff test/baseline..a330462 -- src/` üres kell legyen a módosított fájlokra a feature-chínk előtt (különben a baseline már tartalmazza a módosítást, ami körkörösséget jelez).

## Workflow terv

### Setup
1. Worktree létrehozása: `git worktree add --detach /tmp/claw-typefix test/baseline`
2. Node_modules symlink: `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-typefix/node_modules`
3. Baseline SHA rögzítése: `git rev-parse HEAD`

### Implementáció (worktree-ben, main agent)
1. Edit A1 (`src/web/dashboard-settings.ts:85`)
2. Edit A2 (`src/db.ts:1673`)
3. Edit A3 (`src/web/token-usage.ts:505,508`)
4. Edit A4 (`src/web/routes/kanban.ts:357`)
5. Edit A5 (`src/web/routes/connectors.ts:49,50`)
6. Typecheck lokálisan a worktree-ben
7. Ha typecheck fail, JAVÍTÁS vagy VISSZALÉPÉS a felelős editnél — NEM megyünk tovább fail-es típussal

### Dupla ellenőrzés (két subagent, párhuzamosan, isolation: worktree)

CLAUDE.md §8 szabályai szerint: **Agent tool** `isolation: 'worktree'`-vel, NEM Workflow tool.

**Subagent 1 — `code-correctness reviewer`:**
- Prompt: "Review the 5 edits for type-safety correctness. Verify each `as unknown[]` / narrowed cast preserves the exact runtime semantics. Check that no property access is broken by the narrowing. Check that no `as any` was re-introduced. Check CLAUDE.md §7 compliance. Run typecheck."
- Schema: `{ passes: boolean, findings: [{ file, line, issue, severity }] }`

**Subagent 2 — `test-impact reviewer`:**
- Prompt: "Analyze which existing tests cover the 5 modified files. Predict which tests might be affected by the cast changes. Run the targeted test subset (`bun --bun vitest run <subset>`) in your worktree and report which pass/fail. If any fail, run the same subset on baseline `a330462` and report whether baseline also fails. Cite specific test files and assertions."
- Schema: `{ affectedTests: [{ file, status, baselineComparison }], unexpectedFailures: [] }`

### Commit és visszavezetés
- Ha mindkét subagent `passes: true` (vagy minden `finding` megoldva): commit a worktree-ben
- Commit message: `fix(types): drop \`as any\` in favor of narrowed types (CLAUDE.md §7)`
- Body: lista az 5 érintett fájlról és sorról
- Per CLAUDE.md §8: `git worktree remove /tmp/claw-typefix --force`
- Visszavezetés: `git merge --ff-only <commit-sha>` a `test/baseline`-re (NEM `git reset --hard`)
- Ellenőrzés: `git log --oneline -3` a `test/baseline`-en

### Befejezés
- A user a `/code-review max --fix` skillt KÖTELEZŐEN meghívja a terminálban (CLAUDE.md §8: a skill `disable-model-invocation` flag-gel rendelkezik, a Skill tool elutasítja — CSAK user invokálhatja).
- Plan emlékeztető: a skill user-oldali hívása az utolsó lépés, a workflow végén ki kell írni.

## Kockázatok és mitigáció

| Kockázat | Valószínűség | Mitigáció |
|---|---|---|
| Typecheck fail valamelyik editnél (a szűkítés túl szigorú) | KÖZEPES | Azonnali javítás a worktree-ben; a typecheck lefut MINDEN edit után |
| Valamely célzott teszt fail a cast változás miatt | ALACSONY | Subagent-2 baseline-diff; ha pre-existing, bizonyítjuk a usernek; ha új, revertáljuk az adott editet |
| `kanban.ts:357` `?? 'normal` nem fordul le string-en | ALACSONY | `st.priority` típusa `string` (341. sor); a `??` fallback TypeScript "no-op" warning-ot adhat, de a fordító engedi. Ha gond, typeguard: `st.priority ? st.priority : 'normal'` |
| `connectors.ts:50` `Map<string, unknown>` hívóinak típus-inkompatibilitása | ALACSONY | A hívók `String(item.id)` pattern-t használnak (`String()` elfogad `unknown`-t); typecheck megfogja |
| Worktree merge conflict | ALACSONY | A worktree detached HEAD, `test/baseline` HEAD-ről indult (clean state); ff-only merge csak akkor sikerül, ha a branch nem változott a worktree alatt |

## Ami NEM történik

- A6 (`src/agent.ts` `sessionId` → `session_id` valódi bug) — külön ciklus, user megerősítette.
- INDEX nyitott sorok (message-router 131-133, routes-agents 149, web-agent-scaffold 192, stb.) — task-rule blokkolta vagy "Deferred to next cycle".
- Tripwire comment a `channel-request-watcher.ts:67-76`-on — load-bearing, nem nyúlunk hozzá.
- `console.log(BANNER)` az `src/index.ts:417`-en — startup banner, nem debug.
- String konkatenáció sweep (`+ '\n'`) — ~30 fájl, túl nagy módosítás.

## Fájlok összesen (5 módosítás, 5 fájl, ~6-8 LOC)

1. `src/web/dashboard-settings.ts` (A1)
2. `src/db.ts` (A2)
3. `src/web/token-usage.ts` (A3, 2 sor)
4. `src/web/routes/kanban.ts` (A4)
5. `src/web/routes/connectors.ts` (A5, 2 sor)