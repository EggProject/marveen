# Terv: `test-suite-forbid-incomplete-coverage` (16 commit + 4 külön needs-fix)

## Context

A `docs/needs-to-be-fix/` index 179 MD-ből **178 lezárt** és **1 Open**: `test-suite-forbid-incomplete-coverage` (low.md:32, HEAD `54b111c`-en filed). A `53a9f6c` globális forbid-system-calls setupFile 74 új fail-t okozott 16 fájlban; a másik 4 failing fájl (19 fail) pre-existing drift a `a330462` baseline-ról.

A user döntése (AskUserQuestion): **per-file opt-in 16 fájlra (16 commit) + a 4 CAT-D pre-existing drift külön needs-fix itemként** filingre. Végállapot: a default `bun --bun vitest run` gate 93/20 -> 19/4 fail (74 csökkenés); a CI `bun run coverage` gate a 4 pre-existing fájl kivételével zöld lesz.

A 4 CAT-D fájl (`email-send-gate.test.ts` 3 fail, `governance-gates.test.ts` 3, `hook-command-quoting.test.ts` 6, `hook-path-guard.test.ts` 7) out-of-scope erre a ciklusra — külön low.md sorok + új MD-k a `test-suite-forbid-incomplete-coverage.md` Empirical record szekciójában leírt drift-okokkal.

## Scope (16 commit, in-scope)

### CAT-A (14 fájl, vi.importActual mintával)

| # | File | Fails @ 54b111c | Mock insert site |
|---|---|---|---|
| 1 | `src/__tests__/installer-start-and-fallback.test.ts` | 13 | L2 (after `import { execFileSync }`) |
| 2 | `src/__tests__/skill-index.test.ts` | 10 | L2 |
| 3 | `src/__tests__/installer-service-auth-gate.test.ts` | 9 | L2 |
| 4 | `src/__tests__/port-chain-no-hardcode.test.ts` | 8 | L2 |
| 5 | `src/__tests__/agent-bundle.test.ts` | 7 | L3 |
| 6 | `src/__tests__/channels-reap-scope.test.ts` | 4 | L2 |
| 7 | `src/__tests__/managed-settings.test.ts` | 4 | L3 |
| 8 | `src/__tests__/memory-boundary.test.ts` | 4 | L3 |
| 9 | `src/__tests__/installer-apt-lock-set-e.test.ts` | 3 | L2 |
| 10 | `src/__tests__/package-syntax-check.test.ts` | 3 | L15 |
| 11 | `src/__tests__/staleness-guard.test.ts` | 2 | L11 |
| 12 | `src/__tests__/update-checker-branch.test.ts` | 2 | L10 |
| 13 | `src/__tests__/bridge-enroll.test.ts` | 1 | after SUT imports |
| 14 | `src/__tests__/channel-inbound-tee.test.ts` | 1 | L5 |

### CAT-B (2 fájl, vi.spyOn(process, 'kill') mintával)

| # | File | Fails @ 54b111c | Edit site |
|---|---|---|---|
| 15 | `src/__tests__/routes-updates.test.ts` | 2 | inline `it()` blokk L1225 + L1371 area, `vi.spyOn(process, 'kill').mockImplementation(...)` per-test, `finally { spy.mockRestore() }` |
| 16 | `src/__tests__/channel-coordinator-liveness.test.ts` | 1 | inline `it()` blokk L566 (ORPHAN test) |

A sorrend a fail-szám csökkenő (legnagyobb elöl), hogy a részleges haladás hamar látható legyen.

## CAT-A mock pattern (lifted from `2a28a54` + `web-command-task.test.ts:90` + `schedule-runner-full.test.ts:381` + `web-agent-bundle.test.ts:91` + `parked-input-escalation.test.ts:30`)

Beszúrandó a fájl utolsó `import` sora után, az első nem-import utasítás előtt:

```ts
// Global forbid-system-calls setupFile (vitest.config.ts) blanket-forbids
// node:child_process across the suite. This file's pinning tests run real
// subprocesses (see header for the specific API surface); the simplest
// zero-behavior-change opt-out is `vi.importActual`, which restores the real
// child_process module for this file only. Per-test-file mock wins over the
// global forbid (hoisting order: setupFile first, per-file factory second).
vi.mock('node:child_process', async () => {
  return await vi.importActual<typeof import('node:child_process')>('node:child_process')
})
```

