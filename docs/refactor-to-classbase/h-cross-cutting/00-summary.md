# H (cross-cutting) — Executive summary

Synthesis of `h-cross-cutting/01-module-state-analysis.md` (module/state lens)
and `h-cross-cutting/02-type-interface-analysis.md` (types/interfaces lens),
cross-checked against `src/` on 2026-08-30. **Planning only — no source file
was modified.**

---

## Thesis

H is the smallest subsystem by line count (`src/logger.ts` is 9 lines,
`src/platform.ts` is 81) and the largest by blast radius: 88 non-test files
import `logger`, 744 `logger.<level>(...)` calls exist in production, and 91
test files replace the module with `vi.mock`. The single highest-value
deliverable is therefore **not** a class — it is an exported `LoggerLike`
interface that lets every other subsystem's constructor accept a logger
without importing pino's concrete type, because until that interface exists,
Parts A/B/C/D/E of the framework plan cannot write a constructor signature at
all. The second deliverable, `LazyBin`, is a literal closure-to-class
translation of `makeLazyBinResolver` (`src/platform.ts:74`) whose only real
gain is a cache-invalidation hook that tests currently obtain by constructing
a fresh resolver per test (`src/__tests__/platform-bin-resolve.test.ts:96`).
The third, an `AppError` base for the nine existing error classes, is the
lowest-urgency and highest-regret item: all nine are discriminated by
`instanceof` at 15 production sites, so the base class must be additive and
must never change what `instanceof` answers. H owns no runtime behaviour of
its own; every phase below is designed so the observable log stream and the
observable throw/catch behaviour are byte-identical before and after.

