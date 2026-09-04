# Remaining LOW-Risk Refactor Items Inventory

**Date:** 2026-08-30
**Scope:** All not-yet-landed refactor items in `docs/refactor-to-classbase/` whose documented risk is `Low`.

## Verification: what is already DONE

Confirmed landed (per the commits cited in the prompt and per the "LANDED in `57c78d0`" annotations in the roadmaps):

- **D.2** — `ChannelProviderRegistry` + 5 provider classes — landed `10d06cb`
- **D.4** — `TestRunMarkingDecorator` (part of channel-provider) — landed `10d06cb`
- **E.1** — `PortLockAcquirer` class — landed `57c78d0` (with E.2)
- **E.2** — `PidfileLockAcquirer` class — landed `57c78d0` (with E.1)

Both E.1 and E.2 explicitly annotated `e-process-lock/05-refactor-roadmap.md:25, :79`. The D.2/D.4 work is annotated in `d-channel-provider/05-refactor-roadmap.md`.

## Search results for "auto-restart" and "AutoRestart"

- `src/auto-restart.ts:1` — exists, 122 lines, dependency-free, zero logger calls
- `src/auto-restart.ts:48` — `export const DEFAULT_AUTO_RESTART: AutoRestartConfig = { … }`
- `src/auto-restart.ts:72` — `export function normalizeAutoRestartConfig(raw: unknown)`
- `src/web/auto-restart-runner.ts` — exists (separate; the I/O runner, not the pure logic module)
- **No `AutoRestartSchedule` class exists yet** — verified by `grep "class.*AutoRestart" src/auto-restart.ts` (zero hits).

## Search results for "Low" risk markers

`grep -rn "Low.*risk\|risk.*Low" docs/refactor-to-classbase/*/05-refactor-roadmap.md` returned:

| File | Phase | Risk label | Line |
|---|---|---|---|
| `e-process-lock/05-refactor-roadmap.md` | E.3 | Low | 188 |
| `e-process-lock/05-refactor-roadmap.md` | E.6 | Low | 340 |
| `h-cross-cutting/05-refactor-roadmap.md` | H.1 | Low | 52 |
| `h-cross-cutting/05-refactor-roadmap.md` | H.3 | Low | 161 |
| `h-cross-cutting/05-refactor-roadmap.md` | H.4 | Low-Medium | 211 (excluded — Medium-bias) |
| `h-cross-cutting/05-refactor-roadmap.md` | H.5 | High | 260 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.5 | Low | 242 |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.7 | Low | 348 |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.4 | Medium | 203 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.1 | High | 46 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.2 | Medium | 108 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.3 | Medium | 156 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.6 | Medium | 300 (excluded) |
| `f-agent-subsystem/05-refactor-roadmap.md` | F.8 | Critical | 403 (excluded) |
| `05-refactor-roadmap.md` (framework) | Phase 1 (LoggerLike) | Low | 40 |
| `05-refactor-roadmap.md` (framework) | Phase 8 (Docs) | Low | 312 |

## Comparison table: remaining LOW-risk items

