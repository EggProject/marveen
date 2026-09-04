# E.4 — PidfileLock consumer migration (refactor/classbase)

## Context

A `docs/refactor-to-classbase/` 9 fázisa (Phase 0–8) közül a Phase 2
(`process-lock.ts`) részben landolt: E.1+E.2 (`57c78d0`, mindkét class +
free fn wrapper) és E.3 (`22684fd`, port-lock consumer migráció) már a
branch-en vannak. A phase utolsó nyitott eleme az **E.4 — pidfile-lock
consumer migráció**: a `releaseLock()` body-t és a 4 release call site-ot
kell a `PidfileLockAcquirer` class metódusaira átállítani.

**Miért most:** a `PidfileLockAcquirer` class már él (`src/process-lock.ts:314`),
DE a `release()` metódust az E.1/E.2 eltérés-táblázat szándékosan E.4-re
hagyta. A class-vs-functional-decision tree alapján a class jogos (instance
state `ctx: PidfileLockContext` `this`-en + DI), tehát a `release()` metódus
hozzáadása a class-hoz NEM ceremony — a class logikus kiterjesztése.

**Cél:** a `src/index.ts` releaseLock consumer hívásait a class
`.release(path, selfPid)` metódusára állítani, a 4 release call site
változatlanul hagyása mellett (a `releaseLock()` body cserélődik, nem a
hívók).

## Scope (GREP-ellenőrzött)

### Érintett fájlok
1. `src/process-lock.ts` — `release()` metódus hozzáadása a `PidfileLockAcquirer` class-hoz
2. `src/index.ts` — import csere + `pidfileLockAcquirer` module-scope `let` + `releaseLock()` body csere
3. `src/__tests__/index.test.ts` — `vi.mock` factory bővítése + `mockPidfileLockRelease` hoisted mock
4. `src/__tests__/process-lock-classes.test.ts` — 3 új `it()` case a `release()` metódushoz

### GREP-verified tények
- `PidfileLockAcquirer` class: `src/process-lock.ts:314-388` (`acquire` a `:317`-en, class `}` a `:388`-on)
- `acquirePidfileLock` free function wrapper: `src/process-lock.ts:390-392`
- A class-ban **NINCS** `release()` metódus (`grep -n 'release(' src/process-lock.ts`: 0 találat a class body-ban)
- `releaseLock()` body: `src/index.ts:359-367`
- 4 release call site: `src/index.ts:396` (hardKill timer), `:405` (webServer.close callback), `:411` (early shutdown), `:416` (catch block)
- Module-scope `let` blokk: `src/index.ts:374-379` (`decayInterval`, `digestTimer`, `digestInterval`, `webServer`, `shuttingDown`, `exitCode`)
- A mock factory `src/__tests__/index.test.ts:190-199` `PidfileLockAcquirer` mock class-t **NEM** tartalmaz, csak a `acquirePidfileLock: mockAcquirePidfileLock` free function exportot
- A `process-lock-classes.test.ts:44-60` `buildPidfileCtx` helper `tryCreateExclusive` + `readRecordedPid` ctx metódusokat biztosít (a `release()` ezeket fogja hívni)

## Végrehajtási terv (M1–M5)

### M1: `release(path, selfPid)` metódus hozzáadása a class-hoz

**Fájl:** `src/process-lock.ts`, beszúrás a `:387` sor után, közvetlenül a class záró `}`-je (`:388`) ELŐTT.

**Hozzáadandó kód:**

```typescript
  /**
   * Best-effort cleanup: read the pidfile and unlink it IFF its recorded
   * PID equals `selfPid`. Mirrors the legacy `releaseLock()` free function
   * at src/index.ts:359-367 -- the guard `recorded === selfPid` is what
   * prevents a shutdown path from nuking a successor's already-acquired
   * pidfile. Silent on ENOENT / parse failures / mismatch (they all
   * indicate "someone else owns (or already cleared) this slot").
   *
   * Sync because all underlying I/O is sync (readFileSync + unlinkSync
   * via ctx), and shutdown callers cannot await (invoked from
   * process.on('SIGTERM') / hardKill timer where delay blocks exit).
   *
   * Per-call (path, selfPid) signature matches `acquire(path, selfPid, opts)`.
   */
  release(path: string, selfPid: number): void {
    const recorded = this.ctx.readRecordedPid(path)
    if (recorded == null) return
    if (recorded !== selfPid) return
    this.ctx.unlinkIfMatches(path, recorded)
  }
```