Miért működik: a setupFile `vi.mock('node:child_process', ...)`-je (`forbid-system-calls.ts:62-85`) a workerben a per-file `vi.mock` ELŐTT fut; vitest last-registered factory nyer azonos module specifier-re, így ez a fájl-szintű passthrough felülírja a throwert csak erre a fájlra. Ugyanez a minta bizonyítottan működik `hook-path-guard.test.ts:33-35`-ben (BETA verifier megerősítette: a 7 fail NEM a blanket-ből jön, hanem pre-existing drift — a mock hatékony).

## CAT-B mock pattern

`process.kill` a `process` közvetlen property-je (nem module), ezért `vi.mock` nem állítja vissza — a setupFile (`forbid-system-calls.ts:103-111`) property-szintű cserét végzett. A per-file opt-in shape: per-test `vi.spyOn(process, 'kill').mockImplementation(...)` a `finally { spy.mockRestore() }` blokkal együtt.

`routes-updates.test.ts:1225` és `1371` (real `checkNoConcurrentUpdate` path, pid 999999 / ESRCH):
```ts
const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
  pid: number, sig?: NodeJS.Signals | number,
) => {
  if (sig === 0) {
    const e = new Error('ESRCH') as NodeJS.ErrnoException
    e.code = 'ESRCH'
    throw e
  }
  return true
}) as never)
try {
  // ... existing test body ...
} finally {
  killSpy.mockRestore()
}
```

`channel-coordinator-liveness.test.ts:566` (real `process.kill(pid, 0)` ORPHAN pid-del, ESRCH):
```ts
const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
  pid: number, sig?: NodeJS.Signals | number,
) => {
  if (sig === 0 && (pid <= 0 || pid > 4_000_000)) {
    const e = new Error('ESRCH') as NodeJS.ErrnoException
    e.code = 'ESRCH'
    throw e
  }
  return true
}) as never)
try {
  // ... existing test body ...
} finally {
  killSpy.mockRestore()
}
```

A `channel-coordinator-liveness.test.ts:550-564` self-test (real `process.kill(process.pid, 0)`) jelenleg is átmegy — NEM szabad módosítani. Csak az ORPHAN tesztet patch-eljük.

## Végrehajtási recept (commit-onként, worktree-ből)

### Worktree setup (egyszer az elején, takarítás a végén)

```bash
git -C /Users/eggp/marveen-develop/test-baseline worktree add --detach /tmp/claw-fix-forbid test/baseline
ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-fix-forbid/node_modules
```

Minden `bun --bun vitest run` a `/tmp/claw-fix-forbid`-ből fut (a `store/` pollution és az `assert-not-live-install.ts` guard elkerülésére, CLAUDE.md 8.).

### Per-commit lépések (minden fájlhoz)

1. **Read forrás a beszúrási ponton** (CLAUDE.md 8. ground-truth check): nyisd meg a target fájlt, ellenőrizd (a) `vi` a vitest importban van-e (vagy globals:true a vitest.config.ts:12-ből), (b) az import blokk rendesen végződik-e, (c) nincs már meglévő `vi.mock('node:child_process', ...)` a fájlban (ütközés lenne).
2. **Mock beszúrása** a §3 táblázatban megadott insert site-ra, a §4a vagy §4b minta szerint.
3. **Per-file verify**: `bun --bun vitest run src/__tests__/<file>.test.ts --reporter=basic 2>&1 | tail -30` — a fájl fail-száma a §3 táblázatban lévő N-ről 0-ra csökkenjen.
4. **Cross-file regression check**: `bun --bun vitest run 2>&1 | tail -10` — a teljes fail-szám pontosan N-nel csökkenjen, ne legyen új fail máshol. Ha van, STOP és investigate.
5. **Commit** (CLAUDE.md 7.: kötelező commitolni, 8.: SHA-placeholder pattern):
   ```
   git add src/__tests__/<file>.test.ts
   git commit -m "test(<file>): opt out of forbid-system-calls via vi.importActual<...>(node:child_process)

   Closes part of test-suite-forbid-incomplete-coverage (low.md:32).

   Per-file vi.mock with vi.importActual restores the real child_process
   module for this file only. Per-test-file mock wins over the setupFile
   mock because the per-file factory is hoisted AFTER the setupFile (see
   src/__tests__/setup/forbid-system-calls.ts:43-46, 2a28a54 precedent).

   N tests in this file went from fail to pass under bun --bun vitest run."
   ```
   A 2 CAT-B commit subject: `test(<file>): stub process.kill via vi.spyOn for forbid-system-calls opt-out`.

### Pre-flight checks a 16 commit előtt