| Item | Source file(s) | Files touched | New tests needed | Risk | Parallelizable? | Notes |
|---|---|---:|---|---|---|---|
| **F.5 `AutoRestartSchedule`** | `src/auto-restart.ts` (122 lines, 0 imports, 0 logger calls, 0 module state) | 1 src + 2 test files (`auto-restart-store.test.ts`, `auto-restart-main-mechanism.test.ts`) | 2 (DEFAULT identity pin + purity pin for the 5 methods) — per `f-agent-subsystem/05-refactor-roadmap.md:262-263` | Low | **Yes** — independent of F.1–F.4 and H.1 | Listed at `00-summary.md:108` as **#3 lowest-risk win**; F.5 module is the simplest file in the F subsystem |
| **H.3 `LazyBin` class** | `src/platform.ts` (the 7-line closure `makeLazyBinResolver` at `:74-80`) | 2 (`platform.ts` + `src/__tests__/platform-no-import-time-bin-resolve.test.ts`) | 3 (invalidate-cache, no-import-time-resolve, throws-on-unresolvable) — per `h-cross-cutting/05-refactor-roadmap.md:163-176` | Low | **Yes** — fully independent of H.1/H.2/H.4; `platform.ts` imports neither logger nor any error class | Mechanical translation of a 7-line closure; zero behaviour change for the 14 existing invocations |
| **F.7 `ClaudeCodeBinResolver extends LazyBin<'claude'>`** | `src/agent.ts` (216 lines, lines 81–100) | 2 (`agent.ts` + `src/__tests__/platform-no-import-time-bin-resolve.test.ts` reused) | 2 (invalidate() drops cache + generic-type distinction) — per `f-agent-subsystem/05-refactor-roadmap.md:360-362` | Low | **Yes** — independent of F.1–F.6; **gated on H.3** | Adds `invalidate()` method that the closure form lacks |
| **H.1 `LoggerLike` introduction** | `src/logger.ts`, `src/process-lock.ts`, `src/index.ts`, `src/__tests__/process-lock.test.ts` | 3 src + 1 test | 4 (compile-time assignability pin, `// @ts-expect-error` negative pin, logger.test.ts pass-through, `index.test.ts:1383` forwarder pin) — per `h-cross-cutting/05-refactor-roadmap.md:62-74` | Low | **No** — gates H.2a, framework Phase 2, and every constructor signature in A/B/C/D/E per `review-completeness.md` OE-11 | Additive; revertible in isolation. Two test sites at `process-lock.test.ts:81, :515` need a `debug` stub |
| **E.3 PortLock consumer migration** | `src/index.ts:341` (the one production consumer of `acquirePortLock`) | 1–2 (`src/index.ts`; test fixtures only if `process-lock.test.ts` `:333-528` are migrated in lockstep) | 0 new tests required (full `bun --bun vitest run` + `index.test.ts:876` pin) — per `e-process-lock/05-refactor-roadmap.md:188-198` | Low | **Yes** — disjoint from E.4; parallelisable once E.1/E.2 land | Single call site; constructor + method-call rewrite with byte-identical semantics |
| **E.6 `LogFn` removal** | `src/process-lock.ts:19`, `:49`, `:253`; `src/index.ts:171-175`, `:280-287`; comment fix at `index.ts:283`; `src/__tests__/process-lock.test.ts:81, :515` | 3 | 0 new tests (pin is `index.test.ts:1383` `bun tsc --noEmit` zero delta) — per `e-process-lock/05-refactor-roadmap.md:346-353` | Low | **Yes** (with E.5) — only if E.5 touches disjoint lines; verify with `git diff` | Pure type-side change; depends on H.1 having landed; collapse 3-method → 4-method `LoggerLike` shape |
| **Phase 8 Docs reconciliation** | `docs/**/*.md` | many (docs only, no code) | 0 (docs only) | Low | **Yes** — multiple agents can each own a docs subdirectory | Cross-reference updates after line numbers shift; per `05-refactor-roadmap.md:303-316`. Cannot land before the code phases it documents |

## Specific answers to Q1 / Q2 / Q3

### Q1: Is H.3 (LazyBin class) the lowest-risk remaining work? Are there any lower-risk items?

**No, H.3 ties F.5 at Low risk and is not uniquely lowest.** Three items share the Low rating:

1. **F.5 `AutoRestartSchedule`** — arguably the lowest by blast radius. The source module has zero imports, zero logger call sites, zero module-level state, and already has full test coverage (`auto-restart-store.test.ts` + `auto-restart-main-mechanism.test.ts`). Adding the class only requires 2 new tests (a DEFAULT identity pin and a purity pin for the 5 methods). The `00-summary.md:108` explicitly lists it as **#3 of the top-3 lowest-risk wins** alongside channel-provider (DONE) and process-lock (DONE).

2. **H.3 `LazyBin`** — a mechanical translation of a 7-line closure (`platform.ts:74-80`). Has a well-pinned no-import-time-resolve invariant (`platform-no-import-time-bin-resolve.test.ts:44`) that H.3 must preserve. Adds an `invalidate()` hook.

3. **F.7 `ClaudeCodeBinResolver extends LazyBin<'claude'>`** — Low but **gated on H.3**. Cannot land first.

The other Low items (H.1, E.3, E.6, Phase 8) carry coordination costs (H.1 gates H.2 + framework Phase 2; E.3/E.6 gate on H.1 + E.5; Phase 8 is docs-only).

**Recommendation: F.5 first, then H.3, then H.1 to unlock E.3 / E.6 / F.7.**

### Q2: Is auto-restart.ts actually scheduled in any plan, or has it been removed from scope?

**It IS scheduled — F.5 in `f-agent-subsystem/05-refactor-roadmap.md:227-272`** (`AutoRestartSchedule class extraction`, Low risk). Cross-references confirming continued inclusion:

