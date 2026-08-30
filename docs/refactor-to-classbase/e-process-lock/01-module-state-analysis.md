# E (process-lock) — Module & state analysis

Analysis date: 2026-08-30. **Planning only — no source file was modified.**
Scope: `src/process-lock.ts` (363 lines, 9 sections) and every file that
imports from it or mocks it. All file:line references were read against
the current working tree on 2026-08-30.

---

## Brief summary

`process-lock.ts` is a **pure-function module with zero module-level
mutable state**. It exposes two top-level async functions (`acquirePortLock`
at L169 and `acquirePidfileLock` at L289), one small helper (`writeBufferFully`
at L207), one error class (`DeferToPeerError` at L272), three I/O
"context" interfaces (`ProcessLockContext` at L26, `PidfileLockContext`
at L226, `SignalOutcome` / `ExclusiveCreateOutcome` type aliases), and
two pure-logic helpers (`findOwnNodeHolders` at L77, `findOwnBinaryMatches`
at L88, `terminateProcesses` at L127). All state — process table,
port-holders list, file-system pidfile, sleep timers — is carried in
the `ctx` argument the caller passes in; the module is therefore
trivially re-importable and HMR-safe (no `let` bindings, no module-scope
singletons, no signal-handler registration). The two acquire functions
overlap only in their `ctx.log` field and the `graceMs` default (L67);
the port-holders context has eight methods, the pidfile context has
seven, and only the `signal`/`probeAlive` and `sleep`/`log` pairs are
shape-compatible. `DeferToPeerError` is thrown in **two** places
(`process-lock.ts:347` inside `acquirePidfileLock`, and `index.ts:324`
inside `checkFreshStartupRace`), and both are caught by the single
`instanceof` site at `index.ts:555` in `main().catch`. There are exactly
two importers of the module (`src/index.ts:34`, `src/__tests__/process-lock.test.ts:12`)
and exactly one `vi.mock('../process-lock.js')` site
(`src/__tests__/index.test.ts:173`). All seven reference inputs cited
by the H subsystem plan are reflected in this file's shape: it has
zero module state, it exposes a `LogFn` triple that the `LoggerLike`
interface would widen, and it owns the only existing project error
class with a structured payload field outside the federation poller
(`DeferToPeerError.peerPid`).

---

## 1. process-lock.ts inventory

### Current shape

Pure-function module. All nine exports are either functions, types, or
a single error class. There is **no module-level mutable state** —
verified by `grep -nE "^export (let|const|var)" src/process-lock.ts`
returning only the three function-class exports (`acquirePortLock`,
`acquirePidfileLock`, `writeBufferFully`) and the class export
(`DeferToPeerError`); the `SignalOutcome`, `ExclusiveCreateOutcome`,
`ProcessLockContext`, `AcquirePortLockOptions`, `PidfileLockContext`,
`AcquirePidfileLockOptions` lines are type-only.

### Module-level constants (immutable)

| Constant | Location | Notes |
|---|---|---|
| `DEFAULT_GRACE_MS = 1500` | `process-lock.ts:67` | Shared between both acquire functions via their respective `opts.graceMs ?? DEFAULT_GRACE_MS` lines (`:174`, `:296`). |
| `DEFAULT_POST_KILL_DRAIN_MS = 2000` | `process-lock.ts:68` | Port-lock only. |
| `DEFAULT_POST_KILL_POLL_MS = 100` | `process-lock.ts:69` | Port-lock only. |

### Module-level types

| Type | Location |
|---|---|
| `LogFn` (local) | `process-lock.ts:19` — `(obj, msg?) => void` |
| `SignalOutcome` | `process-lock.ts:24` |
| `ProcessLockContext` interface | `process-lock.ts:26` |
| `AcquirePortLockOptions` interface | `process-lock.ts:52` |
| `PidfileLockContext` interface | `process-lock.ts:226` |
| `AcquirePidfileLockOptions` interface | `process-lock.ts:256` |
| `ExclusiveCreateOutcome` | `process-lock.ts:224` |

### Exported functions / class

| Symbol | Location | Kind |
|---|---|---|
| `findOwnNodeHolders` | `process-lock.ts:77` | pure helper |
| `findOwnBinaryMatches` | `process-lock.ts:88` | pure helper |
| `filterOwnNodeCandidates` | `process-lock.ts:93` | **not exported** — module-private |
| `terminateProcesses` | `process-lock.ts:127` | pure helper (async) |
| `acquirePortLock` | `process-lock.ts:169` | main entry (async) |
| `writeBufferFully` | `process-lock.ts:207` | pure helper |
| `DeferToPeerError` (class) | `process-lock.ts:272` | error type |
| `acquirePidfileLock` | `process-lock.ts:289` | main entry (async) |

### Factory closures / captured state

