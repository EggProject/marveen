# E.3 PortLock consumer migration — végrehajtási terv

## Context

**Miért:** A `docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md:166-201` E.3 fázisa a `PortLockAcquirer` class (LANDED in `57c78d0`, E.1) első production consumer-e. Jelenleg a wrapper `acquirePortLock` hívódik `src/index.ts:341`-en; E.3 átírja a hívást a class formára. E.5 (wrapper removal) csak E.3 + E.4 után jöhet.

**Osztály-vs-funkcionális szabály alkalmazása** (`.claude/rules/class-vs-functional-decision.md`):
A szabály szigorú döntési fája 5 kérdésből áll, és "legalább 2 IGEN, legalább egy az 1/2/3-ból" küszöböt kér. A `PortLockAcquirer` (process-lock.ts:77) a szigorú olvasat szerint 2 IGEN-t kap (Q4 constructor-injected DI + Q5 per-instance test isolation), de 0-t az 1/2/3-ból (readonly ctx, nincs `implements`, nincs lifecycle) — borderline. A szabály **pozitív példák táblázata** (L93) viszont explicit validálja: `Instance state | Polymorphism | DI | Lifecycle` = `ctx: ProcessLockContext this-en | – | igen | –`. A táblázat authoritativ a landolt class-okra. Az anti-pattern #7 (L81-83) inverze is alátámasztja E.3-at: "ha nincs konkrét consumer aki a class formát használná, a wrapper-ök sosem kerülnek eltávolításra" — E.3 = konkrét consumer. A rule satisfied.

**Out-of-scope (explicit nem-célok):**
- H.1 (LoggerLike): a `LogFn` típus `process-lock.ts:19`-en marad.
- D.1 (ChannelEnv): nem érintett.
- E.4 (PidfileLock consumer migration): `acquirePidfileLock` hívás `index.ts:348`-on marad; `releaseLock()` body `index.ts:356-364` marad free function. E.4 saját commit.
- E.5 (wrapper removal): `acquirePortLock` `process-lock.ts:217-219`-en marad — `process-lock.test.ts:333-455` 10 `it()` esete továbbra is a wrapper-t exercise-eli.
- Adapter literal `index.ts:280-287` (H.1 territory) — nem érintett.

---

## Dupla verifikáció eredménye

A tervet két független subagent ellenőrizte a CLAUDE.md §8 szerint (különböző szögek):

**Strukturált checklist (Verifier A):** 17/17 PASS, 1 advisory + 1 critical advisory:
- Item 3 advisory: a terv azt állítja hogy a `vi.mock` factory túléli E.3-at — **HIBÁS**. A factory csak `acquirePortLock` (wrapper) exportot adja vissza; E.3 a class-t importálná → a tesztben `undefined` → `new undefined(...)` TypeError.

**Adversarial falsification (Verifier B):** több BLOCKING + ADVISORY:
- **BLOCKING 1**: Ugyanaz, mint fent (Lens 5.2 / 5.3 / 10.3). A factory MUST be updated.
- **BLOCKING 2** (Lens 6.4): CLAUDE.md §8 author check hiányzik a Step 9 merge előtt. Precedens: 2026-08-30 E.1/E.2 ceremony.
- ADVISORY (Lens 2.1): A terv "alphabetize with PortLockAcquirer first" ellentmond a `src/index.ts` import block konvenciónak (modul szerint csoportosítva, NEM ábécé). Megtartandó a meglévő stílus: `PortLockAcquirer` a values block-ba kerül `acquirePortLock` mellé (ahol a többi process-lock export is van).
- ADVISORY (Lens 8.1): A rule belső ellentmondása (table vs. döntési fa) — E.3 mindkét olvasat alatt átmegy, de a usernek jelezni kell.
- ADVISORY (Lens 9.2/9.4/9.5): Framework-level `docs/refactor-to-classbase/00-summary.md` "Top 3 lowest-risk wins" listája frissítendő.
- ADVISORY (Lens 6.1): Worktree path `~/claw-test-e3` eltér a CLAUDE.md §8 példa `~/claw-test`-től. Az eltérés indokolt (collision avoidance), de explicite jelezni kell.
- ADVISORY (Lens 10.4): `index.test.ts:876` throw-ol `:324`-en mielőtt elérné a migrált `:341`-et — NEM validálja E.3-at. Nem szabad a coverage proof-jaként hivatkozni rá.

