# Plan: Cycle 29 — Smallest-risk needs-fix batch (A + B + C)

## Context

Cycle 28 lezárult (openrouter-models-tier1-auto-empty-fallback + vault-bindings coverage cleanup). Branch `test/baseline` @ `288c352`, working tree clean, typecheck 1701 (tolerancia +5), CI parity stabil.

Az MD inventory 176 fájlból ~80 még nyitott. A legkisebb kockázatú klaszter a "defensive branch unreachable" coverage-only item-ek, ahol a holt ágak soha nem futnak le, és van a helyükön pinning test, ami dokumentálja a jelenlegi (dead-arm) viselkedést. A fix + test együtt megy, viselkedés azonos, typecheck Δ≈0.

User jóváhagyta a 3-item legkisebb batch-et:
- **A** schedule-runner-mcpmissingreason-cache-miss-unreachable (docs-only + komment)
- **B** message-router-cache-fallback-unreachable (3 sor drop + test flip)
- **C** vault-ssh-keys-endsWith-newline (1 sor drop + test flip)

## Items in scope

### Item A — `schedule-runner-mcpmissingreason-cache-miss-unreachable` (docs-only)

- **Source:** `src/web/schedule-runner.ts:468` — `const missing = lastMcpMissing.get(`${taskName}@${agentName}`) ?? []`
- **Háttér:** A `?? []` fallback `0c4c780` commit által törlődött, `fe81ac0` commit visszaállította (TS18048 workaround). Az MD `e831e8f` által re-openolva (`—` státusz).
- **Current source state:** `?? []` jelen van (kódvégleges).
- **Fix:**
  - 1 sor komment a `?? []` fölé: "TS-strict workaround; runtime guarantee documented in MD (line X)"
  - MD státusz `—` → `Resolved: 2026-08-18 fe81ac0`
- **Risk:** LOWEST — kód nem változik, csak MD + komment
- **Typecheck Δ:** 0

### Item B — `message-router-cache-fallback-unreachable`

- **Source:** `src/web/message-router.ts:477-480` (3 `??` arms)
- **Bug:** cache fallback `?? {}` soha nem fut le (minden hívó pre-populálja a cache-t)
- **Fix:** drop the 3 `??` arms, read cache directly
- **Pin test:** `src/__tests__/message-router*.test.ts` — flip assertion
- **Risk:** LOW
- **Typecheck Δ:** 0

### Item C — `vault-ssh-keys-endsWith-newline`

- **Source:** `src/web/routes/vault-ssh-keys.ts:126`
- **Bug:** `if (!content.endsWith('\n'))` feltétel soha nem teljesül normál inputra (minden hívó hozzáfűzi a newline-t)
- **Fix:** 1 sor drop
- **Pin test:** `src/__tests__/vault-ssh-keys*.test.ts` — flip assertion
- **Risk:** LOW
- **Typecheck Δ:** 0

## Commit pattern (8 commit összesen)

Ugyanaz a `fix → test → docs mark-resolved` hármas, mint az utóbbi 4 ciklusban.

| # | Üzenet | Item |
|---|---|---|
| 1 | `fix(message-router): drop dead ?? cache-fallback arms at message-router.ts:477-480` | B |
| 2 | `test(message-router): update pinning assertion to reflect removed cache fallback` | B |
| 3 | `docs(needs-to-be-fix): mark message-router-cache-fallback-unreachable resolved` | B |
| 4 | `fix(vault-ssh-keys): drop redundant endsWith('\n') guard at line 126` | C |
| 5 | `test(vault-ssh-keys): update pinning assertion to reflect removed guard` | C |
| 6 | `docs(needs-to-be-fix): mark vault-ssh-keys-endsWith-newline resolved` | C |
| 7 | `fix(schedule-runner): document TS-strict workaround above ?? [] at line 468` | A |
| 8 | `docs(needs-to-be-fix): re-mark schedule-runner-mcpmissingreason-cache-miss-unreachable resolved (TS-strict workaround documented)` | A |

Sorrend: először a két kód-érintő (B és C), végül a docs-only A. Ha B vagy C elbukik, A még mindig landolhat.

## Workflow plan