None. The two acquire functions are top-level `async function`
declarations; they capture nothing from the module scope (only the
three numeric constants above). Every dependency is passed in via
`(port, ctx, opts)` or `(path, selfPid, ctx, opts)`.

### Side effects

The module itself does **none** of the I/O. It declares no
`process.on`, no `process.kill`, no `import * as fs`. The
file-header comment (`process-lock.ts:1-17`) is explicit: "The logic
is split from the I/O so the ctx can be mocked in tests". The I/O
lives entirely in the `ctx` implementations the caller passes in —
verified by `grep -nE "^import " src/process-lock.ts` returning
**zero** non-type imports (the file has no `import` lines at all;
it is a pure-functional island).

### Re-initialization hazards (HMR)

None measurable. Because the module holds no module-scope `let`
bindings, no module-scope `new` objects, and no registered signal
handlers, importing `process-lock.ts` twice produces two
identically-shaped namespaces. There is no singleton state to
"double-up". The H subsystem's
`h-cross-cutting/01-module-state-analysis.md` risk #3 ("dual log
destination") applies here indirectly: the module **caller** (which
is `src/index.ts`) holds `procCtx.log` once at boot, so re-importing
`process-lock.ts` does not split log destinations — it just re-binds
`acquirePortLock` to the same function. Verified empirically by
reading the file: no top-level `let` or `var`, no `new`, no
`process.on(`, no `process.exit(`.

---

## 2. PortLock flow

`acquirePortLock(port, ctx, opts)` at `process-lock.ts:169-197`.

### Entry shape

```ts
acquirePortLock(
  port: number,
  ctx: ProcessLockContext,
  opts: AcquirePortLockOptions = {},
): Promise<void>
```

`opts` keys: `graceMs` (default 1500), `binaryPattern` (optional
regex), `postKillDrainMs` (default 2000), `postKillPollMs` (default 100).

### Step-by-step

1. **`L174-176`** Resolve the four option defaults.
2. **`L177-178`** Discover victims via two parallel `ctx` calls:
   - `findOwnNodeHolders(port, ctx)` at `L77` → `ctx.listPortHolders(port)`
     → `filterOwnNodeCandidates(pids, ctx)` (L93). Each PID is
     validated for finiteness (L97), not the current PID (L98),
     not duplicated (L99-100), `getProcessCommand(pid)` non-null (L101-102),
     UID equality if `ctx.uid != null` (L103-110), `/node|tsx/i` match
     (L111-114). Failures log via `ctx.log.warn` at L107 and L112.
   - `findOwnBinaryMatches(opts.binaryPattern, ctx)` at L88, same
     filter pipeline but starting from `ctx.listOwnProcessesMatching`.
3. **`L179`** Deduplicate via `Set`. Empty → return.
4. **`L181`** Log a warning `Previous dashboard instance(s) detected,
   taking over` with `{ port, victims, matchedBy: { byPort, byBinary } }`.
5. **`L182`** Call `terminateProcesses(victims, ctx, { graceMs })` (L127).
   Inside:
   - For each PID: `ctx.signal(pid, 'SIGTERM')`; success → log info;
     throw → log warn.
   - `await ctx.sleep(graceMs)`.
   - For each PID: `ctx.signal(pid, 0)`; `'gone'` → skip; throw → assume
     alive (L150-152). Alive → `ctx.signal(pid, 'SIGKILL')`; throw →
     log error (`SIGKILL failed` at L158) and continue.
6. **`L183-196`** Post-kill drain poll. If `drainMs <= 0 || pollMs <= 0`,
   skip. Otherwise loop `findOwnNodeHolders(port, ctx)` until empty or
   `waited >= drainMs`. After the loop, if port still held, log
   `'Port still held after drain window, server.listen may hit EADDRINUSE
   and recover via reclaim'` at L196.

### State captured in `ProcessLockContext`

| Method | Purpose | Production impl (`index.ts`) |
|---|---|---|
| `currentPid: number` | exclude self | `index.ts:99` — `process.pid` |
| `uid: number \| null` | ownership check | `index.ts:98` — `process.getuid()` |
| `listPortHolders(port)` | `lsof -ti TCP:$port` | `index.ts:101-110` — `execFileSync('lsof', ['-ti', \`TCP:\${port}\`])` |
| `listOwnProcessesMatching(pattern)` | `ps -A -o pid,uid,args` | `index.ts:111-150` — `execSync('ps -A -o pid,uid,args')` |
| `getProcessCommand(pid)` | `ps -p pid -o comm=` | `index.ts:151-153` |
| `getProcessUid(pid)` | `ps -p pid -o uid=` | `index.ts:154-156` |
| `signal(pid, sig)` | `process.kill(pid, sig)` | `index.ts:157-167` — wraps `process.kill`, maps ESRCH → `'gone'`, rethrows others |
| `sleep(ms)` | `setTimeout` | `index.ts:168-170` |
| `log` | structured logger | `index.ts:171-175` — adapter literal |