**Döntések:**
- **Per-call (path, selfPid)**, NEM constructor-captured — konzisztens az `acquire(path, selfPid, opts)` mintával + kompatibilis az E.2-vel szállított constructor signature-rel (`constructor(private readonly ctx: PidfileLockContext)`)
- **Szinkron** (NEM async) — a ctx metódusok (`readRecordedPid`, `unlinkIfMatches`) mind szinkron fs read/unlink; a shutdown hívók nem tudnak await-et
- **`recorded == null` early return** — corrupt pidfile, NEM a miénk, ne unlinkeljük
- **`recorded !== selfPid` early return** — PID recycling esetén NEM szabad törölni (a successor már birtokolja)

### M2: `src/index.ts` — import csere + acquire body migráció + module-scope `let`

**Fájl:** `src/index.ts`, 3 lokális módosítás.

**M2a — import block (`src/index.ts:27-34`):** `acquirePidfileLock` → `PidfileLockAcquirer` (a többi import változatlan).

```typescript
import {
  PortLockAcquirer,
  PidfileLockAcquirer,          // ← csere
  writeBufferFully,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from './process-lock.js'
```

**M2b — acquireLock body (`src/index.ts:351-353`):** a free function hívás átállítása class instance-ra.

EREDETI:
```typescript
  await acquirePidfileLock(PID_FILE, process.pid, buildPidfileLockContext(procCtx), {
    onLiveLegitimate: 'defer',
  })
```

ÚJ:
```typescript
  pidfileLockAcquirer = new PidfileLockAcquirer(buildPidfileLockContext(procCtx))
  await pidfileLockAcquirer.acquire(PID_FILE, process.pid, { onLiveLegitimate: 'defer' })
```

**M2c — module-scope `let` (`src/index.ts:374-379` blokk):** a `pidfileLockAcquirer` deklarálása a többi module-scope state mellé.

```typescript
let pidfileLockAcquirer: PidfileLockAcquirer | null = null   // ← új sor, beszúrva a blokk első soraként
let decayInterval: NodeJS.Timeout | null = null
let digestTimer: NodeJS.Timeout | null = null
// ... a többi változatlan
```

A `| null` + `null` kezdeti érték azért kell, mert a `releaseLock()` az `acquireLock()` ELŐTTI early-fail init path-on is hívódhat (a main catch handler eléri, ha az `acquireLock` rejectelt). A releaseLock null-check megvédi a `Cannot read property 'release' of null` hibától.

### M3: `src/index.ts` — `releaseLock()` body csere

**Fájl:** `src/index.ts:359-367`.

EREDETI:
```typescript
function releaseLock(): void {
  try {
    const recordedPid = readRecordedPidFrom(PID_FILE)
    if (recordedPid !== process.pid) return
    unlinkSync(PID_FILE)
  } catch {
    // best-effort: the pidfile may already be gone (successor unlinked it)
  }
}
```

ÚJ:
```typescript
function releaseLock(): void {
  if (pidfileLockAcquirer == null) return // pre-acquireLock shutdown; nothing to clean up
  try {
    pidfileLockAcquirer.release(PID_FILE, process.pid)
  } catch {
    // best-effort: the pidfile may already be gone (successor unlinked it)
  }
}
```

A 4 call site (`:396, :405, :411, :416`) **VÁLTOZATLAN** marad — a `releaseLock()` függvény szignatúrája nem változik, csak a body. A `readRecordedPidFrom` függvény (`:179`) **nem törlendő** — máshol használatban van (`checkFreshStartupRace` a `:301`-en).

### M4: `src/__tests__/index.test.ts` — mock factory bővítése + hoisted mock

**Fájl:** `src/__tests__/index.test.ts`, 2 lokális módosítás.

**M4a — `mockPidfileLockRelease` hoisted mock:** a `vi.hoisted()` callback-ben (`:40-42` és `:72-73` környékén) új `vi.fn()` inicializálás.

**M4b — vi.mock factory (`src/__tests__/index.test.ts:190-199`):** `PidfileLockAcquirer` mock class hozzáadása a `PortLockAcquirer` mock mintájára.