---

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/logger.ts` (9 lines) | add `LoggerLike` type export alongside the existing `logger` singleton at `logger.ts:3` | H.1 |
| `src/process-lock.ts` | replace the local `LogFn` alias at `process-lock.ts:19` and the `{ info; warn; error }` shape at `:49` / `:253` with `LoggerLike` | H.1, H.2 |
| `src/index.ts` | the two pino→`LogFn` adapter literals at `index.ts:171-175` and `index.ts:280-287` collapse once `LoggerLike` lands | H.2 |
| `src/platform.ts` | add `LazyBin` class; keep `makeLazyBinResolver` as a thin factory | H.3 |
| One new file: `src/errors.ts` [ASSUMPTION: filename not yet decided] | `AppError` base + convention doc | H.4 |
| 2 of the 9 error class files (see 03 §C) | first two `AppError` subclasses | H.4 |

### Files this plan does NOT touch

- **The 11 `makeLazyBinResolver` call sites** (`channel-coordinator/liveness.ts:20`,
  `web/channel-mcp-reconnect.ts:11`, `web/agent-process.ts:56-57`,
  `web/agent-worker.ts:43`, `web/channel-plugin-unlock.ts:40`,
  `web/stuck-tool-call-watcher.ts:54`, `web/mcp-list.ts:13`,
  `web/reauth-healer.ts:32`, `web/channel-monitor.ts:53-54`,
  `web/routes/background-tasks.ts:14-15`, `web/routes/agent-terminal.ts:13` —
  14 invocations in 11 files). They keep calling the factory; H.3 does not
  migrate them.
- **The 88 files that `import { logger }`.** H.1 and H.4 are purely additive;
  H.2 migrates consumers only as the owning subsystem converts them, and H.5
  (singleton removal) is gated on all of them being done.
- **`PLATFORM`** (`platform.ts:24`). It has exactly one production consumer
  (`web/claude-credentials-guard.ts:6` import, branched at `:322`). Converting
  it is churn.
- **`tryResolveFromPath` / `resolveFromPath`** (`platform.ts:48` / `:61`).
  They are pure functions with 4 external call sites
  (`web/claude-credentials-guard.ts:142`, `:327`, `web/agent-worker.ts:502`,
  `web/agent-worker.ts:547`). They stay free functions; `LazyBin` composes
  over them.
- **`web/remote-status-cache.ts:19` (`RemoteStatusCache<T>`).** Already a
  well-formed generic class; per `review-completeness.md` CE-9 it is the
  precedent to cite, not a thing to rewrite.
- **The 7 error classes not selected for H.4's first pair.** They convert in
  a later, non-H pass or never.
- **All test files.** They are *updated* by H.1/H.2/H.4, but their layout,
  runner and coverage targets are not in scope (consistent with
  `00-summary.md` "Explicitly OUT OF SCOPE").

---

## Dependency: what other subsystems expect from H

The framework's Part letters (`03-class-boundaries.md`) are the only defensible
mapping; the workflow's letters E/F/B/A/G/C are read against them.
[ASSUMPTION: A = Part A per-entity stores, B = Part B runners, C = Part C
lazy-cache singletons, D = Part D keystones, E = Part E process lock, F =
Part F out-of-scope, G = the `04-generic-interfaces.md` generics list. No
document in `docs/refactor-to-classbase/` states this mapping explicitly.]

| Consumer | H deliverable it needs | What it expects | Blocking? |
|---|---|---|---|
| **E** (`PortLockAcquirer`, `PidfileLockAcquirer`, `03 §E1/E2`) | `LoggerLike` | A type it can put on `ProcessLockContext.log` (`process-lock.ts:49`) that both a real pino instance and the existing `{info,warn,error}` object literals at `index.ts:171-175` / `:280-287` satisfy. This is exactly the `LogFn` triple at `process-lock.ts:19`. | **Yes.** `review-completeness.md` OE-11 already flags that framework Phase 2 cannot land before Phase 1; H.1 is that Phase 1. |
| **A** (entity stores A1, A3, A4, A6, A8, A10, A11, A12) | `LoggerLike` | A constructor parameter type. `04-generic-interfaces.md` G5 lists these as adopters. | Yes for the constructor signature; no for the store logic. |
| **B** (runners B1, B2, B3, B5) | `LoggerLike` | Same. Runners are the heaviest `logger.debug` users — 40+ of the 744 prod calls are `logger.debug` inside `web/*-runner.ts` / `web/*-watcher.ts` / `web/channel-monitor.ts`. | Yes for the signature. |
| **C** (`ClaudeCodeBinResolver` C1, `GoogleTokenCache` C2, `GraphMail*` C3, `LazyBin` C4) | `LazyBin` **and** `LoggerLike` | `03 §C1` states `ClaudeCodeBinResolver` is "a more specialized version" of `LazyBin`; C1 needs `LazyBin`'s shape settled first. C2/C3 need `LoggerLike`. | Yes for C1. |
| **D** (`Config` D1, `App` D3) | `LoggerLike` | `D1` takes a logger; `App` wires the singleton into every store at boot — this is exactly the dual-destination window described in `review-completeness.md` CE-15. | Yes. |
| **G** (generics catalogue) | Corrected `LoggerLike` + `LazyBin` sketches | `04 §G5` currently says `type LoggerLike = Logger` (a bare pino re-alias) and `04 §G7` says `LazyBin.resolve(): string | null`. **Both are wrong** — see `04-generic-interfaces.md` in this folder for the corrections. G must be updated from H, not the other way round. | Yes — G5/G7 are currently unimplementable as written. |
| **F** (out-of-scope list) | Error taxonomy decision | `00-summary.md` currently exempts only `DeferToPeerError` and `RemoteEnrollError`; `review-completeness.md` CE-1 shows 8 more classes exist. H.4 supplies the convention that lets F state one rule instead of nine exceptions. | No — advisory. |

**What H does NOT owe anyone.** No error class imports the logger, no error
class imports `platform.ts`, and `platform.ts` imports neither. Verified: the
nine error constructors take only domain data. So H.3 and H.4 can run
concurrently with each other and with H.2 without ordering constraints.

---

## Top 3 risks specific to H

1. **`LoggerLike` gets the call signature wrong and breaks 118 call sites.**
   The sketch in `h-cross-cutting/02-type-interface-analysis.md` §LoggerLike
   proposes `type LogFn<L> = (record: L, msg?: string) => void` — record
   first, mandatory. Measured against source: of the 744 production
   `logger.<info|warn|error|debug>(` calls, **626 are object-first** and
   **76 are string-first** (`logger.debug('Heartbeat: outside active window,
   skipping')` at `heartbeat.ts:488`; `logger.info('Heartbeat ellenorzes
   indul...')` at `heartbeat.ts:492`; `logger.info('channel-coordinator:
   native channel back UP, yielding to native (-> idle)')` at
   `channel-coordinator.ts:355`), the remaining ~42 being variable-first or
   multi-line. A record-first-only `LogFn` fails to type-check ~118 sites on
   day one. pino's own `LogFn` (`node_modules/pino/pino.d.ts:345-352`) carries
   three overloads precisely for this. Detail in `06-risks-and-mitigations.md`
   HR4.

2. **Requiring `child()` on `LoggerLike` invalidates 88 of 91 test mocks.**
   Measured across `src/**/__tests__/`: 91 files mock `logger.js`; the
   dominant mock shape is `{info, warn, error, debug}` (64 files); only
   **3 files** supply `child` (`vault.test.ts:120` via an
   `as unknown as` cast, `auth.test.ts:183`, and one more). Zero production
   files call `logger.child(` — verified by grep across `src/` excluding
   tests. Detail in `06-risks-and-mitigations.md` HR2.

3. **The migration window has two live log destinations and no test factory.**
   `review-completeness.md` CE-15 states the problem; H owns the fix. During
   H.2, a class constructed at app boot holds `this.log = logger` (the real
   singleton captured before any `vi.mock` factory runs), while
   `vi.mock('../logger.js')` replaces the module binding. A test that asserts
   on `mockLogger.info` sees zero calls. Compounding it: `logger.test.ts:15`
   already calls `vi.resetModules()` in `beforeEach`, which
   `06-risks-and-mitigations.md` R10 mitigation 1 tells everyone not to do —
   the rule is violated by the logger's own test today. Detail in
   `06-risks-and-mitigations.md` HR3.

---

## Migration order inside H

```
H.1  LoggerLike interface           (additive; singleton untouched)
      │
      ├──────────────► H.2  Per-class logger injection (one proof consumer, then roll-out)
      │                       │
      │                       └──► H.5  Singleton removal  [gated on all consumers]
      │
H.3  LazyBin extraction             (independent — can run parallel to H.1/H.2)
H.4  Error taxonomy (AppError + 2)  (independent — can run parallel to everything)
```

Rationale for the order:

- **H.1 first** because E, A, B, C2/C3 and D1 all need a constructor-parameter
  type before they can be written at all. It is the only H item on anyone
  else's critical path.
- **H.2 second** and incrementally, because it is the only H item that can
  silently break test assertions (risk 3 above) — it needs one proof consumer
  with the test-factory convention nailed down before rolling out.
- **H.3 anywhere** — `platform.ts` shares no state or type with `logger.ts`,
  and the 11 existing call sites are untouched by design.
- **H.4 anywhere**, but late is fine: it changes nothing observable and its
  main consumer (a project-wide convention doc) has no deadline.
- **H.5 last and gated.** It is the only irreversible step: once
  `export const logger` is deleted, all 88 importers must already be migrated.
  The gate is mechanical — `grep -rln "from '.*logger\.js'" src/ --include='*.ts' | grep -v __tests__`
  must return only `logger.ts` itself.