### State captured in closures

None. `acquirePortLock` and `terminateProcesses` capture nothing
besides the three numeric defaults at the top of the file. The only
state that crosses the function boundary is `waited` (a local
`let` at `process-lock.ts:189`), which is purely local to one
acquire-call. The `seen: Set<number>` at `L94` lives only inside
one `filterOwnNodeCandidates` call.

---

## 3. PidfileLock flow

`acquirePidfileLock(path, selfPid, ctx, opts)` at `process-lock.ts:289-364`.

### Entry shape

```ts
acquirePidfileLock(
  path: string,
  selfPid: number,
  ctx: PidfileLockContext,
  opts: AcquirePidfileLockOptions = {},
): Promise<void>
```

`opts` keys: `maxAttempts` (default 5), `graceMs` (default 1500),
`onLiveLegitimate` (default `'sigterm'`).

### Step-by-step

The body is a `for (let attempt = 1; attempt <= maxAttempts; attempt++)`
loop (`L298-361`). Each iteration:

1. **`L299`** `ctx.tryCreateExclusive(path, selfPid)`. Returns `'created'`
   → log `'Pidfile lock acquired'` and `return`.
2. **`L305-312`** `ctx.readRecordedPid(path)`. Returns `null` (file
   exists but unparseable) → `ctx.unlinkIfMatches(path, null)` and
   `continue`.
3. **`L313-318`** `recorded === selfPid` (PID recycled to ourselves)
   → `ctx.unlinkIfMatches(path, selfPid)` and `continue`.
4. **`L320-331`** Probe liveness: `ctx.probeAlive(recorded)`; throw →
   assume alive (`alive = true` at L325). `!alive` → log warn `'Pidfile
   references dead PID, unlinking stale file'` and `ctx.unlinkIfMatches(path, recorded)`.
5. **`L333-339`** `!ctx.isLegitimatePredecessor(recorded)` → log warn
   `'Pidfile PID alive but not a dashboard process, treating as stale'`
   and `ctx.unlinkIfMatches(path, recorded)`.
6. **`L341-348`** `onLiveLegitimate === 'defer'` → log info `'Pidfile
   held by legitimate peer, deferring'` and **`throw new DeferToPeerError(recorded)`**
   (`process-lock.ts:347`).
7. **`L350-353`** Otherwise: log warn `'Pidfile held by live predecessor,
   sending SIGTERM and retrying'`. `ctx.sendTerm(recorded)`; throw →
   log warn `'SIGTERM to predecessor failed'`.
8. **`L354`** `await ctx.sleep(graceMs)`.
9. **`L360`** `ctx.unlinkIfMatches(path, recorded)` — guarded against
   a third peer taking the slot mid-sleep (per the source comment at
   L355-359; the regression test at
   `process-lock.test.ts:652-683` pins this).
10. **After loop:** log error `'Failed to acquire pidfile lock after
    ${maxAttempts} attempts'` (L362) and throw `new Error(\`Failed to
    acquire pidfile lock at ${path} after ${maxAttempts} attempts\`)`
    (L363).

### State captured in `PidfileLockContext`

| Method | Purpose | Production impl (`index.ts`) |
|---|---|---|
| `tryCreateExclusive(path, pid)` | `openSync(path, 'wx')` + write | `index.ts:212-232` |
| `readRecordedPid(path)` | `readFileSync(path, 'utf-8')` strict-digit parse | `index.ts:233-235` → `readRecordedPidFrom` at `index.ts:179-191` |
| `unlinkIfMatches(path, expected)` | re-read, compare, `unlinkSync` | `index.ts:236-253` |
| `probeAlive(pid)` | `process.kill(pid, 0)` | `index.ts:254-264` |
| `sendTerm(pid)` | `process.kill(pid, 'SIGTERM')` | `index.ts:265-273` |
| `isLegitimatePredecessor(pid)` | UID + node/tsx + argv pattern | `index.ts:274-276` → `isLegitimateDashboardPid` at `index.ts:198-208` |
| `sleep(ms)` | `setTimeout` | `index.ts:277-279` |
| `log` | structured logger | `index.ts:280-287` — adapter literal; comment at L281-283 says `error` is forwarder-only (pinned by `index.test.ts:1383`) |

### State captured in closures

None. The only loop-local variable is `attempt` (the for-loop counter
at `process-lock.ts:298`) and `alive` (`let alive = false` at L320,
purely per-iteration).

---

## 4. DeferToPeerError

### Class declaration

`process-lock.ts:272-279`:
```ts
export class DeferToPeerError extends Error {
  readonly peerPid: number
  constructor(peerPid: number) {
    super(`Pidfile held by legitimate peer PID ${peerPid}`)
    this.name = 'DeferToPeerError'
    this.peerPid = peerPid
  }
}
```

