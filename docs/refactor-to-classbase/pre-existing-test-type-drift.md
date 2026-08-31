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

## Real breakdown (as of 2026-08-31)

| File | errors | Cleanup cycle |
|---|---|---|
| src/__tests__/channel-monitor.test.ts | 361 | Cycle 1 (this commit) |
| src/__tests__/agents-routes.test.ts | 0 | Cycle 2 (landed 6c6327e) |
| src/__tests__/schedule-runner-full.test.ts | 257 | Cycle 3 |
| src/__tests__/channel-monitor-coverage.test.ts | 224 | Cycle 4 |
| src/__tests__/channel-monitor-baseline.test.ts | 118 | Cycle 5 |
| (smaller files, totals in subsequent cycles) | ~425 | Cycles 6-N |
| src/db.ts (bun:sqlite drift) | 30 | Future (separate MD) |
| src/channel-coordinator.ts | 1 | Future |
| Total | 1055 | (measured 2026-08-31 post-cycle-2; was 1729) |

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
vitest: 384/11225/0 (preserved).

## What cleanup means going forward

Each subsequent cycle:
1. Read the file in full (medium-sized test files, 500-2500 lines).
2. Find the vi.hoisted() factories at the top.
3. For each mock helper, find the production function Parameters<typeof F> and ReturnType<typeof F>.
4. Rewrite the mock with vi.fn<ReturnType<typeof F>>().
5. bun tsc --noEmit delta must equal -(errors in this file).
6. bun --bun vitest run must remain 384/11225/0.

No production code changes. Type-only realignment.

## Rules for future cycles

- No 'as' casts (CLAUDE.md §7). Use 'satisfies' or explicit type imports.
- No 'any' (CLAUDE.md §7). Use 'unknown' if a value genuinely cannot be typed.
- Imports must be 'import type' so they are compile-time-only.
- Never refactor unrelated production code; touch only the test file.
- Each cycle is one commit on refactor/classbase; merge --ff-only after gate-check.