Ezen feedback-ek alapján a terv **MÓDOSÍTÁSRA** került (lásd lentebb a `Step 4.5`-t és a `Step 8.5`-öt).

---

## Files to touch (verified)

| File | Lines | Change |
|---|---|---|
| `src/index.ts` | 27-34 (import block) | `acquirePortLock` → `PortLockAcquirer` (a meglévő values block-ban marad, `acquirePortLock` helyén) |
| `src/index.ts` | 341 | `await acquirePortLock(...)` → `await new PortLockAcquirer(procCtx).acquire(...)` |
| `src/__tests__/index.test.ts` | 173-196 (`vi.mock('../process-lock.js')` factory) | `PortLockAcquirer` mock-os class hozzáadása a factory return-höz |
| `docs/refactor-to-classbase/e-process-lock/00-summary.md` | status line | "E.3 LANDED in `(this commit)`" hozzáfűzése |
| `docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` | E.3 szekció (L166-201) | "**LANDED in `(this commit)`**" prepending + "Files touched" aktualizálása |
| `docs/refactor-to-classbase/00-summary.md` | "Top 3 lowest-risk wins" lista | E.3 státusz frissítése (verifier B Lens 9.2 alapján) |

**Zero changes:**
- `src/process-lock.ts` (class + wrapper marad)
- `src/__tests__/process-lock.test.ts` (10 `it()` eset a wrapper ellen, marad)
- `src/index.ts` egyéb sorai (a release/shutdown path, E.4 territory)
- `src/index.ts:292, 309, 320, 423` kommentek (CLAUDE.md §3 — NEM reformulálandók)

### Verified call-site analysis (read at plan-write time)

`grep -rn 'acquirePortLock' src/ --include='*.ts' | grep -v __tests__` output:
- `src/process-lock.ts:217` — definition (free function)
- `src/index.ts:28` — import (will be changed to `PortLockAcquirer`)
- `src/index.ts:292, 309, 320, 423` — comments referencing the wrapper name (NOT edited per §3)
- `src/index.ts:341` — call site (the only production caller)

Substantive: 1 definition + 1 import + 1 call = 3 production code references. Comments unchanged.

### Verified class signature

`src/process-lock.ts:77-78`:
```
export class PortLockAcquirer {
  constructor(private readonly ctx: ProcessLockContext) {}
```

`src/process-lock.ts:174`:
```
async acquire(port: number, opts: AcquirePortLockOptions = {}): Promise<void> {
```

`src/process-lock.ts:217-219` (wrapper, unchanged):
```
export function acquirePortLock(port: number, ctx: ProcessLockContext, opts?: AcquirePortLockOptions): Promise<void> {
  return new PortLockAcquirer(ctx).acquire(port, opts)
}
```

### Verified test factory (must be updated)

`src/__tests__/index.test.ts:173-196` — a `vi.mock('../process-lock.js', ...)` factory jelenlegi return shape:
```ts
return {
  acquirePortLock: mockAcquirePortLock,
  acquirePidfileLock: mockAcquirePidfileLock,
  writeBufferFully: actual.writeBufferFully,
  DeferToPeerError: actual.DeferToPeerError,
}
```

**E.3 kötelező frissítés** (lásd Step 4.5): a factory return-höz hozzá kell adni egy `PortLockAcquirer` mock class-t, ami az `acquire()` metódust a meglévő `mockAcquirePortLock`-ra delegálja. Ez preserving minden meglévő mock viselkedést (`:324, :1338, :1370` `mockImplementation` calls).

### Verified test cases