A workflow-t a `Workflow` tool-lal hajtjuk végre. A workflow a `test/baseline` branch-ből indul, oda is megy vissza (CLAUDE.md kötelező). Minden commit lokálisan marad, push a useré.

### Fázisok

1. **Setup** — branch ellenőrzés (`test/baseline` @ `288c352`), working tree clean, typecheck 1701 baseline rögzítés
2. **Pipeline phase** — B és C subagent-ek párhuzamosan (`pipeline()` pattern, barrier nélkül):
   - Minden subagent kapja: MD + forrás + pin test kontextus
   - Minden subagent commitonként `bunx vitest run <file>.test.ts` verifikációt futtat
3. **A subagent** — schedule-runner docs-only + komment + MD re-close (a B+C után)
4. **Batch-end verify** (barrier):
   - `bunx tsc --noEmit | wc -l` (≤1706)
   - `git log --oneline -10` (8 új commit a `288c352` után)
   - `git status` — working tree clean
   - `git rev-list --left-right --count origin/test/baseline...HEAD` (0\t8)
5. **Code-review** — `/code-review xhigh --fix` skill hívása a 8 commit-ra (a skill auto-applyolja a P1/P2 javításokat)

A workflow script `agent()` + `pipeline()` patternet használ (default), barrier csak az utolsó verify fázisnál. Max 2 párhuzamos ágens (CLAUDE.md § 7).

### Push policy

A workflow nem pushol. Push kizárólag a useré (CLAUDE.md § 6). Push után Pattern 89 push verification: local HEAD SHA = remote HEAD SHA, typecheck count egyezik, full test suite PASS.

## Verification

### Per-item

- `bunx vitest run <file>.test.ts` — PASS az adott pin testre
- A MD `INDEX.md` entry frissül (`—` → `Resolved: 2026-08-18 <short-sha>`)
- Working tree clean minden commit után

### Batch-end

- `bunx tsc --noEmit | wc -l` — ≤ 1706 (baseline 1701 + max +5 tolerancia)
- `git log --oneline -10` — 8 új commit a `288c352` után
- `git status` — working tree clean
- `git rev-list --left-right --count origin/test/baseline...HEAD` — `0\t8`

### Code-review után

- A skill 4-8 findinget hozhat (P1/P2 fix-ek auto-applyolva): típus-szűkítés, instanceof typeguard, comment cleanup
- A code-review commit-ok hozzáadódnak a stack-hez (összesen 10-14 commit)
- Újabb `bunx tsc --noEmit | wc -l` ellenőrzés

### Push után (user végzi)

- CI run parity check (Pattern 89): local HEAD SHA = remote HEAD SHA, typecheck count egyezik, full test suite PASS

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/web/schedule-runner.ts` (komment hozzáadás a 468. sor fölé)
- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts` (3 sor drop a 477-480. sorokon)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/message-router*.test.ts` (pin test flip)
- `/Users/eggp/marveen-develop/test-baseline/src/web/routes/vault-ssh-keys.ts` (1 sor drop a 126. soron)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/vault-ssh-keys*.test.ts` (pin test flip)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (3 sor frissítés: A, B, C)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/schedule-runner-mcpmissingreason-cache-miss-unreachable.md` (status flip `—` → Resolved)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` (status flip `—` → Resolved)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/vault-ssh-keys-endsWith-newline.md` (status flip `—` → Resolved)

## Reuse / pattern references

- **Commit triplet `fix → test → docs mark-resolved`** — pontosan ugyanaz, mint a cycles 25-28-ban (vault-bindings, fleet-q, routes-docs, openrouter-models)
- **TypeScript strict workaround pattern (Pattern 99)** — schedule-runner re-close kezeli a TS-strict limitation-t; comment + MD re-stamp
- **Workflow tool pattern** — Phase 1-2-3, pipeline + barrier, max 2 párhuzamos ágens (CLAUDE.md § 7)
- **Push policy** — CLAUDE.md § 6: workflow soha nem pushol, push kizárólag a useré
- **Code-review skill** — `/code-review xhigh --fix` minden batch végén kötelező (CLAUDE.md + Honcho profile)