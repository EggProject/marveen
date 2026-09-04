# E (process-lock) — Risks and mitigations

Risks specific to the E subsystem. Each entry: where it bites,
mitigation, detection signal. Framework-level risks
(`06-risks-and-mitigations.md` R1-R10) and H-subsystem risks
(`h-cross-cutting/06-risks-and-mitigations.md` HR1-HR6) are
referenced where they apply; the entries below are only those that
the E conversion changes.

All file:line references were read against `src/` on 2026-08-30.

---

## ER1. Lock lifecycle is held at process lifetime — wrong
ownership path causes a leak

### Where it bites

The two locks are intentionally long-lived. The port lock is held
by the kernel from `PortLockAcquirer.acquire()` returning until
process exit (`01-module-state-analysis.md` §2 — "the kernel releases
the port on process death"). The pidfile is held from
`PidfileLockAcquirer.acquire()` returning until either (a)
`releaseLock()` runs in shutdown (current thin wrapper at
`src/index.ts:364-371` that calls
`pidfileLockAcquirer.release(PID_FILE, process.pid)`) or (b) the next
startup's
`unlinkIfMatches` chain at `process-lock.ts:236-253`. Neither path
involves an explicit "release the class instance" — the class has no
state to clean up beyond what the kernel and the pidfile entry
already track.

The risk is at construction. If E1's `PortLockAcquirer` instance is
constructed in a hot path (e.g. per-request, per-route, per-test)
without a process-lifetime owner, every instance is a fresh DI
bag with no identity — fine for one acquire, but if the code path
constructs the instance, calls `acquire(port)`, and then drops the
reference, the next `acquire` call would have to construct a fresh
instance again. Today the free function does this naturally because
it's a stateless call; the class version has a *named* instance
whose lifetime becomes visible.

The pidfile is the bigger concern: a `PidfileLockAcquirer` instance
whose `selfPid` is captured at construction but whose `.release()`
is called against an instance from a different boot — would
unlink a pidfile the current process did not write. Verified at
`src/index.ts:356-364`: the current `releaseLock()` reads the
pidfile and only unlinks if `recorded === process.pid`. If
`release()` is a method on the wrong instance, the `selfPid` field
is correct (it's the process's own PID), but the wrong instance
implies the wrong boot context, which implies `recorded` may be a
peer's PID.

### Mitigation

1. **One instance per process, owned by `class App` (framework D3,
   `05-refactor-roadmap.md` Phase 7) or by `acquireLock()` at
   `src/index.ts:337-351`.** The acquirer is constructed at boot
   with `selfPid: process.pid` once and held in a single closure
   scope for the process lifetime.
2. **The constructor captures `selfPid` once.** The class field is
   `private readonly selfPid: number`, set at construction; it is
   *not* re-read from `process.pid` inside `acquire()` or
   `release()`. This pins the boot-time identity.
3. **The `release()` method validates `recorded === this.selfPid`
   inside the class body**, not in a free helper that could be
   called against any instance. If a test wants to exercise
   `release()`, it constructs an instance with a specific `selfPid`
   and asserts the unlink happens only on match.
4. **No static instances.** Neither class exposes a `static
   default()` or `static fromEnv()` that would tempt callers to
   re-use a shared instance across boots.

### Detection signal

- A test that constructs two `PidfileLockAcquirer` instances with
  different `selfPid` values in the same test, then calls
  `.release()` on the second instance, observes the first instance's
  pidfile being deleted. This means `release()` is not pinning
  `selfPid` to the constructor argument.
- A `git grep -n 'new PortLockAcquirer\|new PidfileLockAcquirer'
  src/` shows more than one call site (one for each acquirer) —
  any new call site beyond `src/index.ts` is a sign the lifecycle
  is being broken into smaller pieces than the design intends.
- A runtime `process-lock.test.ts:652-683` style "third peer
  survives" test starts failing because the unlink matches a
  different pidfile than the one the current `acquire()` wrote.

---

## ER2. `PortLockAcquirer.acquire()` reads `NETSTAT_OUTPUT` for port-checking —
class version must preserve this side-effect path

### Where it bites

The E subsystem's port-lock flow relies on a side-effect chain the
class must preserve verbatim:

```
new PortLockAcquirer(ctx).acquire(port, opts)  [process-lock.ts:77-204, post-E.5a]
  -> this.ctx.listPortHolders(port)            [via this.findOwnNodeHolders:177-178]
       -> execFileSync('lsof', ['-ti', `TCP:${port}`])   [index.ts:101-110]
  -> this.ctx.listOwnProcessesMatching(pat)    [via this.findOwnBinaryMatches:179]
       -> execSync('ps -A -o pid,uid,args')               [index.ts:111-150]
  -> this.ctx.getProcessCommand(pid)           [index.ts:151-153]
       -> execFileSync('ps', ['-p', String(pid), '-o', 'comm='])
  -> this.ctx.getProcessUid(pid)               [index.ts:154-156]
       -> execFileSync('ps', ['-p', String(pid), '-o', 'uid='])
  -> this.ctx.signal(pid, sig)                 [index.ts:157-167]
       -> process.kill(pid, sig)
```

Each `execFileSync` / `execSync` is a synchronous I/O call into the
real OS process table. The class version *must not* lazily defer
these, batch them, or move them out of the function body. The mock
test fixture at `src/__tests__/process-lock.test.ts:46-58`
(short-circuits `defaultSignal` to a no-op literal) and
`src/__tests__/index.test.ts:173-188`'s `vi.mock('../process-lock.js')`
factory (which provides the real class via `vi.importActual`
precisely because the real `execSync` capture at module-load time
would otherwise route through the un-mocked `vi.importActual`) both
pin this behaviour.

### Mitigation

1. **The class is a literal translation.** Every `ctx.listPortHolders(...)`
   call in `process-lock.ts:177` becomes `this.ctx.listPortHolders(...)`
   in `PortLockAcquirer.acquire()`. No method body changes.
2. **The free-function `acquirePortLock` is gone (deleted in E.5a).**
   The class IS the implementation. No wrapper, no reorganisation
   of the call sequence.
3. **The `vi.mock('../process-lock.js')` factory at
   `index.test.ts:173` returns the real `PortLockAcquirer` via
   `vi.importActual`** (post-E.5a) so the production call site at
   `index.ts:350` constructs a real instance whose `acquire()`
   method drives the real `ctx.listPortHolders` chain. The factory's
   faithful re-implementation (`:324-341`) and the
   `withRealAcquirePortLock` helper (`:1363-1374`) both depend on
   the call sequence being preserved.

### Detection signal

- A test asserting `mockExecSync.calls` length or arguments starts
  failing — the class's call sequence diverged from the free
  function's.
- A diff in `src/process-lock.ts` that reorders calls inside the
  `acquirePortLock` body (now `PortLockAcquirer.acquire()` body)
  during E.1 lands — flagged by code review.
- The `mockAcquirePortLock` at `index.test.ts:324-341` stops
  faithfully driving the same `ctx` methods because the production
  code now calls methods the mock doesn't override.

---

## ER3. PidfileLock write path is `fs.writeFileSync` / `writeSync`,
not `fs.writeFile` — class version must preserve

### Where it bites

The pidfile create path at `src/index.ts:212-232` is **strictly
synchronous**:

```ts
tryCreateExclusive(path, pid) {
  try {
    const fd = openSync(path, 'wx')                          // :214
    try {
      writeBufferFully(                                      // :220
        (b, off, len) => writeSync(fd, b, off, len),         // :221
        Buffer.from(String(pid)),                            // :222
      )
    } finally {
      closeSync(fd)                                          // :225
    }
    return 'created'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists'
    throw err
  }
}
```

`openSync(path, 'wx')` opens atomically with O_EXCL — if the file
exists, the call throws `EEXIST` (`:229`). The subsequent
`writeSync` inside `writeBufferFully` (`:220-223`) writes the PID
into the now-locked fd. The class version of `acquirePidfileLock`
(this is `PidfileLockAcquirer.acquire()` after E.5b) calls
`this.ctx.tryCreateExclusive(path, selfPid)` at `process-lock.ts:302`
— the production `tryCreateExclusive` is at `index.ts:212-232`.

The risk: a well-intentioned refactor that "modernizes" the
synchronous path to `fs.writeFile(path, String(pid), { flag: 'wx' })`
introduces a race window. `fs.writeFile` opens, writes, and closes
across multiple internal steps; the file is visible to other
processes *between* the open and the write. A competing acquirer's
`this.ctx.readRecordedPid(path)` call at `process-lock.ts:308` could
read a truncated pidfile (an empty string or a partial write) and
parse it as `null` (per the strict-digit parse at `index.ts:233-235`
and the fallback at `process-lock.ts:309-315`), then trigger the
`this.ctx.unlinkIfMatches(path, null)` branch at `:313` — unlinking
the pidfile we just created, dropping our lock.

The current sync path closes that window: the file is visible to
other processes only after `closeSync(fd)` at `:225` has run.

### Mitigation

1. **The class is a literal translation.** `ctx.tryCreateExclusive`
   is called the same number of times in the same order. The
   class does not own the implementation of `tryCreateExclusive`
   — that stays at `src/index.ts:212-232` in the production ctx
   factory closure.
2. **No "async refactor" lands inside `tryCreateExclusive`.** The
   synchronous `openSync` / `writeSync` / `closeSync` triad is
   pinned by the regression test at `process-lock.test.ts:652-683`
   ("third peer survives"). The test would catch an async
   conversion because the test runs synchronously against a
   deterministic `PidfileState` Map and any async gap would
   produce a different observable sequence.
3. **`writeBufferFully` stays as a free export** (per E.1 "Free
   functions that REMAIN" in `03-class-boundaries.md`). It is
   imported by `src/index.ts:30` and used at `:220-223` only — no
   class absorbs it. Its signature
   `(writer: (buf, offset, length) => number, buf: Buffer) => void`
   is unchanged.

### Detection signal

- A diff that converts `openSync`/`writeSync`/`closeSync` to
  `fs.open`/`fs.write`/`fs.close` (the async trio) lands in
  `src/index.ts:212-232` — flagged by code review.
- A diff that converts `tryCreateExclusive` to use `fs.writeFile`
  inside a class method — flagged.
- The "third peer survives" test at `process-lock.test.ts:652-683`
  starts failing — the race window opened.
- A `bun run lint` warning about mixing `*Sync` and async I/O in
  the same function (if the project's lint config catches this).

---

## ER4. `DeferToPeerError` throw site — does it change?

### Where it bites

The module-state analysis at `01-module-state-analysis.md` §4
"Production throw sites — **two**, not one" identifies two
throw sites, not one. The H plan only cites one.

| File:line | Thrower | Trigger |
|---|---|---|
| `process-lock.ts:350` | `PidfileLockAcquirer.acquire()` (method body) | `onLiveLegitimate === 'defer'` and recorded PID is alive-and-legitimate |
| `src/index.ts:333` | `checkFreshStartupRace` (pre-acquire early-exit) | peer is alive, legitimate, and not yet on the port (mid-init loser detection) |

After E.2, the first throw site moved from a free function body
(`acquirePidfileLock`) to a method body
(`PidfileLockAcquirer.acquire()`); after E.5b the throw line shifted
from `:347` to `:350` (the method body adds the `this.ctx.*` prefix
and the method signature). The throw itself is byte-identical:
`throw new DeferToPeerError(recorded)` with the same `recorded`
value. The `instanceof DeferToPeerError` consumer at `index.ts:564`
continues to discriminate correctly because the class is the same
class (now imported from the same file).

The second throw site at `src/index.ts:333` is INSIDE
`checkFreshStartupRace`, which is a free function inside `index.ts`.
It does **not** move with E.2 — it stays at `:333` unchanged.
Both throw sites continue to produce a `DeferToPeerError` instance
that `instanceof DeferToPeerError` recognises at `:564`.

The risk: if `DeferToPeerError` is moved to `src/errors.ts` (the
H.4 candidate file per `h-cross-cutting/00-summary.md` Scope), the
class conversion of E.2 must keep the import path consistent.
`src/index.ts:31` re-exports it; both `:333` (throw) and `:564`
(`instanceof`) reference the same symbol.

### Mitigation

1. **`DeferToPeerError` stays in `src/process-lock.ts` for E.2.**
   The H.4 move is a separate phase (not in E's scope). E.2's class
   conversion does not move the error class.
2. **The throw at the class method body** is line-equivalent to
   the throw at the free function body — both end up at line
   `:350` (the body's `throw new DeferToPeerError(recorded)`
   statement is moved verbatim into the method).
3. **The throw at `src/index.ts:333` is unchanged** — it's in
   `checkFreshStartupRace`, which is not part of E's refactor.
4. **If H.4 later moves `DeferToPeerError` to `src/errors.ts`,** the
   move is a single-commit operation: `index.ts:31` updates its
   re-export, the `index.ts:333` throw imports from the new
   location, the `process-lock.ts:350` throw imports from the new
   location, and `index.ts:564`'s `instanceof` import updates.
   The class version of E.2 carries the same import statement
   because the class file imports the error class the same way
   the free function file did.

### Detection signal

- A test pinning `DeferToPeerError` from `process-lock.ts` (e.g.
  `process-lock.test.ts:631`,
  `index.test.ts:876`, `:1545`, `:1910`, `:1949`, `:2207`)
  starts failing because the import path changed and the test
  imports from the old path.
- A code-review diff that imports `DeferToPeerError` from a
  different module — flagged by review.
- A runtime test where `err instanceof DeferToPeerError` at
  `index.ts:555` returns `false` on a thrown `DeferToPeerError` —
  means two different classes exist (test shadow vs production
  shadow), per HR6 mitigation #1.

---

## ER5. `vi.mock('../process-lock.js')` pattern — only one file, but
the mock factory must keep returning assignable symbols

### Where it bites

Per `01-module-state-analysis.md` §5:

```
grep -rEn "vi\.mock.*process-lock" --include='*.ts'
→ src/__tests__/index.test.ts:173 (active mock)
→ src/__tests__/index.test.ts:1314 (explanatory comment in withRealAcquirePidfileLock)
```

**One active mock site.** The factory at
`src/__tests__/index.test.ts:173-194` (post-E.5) returns:

```ts
{
  PortLockAcquirer: actual.PortLockAcquirer,
  PidfileLockAcquirer: actual.PidfileLockAcquirer,
  writeBufferFully: actual.writeBufferFully,
  DeferToPeerError: actual.DeferToPeerError,
}
```

The factory uses `vi.importActual` to pull the two classes,
`writeBufferFully`, and `DeferToPeerError` from the real module
(none of them need mocking — the class instances drive the same
`ctx.listPortHolders` etc. chain as the old free functions did).
The legacy `mockAcquirePortLock` / `mockAcquirePidfileLock` `vi.fn()`s
remain as module-scope helpers used by the `withReal*` helpers' inner
class wrappers and by direct `mockImplementation` overrides at
`:324-341`; they are NOT re-exported from the `vi.mock` factory
because `index.ts` no longer references them.

After E.5a (`d4f2d71`) and E.5b (`8f33a22`), the factory shape is
exactly the four-symbol return shown above — `index.ts` imports only
`PortLockAcquirer`, `PidfileLockAcquirer`, and `DeferToPeerError`
from `process-lock.js` (verified by `grep -n "from.*process-lock" src/index.ts`).

| E phase | Factory shape |
|---|---|
| E.1–E.4 | `return { acquirePortLock: mock…, acquirePidfileLock: mock…, writeBufferFully: actual.writeBufferFully, DeferToPeerError: actual.DeferToPeerError }` (unchanged) |
| E.5 (landed) | `return { PortLockAcquirer: actual.PortLockAcquirer, PidfileLockAcquirer: actual.PidfileLockAcquirer, writeBufferFully: actual.writeBufferFully, DeferToPeerError: actual.DeferToPeerError }` |

### Mitigation

1. **The factory stays byte-identical through E.1–E.4.** E.5 is the
   only phase that touches it. **Verified post-E.5.**
2. **The `withRealAcquirePortLock` / `withRealAcquirePidfileLock`
   helpers at `index.test.ts:1363` and `:1314` route through
   `vi.importActual`** and call `actual.acquirePortLock(...)` /
   `actual.acquirePidfileLock(...)`. These work as long as the
   module exports the functions. After E.5, the helpers must be
   rewritten to construct a real instance: `new
   PortLockAcquirer(actualCtx).acquire(port)` OR removed
   entirely if the test groups that depend on them can be
   satisfied by the mock factory alone.
3. **The 40+ `mockAcquirePortLock` / `mockAcquirePidfileLock`
   assertion sites keep working unchanged** through E.5 — the
   mocks are `vi.fn()` instances; renaming the symbols they
   substitute does not affect the assertions. Only the `vi.mock`
   factory's *return* shape changes at E.5.
4. **`process-lock.test.ts` does not use `vi.mock`** (verified —
   `01-module-state-analysis.md` §8). Its 33 cases construct a
   `MockProc` table (`:18-83`) or a `PidfileState` Map
   (`:460-530`) directly. The class conversion only requires
   updating the `acquirePortLock` / `acquirePidfileLock` import
   lines (`:8, :9`) and rewriting the per-case construction if
   the case calls the free function directly.

### Detection signal

- The `vi.mock` factory at `index.test.ts:173` returns an object
  that no longer matches `index.ts`'s imports — `tsc --noEmit`
  reports `TS2305: Module '"../process-lock.js"' has no exported
  member 'X'`.
- A test that calls `mockAcquirePortLock` (defined at `:321`)
  observes zero calls in a passing test — means the production
  code is now constructing a class and the mock is no longer
  in the call path.
- `index.test.ts:876` ('defers to a legitimate alive peer that is
  not yet on the port') starts failing — the `vi.mock` factory
  shape drifted.
- A diff that removes the `vi.mock` factory without updating the
  13+ test groups that depend on `withRealAcquire*` helpers —
  flagged by code review.

---

## ER6. H subsystem HR4 (`LoggerLike` vs `pino.Logger` confusion)
applies to E — test code that mocks logger must provide
`LoggerLike`, not `pino.Logger`

### Where it bites

Per `h-cross-cutting/06-risks-and-mitigations.md` HR4, the two
directions of compatibility are:

1. **`pino.Logger` assignable to `LoggerLike`?** Yes, structurally
   — pino's `info`/`warn`/`error`/`debug` are typed as pino's own
   `LogFn`, whose overload set is a superset of `LoggerLike.LogFn`'s.
   So `const l: LoggerLike = logger` compiles.
2. **Every existing call site compile through `LoggerLike`?** Yes
   for the 13 process-lock call sites because all use the obj-first
   form (`ctx.log.<level>({ ... }, 'msg')`). The string-first form
   (`ctx.log.<level>('msg')`) is **never used** in process-lock —
   verified by `grep -nE 'log\.(info|warn|error)' src/process-lock.ts`
   and tabulated in `02-type-interface-analysis.md` §1.

The HR4 hazard is on the test side. When E.6 lands and the
`process-lock.test.ts:81` and `:515` fixtures' `log: { info, warn,
error }` literal must be widened to `log: { info, warn, error,
debug }` to satisfy `LoggerLike`. The widening is mechanical:

```ts
// Before E.6
log: { info: log('info'), warn: log('warn'), error: log('error') }

// After E.6
log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }
```

But the test mock factory at `index.test.ts:173` also touches the
adapter literals at `src/index.ts:171-175` and `:280-287`. Once E.6
collapses those adapters to `log: logger`, the test factory's
behaviour changes: `mockLogger.error` is now called *directly* by
the `acquirePidfileLock` body (when it logs an error), not via the
adapter's `(obj, msg) => logger.error(obj, msg)` forwarder. The
assertion `expect(mockLogger.error).toHaveBeenCalledWith(...)` at
`index.test.ts:1391` continues to pass because the call site is
the same; only the forwarder in between disappears.

### Mitigation

1. **The two test fixtures at `process-lock.test.ts:81` and `:515`
   are widened to four methods in the same E.6 commit.** The
   `log()` helper function in the test file (the factory that
   builds each level's mock) is extended from
   `function log(level: 'info' | 'warn' | 'error')` to
   `function log(level: 'info' | 'warn' | 'error' | 'debug')`.
2. **The compile-time pin** `const _check: LoggerLike = logger` is
   added in a test file (per HR4 mitigation #2). For E, the pin
   goes in `process-lock.test.ts` or a new `logger-like.test.ts`
   — wherever the test runner discovers it. [ASSUMPTION: location
   not yet decided; H.1 owns the canonical location.]
3. **No `as unknown as LoggerLike` casts** in E's diff. Per HR2
   mitigation #4, a cast at the boundary is a rejected diff.
4. **The pin test at `index.test.ts:1383`** ('forwards pidfile
   context errors to logger.error') continues to pass through
   the collapse because the call chain loses one layer (the
   adapter at `index.ts:280-287`) but the `mockLogger.error`
   call still happens at the same `process-lock.ts:362` line.

### Detection signal

- `bun tsc --noEmit` reports `Property 'debug' is missing in type
  '{ info: ...; warn: ...; error: ... }'` at `process-lock.test.ts:81`
  or `:515` — the test fixture was not updated in lockstep with
  E.6.
- A diff introduces `as unknown as LoggerLike` in a `__tests__/`
  file — flagged by code review (HR2 mitigation #4).
- The pin test at `index.test.ts:1383` starts failing — the
  collapse to `log: logger` did not preserve the call site.
- A pino internal assertion (e.g. `logger._level` at
  `logger.test.ts:33`, `:42`) starts failing because the test
  reaches a `LoggerLike`-typed code path and loses the concrete
  pino type. E does not touch pino internals, but if H.2 changes
  how the singleton is reached, E's call sites may route through
  `LoggerLike` and lose access to pino-specific members — which
  E does not use today.

---

## Summary table

| ID | Risk | Live today? | Severity | Mitigation summary |
|---|---|---|---|---|
| ER1 | Lock lifecycle leak via wrong ownership path | **No** — single free function today, no instance to leak | Low (latent) | One instance per process, owned by `class App` or `acquireLock()`; `selfPid` captured at construction |
| ER2 | PortLock side-effect path (`lsof`/`ps`/`kill`) reordered or batched | **No** — single function body today | Low | Literal translation; `vi.mock` factory at `index.test.ts:173` pins the call sequence |
| ER3 | Pidfile write path async-ified (race window opens) | **No** — sync triad at `index.ts:212-232` today | Medium | `tryCreateExclusive` stays sync; `openSync`/`writeSync`/`closeSync` pinned by `process-lock.test.ts:652-683` |
| ER4 | `DeferToPeerError` throw site drift after class extraction | **No** — line-equivalent move | Low | Class body inherits the throw; `src/index.ts:324` throw unchanged; H.4 move to `src/errors.ts` is out of scope for E |
| ER5 | `vi.mock('../process-lock.js')` factory at `index.test.ts:173` breaks at E.5 | **Yes** at E.5 — one mock site must change shape | Medium | Factory unchanged through E.1–E.4; E.5 rewrites it to mock constructors; `withReal*` helpers at `:1363`/`:1314` rewritten in lockstep |
| ER6 | HR4 `LoggerLike` widening forces test fixture update | **Yes** at E.6 — two fixtures at `process-lock.test.ts:81`/`:515` lack `debug` | Low | Widen in lockstep with E.6; compile-time `LoggerLike = logger` pin; no `as unknown as` at boundaries |