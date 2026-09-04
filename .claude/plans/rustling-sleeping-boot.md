# Cycle 38 Plan: web.ts close() teardown hardening

## Context

Két MEDIUM/LOW priority MD ugyanazt a kódterületet (`src/web.ts` close() override) érinti. Mindkettő valódi, termelésben is elérhető bug:

1. **`web-watchdog-survives-close`** (`src/web.ts:310-319` arm + `:539-562` close override) — A not-listening watchdog két `setTimeout`/`setInterval` hívását semmi sem tartja referenciában, így a close() override nem tudja törölni. Egy szándékos `server.close()` (amely `listening: false`-ra vált) után a watchdog 7 perc múlva elkezdi figyelni, és a következő 60 s tickben `process.exit(1)`-et hív — miközben a process pontosan azt tette, amit kértek. A poszt-mortem log ("Web server not listening -- exiting(1)") a rossz okra mutat.

2. **`web-worker-warmup-ignores-close`** (`src/web.ts:339-343`) — A warm-up `import('./web/agent-worker.js').then(...)` nem olvassa a `workerLivenessCancelled` flag-et, pedig ugyanaz a mintázat. Ha a close() a dynamic import feloldása előtt fut le, a warm-up akkor is elindítja a `startWorkerSession`-t egy már lezárt szerverhez. A liveness monitor számára ezért vezették be a flag-et; a warm-up ugyanebbe a hibába esik.

A korábbi terv (agent-worker-settings-symlink-preserve) az adversarial verifier által REFUTED: a `WORKER_CONFIG_SKIP` set kihagyja a `settings.json`-t a symlink loopból (`src/web/agent-worker.ts:60`), tehát a `sst?.isSymbolicLink()` branch termelésben STRUCTURALLY UNREACHABLE. A MD premise hamis — a fix defensive code lenne egy unreachable branch-re, ami sérti a CLAUDE.md §2-t ("Nothing speculative").

A pivot szükséges: két VALÓDI, elérhető bug, azonos fájl, azonos close() override blokk → egyetlen kombinált source fix.

## Approach

### Source change: `src/web.ts`

**1. Watchdog (lines 310-319):** A két timer handle-t module-szintű változókba emeljük, és a close() override-ban töröljük.

```ts
let startupWatchdogGrace: NodeJS.Timeout | undefined
let startupWatchdogPoll: NodeJS.Timeout | undefined
const STARTUP_GRACE_MS = 7 * 60 * 1000
const RELISTEN_POLL_MS = 60 * 1000
startupWatchdogGrace = setTimeout(() => {
  startupWatchdogPoll = setInterval(() => {
    if (!server.listening) {
      logger.error({ port }, 'Web server not listening -- exiting(1) for a clean launchd restart')
      process.exit(1)
    }
  }, RELISTEN_POLL_MS)
  startupWatchdogPoll.unref()
}, STARTUP_GRACE_MS)
startupWatchdogGrace.unref()
```

**2. Warm-up (lines 339-343):** A `workerLivenessCancelled` flaget átnevezzük `workerStartupCancelled`-ra, és a warm-up `.then()` is ellenőrzi.

```ts
if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
  import('./web/agent-worker.js')
    .then(m => {
      if (workerStartupCancelled) return
      m.startWorkerSession()
      logger.info('Interactive agent worker pre-started')
    })
    .catch(err => logger.warn({ err }, 'Failed to pre-start agent worker (will lazy-start on first use)'))
}
```

`workerLivenessCancelled` → `workerStartupCancelled` rename a `:19, :359, :544` három helyen.

**3. Close() override (lines 539-562):** Hozzáadjuk a két watchdog timer clear-ét.

```ts
server.close = (cb?: (err?: Error) => void) => {
  clearInterval(routerInterval)
  clearInterval(scheduleInterval)
  if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
  workerStartupCancelled = true  // renamed
  if (workerLivenessInterval) clearInterval(workerLivenessInterval)
  if (startupWatchdogGrace) clearTimeout(startupWatchdogGrace)
  if (startupWatchdogPoll) clearInterval(startupWatchdogPoll)
  // ... többi clearInterval marad
  return origClose(cb)
}
```

### Test changes: `src/__tests__/web-server.test.ts`

**Test A (line 537-550):** Jelenleg a watchdog bugot pineli. Átfordítjuk a fixre.

```ts
it('clears the startup watchdog on close() (no spurious exit)', async () => {
  const srv = await boot()
  await flush()
  srv.close()
  srv.listening = false

  vi.advanceTimersByTime(7 * 60 * 1000 + 60 * 1000)

  expect(exitCalls).toEqual([])
})
```

**Test B (line 526-535):** Jelenleg a warm-up bugot pineli. Átfordítjuk, hogy mindkét import close-előtti feloldásakor NE induljon el.

```ts
it('does not start either worker when close() ran before the imports resolved', async () => {
  const srv = await boot()
  srv.close()
  await flush()
  expect(H.startWorkerLivenessMonitor).not.toHaveBeenCalled()
  expect(H.startWorkerSession).not.toHaveBeenCalled()
})
```

**Meglévő test, ami a watchdog HELYES működését pineli (line 732-745):** Változatlanul marad — a watchdog akkor is ki kell hogy lőjön, ha a listener menet közben hal meg close() nélkül.

### Docs change: `docs/needs-to-be-fix/INDEX.md`

A `:37` és `:68` sorok `Resolved` oszlopát a fix commit SHA-jával töltjük fel (külön docs commit, SHA-UNKNOWN-AT-COMMIT-TIME pattern).

## Files Modified