1. **Cross-cutting fetch risk** (Honcho memory: per-API escape hatch shape): grep minden CAT-A fájlra `fetch(`-re. Az Explore pass zero hitet mutatott — ha valamelyik fájlban van `fetch(` hívás, ahhoz `vi.stubGlobal('fetch', globalThis.__originalFetch)` is kell (a setupFile `forbid-system-calls.ts:97-100` elmenti az eredetit erre a célra).
2. **process.kill risk CAT-A fájlokban**: grep `process.kill` minden CAT-A fájlra. Az Explore pass zero hitet mutatott — CAT-A fájlok csak `node:child_process`-t használnak, nem `process.kill`-t vagy `fetch`-et.
3. **Stale MD line refs** (CLAUDE.md 8.): `cd /tmp/claw-fix-forbid && bun --bun vitest run 2>&1 | grep -E "Test Files|Tests +[0-9]+ failed" | tail -5` — ha a §3 számai eltérnek a §3 táblázattól, frissítsd a sorrendet commit előtt.

## Verification (végén)

```bash
cd /tmp/claw-fix-forbid
bun --bun vitest run 2>&1 | tail -10
```

Elvárt: **Test Files 4 failed | 362 passed (366)**; **Tests 19 failed | 11156 passed (11175)**. A 19 fail kizárólag a 4 CAT-D fájlban legyen (email-send-gate 3 + governance-gates 3 + hook-command-quoting 6 + hook-path-guard 7).

A 16 in-scope fájl mind fail-szám 0-ra csökkent, és nincs új fail máshol.

## Double verify (2 subagent, párhuzamos, Agent tool isolation: worktree)

**ALPHA — checklist verifier**:
- Mind a 16 fájlra: vi.mock/vi.spyOn block létezik, line position valid (import és describe/vi.hoisted között), factory shape egyezik a §4a/§4b-vel, nincs `as any` shortcut.
- A 4 CAT-D fájl byte-identikus a `test/baseline`-hoz: `git diff test/baseline..HEAD -- src/__tests__/{email-send-gate,governance-gates,hook-command-quoting,hook-path-guard}.test.ts` üres.
- A diff csak `src/__tests__/*.test.ts`-t érint (nincs source/setupFile/vitest.config.ts módosítás).
- Output: per-file PASS/FAIL file:line bizonyítékkal.

**BETA — adversarial falsifier**:
- Fresh worktree a merge-result branch-ről, független `bun --bun vitest run`.
- Megerősíti: total fail = 19, eloszlás: email-send-gate 3 + governance-gates 3 + hook-command-quoting 6 + hook-path-guard 7.
- Megerősíti: delta = 93 - 19 = 74 fail removed, egyezik a §3 sum-mal (13+10+9+8+7+4+4+4+3+3+2+2+2+1+1+1 = 74).
- 3 random fájl a 16-ból izolált újrafuttatása: zero fail each.
- Adversarial: tudatosan revertálja EGY commit mock-ját, megerősíti hogy a fájl fail-száma visszatér (validálja hogy a mock load-bearing, nem véletlenül zöld). Restore.

A két verifier **különböző szöget** kap (CLAUDE.md 8. precedens 2026-08-26).

## Worktree cleanup + merge back (a 16 commit + double verify után)

```bash
cd /Users/eggp/marveen-develop/test-baseline
git merge-base test/baseline /tmp/claw-fix-forbid  # confirm branch HEAD matches
git worktree remove /tmp/claw-fix-forbid --force
git merge --ff-only <SHA-of-final-commit>
```

**Tilos** `git reset --hard <SHA>` — security warning-ot triggerel (CLAUDE.md 8.). A `--ff-only` merge a dokumentált út.

## User-triggered final step

A user külön hívja a terminálban:
```
/code-review max --fix 54b111c..HEAD
```
(CLAUDE.md 8.: a `/code-review` skill `disable-model-invocation` flag-gel rendelkezik, a Skill tool elutasítja, CSAK a user hívhatja manuálisan.)

## Out-of-scope: 4 CAT-D pre-existing needs-fix filing (utolsó commit)

A 4 CAT-D fájl külön needs-fix itemként filingre kerül (1 docs-only commit, a 16 source commit után):