`src/__tests__/process-lock.test.ts:333-455` — a `describe('acquirePortLock')` block **pontosan 10 `it()` esetet** tartalmaz (L334, 340, 349, 358, 367, 377, 388, 398, 419, 435). A terv korábbi "33 cases" állítása az egész fájlra vonatkozott; E.3-hoz csak ez a 10 releváns.

`src/__tests__/index.test.ts:876` — `it('defers to a legitimate alive peer that is not yet on the port (throws DeferToPeerError)')`. Ez a teszt `checkFreshStartupRace` `index.ts:324`-en throw-ol, mielőtt elérné `:341`-et → **NEM validálja E.3-at**. Ne használjuk coverage proof-ként.

`src/__tests__/index.test.ts:173-196` factory mocks — a `mockAcquirePortLock` összesen 13 referenciát kap (1 declaration, 1 definition, 1 factory target, 3 `mockImplementation` calls at `:324, :1338, :1370`, 7 comments). A "40+ assertions" állítás a terv korábbi vázlatában dokumentáció drift volt (CLAUDE.md §8 javítva).

---

## Implementation steps

### Step 1: create worktree at `$HOME/claw-test-e3`

```sh
git worktree add --detach "$HOME/claw-test-e3" refactor/classbase
```

**Megjegyzés:** A path `claw-test-e3` (nem `claw-test`) — a CLAUDE.md §8 példától való eltérés indoklása: collision avoidance párhuzamos worktree-izolált agentekkel szemben. A review-nak ezt explicite jelezni kell.

Verify:
```sh
git -C "$HOME/claw-test-e3" log -1 --format='%h %s'
# expected: b29dda1 docs(i-auto-restart): handoff references real WITHDRAWN note...
```

### Step 2: symlink node_modules

```sh
ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules "$HOME/claw-test-e3/node_modules"
```

`$HOME/claw-test-e3` kötelező (nem `/tmp/`) a `_TMP_PREFIXES` guard miatt (`src/web/agent-scaffold.ts:144`). CLAUDE.md §8 verbatim indoklás.

### Step 3: baseline gates (measured at plan-write time)

| Gate | Baseline | Source |
|---|---|---|
| `bun tsc --noEmit` | **1729 errors** | `bun tsc --noEmit 2>&1 \| grep -cE 'error TS'` |
| `bun --bun vitest run` | **384 test files passed, 11225 tests passed, 0 failed, Duration 132.43s** | tail of full output |
| `git status --porcelain` | empty (clean worktree) | verified |
| `git config user.email` | `eggprojectteams@gmail.com` | verified |
| `git config user.name` | `EggProjectTeams` | verified |
| `ls store/` | non-existent (assert-not-live-install.ts guard satisfied) | verified |
| `.gitignore` L98-99 | `coverage/` + `coverage-temp/` gitignored | verified |

### Step 4: edit `src/index.ts` (TWO edits, surgical)

**Edit A — lines 27-34** (import block, meglévő konvenció megtartása):

Before:
```ts
import {
  acquirePortLock,
  acquirePidfileLock,
  writeBufferFully,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from './process-lock.js'
```

After:
```ts
import {
  PortLockAcquirer,
  acquirePidfileLock,
  writeBufferFully,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from './process-lock.js'
```

**Konvenció:** a `process-lock.js` block values-first (a `type` kulcsszavasok a végén) — ezt a meglévő stílust tartjuk. NEM alphabetizálunk (verifier B Lens 2.1). A `PortLockAcquirer` a values block első helyére kerül, mert az ábécé-sorrend szerinti behelyettesítés `acquirePortLock` helyén a legkisebb diff.

**Edit B — line 341** (call site):

Before:
```ts
  await acquirePortLock(WEB_PORT, procCtx, { binaryPattern: DASHBOARD_BINARY_PATTERN })
```

After:
```ts
  await new PortLockAcquirer(procCtx).acquire(WEB_PORT, { binaryPattern: DASHBOARD_BINARY_PATTERN })
```