No `cause`, no `code`, no `stack` override. The `name` is hand-set
(the same pattern as the other eight project error classes; see
`h-cross-cutting/03-class-boundaries.md` §C3 "AppError shape" for the
pending `AppError` base convention that would replace this hand-set
with `new.target.name`).

### Production throw sites — **two**, not one

The H subsystem plan cites `process-lock.ts:347` as the single
throw site. **There are two** in production code:

| File:line | Thrower | Trigger |
|---|---|---|
| `process-lock.ts:347` | `acquirePidfileLock` | `onLiveLegitimate === 'defer'` and recorded PID is alive-and-legitimate — the O_EXCL race lost |
| `index.ts:324` | `checkFreshStartupRace` | Pre-acquire early-exit: peer is alive, legitimate, and not yet on the port (mid-init loser detection) |

Both throw sites are pinned by tests in `index.test.ts`:

- `process-lock.ts:347` is exercised by
  `index.test.ts:876` `'defers to a legitimate alive peer that is not yet on the port (throws DeferToPeerError)'`,
  `index.test.ts:1545` `'isLegitimatePredecessor true with onLiveLegitimate=defer: throws DeferToPeerError'`,
  `index.test.ts:1910`, `index.test.ts:1949`, and the
  `process-lock.test.ts:631` direct test.
- `index.ts:324` is exercised by `index.test.ts:2206-2207`
  `'checkFreshStartupRace: rethrows DeferToPeerError when peer is mid-init'`.

### `instanceof` consumer — **one** site

`index.ts:554-558`:
```ts
main().catch((err) => {
  if (err instanceof DeferToPeerError) {
    logger.info({ peerPid: err.peerPid }, 'Peer dashboard already claimed the pidfile, exiting quietly')
    process.exit(0)
  }
  ...
})
```

`err.peerPid` is read positionally (`index.ts:556`) — the only
production read of the `peerPid` field. This matches the
`h-cross-cutting/03-class-boundaries.md` §C3 observation that error
payloads are read positionally, never generically. The
`process-lock.test.ts:631` test asserts `toBeInstanceOf(DeferToPeerError)`
on the direct throw, and `index.test.ts:639` and `:2207` assert the
same for the cross-module case. There are **no other production
`instanceof DeferToPeerError`** sites — verified by `grep -rn
"instanceof DeferToPeerError" src/ --include='*.ts'`.

### Integration with the lock flow

`DeferToPeerError` is the contract between two stages of
`acquireLock` at `index.ts:327-351`:

```
acquireLock() {
  mkdirSync(STORE_DIR)             // pre-step
  procCtx = buildProcessLockContext()
  checkFreshStartupRace(procCtx)    // <-- throws DeferToPeerError (index.ts:324)
  await acquirePortLock(...)        // SIGKILL takeover
  await acquirePidfileLock(..., { onLiveLegitimate: 'defer' })
                                   // <-- throws DeferToPeerError (process-lock.ts:347)
}
```

The `onLiveLegitimate: 'defer'` at `index.ts:349` is a
"belt-and-braces backup" per the source comment at `index.ts:343-347`:
`checkFreshStartupRace` is expected to have caught the common case,
but if a peer's `tryCreateExclusive` lands between the two checks, the
pidfile path also defers. So the production throw sites are
sequenced by the boot order, not redundant.

---

## 5. Test mock patterns

### `vi.mock('../process-lock.js')` count

`grep -rEn "vi\.mock.*process-lock" --include='*.ts'` returns **1 file**:

```
src/__tests__/index.test.ts:173:vi.mock('../process-lock.js', async () => {
src/__tests__/index.test.ts:1314:// vi.importActual bypasses the vi.mock('../process-lock.js') factory; without
```

The second hit is a comment inside `withRealAcquirePidfileLock`
describing the factory. So **1 active mock site**, 1 explanatory
comment.

### Mock shape at `index.test.ts:173`

```ts
vi.mock('../process-lock.js', async () => {
  const actual = await vi.importActual<typeof import('../process-lock.js')>('../process-lock.js')
  return {
    acquirePortLock: mockAcquirePortLock,
    acquirePidfileLock: mockAcquirePidfileLock,
    writeBufferFully: actual.writeBufferFully,
    DeferToPeerError: actual.DeferToPeerError,
  }
})
```

Key observations:

- The factory uses `vi.importActual` to pull `writeBufferFully` and
  `DeferToPeerError` from the real module while substituting
  `mockAcquirePortLock` / `mockAcquirePidfileLock` (defined at the
  top of `index.test.ts` via `vi.fn()`). The rationale comment at
  L173-188 explains: the real `acquirePortLock` would otherwise
  capture `execSync` at module-load time and route lsof/ps through
  the real `/usr/bin/lsof` instead of the test's `mockExecSync`.
