# IdeaStore cycle db-client.test.ts flakiness (2026-09-09)

## Symptom
Phase 5 verify worktree (`$HOME/claw-idea-store-verify`) 1 futtatáskor FAIL:
- `src/__tests__/db-client.test.ts > DbClient.open serialize migrateTaskRunsFromJson with file lock > two parallel open() calls produce exactly N rows (multi-process)`
- `AssertionError: expected 1 to be +0 // Object.is equality`

## Verification
- 3x ismétlés a debug worktree-ben (`$HOME/claw-idea-store-debug`): MIND PASS (30/30)
- `c6d9ca6` baseline worktree (`$HOME/claw-idea-store-baseline`): PASS (30/30) — a refaktor ELŐTT is átment
- A refaktor (IdeaStore class extraction) NEM okozta a regressziót

## Root cause
`migrateTaskRunsFromJson` race condition (fájlrendszer lock, multi-process koordináció).
PRE-EXISTING — a Honcho `code-review-skipped-findings-dbts-lock-filename` entry dokumentálja a `src/db.ts:2472` dirname relative dbPath shared lock dir findinget.

## Refaktor scope
A refaktor a `src/db.ts:1634-1799` klaszterre korlátozódott (class IdeaStore + module-singleton + 10 thin shim wrapper). A `DbClient` kódját NEM érintette. A `routes/ideas.ts` UNCHANGED. A másik 149 db.ts free fn UNCHANGED.

## Javítás
Külön ciklusban, a Honcho `code-review-skipped-findings-dbts-lock-filename` entry-vel összhangban. A `src/db.ts:2472` dirname relative dbPath shared lock dir finding (3 db-client test fixture block) release-checklist-prevention-re. A "release előtt javítjuk" NEM opció, mert "el lesz felejtve" — 2026-09-06 f84a8666 precedens.

## Honcho dual-write
Entry: "IdeaStore cycle db-client.test.ts flakiness (2026-09-09 Phase 5 gate)" — 2026-09-09 03:20 session.