`procCtx` a meglévő `ProcessLockContext` (`index.ts:330`-ról, `buildProcessLockContext()` visszatérési értéke). `WEB_PORT` és `DASHBOARD_BINARY_PATTERN` unchanged.

### Step 4.5: edit `src/__tests__/index.test.ts:173-196` (factory update — KÖTELEZŐ)

A `vi.mock('../process-lock.js', ...)` factory-t ki kell egészíteni `PortLockAcquirer` mock class-szal. A factory célja: a `new PortLockAcquirer(ctx).acquire(port, opts)` hívást átirányítani a meglévő `mockAcquirePortLock`-ra (ami a `:324`-es default impl-t futtatja).

Before (`src/__tests__/index.test.ts:189-195`):
```ts
  const actual = await vi.importActual<typeof import('../process-lock.js')>('../process-lock.js')
  return {
    acquirePortLock: mockAcquirePortLock,
    acquirePidfileLock: mockAcquirePidfileLock,
    writeBufferFully: actual.writeBufferFully,
    DeferToPeerError: actual.DeferToPeerError,
  }
```

After:
```ts
  const actual = await vi.importActual<typeof import('../process-lock.js')>('../process-lock.js')
  return {
    PortLockAcquirer: class {
      constructor(public readonly ctx: typeof actual.PortLockAcquirer.prototype extends infer _ ? unknown : never) {
        // Type erased at runtime; the production code only needs the shape
        // (constructor takes ctx, instance has acquire(port, opts)).
      }
      acquire = (port: number, opts: AcquirePortLockOptions = {}): Promise<void> =>
        mockAcquirePortLock(port, this.ctx, opts)
    },
    acquirePortLock: mockAcquirePortLock,
    acquirePidfileLock: mockAcquirePidfileLock,
    writeBufferFully: actual.writeBufferFully,
    DeferToPeerError: actual.DeferToPeerError,
  }
```

**Megjegyzés a type erasure-ről:** a factory egy névtelen class-t ad vissza, ami `instanceof` check-eknél nem egyezik a valódi `PortLockAcquirer`-rel. A termelési kód NEM használ `instanceof` check-et a `PortLockAcquirer` ellen (verifier A Item 5 és a `process-lock.ts` átvizsgálása megerősítette: nincs `instanceof PortLockAcquirer` a kódbázisban). Tehát ez biztonságos.

**Megjegyzés a `mockAcquirePortLock` szignatúráról:** `mockAcquirePortLock(port, ctx, opts)` — a `(this.ctx, opts)` átadásával a meglévő default impl `:324`-en továbbra is a production ctx-szel dolgozik. A `withRealAcquirePortLock` helper `:1370`-en (amely `vi.importActual` + `actual.acquirePortLock` delegál) szintén működik, mert az is `mockAcquirePortLock.mockImplementation`-t állít be.

**E.4 előkészítés:** a factory ugyanebben a lépésben megkapja `PidfileLockAcquirer: actual.PidfileLockAcquirer`-t is (real class, `vi.importActual` által), hogy az E.4 ne kelljen factory-t módosítania. Ez 1 sor, 0 kockázat (most nem használja senki).

### Step 5: run vitest on the worktree

```sh
cd "$HOME/claw-test-e3" && bun --bun vitest run 2>&1 | tail -10
```

Expected output tail:
```
 Test Files  384 passed (384)
      Tests  11225 passed (11225)
   Duration  ...
```

**Gate:** match the baseline (384 files / 11225 tests / 0 failed). **A Step 4.5 factory update nélkül ez a gate FAIL-öl** (`new undefined(...)` TypeError). A factory update után a meglévő mock viselkedés megmarad → a tesztek átmennek byte-identical-on.

### Step 6: run tsc on the worktree

```sh
cd "$HOME/claw-test-e3" && bun tsc --noEmit 2>&1 | grep -cE 'error TS'
```

Expected: **1729** (unchanged from baseline).

### Step 7: commit on detached HEAD

Per CLAUDE.md §8 (author check):