```typescript
  return {
    PortLockAcquirer: class {
      constructor(public readonly ctx: unknown) {}
      acquire = (port: number, opts: unknown = {}): Promise<void> =>
        mockAcquirePortLock(port, this.ctx, opts)
    },
    PidfileLockAcquirer: class {                                       // ← új mock class
      constructor(public readonly ctx: unknown) {}
      acquire = (path: string, selfPid: number, opts: unknown = {}): Promise<void> =>
        mockAcquirePidfileLock(path, selfPid, this.ctx, opts)
      release = (path: string, selfPid: number): void => {
        mockPidfileLockRelease(path, selfPid)
      }
    },
    acquirePidfileLock: mockAcquirePidfileLock,                       // ← MEGŐRZENDŐ
    writeBufferFully: actual.writeBufferFully,
    DeferToPeerError: actual.DeferToPeerError,
  }
```

A `acquirePidfileLock: mockAcquirePidfileLock` factory export **MEGTARTANDÓ**, mert a `withRealAcquirePidfileLock` helper (`:1321-1335`) ezt használja `mockImplementation(vi.importActual.acquirePidfileLock)` formában. A factory törlése esetén a helper eltörne.

### M5: `src/__tests__/process-lock-classes.test.ts` — `release()` lefedettségi tesztek

**Fájl:** `src/__tests__/process-lock-classes.test.ts`, 3 új `it()` case a `describe('PidfileLockAcquirer')` blokkba (a fájl már tartalmazza a class importját a `:4`-en és a `buildPidfileCtx` helper-t a `:44-60`-on).

```typescript
describe('PidfileLockAcquirer.release', () => {
  it('unlinks when recorded === selfPid', () => { /* ... */ })
  it('is a no-op when recorded !== selfPid', () => { /* ... */ })
  it('is a no-op when recorded is null (corrupt pidfile)', () => { /* ... */ })
})
```

A 3 case a `src/process-lock.ts:387` utáni új metódus mind a 3 branch-ét lefedi:
- `recorded == null` → return (corrupt)
- `recorded !== selfPid` → return (valaki másé)
- `recorded === selfPid` → `ctx.unlinkIfMatches(path, recorded)`

A `buildPidfileCtx` helper `files: Map<string, number>`-el seed-eli a pidfile tartalmát; az `unlinkIfMatches` a ctx-en belül a `files.delete(path)` hívással ellenőrizhető.

## Verification gates (GREP-ellenőrzött baseline, E.4 ELŐTT mérve)

A `refactor/classbase` branch, working tree clean, ahead of origin by 11 commit esetén:

| Gate | Jelenlegi érték | E.4 utáni elvárás |
|---|---|---|
| `bun tsc --noEmit` | 0 hiba | 0 hiba (NEM változhat) |
| `bun run lint` | 9783 problems | 9783 (vagy kevesebb, ha `release()` body lint-tisztább) |
| `bun --bun vitest run` | 384 / 11225 / 0 | 384 / 11228 / 0 (+3 új release teszt) |
| Coverage `src/process-lock.ts` | 100% lines/functions/statements/branches | 100% (M5 biztosítja) |
| Coverage `src/index.ts` | a jelenlegi szám | nem csökkenhet |

**Implementációs gate-ek (commit ELŐTT futtatandó):**

1. `grep -rln 'acquirePidfileLock' src/ --include='*.ts' | grep -v __tests__` → csak `src/process-lock.ts` (a wrapper) maradhat; ha `src/index.ts`-ben marad → rollback + revise
2. `grep -n 'releaseLock()' src/index.ts` → 4 hívás a `:396, :405, :411, :416`-on (változatlan), a body a `:359-367`-en már `pidfileLockAcquirer.release(PID_FILE, process.pid)` formátumban
3. `git grep -n 'new PidfileLockAcquirer' src/index.ts` → 1 találat (az acquireLock body-ban)
4. `git grep -n 'pidfileLockAcquirer' src/index.ts` → 3 találat: module-scope deklaráció, acquireLock értékadás, releaseLock body hívás

## Végrehajtás: Workflow script (vázlat)

A user kérésére **workflow tool**-t használunk, **dupla ellenőrzéssel** (2
verifier subagent, **eltérő szöggel**) és **a végén `/code-review max --fix`**
skill-lel. A workflow a jelenlegi branch-ről indul és oda vezet vissza.

### Workflow fázisok (Phase 1–6)

