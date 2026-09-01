# Pre-existing test type drift - forensic and cleanup plan

## Why this document exists

The codebase carried 1729 bun tsc --noEmit errors as a 'pre-existing baseline'
for months. That framing was wrong: only 30 of those errors were actual
bun:sqlite drift in src/db.ts; the remaining 1699 were loose-typed test
fixtures introduced during the late-August 2026 100% coverage test push.

This document captures the forensic and the per-file cleanup plan so the
real shape does not get re-buried under 'pre-existing' again.

## Forensic - what created the 1699 test errors

| Date | tsc errors | Event |
|---|---|---|
| 2026-04-08 (f24eacc, initial release) | 2 | Original baseline |
| 2026-08-06 (0b800e0) | 435 | ~120 days of organic growth |
| 2026-08-31 (HEAD pre-cycle-1) | 1729 | After 100% coverage push |
| 2026-08-31 (HEAD post-cycle-1) | 1368 | Cycle 1 (channel-monitor.test.ts) |
| 2026-08-31 (HEAD post-cycle-2) | 1055 | Cycle 2 (agents-routes.test.ts) |
| 2026-08-31 (HEAD post-cycle-3) | 798 | Cycle 3 (schedule-runner-full.test.ts) |
| 2026-09-01 (HEAD post-cycle-4) | ~574 | Cycle 4 (channel-monitor-coverage.test.ts) |
| 2026-09-01 (HEAD post-cycle-5) | ~456 | Cycle 5 (channel-monitor-baseline.test.ts) |

The +1294 jump between 2026-08-06 and 2026-08-31 came from these
'baseline tests lift coverage' commits:

| Commit | Message |
|---|---|
| 40c19ed | test(routes/agents): baseline tests lift branch coverage 92.2% -> 99.76% |
| dfc961c | test(agents-routes): cover ?? null / ?? '' / ?? [] fallback branches via baseline tests |
| c333a6f | test(schedule-runner,inbound-probe): extend suites to 100% coverage |
| 3e11a98 | test(channel-monitor-coverage): cover sub-agent w/o-channel + non-telegram branches |
| ac91c62 | test(schedule-runner): cover loadScheduleLastRun non-object branch |
| 4213852 | test(agents-routes): drop OpenRouter route coverage |

The pattern: vi.hoisted(() => ({ mockFn: vi.fn<T1, T2>() => ... }))
factories use too many type arguments (TS2558) or have inferred param/return
types that narrow to never after type assertions (TS2345), and pass
null / 0 / loose literals to functions typed against production
signatures.

## Real breakdown (as of 2026-09-01, post-cycle-5)

| File | errors | Cleanup cycle |
|---|---|---|
| src/__tests__/channel-monitor.test.ts | 0 | Cycle 1 (landed 0e9c39b) |
| src/__tests__/agents-routes.test.ts | 0 | Cycle 2 (landed 6c6327e) |
| src/__tests__/schedule-runner-full.test.ts | 0 | Cycle 3 (landed 7ddcc5b) |
| src/__tests__/channel-monitor-coverage.test.ts | 0 | Cycle 4 (landed ae17782) |
| src/__tests__/channel-monitor-baseline.test.ts | 0 | Cycle 5 (landed 7ba26d6) |
| (smaller files, <10 errors each) | ~425 | Cycles 6-N |
| src/db.ts (bun:sqlite drift) | 30 | Future (separate MD) |
| src/channel-coordinator.ts | 1 | Future |
| Total | ~456 | (measured 2026-09-01 post-cycle-5; was 1729) |

## Cycle 1 - what was done

(See commit 0e9c39bc9a51869b9d64f1ad5b8dbe97ef773cb6 on refactor/classbase.)

Channel-monitor.test.ts mock factory rewritten: each vi.fn() now uses
vi.fn<ReturnType<typeof productionFn>>() with production types imported
as 'import type'. No 'as' casts, no 'any' introduced (CLAUDE.md §7).

### Patterns addressed

| Pattern | Count in this file | Fix template |
|---|---|---|
| TS2558 (too many type args) | 9 | vi.fn<T1, T2>() -> vi.fn<ReturnType<typeof Fn>>() |
| TS2345 (null/never) | 287 | vi.fn<>() -> vi.fn<ReturnType<typeof Fn>>() with prod type |
| TS2322 (object shape) | 63 | explicit type annotation via Parameters/ReturnType |
| TS2353 (object literal) | 1 | typed object literal |
| TS2344 (constraint) | 1 | satisfies form constraint |

## Cycle 2 - what was done

(See commit 6c6327e9f5d724c1a637b1c94a1b20560202ec7d on refactor/classbase.)

Agents-routes.test.ts mock factory rewritten: each vi.fn() now uses
vi.fn<ReturnType<typeof productionFn>>() with production types imported
as 'import type'. Same pattern as Cycle 1, applied to the second-largest
offender.

tsc: 1368 -> 1055 (delta -313, matching the row above).
vitest: 384 files; pass/fail count measured per cycle (see git log for current value).

## Cycle 3 - what was done

(See commit 7ddcc5b4d73a5cd35742fe2964be2e114dc01cb8 on refactor/classbase.)