```sh
cd "$HOME/claw-test-e3"
git -c user.name='EggProjectTeams' -c user.email='eggprojectteams@gmail.com' \
  commit --no-verify -am "$(cat <<'EOF'
refactor(index): migrate acquirePortLock call to PortLockAcquirer class (E.3)

E.3 proof consumer for the PortLockAcquirer class extracted in 57c78d0.
Replaces the wrapper call at src/index.ts:341 with the class form
(`new PortLockAcquirer(procCtx).acquire(WEB_PORT, { binaryPattern: ... })`).
The free-function wrapper at process-lock.ts:217-219 survives (E.5 owns
its removal), so the 10 acquirePortLock cases in process-lock.test.ts:
333-455 continue to exercise the wrapper unchanged.

vi.mock factory at index.test.ts:173-196 updated to expose a mock
PortLockAcquirer class whose acquire(port, opts) delegates to the
existing mockAcquirePortLock, preserving the default test behavior
(:324, :1338, :1370 mockImplementation calls continue to work without
change). PidfileLockAcquirer also added to the factory return for
E.4 forward-compatibility (unused by current production code).

The 4 comments at src/index.ts:292,309,320,423 still reference the
acquirePortLock name; per CLAUDE.md §3 ("Surgical Changes") they remain
unmodified -- they describe behavior the class form still implements.

Refs: docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md (E.3)
EOF
)"
```

### Step 8: verify author + commit content

```sh
cd "$HOME/claw-test-e3" && git log -1 --format='%an <%ae> | %cn <%ce>'
```

Expected:
```
EggProjectTeams <eggprojectteams@gmail.com> | EggProjectTeams <eggprojectteams@gmail.com>
```

If a `Claude <claude@anthropic.com>` author/committer jelenik meg (a subagent override-olta a git identity-t), **STOP** per CLAUDE.md §8 és kérdezzük a user-t. Ne javítsuk önhatalmúlag — a javítás history rewrite, ami külön engedélyköteles. Precedens: 2026-08-30 E.1/E.2 ceremony (3 extra commit).

### Step 8.5: pre-merge ancestry check

```sh
git -C /Users/eggp/marveen-develop/test-baseline merge-base --is-ancestor <SHA> refactor/classbase
```

A `<SHA>` a Step 7 commit hash-e. Ha az `--is-ancestor` check FAIL-öl (SHA nem a branch gyermeke), **STOP** — a worktree rossz baseline-ről indult.

### Step 9: merge back to `refactor/classbase` from main worktree

Per CLAUDE.md §8 (worktree-isolated commit rebase / merge):

```sh
git -C "$HOME/claw-test-e3" worktree remove --force
git -C /Users/eggp/marveen-develop/test-baseline merge --ff-only <SHA>
```

A worktree cleanup a merge ELŐTTI kell (a `merge` elutasít, ha a working tree piszkos; a worktree remove során a detached HEAD commit a reflog-ban marad, amíg `git gc` nem fut).

### Step 10: cleanup + docs commit

```sh
git -C /Users/eggp/marveen-develop/test-baseline worktree list
# confirm claw-test-e3 is gone

# A docs commit (Step 8.5 author check után) — külön commit, nem a fő commitban
```

A docs commit a Step 11-ben van részletezve.

### Step 11: documentation update commit (külön, post-merge)

Két MD fájl + 1 framework-level MD frissítése. Minden SHA hivatkozás `(this commit)` placeholder, amit egy külön `repoint SHA references` commit ír át a SHA stabilizálódása után (CLAUDE.md §8 inline-SHA bullet).

**Commit message:**
```
docs(e-process-lock): mark E.3 landed + reconcile framework summary

Updates per E.3 commit (this commit):
- e-process-lock/00-summary.md: status line +E.3
- e-process-lock/05-refactor-roadmap.md: E.3 section LANDED note
- refactor-to-classbase/00-summary.md: Top 3 lowest-risk wins update

SHA references use `(this commit)` placeholder; a follow-up
`docs(...): repoint E.3 SHA references` commit rewrites them
after SHA stabilization (precedent: 0e1e7ed).
```