| File | Lines | Change |
|---|---|---|
| `src/web.ts` | ~310-319 | Watchdog handle-ek eltárolása |
| `src/web.ts` | ~339-343 | Warm-up cancel check hozzáadása |
| `src/web.ts` | ~19, ~359, ~544 | `workerLivenessCancelled` → `workerStartupCancelled` rename |
| `src/web.ts` | ~539-562 | Close override: két watchdog clear hozzáadása |
| `src/__tests__/web-server.test.ts` | ~526-535 | Test B átírása |
| `src/__tests__/web-server.test.ts` | ~537-550 | Test A átírása |
| `docs/needs-to-be-fix/INDEX.md` | ~37, ~68 | Resolved sorok kitöltése (2 docs commit) |

Összesen: 1 production file (~15 sor módosítás), 1 test file (~10 sor), 1 docs file (2 sor).

## Verification

### Worktree setup (CLAUDE.md §8)
A `store/` ellenőrzése után: ha nem üres → `git worktree add --detach /tmp/claw-cycle38 test/baseline` + `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-cycle38/node_modules`.

### Typecheck
`bun --bun tsc --noEmit` — alapvonal ~2254, nem várható változás (a type-szintű változtatás kizárólag rename, ami típus-kompatibilis).

### Vitest subset
A módosított tesztek lefuttatása a worktree-ben:
- `bun --bun vitest run src/__tests__/web-server.test.ts` — az érintett ~3-4 teszt zöld, a többi teszt nem változik
- `bun --bun vitest run src/__tests__/web.test.ts` ha van, egyéb szomszédos tesztek hogy a close()/grace ne legyen regressziós hatású

### Pre-existing failures baseline
A 19 pre-existing failure (`governance-gates`, `email-send-gate`, `hook-path-guard`, `hook-command-quoting`) baseline `99f56c1`-en van — a mi fixünk ezeket nem érinti, de a futtatáskor ugyanazt a 19-et kell látni.

### Coverage
A close() override és a watchdog ág 100%-os branch coverage-e várható a módosítás után (a `if (startupWatchdogGrace)` és `if (startupWatchdogPoll)` típusú guard-ok a close() híváskor triggerelődnek).

## Risks

| Kockázat | Valószínűség | Hatás | Mitigáció |
|---|---|---|---|
| A watchdog clear() rossz timer handle-t töröl | alacsony | közepes (process exit(1) amúgy is történne, csak most a close után) | Mindkét handle `let`-ként deklarálva, close() guard-okkal; a meglévő close() tesztek a `web-server.test.ts:758+` describe-ban a többi interval-t hasonlóképp törlik |
| A rename (`workerLivenessCancelled` → `workerStartupCancelled`) kihagy egy hivatkozást | alacsony | magas (fordítási hiba) | grep `workerLivenessCancelled` a módosítás előtt és után, 3 helyen kell cserélni: `:19, :359, :544` |
| A `workerStartupCancelled` flag a warm-up `.then()`-ben a closure miatt nem frissül close() után | alacsony | magas (a fix nem működik) | A `let workerLivenessCancelled = false` minta (most `workerStartupCancelled`) a `:355`-ön definiált, function-scope, közvetlenül a `import('./web/worker-liveness.js')` előtt. A close() a `:544`-en állítja. A `.then()` callback-je a `:359`-en olvassa. Ugyanaz a closure, ugyanaz a flag — a minta működik a liveness-re, a warm-up-ra is működni fog |
| A `setTimeout`/`setInterval` sorrend a watchdog fixben (hoisting) | alacsony | alacsony | A `let` deklaráció a `setTimeout` hívás ELŐTT van; a `setTimeout` body-ja fut le azonnal (vár 7 percet), addigra a `let` deklaráció már megtörtént. Mivel a body-ban NEM hivatkozunk a változóra a 7 perces várakozás előtt, a hoisting nem okoz gondot |

## Execution Plan

### Workflow (futtatás)

A teljes ciklust egy workflow-ban hajtjuk végre, `test/baseline`-ről indulva és oda visszavezetve:

1. **Worktree prep:** `git worktree add --detach /tmp/claw-cycle38 test/baseline` + `ln -sf node_modules` + a `assert-not-live-install.ts` guard ellenőrzése.
2. **Source apply:** `src/web.ts` módosítása a fenti három blokkban.
3. **Test apply:** A két teszt átírása a `src/__tests__/web-server.test.ts`-ben.
4. **Verify:** `bun --bun tsc --noEmit` + `bun --bun vitest run src/__tests__/web-server.test.ts`.
5. **Commit A (fix + test):** `fix(web): clear startup watchdog + warm-up cancel on close()` (commit body file-on át, lásd §6 backtick-escape bug).
6. **Docs commit:** A fix SHA rögzítése után `docs(needs-to-be-fix): mark web-watchdog + web-worker-warmup Resolved`.
7. **Code-review (USER):** A user futtatja a `/code-review max --fix` skillt a `test/baseline..HEAD` diffre; a workflow NEM hívja a skill-t (`disable-model-invocation`).

### Nem módosítjuk

- `src/web/agent-worker.ts` — nem érintett
- A többi MD a backlog-ban (`routes-memories-put-skips-validation`, `test-suite-store-pollution-...`, `web-port-reclaim-...`, stb.) — kimarad, marad a backlogban
- A `src/web/web-inbound-probe.ts` — más MD, más ciklus

## Critical Files

- `/Users/eggp/marveen-develop/test-baseline/src/web.ts` (production)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/web-server.test.ts` (tests)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (docs)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/web-watchdog-survives-close.md` (forrás MD)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/web-worker-warmup-ignores-close.md` (forrás MD)
- `/Users/eggp/marveen-develop/test-baseline/.claude/CLAUDE.md` (szabályok)