Schedule-runner-full.test.ts mock factory rewritten: each vi.fn() now uses
vi.fn<ReturnType<typeof productionFn>>() with production types imported
as 'import type'. Same pattern as Cycles 1 and 2, applied to the
third-largest offender. 257 errors fixed via strict typeof prodFn pattern.

tsc: 1055 -> 798 (delta -257, matching the row above).
vitest: 384 files; pass/fail count measured per cycle (see git log for current value).

## Cycle 4 - what was done

(See commit ae17782b1ac7529b033c97935fb4042bc484cfdd on refactor/classbase.)

Channel-monitor-coverage.test.ts mock factory rewritten: each vi.fn() now
uses vi.fn<ReturnType<typeof productionFn>>() with production types
imported as 'import type'. Same pattern as Cycles 1-3, applied to the
fourth-largest offender. 224 errors fixed via strict typeof prodFn pattern.

tsc: 798 -> ~574 (delta -224, matching the row above).
vitest: 384 files; pass/fail count measured per cycle (see git log for current value).

## Cycle 5 - what was done

(See commit 7ba26d69cfe237429aaacf8ae86089516fdaf8b4 on refactor/classbase.)

Channel-monitor-baseline.test.ts mock factory rewritten: each vi.fn() now
uses vi.fn<ReturnType<typeof productionFn>>() with production types
imported as 'import type'. Same pattern as Cycles 1-4, applied to the
fifth and final top-error test file. 118 errors fixed via strict
typeof prodFn pattern.

tsc: 574 -> ~456 (delta -118, matching the row above).
vitest: 384 files; pass/fail count measured per cycle (see git log for current value).

## 5/5 Top-File Plan Complete

With cycle 5 the original cleanup plan is DONE. Every test file that
contributed more than 100 tsc errors to the 1699-error pre-cycle-1
baseline has been realigned to production types via the
`vi.fn<ReturnType<typeof productionFn>>()` pattern:

| File | Pre-cycle-1 errors | Post-cycle | Cycle |
|---|---|---|---|
| channel-monitor.test.ts | 361 | 0 | 1 |
| agents-routes.test.ts | 313 | 0 | 2 |
| schedule-runner-full.test.ts | 257 | 0 | 3 |
| channel-monitor-coverage.test.ts | 224 | 0 | 4 |
| channel-monitor-baseline.test.ts | 118 | 0 | 5 |
| **Total** | **1273** | **0** | 1-5 |

Across 5 cycles: 1273 tsc errors eliminated, vitest stayed green every
cycle (384 test files; exact pass/fail counts measured per cycle),
and zero production code was touched.

## Remaining work (~425 errors, smaller files)

The remaining ~456 tsc errors are distributed across ~70 smaller test
files, none of which contribute more than ~47 errors individually
(top of the heap: routes-updates.test.ts at 47, inbound-probe-full at
40, db-100 at 38, routes-federation-full at 37, auth at 20).

This work was deliberately deferred from cycles 1-5 because:

1. **No single file dominates.** None would justify a dedicated cycle
   in isolation; the natural shape is a batched fix-up cycle.
2. **Pattern is established.** Cycles 1-5 proved that
   `vi.fn<ReturnType<typeof productionFn>>()` plus `import type`
   handles 100% of the recurring TS2558 / TS2345 / TS2322 errors.
3. **Different shape may apply.** Some of the remaining errors
   (e.g. `db-100.test.ts`, `src/__tests__/setup/test-sandbox-setup.ts`
   `Cannot find name 'vi'`) hint at root causes that the
   typeof-prodFn pattern alone may not fix.

Suggested next steps:

- **Cycle 6+:** Pick the next-largest offender
  (`routes-updates.test.ts`, 47 errors) and apply the same pattern.
- **Batched approach:** Group files by error category
  (TS2558 / TS2345 / TS2322 / etc.) and run a single batch cycle.
- **Setup file first:** Resolve the `test-sandbox-setup.ts` `Cannot find
  name 'vi'` separately, since it is shared across multiple suites.

The forensic baseline is now stable: 1729 -> 456 (-73.6%) with the
top-error work finished. The remaining 425 errors in smaller files
will not move on their own; they need dedicated cycles 6+.

## What cleanup means going forward

Each subsequent cycle:
1. Read the file in full (medium-sized test files, 500-2500 lines).
2. Find the vi.hoisted() factories at the top.
3. For each mock helper, find the production function Parameters<typeof F> and ReturnType<typeof F>.
4. Rewrite the mock with vi.fn<ReturnType<typeof F>>().
5. bun tsc --noEmit delta must equal -(errors in this file).
6. bun --bun vitest run must stay green (384 test files; exact pass/fail counts measured per cycle).

No production code changes. Type-only realignment.

## Rules for future cycles

- No 'as' casts (CLAUDE.md §7). Use 'satisfies' or explicit type imports.
- No 'any' (CLAUDE.md §7). Use 'unknown' if a value genuinely cannot be typed.
- Imports must be 'import type' so they are compile-time-only.
- Never refactor unrelated production code; touch only the test file.
- Each cycle is one commit on refactor/classbase; merge --ff-only after gate-check.