- `mockAcquirePortLock`'s default implementation
  (`index.test.ts:324-341`) is a **faithful re-implementation** that
  drives the same `ctx` methods — not a no-op. Tests that want the
  *real* `acquirePortLock` override this via
  `withRealAcquirePortLock` (`index.test.ts:1363-1374`), which
  delegates to `actual.acquirePortLock`.
- `mockAcquirePidfileLock`'s default is
  `mockResolvedValue(undefined)` (L321); tests that want the real
  implementation use `withRealAcquirePidfileLock`
  (`index.test.ts:1314-1330`), which delegates to
  `actual.acquirePidfileLock` via `vi.importActual` bypass.

### Test files using each pattern

| Pattern | Files | Notes |
|---|---|---|
| `vi.mock('../process-lock.js')` factory | 1 (`index.test.ts`) | the only mock site |
| Direct import of `process-lock.js` for unit testing | 1 (`process-lock.test.ts`) | imports `findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses`, `acquirePortLock`, `acquirePidfileLock`, `writeBufferFully`, `DeferToPeerError`, plus both context types — exercises the pure functions against in-memory `MockProc` tables (L18-83) and `PidfileState` Maps (L460-530). 33 unique `it()` cases over the file. |
| `vi.importActual('process-lock.js')` inside a `vi.mock` factory | 1 (`index.test.ts:189`) | pulls `writeBufferFully` + `DeferToPeerError`; `acquirePortLock`/`acquirePidfileLock` are delegated to via `vi.importActual` inside the `withReal*` helpers (`:1324`, `:1372`) |

Total test files that touch `process-lock.ts`: **2** (`index.test.ts`,
`process-lock.test.ts`). Both files are within `src/__tests__/`; no
test file outside that directory uses the module.

### Mock factory regression risk

If the E subsystem converts the two `acquireX` exports into class
methods, the `vi.mock('../process-lock.js', async () => { ...
acquirePortLock: mockAcquirePortLock, ...})` shape must keep
returning *something assignable* to the symbol `index.ts:28-29` imports.
With the current factory, `index.ts:28-29` imports the named exports
directly (`import { acquirePortLock, acquirePidfileLock, ... }`).
Converting to `new PortLockAcquirer(...).acquire(...)` would require
either (a) keeping a free-function facade that constructs the class
and calls the method, or (b) updating `index.ts` to construct an
instance and store it. The `process-lock.test.ts` direct-import
pattern at `:3-12` would also need updating from
`acquirePortLock(3420, ctx)` to `portLockAcquirer.acquire(3420, ctx)`
or equivalent.

---

## 6. Integration consumers

### Files that import `process-lock.js`

`grep -rEn "from.*process-lock" --include='*.ts'` returns exactly 2
importers (verified, no others):

| Importer | File:line | Symbols imported | Usage |
|---|---|---|---|
| `src/index.ts` | `:27-34` | `acquirePortLock`, `acquirePidfileLock`, `writeBufferFully`, `DeferToPeerError`, `type ProcessLockContext`, `type PidfileLockContext` | the sole production caller; see breakdown below |
| `src/__tests__/process-lock.test.ts` | `:2-12` | `findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses`, `acquirePortLock`, `acquirePidfileLock`, `writeBufferFully`, `DeferToPeerError`, `type ProcessLockContext`, `type PidfileLockContext` | unit tests |

### Call sites in `src/index.ts`