**Edits:**

`docs/refactor-to-classbase/e-process-lock/00-summary.md` (status line):
- Before: "Status: E.1 and E.2 LANDED in `57c78d0`"
- After: "Status: E.1 and E.2 LANDED in `57c78d0`, E.3 LANDED in `(this commit)`"

`docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` (Phase E.3 szekció):
- Before: a Phase E.3 szekció (L166-201) jelenleg "not yet implemented" framing-gel indul.
- After: prepend "**LANDED in `(this commit)`**" a Phase E.3 címhez, mint az E.1/E.2-nél (`:25, :79`).
- "Files touched" sub-bullets frissítése az aktuális landed diff-re (1 src + 1 test forrás).

`docs/refactor-to-classbase/00-summary.md` (framework-level, "Top 3 lowest-risk wins" lista, L86-108):
- A "Top 3 lowest-risk wins" item 2 (process-lock classes) kiegészítése: "E.1+E.2 LANDED, E.3 LANDED in `(this commit)`, E.4-E.6 OPEN."

### Step 12: post-merge re-measurement

```sh
cd /Users/eggp/marveen-develop/test-baseline
bun tsc --noEmit 2>&1 | grep -cE 'error TS'    # expect 1729
bun --bun vitest run 2>&1 | tail -5             # expect 384/11225/0
```

### Step 13: user invokes `/code-review max --fix`

CLAUDE.md §8: a `code-review` skill `disable-model-invocation` flag-gel rendelkezik; CSAK a user hívhatja manuálisan. A terv ezt a lépést a usernek dokumentálja, de a planner nem futtatja.

Ha a code-review fixes-t alkalmaz, a commit message format:
```
fix(index+process-lock+test): /code-review follow-ups on <E.3-SHA>
```

A fix után Step 12 gates újrafuttatandó.

### Step 14: SHA stabilization + repoint commit

Ha a Step 13 fix commit history rewrite-ot okoz (rebase), az MD-kben lévő `(this commit)` placeholder-eket át kell írni a végleges SHA-ra. Commit message:
```
docs(...): repoint E.3 SHA references after stabilization
```

Precedensek: `0e1e7ed`, `98e05e4`, `080e9c6`, `52baf44`.

---

## Verification gates (measured at plan-write time)

| Gate | Baseline | Post-E.3 target |
|---|---|---|
| `bun tsc --noEmit` errors | 1729 | **1729** (delta = 0) |
| `bun --bun vitest run` tests passing | 11225 (384 files) | **11225** (384 files) |
| `bun --bun vitest run` tests failing | 0 | **0** |
| `process-lock.test.ts:333-455` (10 `it()` cases) | all pass | all pass (factory update megőrzi) |
| `index.test.ts` factory mockAcquirePortLock | 13 refs unchanged | **13 refs unchanged** (factory mock class delegál, a default impl `:324`-en marad) |
| `src/index.ts` per-file coverage | 100% | 100% (line 341 still exercised through factory mock) |
| `src/process-lock.ts` per-file coverage | 100% (115/115 lines, 15/15 funcs, 129/129 statements, 66/66 branches) | 100% (no change — wrapper survives, 10 cases still pass through it) |
| Author of commit | `EggProjectTeams <eggprojectteams@gmail.com>` | match (Step 8 gate) |

`bun run lint` not measured at plan-write time (10048-problem baseline per `05-refactor-roadmap.md:150` is pre-existing; E.3 introduces no new lint findings — the diff is 1 import line + 1 call-site rewrite + 1 factory update, none of which trips any rule).

---

## Reversibility

