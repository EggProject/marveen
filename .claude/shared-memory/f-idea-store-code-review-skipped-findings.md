# f-idea-store-code-review-skipped-findings (2026-09-09)

## /code-review max --fix run

Range: `c6d9ca6..7222365` (refactor: IdeaStore class extraction + tests + shared-memory docs).

## Applied fixes (commit 56485c6, author EggProjectTeams)

- `src/db.ts`: "held by App" hamis comment eltávolítva (CRITICAL — App class nem létezik, dokumentáció fraud lett volna)
- `src/db.ts`: 4 `as` cast → `prepare<T, P>()` generics (CLAUDE.md §7 `as` tiltás)
- `src/db.ts`: `this.getDb()` ismétlés megszüntetése `addComment` és `revertFromKanban`-ban (1 lokális per metódus — a comment azt ígérte, hogy minden híváskor feloldódik, de egy logikai write-on belül nem szabad, hogy két különböző handle-re kerüljön)
- `src/db.ts`: dead `kanbanId ?? undefined` eltávolítva
- `src/__tests__/idea-store-classes.test.ts`: `noopLog` module-level const cast nélkül (`process-lock-classes.test.ts:18-20` minta)
- `src/__tests__/idea-store-classes.test.ts`: T8 SQL seed (busy-spin helyett, 1051ms → 0ms) — most a seed és a pre-call másodperc ellen is assertel
- `src/__tests__/idea-store-classes.test.ts`: ALTER try/catch eltávolítva (a guarded condition nem fordulhat elő, csak elnyelné a valódi hibát)
- `src/__tests__/idea-store-classes.test.ts`: T12 finally-ban zárja a handle-eket
- `src/__tests__/idea-store-classes.test.ts`: T13 cleanup comment javítva
- `src/__tests__/idea-store-classes.test.ts`: header index trim-elve
- `.claude/shared-memory/f-idea-store-db-client-flakiness.md`: em dash-ok eltávolítva, anchor `2472` → `2519-2521`, scope `1634` → `1672`, count `149` → `145`

Gates: tsc 0 errors, eslint 52→50, 346/346 tests pass across `idea-store-classes`, `db-100`, `ideas-routes`, `kanban-routes`.

## Dropped after verification (REFUTED)

- **T13/T15 cross-file test contamination** — REFUTED (vitest 4.1.10 `isolate: true` alapértelmezett, `node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:47` megerősítve; `idea-store-classes` + `db-100` együtt is 146/146 zöld)
- **`revertFromKanban` → `this.logStatusChange` spy-indirection break** — REFUTED (nincs ilyen spy a repo-ban; codebase convention a teljes `vi.mock` module-re)

## Skipped findings (7)

### 1. Unused `log` field
- **File:** `src/db.ts:1679`
- **Summary:** `private readonly log: LoggerLike` constructor-injected and assigned at `:1683` but never read by any of the 10 methods.
- **Failure scenario:** `grep -n 'this\.log' src/db.ts` returns only the write. Every construction site fabricates a logger it does not need. Manufactures false pass on criterion 4 (DI) of `.claude/rules/class-vs-functional-decision.md`, inflating the justification score for the class form.
- **Why skipped:** removing changes public constructor signature, diverges from `DbClient:2454` (which stores an equally unused `this.log`). Constructor-convention decision for the extraction program.

### 2. Transactions around `addComment` / `revertFromKanban`
- **File:** `src/db.ts:1730`
- **Summary:** `addComment` (INSERT + UPDATE) and `revertFromKanban` (UPDATE + INSERT) are non-transactional, though `DbClient.transaction()` exists at `:3473`.
- **Failure scenario:** Single-handle failure mode on the real WAL database: if the second statement hits `SQLITE_BUSY` or disk-full, `revertFromKanban` leaves the idea flipped to `'reviewed'` with `kanban_id` NULLed and no `idea_status_log` row. `kanban.ts:238` and `:262` discard the return value, so nothing notices, and the history endpoint shows a state transition that was never recorded.
- **Why skipped:** behavior change; non-atomicity pre-existing and moved verbatim.

### 3. `q +=` → template string
- **File:** `src/db.ts:1687`
- **Summary:** `q += ' AND status = ?'` (and `:1690`, `:1691`) is string concatenation, which CLAUDE.md §7 forbids: "Tilos a string konkatenáció ... Mindig template string".
- **Why skipped:** rule's stated examples are `+`, not `+=`, so the reading is contestable. Flagging for user call.

### 4. `createSchema()` → `DbClient.open(':memory:')`
- **File:** `src/__tests__/idea-store-classes.test.ts:60`
- **Summary:** `createSchema()` hand-mirrors the production DDL at `src/db.ts:3121-3163` as a second source of truth.
- **Failure scenario:** Byte-identical today. But `db.ts` adds columns to existing tables every cycle (sessions, kanban_cards, memories, agent_messages, task_runs, token_usage, idea_box itself). The next `idea_*` column silently drops out of this file's coverage.
- **Why skipped:** test-architecture change, ~30 production migrations × 14 tests. T14 already proves `DbClient.open(':memory:')` is a drop-in with no disk access.

### 5. `beforeEach` waste
- **File:** `src/__tests__/idea-store-classes.test.ts:137`
- **Summary:** builds full schema (Database + 5 DDL + 2 ALTER + 4 indexes) for T12/T13/T14/T15, none of which touch the resulting store.
- **Failure scenario:** ~44 pointless DDL statements per file run on top of what those tests already pay for themselves.
- **Why skipped:** needs describe split; churn on a brand-new file.

### 6. Class-vs-functional verdict [USER DECISION]
- **File:** `src/db.ts:1677` (`class IdeaStore`)
- **Summary:** IdeaStore fails the decision tree in `.claude/rules/class-vs-functional-decision.md`, which requires ≥2 YES with at least one from questions 1/2/3.
- **Failure scenario:** Q1 per-instance mutable state: no (both fields readonly). Q2 `implements X`: no interface. Q3 lifecycle: no init/dispose. Only Q4 (DI, itself weakened by the unused `log`) and Q5 (test isolation) pass — and neither is in the required 1/2/3 set. The rule's anti-pattern list names this shape explicitly: "Class ami csak a free function-öket csomagolja, anélkül hogy bármit hozzáadna". Zero production consumers construct the class.
- **Why skipped:** reverting contradicts the refactor program. **USER DECISION required** — release-checklist-prevention.

### 7. Stale line numbers in docs [USER DECISION]
- **File:** `docs/refactor-to-classbase/*.md` and `.claude/plans/cheeky-percolating-shell.md`
- **Summary:** pre-existing drift, outside the diff.
- **Why skipped:** **USER DECISION required** — the plan MDs will be deleted eventually per Honcho rule "classbase refactor doksik törlendők"; the refactor MDs (`refactor-to-classbase/*.md`) need a separate docs cycle.

## Honcho dual-write

Honcho entry: "f-idea-store-code-review-skipped-findings (2026-09-09)" — release-checklist-prevention per CLAUDE.md §7. 7 Skipped finding részletes reprodukcióval. 6 Applied fixek commitolva `56485c6` SHA-val. A user-döntésre váró findingek (#6, #7) külön jelölve.