| Caller | File:line | Args |
|---|---|---|
| `acquirePortLock` | `index.ts:341` | `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: DASHBOARD_BINARY_PATTERN })` |
| `acquirePidfileLock` | `index.ts:348` | `acquirePidfileLock(PID_FILE, process.pid, buildPidfileLockContext(procCtx), { onLiveLegitimate: 'defer' })` |
| `DeferToPeerError` (throw) | `index.ts:324` | `throw new DeferToPeerError(recorded)` inside `checkFreshStartupRace` |
| `DeferToPeerError` (import) | `index.ts:31, :555` | imported for the `instanceof` discriminant and for the throw |
| `writeBufferFully` | not used in `index.ts` | imported at L30 but called only via the production `PidfileLockContext.tryCreateExclusive` implementation at `index.ts:220-223` (which the module's tests import directly) |
| `ProcessLockContext` | `index.ts:97` (`buildProcessLockContext` return type), `index.ts:198` (passed into `isLegitimateDashboardPid`) | factory + helper |
| `PidfileLockContext` | `index.ts:210` (`buildPidfileLockContext` return type), `index.ts:348` (passed to `acquirePidfileLock`) | factory |
| `terminateProcesses` | not called directly by `index.ts` | only `acquirePortLock` invokes it (transitively) |
| `findOwnNodeHolders` / `findOwnBinaryMatches` | not called directly by `index.ts` | only `acquirePortLock` invokes them (transitively) |

### Call sites in `src/web/` / `src/scripts/`

**None.** `grep -rEn "acquirePortLock|acquirePidfileLock" --include='*.ts' src/web/ scripts/`
returns **zero hits** outside `src/index.ts` and the two test files.
The web layer (`src/web/*`) does not acquire or release the process
lock — it consumes the running server. There is no `scripts/`-tree
caller either; the only production caller is `src/index.ts`'s `main()`.

### Integration in `src/index.ts`'s boot flow

```
main()
  └─ process.on(SIGINT/SIGTERM/uncaughtException)  (L426-435)
  └─ await acquireLock()                            (L437)
       ├─ mkdirSync(STORE_DIR)
       ├─ procCtx = buildProcessLockContext()       (L97-177)
       ├─ checkFreshStartupRace(procCtx)            (L299-325)
       │     └─ throws DeferToPeerError (L324)
       ├─ await acquirePortLock(...)                (L341)
       ├─ buildPidfileLockContext(procCtx)          (L210-289)
       └─ await acquirePidfileLock(...)             (L348)
             └─ throws DeferToPeerError (process-lock.ts:347)
  └─ main().catch(...)
        └─ err instanceof DeferToPeerError (L555) → process.exit(0)
                                                       else shutdown()
```

`releaseLock()` at `index.ts:356-364` is the inverse — it
`unlinkSync` the pidfile ONLY if `recordedPid === process.pid`, and
is called from three places inside `shutdown()` (L393, L402, L408,
L413) plus the catch-all L411-415 path.

---

## 7. Cross-cutting observations (H subsystem interaction)

### LoggerLike dependency

`process-lock.ts` is the **only** module in the project that
hand-rolls a local `LogFn` type alias at L19 and threads it through
two context interfaces (L49 and L253). The H subsystem's
`00-summary.md` lists this as the primary adoption site for the
`LoggerLike` interface; the dependencies table flags E as
**blocking on H.1**:

| Consumer | What E needs |
|---|---|
| `ProcessLockContext.log` (L49) | A type it can put on the `log` field that both a real pino instance and the existing `{info,warn,error}` object literals at `index.ts:171-175` / `:280-287` satisfy |
| `PidfileLockContext.log` (L253) | Same |
| `LogFn` local alias (L19) | Should be replaced by the wider `LoggerLike` type once H.1 lands |

The H plan (`h-cross-cutting/03-class-boundaries.md` §C1) correctly
identifies this:

> Once `LoggerLike` types that field, both literals collapse to
> `log: logger`. Note the comment at `index.ts:281-283` documents that
> `PidfileLockContext.log.error` is forwarder-only and is pinned by a
> test it cites as `index.test.ts:1382`; the test
> (`it('forwards pidfile context errors to logger.error', ...)`)
> actually starts at `index.test.ts:1383` — the source comment is off
> by one.

The source comment is at `process-lock.ts:282` (`process-lock.ts:282`
says: `(info/warn only at process-lock.ts:301/328/336/346/350/352)`)
but the *index.ts* mirror at `index.ts:281-283` says:
> PidfileLockContext.log.error is forwarder-only: required by the interface
> (process-lock.ts:253) but never invoked by acquirePidfileLock (info/warn
> only at process-lock.ts:301/328/336/346/350/352). Pinned by index.test.ts:1382.

That comment is **off by one** — the test starts at
`index.test.ts:1383`. The H review at `review-correctness.md` M2/m2
flags this and recommends the fix land in the H.1 commit alongside
the adapter-literal collapse.

### Context-type overlap and divergence

`ProcessLockContext` (L26-50) and `PidfileLockContext` (L226-254)
overlap on three members:

| Shared member | Port (`ProcessLockContext`) | Pidfile (`PidfileLockContext`) |
|---|---|---|
| `sleep(ms)` | L48 | L252 |
| `log` | L49 (`{ info; warn; error }`) | L253 (`{ info; warn; error }`) — structurally identical |
| (none of the others) | `currentPid`, `uid`, `listPortHolders`, `listOwnProcessesMatching`, `getProcessCommand`, `getProcessUid`, `signal` | `tryCreateExclusive`, `readRecordedPid`, `unlinkIfMatches`, `probeAlive`, `sendTerm`, `isLegitimatePredecessor` |

Only `signal` (L47) and `probeAlive` (L243) overlap in *concept*
(both wrap `process.kill(pid, sig)`), but their signatures differ:
`signal` returns `'sent' | 'gone'` (L24) and accepts
`SIGTERM | SIGKILL | 0`; `probeAlive` returns `boolean` and accepts
only a PID. They are not interchangeable.

If the E subsystem converts to classes
(`PortLockAcquirer`, `PidfileLockAcquirer` per
`h-cross-cutting/03-class-boundaries.md`), the two ctx types could
remain unchanged — they are pure interfaces and do not need to
collapse. The class would simply hold them as constructor args or
build them internally.

### `DeferToPeerError` and the H.4 AppError taxonomy

`DeferToPeerError` is the **first** class in
`h-cross-cutting/03-class-boundaries.md` §C3's enumeration
(`process-lock.ts:272`). It satisfies the AppError selection criteria
trivially:

- (a) already carries a structured field (`readonly peerPid: number`)
- (b) **two** throw sites in production (the lowest of any project
  error class after `PeerResponseTooLargeError`)
- (c) **one** `instanceof` consumer (`index.ts:555`) — the regression
  is observable

However, the H plan explicitly defers `DeferToPeerError` from the
H.4 first-pair conversion (`00-summary.md` Scope: "The other seven
classes are explicitly deferred"). So the E subsystem's class
refactor must NOT make `DeferToPeerError extends AppError` without
its own first-pair inclusion — that would change what
`err instanceof DeferToPeerError` answers (it would still pass,
because the class name is preserved, but reviewers would flag it
as out-of-order).

### Re-import safety (H.1 interaction)

Because the module has no module-scope state, H.1's `LoggerLike`
type addition will not change the module's re-import safety. The
`LoggerLike` interface is a `type` export; re-importing the module
twice still yields two identical type-only namespaces. The H
`review-correctness.md` HR3 dual-destination hazard does not apply
here — `process-lock.ts`'s `ctx.log` is *injected*, not imported.
Even if `index.ts` constructs `procCtx.log` once at boot and the
test factory's `vi.mock('../logger.js')` replaces the module
binding, `procCtx.log` still points at the captured pino instance
from boot, so test-side mocks never see process-lock log calls.
Verified by reading the wiring at `index.ts:97-177`.

---

## 8. Test file structure inventory (for E migration planning)

### `src/__tests__/process-lock.test.ts` (33 it-cases, 800+ lines)

| describe block | it-cases | what it tests |
|---|---:|---|
| `findOwnNodeHolders` (L86) | 9 | empty port, self-PID, foreign UID, non-node cmd, race, non-positive, no-uid, dedupe, gone-between |
| `findOwnBinaryMatches` (L166) | 3 | match, exclude self, foreign UID |
| `terminateProcesses` (L194) | 8 | no-op, SIGTERM-grace-no-kill, SIGKILL escalation, EPERM probe, ESRCH skip, parallel SIGTERM, SIGTERM-fail-doesnt-block, SIGKILL-fail-logs-error, signal='gone' branch |
| `acquirePortLock` (L333) | 8 | no-victim, self-PID, kill-old, kill-zombie, dedupe port+bin, multi-victim, foreign-UID-untouched, drain-poll, sticky-port-warn, pollMs<=0 short-circuit |
| `acquirePidfileLock` (L532) | 14 | atomic-create, stale-unlink, SIGTERM-retry, illegitimate-PID-skip, self-recorded-unlink, maxAttempts-give-up, EPERM-conservative, DeferToPeerError, defer-still-unlinks-stale, third-peer-survives, defer-unlinks-recycled, unparseable-unlink, sendTerm-fail-warns |
| `writeBufferFully` (L751) | 5 | full-write, short-write-loop, returns-0-throws, negative-throws, NaN-throws, empty-buffer |
| `DASHBOARD_BINARY_PATTERN` (L797) | 7+ | `\b` regression tests (matches `dist/index.js`, doesn't match `.map`/`.bak`/`.old`) |

The test file uses **no `vi.mock`**; it constructs `MockProc` tables
and `PidfileState` Maps directly. The migration to a class form
must preserve the ability to construct a `ctx` and call methods
without touching the real fs / process table — i.e. the
constructor/method split must keep the `ctx` as a first-class
injection point, not move it into the class.

### `src/__tests__/index.test.ts` (test-by-test dependencies on process-lock)

The `vi.mock('../process-lock.js')` factory at `:173` substitutes
`mockAcquirePortLock` / `mockAcquirePidfileLock`. The default
`mockAcquirePortLock` implementation at `:324-341` is a **faithful
re-implementation**, not a stub. Tests that exercise the real
implementation delegate through `withRealAcquirePortLock` (`:1358-1374`)
and `withRealAcquirePidfileLock` (`:1304-1330`), both of which call
the `vi.importActual`'d real function.

Test groups that depend on the real acquire functions (via the
helpers):

| Group | File:line range | What it tests |
|---|---|---|
| `buildPidfileLockContext helpers via real acquirePidfileLock` | `:1377-1481` | full acquire path through `buildPidfileLockContext` |
| `buildProcessLockContext.log and sleep via real acquirePortLock` | `:2743-2790+` | port-acquire path |
| `checkFreshStartupRace: rethrows DeferToPeerError` | `:2206+` | mid-init detection |
| `main().catch() routes non-DeferToPeerError errors through shutdown` | `:2148+` | error path |
| `defers to a legitimate alive peer that is not yet on the port` | `:876+` | DeferToPeerError from `checkFreshStartupRace` |

If the E migration renames `acquirePortLock`/`acquirePidfileLock`
into class methods, the `vi.mock` factory at `:173` and the
`withReal*` helpers at `:1324`/`:1372` are the only two sites that
must change in `index.test.ts`. The 40+ test sites that call
`mockAcquirePortLock` / `mockAcquirePidfileLock` continue working
unchanged as long as the mock factory still exports the same names.

---

## 9. Boundary with H and A subsystems

### What E OWES to H

- `LoggerLike` (`ProcessLockContext.log` field at L49, `PidfileLockContext.log` at L253, `LogFn` alias at L19).
- AppError convention (for `DeferToPeerError` at L272 — deferred but future-owned).

### What E OWES to A (entity stores)

None directly. `process-lock.ts` has no knowledge of the entity
stores, the heartbeat, the scheduler, the federation poller, or any
other subsystem. It is an I/O primitive.

### What E OWES to B (runners)

None directly.

### What E OWES to D (App composition)

`buildProcessLockContext()` and `buildPidfileLockContext()` are
factories in `src/index.ts` that the E subsystem could absorb if
converted to classes. Two factory functions building two context
interfaces and reading `process.pid` / `logger` / `WEB_PORT` are
natural class-constructor parameters (`new PortLockAcquirer({
uid, port, binaryPattern, logger, ...})` would close over the
boilerplate that today lives in `index.ts:97-177`).

### What E BLOCKS elsewhere

E does not block any other subsystem's migration — the reverse
is true: E cannot migrate until H.1 lands, because the `LoggerLike`
type is the constructor parameter for both classes' `log` field.
Verified by reading `h-cross-cutting/00-summary.md` Dependency table
("E → LoggerLike — Yes. Phase 2 cannot land before Phase 1; H.1 is
that Phase 1").

---

## 10. Open questions for the next phase

These are NOT decisions — they are pointers the next planning phase
should resolve before designing the class shape:

1. **One class or two?** The two acquire functions have ~25% overlap
   (the `sleep` and `log` members of the ctx, plus the `graceMs`
   default). A single `ProcessLockAcquirer` with `acquirePort()` and
   `acquirePidfile()` methods is plausible, but the ctx interfaces
   are non-overlapping and would force two ctx-constructor args. Two
   classes (`PortLockAcquirer`, `PidfileLockAcquirer`) is the
   cleaner shape per `h-cross-cutting/03-class-boundaries.md` §E1/E2
   (referenced but not yet written).
2. **Where do `findOwnNodeHolders` / `findOwnBinaryMatches` /
   `terminateProcesses` live?** They are public exports today
   (L77, L88, L127) but only `acquirePortLock` calls them. After
   conversion, they could become private methods on
   `PortLockAcquirer`, or stay as standalone exports for `index.ts`
   to use if needed (verified: `index.ts` does NOT call them
   directly).
3. **Where does `DeferToPeerError` live?** Currently in
   `process-lock.ts:272`. After split, it could move to
   `src/errors.ts` (the H.4 candidate file) once that exists.
   `index.ts:31` and `index.ts:555` would update.
4. **Where do `writeBufferFully` and `findOwnBinaryMatches` test
   imports land?** `process-lock.test.ts:3-12` imports all of them
   alongside the acquires. If the two classes land in separate
   files, the test file may need to split too — or stay as-is with
   import paths updated.
5. **`ProcessLockContext` and `PidfileLockContext` keep their names,
   or get renamed to `PortLockContext` / `PidfileContext`?** No
   caller outside `index.ts` and `process-lock.test.ts` uses them;
   this is a local-naming decision.
6. **Should the class accept the ctx via constructor, or accept the
   primitive operations (lsof, ps, fs, kill) directly?** Today
   `index.ts:97-177` builds the ctx. The class could absorb that
   factory function (closes over `process.pid`, `WEB_PORT`,
   `logger`, `PID_FILE`, etc.) and the ctx becomes an internal
   implementation detail. The test file would then construct mock
   primitives via a different seam (constructor-inject the pieces
   individually rather than the assembled ctx).
7. **`signal` and `probeAlive` both wrap `process.kill`.** Today
   they are separate methods on separate ctxs. If both classes live
   in the same module, they could share a private
   `processKillOrProbe(pid, sig)` helper — but the signatures differ
   (return type, accepted sig values), so this is non-trivial.

None of these are blocked by current source — they are sequencing
choices for the E.1/E.2 phases.

---

## Verification provenance

Every file:line reference above was read from the working tree on
2026-08-30. The single `vi.mock` site, the two importers, the two
`DeferToPeerError` throw sites, the single `instanceof` consumer, the
two context interfaces, the seven `ctx` methods of each, the seven
helper functions, and the 33 test cases were enumerated directly.
The seven cross-cutting claims (logger adapter collapse, off-by-one
in `index.ts:283` comment, AppError deferral, H.1 blocking, no
module state, dual-destination safety, no `web/` or `scripts/`
callers) were checked against the cited H subsystem files.