| File | Drift ok |
|---|---|
| `email-send-gate.test.ts` | `injectEmailSendGate` writes real settings.json; no per-file opt-in |
| `governance-gates.test.ts` | `injectSelfPaceGate` writes real settings.json; no per-file opt-in |
| `hook-command-quoting.test.ts` | quoting + migration tests use real `execFileSync`; no per-file opt-in |
| `hook-path-guard.test.ts` | `vi.importActual` IS in place at L33-35, de a 7 fail test/code drift (STALENESS_HOOK path resolution, python3 fixture, `isUnsafeHookCommand` divergence) |

A filing formátuma: új sor a `low.md`-ben + 1-1 új MD a `docs/needs-to-be-fix/`-ben, ahol a Title és a File:Line a CAT-D drift konkrét okát írja le (hivatkozva a `test-suite-forbid-incomplete-coverage.md:64, 86-94` Empirical record szekcióra).

A `low.md:32` row (`test-suite-forbid-incomplete-coverage`) státusza frissül `Open — partial: 74 of 93 fails fixed via 16 per-file opt-in commits (2026-08-27), remaining 19 pre-existing fails filed as separate items` formátumban, a 16 SHA + a 4 új MD SHA referencia placeholder-rel (CLAUDE.md 8.).

## Kritikus fájlok

- `src/__tests__/setup/forbid-system-calls.ts` — a gate; meghatározza a per-file opt-in shape-et és a `MARVEEN_TEST_*` env var-okat
- `vitest.config.ts:21-26` — a setupFile-ok regisztrációs sorrendje
- `src/__tests__/hook-path-guard.test.ts:33-35` — a működő vi.importActual precedens (a §4a minta forrása)
- `src/__tests__/web-command-task.test.ts:90`, `schedule-runner-full.test.ts:381`, `web-agent-bundle.test.ts:91`, `parked-input-escalation.test.ts:30` — további működő precedensek
- `docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` — source-of-truth MD; a 16 commit után frissül a 4 CAT-D filinggel és a SHA reference-ekkel
- `package.json:15-17` — test vs test:integration vs test:integration:real-world script split

## Referenciák (reuse)

- `vi.importActual<typeof import('node:child_process')>('node:child_process')` — a Honcho-ból dokumentált per-API escape hatch shape (would-be CLAUDE.md patch #3)
- `vi.spyOn(process, 'kill').mockImplementation(...)` + `finally { spy.mockRestore() }` minta — Honcho-ból (would-be CLAUDE.md patch #3)
- `vi.hoisted` — `schedule-runner-precheck.test.ts:18-30` mintájára (hand-rolled factory), csak CAT-B edge case-eknél kell

## Kötelező szabályok (CLAUDE.md)

- **NE pusholj** (6.) — minden commit lokálisan marad
- **NE amendelj** (7./8.) — SHA-placeholder + follow-up pattern
- **Dupla verify** (8.) — ALPHA checklist + BETA adversarial, különböző szög, isolation: worktree, Agent tool (nem Workflow tool)
- **Worktree-isolated execution** (8.) — `/tmp/claw-fix-forbid`, `git merge --ff-only` a végén
- **File:line ref Read-ellenőrzés** commit előtt ÉS után (Honcho memory #2)
- **Minden commit commitolva** (7.)
- **Minden bug teszttel lefedve** (8.) — jelen esetben a per-file verify a regression teszt (újrafuttatás a fájlra)
- **Coverage szám csak flag nélküli futásból** (8.) — minden verify a `bun --bun vitest run` (no flags) parancsot használja
- **Coverage/ .gitignore** (8.) — nem futtatunk `bun run coverage`-t, mert a JSON nem lenne committálható (`.gitignore:98-99`)

## Definition of Done

- 16 commit a `test/baseline`-en (vagy feature branch-en, ami `--ff-only` merge-ölhető vissza), mind a §3 §5.3 + §5.4 gate-en átment
- Teljes `bun --bun vitest run` 19 fail / 4 fájlt mutat (visszaesés 93/20-ról)
- A 4 CAT-D fájl byte-identikus a pre-batch állapothoz
- ALPHA + BETA verifier riportok csatolva
- `git worktree remove /tmp/claw-fix-forbid --force` lefutott
- `git merge --ff-only <SHA>` sikeres a `test/baseline`-en
- A 4 CAT-D needs-fix filing (1 docs-only commit) landolt
- `low.md:32` row frissítve a 16 SHA-val + 4 új MD SHA-val, status: `Open — partial: 74 of 93 fails fixed`
- Usernek jelezve: `/code-review max --fix 54b111c..<new-HEAD>` manuális indítása
- A 6 commit (54b111c előtti) pusholatlan marad (CLAUDE.md 6.); a user dönt a push-ról