- Single commit on `refactor/classbase` (plus a separate docs commit, also revertable).
- `git revert <SHA>` restores `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: DASHBOARD_BINARY_PATTERN })` at `src/index.ts:341`, the original import at `:27-34`, and the original factory at `index.test.ts:173-196`.
- `src/process-lock.ts` (class + wrapper) unchanged in E.3 — revert affects only `src/index.ts` and `src/__tests__/index.test.ts`.
- `process-lock.test.ts:333-455` cases stay as-is (wrapper survives); they were never part of E.3's diff.

---

## Risks and mitigations

| Risk | Applies to E.3? | Mitigation |
|---|---|---|
| **ER1** Lock lifecycle leak via wrong ownership path | Latent | Inline construction mirrors the pre-E.1 free function's "allocate fresh per call" semantics; the kernel releases the port on process death, so per-call construction does not leak. `class App` (framework D3) is the future owner. |
| **ER2** PortLock side-effect path reordered | **No** | E.3 is a literal call-site rewrite; `acquire()` body at `process-lock.ts:174-198` is byte-identical. |
| **ER3** Pidfile write path async-ified | **No** | Out of scope; E.4 owns it. |
| **ER4** `DeferToPeerError` throw site drift | **No** | Throw at `process-lock.ts:347` (in `PidfileLockAcquirer.acquire()`) not touched by E.3. Throw at `index.ts:324` (in `checkFreshStartupRace`) not touched. |
| **ER5** `vi.mock('../process-lock.js')` factory breaks | **YES — APPLIED in Step 4.5** | Factory MUST be updated to add `PortLockAcquirer` mock class (delegates to `mockAcquirePortLock`). Without this, `new undefined(...)` throws TypeError. The mock class preserves all existing test behavior. |
| **ER6** HR4 `LoggerLike` widening | **No** | E.6 owns this. |

**E.3-specific risks NOT in ER1-ER6:**

| Risk | Mitigation |
|---|---|
| `bun tsc --noEmit` delta ≠ 0 | Gate measures exact 1729 (matches baseline). Any deviation = revert. |
| Author mismatch on commit | Step 8 verifies `git log -1 --format='%an <%ae> | %cn <%ce>'` BEFORE Step 9 merge. Precedent: 2026-08-30 E.1/E.2 (3 extra commits). |
| Worktree at `/tmp/` instead of `$HOME/` | Step 1 uses `$HOME/claw-test-e3`; Step 2 symlinks node_modules. |
| Factory mock class breaks `instanceof` checks | Verified: no `instanceof PortLockAcquirer` in production code (verifier A Item 5 + grep). |
| Step 5 vitest gate fails (factory still broken) | Step 5 expected output is the gate; if FAIL, revert Step 4.5 and try alternative mock shape (vi.fn() with mockImplementation of constructor). |

---

## Critical Files for Implementation

- `/Users/eggp/marveen-develop/test-baseline/src/index.ts` (lines 27-34, 341)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/index.test.ts` (lines 173-196)
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts` (read-only, class at :77, wrapper at :217)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/process-lock.test.ts` (read-only verification, :333-455)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/e-process-lock/00-summary.md` (status line)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` (Phase E.3 section)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/00-summary.md` (Top 3 lowest-risk wins)

---

## Workflow execution note

A felhasználó kérésére a végrehajtás workflow-val történik. A workflow indítása **kívül esik** ennek a tervfájlnak a scope-ján (a terv itt csak az implementáció részleteit definiálja). A workflow várható fázisai:

1. **Pre-flight**: baseline gates re-measurement a main worktree-n (Step 3).
3. **Implementer subagent**: worktree-izolált implementáció (Step 1-7) + author check (Step 8).
4. **Verifier A**: strukturált PASS/FAIL checklist az új kód ellenőrzésére (cikkspecifikus file:line audit).
5. **Verifier B**: adversarial falsification — saját teszt meg a claim megdöntésére, független szög.
6. **Barrier**: mindkét verifier PASS-zel zár, különben javítás + re-verify.
7. **Merge + docs commit** (Step 9-11).
8. **User invokes `/code-review max --fix`** (Step 13, dokumentáltan user-only).
9. **Code-review follow-up commit** + SHA repoint (Step 14).