- `00-summary.md:108` — Top 3 lowest-risk wins #3: `src/auto-restart.ts` namespace → `class AutoRestartSchedule`
- `f-agent-subsystem/00-summary.md:41` — file in scope table, F.5 phase, "brief override of the `02 §AutoRestart deep-dive` recommendation"
- `f-agent-subsystem/05-refactor-roadmap.md:227-272` — full phase spec
- `f-agent-subsystem/05-refactor-roadmap.md:455` — F.5 listed in the "Total parallelizable surface" 5-way parallelism set
- `f-agent-subsystem/05-refactor-roadmap.md:482-491` — F.5 #3 in the risk-adjusted serial order
- `f-agent-subsystem/05-refactor-roadmap.md:497` — Group B in the parallel agent grouping

**Not removed from scope; not yet landed; not done by any other phase.** Verified by `grep "AutoRestartSchedule\|class.*AutoRestart" src/auto-restart.ts` → no hits.

### Q3: What is the next item after H.3 (LazyBin) in the dependency graph? Does doing H.3 unlock anything?

**Yes — H.3 unlocks exactly one downstream item: F.7 (`ClaudeCodeBinResolver extends LazyBin<'claude'>`).** Evidence:

- `h-cross-cutting/05-refactor-roadmap.md:290` — dependency graph: `H.3 (LazyBin) ──► framework §C1 ClaudeCodeBinResolver`
- `f-agent-subsystem/05-refactor-roadmap.md:330-371` — F.7 spec, "blocked on H.3"
- `f-agent-subsystem/05-refactor-roadmap.md:431` — dependency graph line `H.3 (LazyBin) ──────────┐`
- `f-agent-subsystem/05-refactor-roadmap.md:451` — "F.7: blocked on H.3; parallel to F.6"

Nothing else in the H or F subsystem directly depends on H.3:

- H.1, H.2, H.4, H.5 — independent of H.3 (per `h-cross-cutting/05-refactor-roadmap.md:294`)
- E.1, E.2, E.3, E.4, E.5, E.6 — independent of H.3 (the E subsystem imports `process-lock.ts`, not `platform.ts`)
- F.1, F.2, F.3, F.4, F.5, F.6, F.8 — F.5 is the only F item that does not depend on H.3 (verified: F.5 touches only `auto-restart.ts`, which is dependency-free)
- Framework A1, A6, A10, B1–B5, C1–C4, D1, D3, D4 — only C1 (`ClaudeCodeBinResolver`) is downstream; A1 (`MemoryStore`), A6 (`MemoryStore` decay), B*, D1 (`AuthContext`), D3 (`App`), D4 (channel-provider, DONE) are independent of H.3

**H.3 → F.7 is the only downstream edge.** No other Low item unblocks anything else from this list.

## Cross-item ordering recommendation

The Low items decompose into four unblocked chains:

```
Chain A (lowest blast radius first):
  F.5 (auto-restart.ts, no imports)
  → F.7 (ClaudeCodeBinResolver)  [depends on H.3]

Chain B (the H.3 + downstream branch):
  H.3 (LazyBin class on platform.ts)
  → F.7 (ClaudeCodeBinResolver extends LazyBin)

Chain C (the logger-unification branch, gates the rest):
  H.1 (LoggerLike interface)
  → H.2a (proof consumer) → H.2b (roll-out) → H.5 (removal)
  → E.6 (LogFn removal) [also depends on E.5]
  → F.6 (LoggerLike adoption across F classes)

Chain D (consumer migrations):
  E.3 (PortLock consumer in src/index.ts:341)
  E.4 (PidfileLock consumer in src/index.ts:348)  [Low-Medium — borderline excluded from this Low table]
  → E.5 (free fn removal)  [Medium, gates E.6]

Chain E (docs only):
  Phase 8 (docs reconciliation) — last
```

`F.5` and `H.3` are the two unblocked Low items that can run in parallel from day one. `H.1` is Low but **not parallelizable** because it gates the entire H.2a → H.2b → H.5 chain and the framework's Phase 2 (process-lock) plus every constructor signature across A/B/C/D/E.

## Recommended next-batch selection

For a single-batch follow-up to the recent `57c78d0` / `10d06cb` / `ed2dd0b` work, the candidates with smallest blast radius and highest parallelism are:

1. **F.5 (`AutoRestartSchedule`)** — Low, 1 src file, parallelizable, no upstream gates
2. **H.3 (`LazyBin`)** — Low, 1 src file + 1 test update, parallelizable, no upstream gates

These two can land concurrently on disjoint files (`auto-restart.ts` vs `platform.ts`) with zero merge conflicts.