```javascript
// Workflow script vázlat — a végrehajtás előtt a workflow-authoring skill alapján finomítandó

export const meta = {
  name: 'e4-pidfile-lock-consumer',
  description: 'E.4 — PidfileLockAcquirer consumer migration with double verification and code review',
  phases: [
    { title: 'Worktree setup' },
    { title: 'Implementation' },
    { title: 'Double verification' },
    { title: 'Code review + fix' },
    { title: 'Docs reconciliation' },
    { title: 'Branch merge' },
  ],
}

// Phase 1: Worktree setup
// - git worktree add --detach $HOME/claw-test-e4 refactor/classbase
// - ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-test-e4/node_modules
// - cd $HOME/claw-test-e4
// (Lásd CLAUDE.md §8: NE /tmp/ alatt, mert a hook registration guard ott elutasít)

// Phase 2: Implementation (1 agent, worktree-isolated)
// Agent task: M1-M5 végrehajtása, commitolás EggProjectTeams <eggprojectteams@gmail.com> author-ral
// Commit message placeholder: "(this commit)"
// Verification: bun tsc --noEmit + bun run lint + bun --bun vitest run + coverage src/process-lock.ts

// Phase 3: Double verification (2 agent, ELTÉRŐ szög)
// - Verifier A: strukturált PASS/FAIL checklist (minden M1-M5 claim, file:line, gate szám)
// - Verifier B: adversarial falsification (próbálja megdönteni a terv állításait — release() metódus
//   valóban szinkron-e, a mock factory valóban forwardol-e, a 4 call site valóban változatlan-e)

// Phase 4: /code-review max --fix skill (USER ÁLTALI INVOKÁCIÓ — lásd CLAUDE.md §8)
// A skill disable-model-invocation flag-gel rendelkezik, ez CSAK a user indíthatja terminálban.
// A workflow ezt a fázist SKIP-re állítja, és a usernek szóló üzenetben jelzi.

// Phase 5: Docs reconciliation
// - src/process-lock.ts: M1 release() metódus JSDoc frissítés, ha a code-review változtat
// - docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md: E.4 szekció státusz → "LANDED"
// - Commit message: "(this commit)" → valódi SHA átírása

// Phase 6: Branch merge
// - git -C $HOME/claw-test-e4 log -1 --format='%an <%ae>'  (ellenőrizni: EggProjectTeams)
// - git -C /Users/eggp/marveen-develop/test-baseline worktree remove $HOME/claw-test-e4 --force
// - cd /Users/eggp/marveen-develop/test-baseline
// - git merge --ff-only <SHA>  (HA a merge-base megegyezik a branch HEAD-del)
// - A (this commit) placeholder-ek átírása a docs/commit message-ben (külön follow-up commit, lásd CLAUDE.md §8)
```

### Worktree-isolated commit visszavezetése

A CLAUDE.md §8 szabályai szerint:
- A worktree-isolated subagent commit **NE** `git reset --hard <SHA>`-dal kerüljön a branch-re (security warning)
- Helyette `git merge --ff-only <SHA>`, ha a commit a branch gyermeke (`git merge-base refactor/classbase <SHA>` ellenőrzés)
- Working tree clean kell legyen a merge előtt
- A worktree cleanup: `git worktree remove $HOME/claw-test-e4 --force`
- A detached HEAD commit a reflog-ban megmarad a merge-ig

### Szerző ellenőrzése commit után

A CLAUDE.md §8: **Minden subagent commit után ellenőrizd a szerzőt MIELŐTT továbbmennél.**
- `git log -1 --format='%an <%ae> | %cn <%ce>'` — összevetés `git config user.email`-lel
- Ha eltérés (pl. `claude@anthropic.com` author), ÁLLJ MEG és kérdezd meg a user-t

### /code-review max --fix user invokáció

A CLAUDE.md §8: a `/code-review` skill `disable-model-invocation` flag-gel rendelkezik. **A Skill tool elutasítja**, CSAK a user hívhatja manuálisan a terminálban. A workflow ezt a fázist a usernek szóló üzenettel zárja.

## Hibakezelés és edge case-ek

### `release()` metódus design
- **Miért sync, nem async**: a `releaseLock()` eredetileg szinkron (`function releaseLock(): void`). A `release()` body minden I/O-ja szinkron (`ctx.readRecordedPid` szinkron `readFileSync`, `ctx.unlinkIfMatches` szinkron `unlinkSync`). A shutdown hívók (process.on('SIGTERM'), hardKill setTimeout callback) nem tudnak await-et, mert a process.exit hamarosan jön.
- **Miért per-call (path, selfPid), nem constructor-captured**: a `(path, selfPid)` per-arg forma megőrzi az E.2-vel szállított class signature-t (`constructor(private readonly ctx)`), és konzisztens az `acquire(path, selfPid, opts)` mintával.
- **`recorded == null` early return**: a `tryCreateExclusive` race esetén a pidfile létezhet de a tartalma corrupt lehet — a `readRecordedPid` `null`-t ad vissza. Nem szabad unlinkelni, mert nem a miénk.
- **`recorded !== selfPid` early return**: korai `unlinkIfMatches(path, recorded)` megvéd attól, hogy a miénk előtt/után egy másik process nyert O_EXCL-t (PID recycling eset).

### `deferToPeerError` byte-identical megőrzése
- A throw site (`src/process-lock.ts:370`) VÁLTOZATLAN: `throw new DeferToPeerError(recorded)`
- Az `instanceof DeferToPeerError` consumer (`src/index.ts:559`) VÁLTOZATLAN: a class ugyanazt az error class-t dobja

### Mock factory pattern (az E.3 mintából)
- A `PidfileLockAcquirer` mock class `acquire = (path, selfPid, opts) => mockAcquirePidfileLock(path, selfPid, this.ctx, opts)` formátumban forwardol — ugyanaz, mint a `PortLockAcquirer` mock az E.3-ban
- A `release = (path, selfPid) => mockPidfileLockRelease(path, selfPid)` forwardolás az új metódus mock-ja
- A `this.ctx` binding csak acquire-hez kell (release nem használja), de a constructor szignatúra konzisztens a PortLock mintával

### `pidfileLockAcquirer == null` védelem
- Ha a `releaseLock()` az `acquireLock()` ELŐTT hívódik (early-fail init path vagy `process.on('uncaughtException')` a main async flow előtt), a `null` check megakadályozza a `Cannot read property 'release' of null` hibát
- A main async flow-ban (`main() → await acquireLock() → install signal handlers → run`) ez az eset akkor fordul elő, ha a `process.on('uncaughtException')` handler a `acquireLock` befejezése előtt aktiválódik

## Rollback terv

- **1 commit** (vagy 2, ha a docs reconciliation külön commit), teljes mértékben visszaállítható `git revert <SHA>`-val
- A commit **4 fájlt** érint: `src/process-lock.ts` (M1), `src/index.ts` (M2+M3), `src/__tests__/index.test.ts` (M4), `src/__tests__/process-lock-classes.test.ts` (M5)
- A **legacy free function wrapper** `acquirePidfileLock` (`src/process-lock.ts:390-392`) **MEGMARAD** E.4 után is — E.5 (vagy későbbi fázis) törli majd
- A `releaseLock()` függvény a `src/index.ts:359-367`-ben **megmarad** mint szintaxis — csak a body tér vissza rollback esetén
- Nincs adatbázis-migráció, nincs schema-változás, nincs build artifact érintettség — pure kód-szintű refaktor

## Kritikus fájlok (végrehajtáshoz)

- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts` — M1 (release metódus)
- `/Users/eggp/marveen-develop/test-baseline/src/index.ts` — M2 (import + acquire body + module-scope let), M3 (releaseLock body)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/index.test.ts` — M4 (mock factory + hoisted mock)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/process-lock-classes.test.ts` — M5 (3 új it())
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` — Phase 5 (docs reconciliation, E.4 szekció státusz → LANDED)

## Commit message javaslat (placeholder)

```
refactor(index): migrate acquirePidfileLock + releaseLock to PidfileLockAcquirer class (E.4)

E.4 proof consumer for the PidfileLockAcquirer class extracted in 57c78d0.
Adds a release(path, selfPid) method to src/process-lock.ts:PidfileLockAcquirer
so the releaseLock() body at src/index.ts:359-367 can delegate to it; the
four releaseLock() call sites (:396, :405, :411, :416) are unchanged.

Replaces the wrapper call at src/index.ts:351 with the class form
(`new PidfileLockAcquirer(buildPidfileLockContext(procCtx)).acquire(PID_FILE, process.pid, { onLiveLegitimate: 'defer' })`).

The free-function wrapper at process-lock.ts:390-392 survives (E.5 owns
its removal). The vi.mock factory at index.test.ts:173-200 extends with
a PidfileLockAcquirer mock class whose acquire(path, selfPid, opts)
delegates to mockAcquirePidfileLock and release(path, selfPid) delegates
to a new mockPidfileLockRelease vi.fn.

process-lock-classes.test.ts gains three release() it() cases pinning the
recorded===selfPid, recorded!==selfPid, and recorded==null branches.

Refs: docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md (E.4)
Refs (this commit): (to be filled after commit)
```
