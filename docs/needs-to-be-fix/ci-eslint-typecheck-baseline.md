# ci-eslint-typecheck-baseline

**Filed:** 2026-08-13
**Severity:** low (tooling debt, no runtime defect)
**Status:** open, deliberately unfixed

## What

A strict, type-aware ESLint setup (`eslint.config.js`, `tsconfig.eslint.json`) and a CI workflow
(`.github/workflows/ci.yml`) were added to the repo. Both the ESLint run and the pre-existing `tsc --noEmit`
run report a large number of violations. The decision at the time of filing was to **land the tooling and
leave the violations unfixed**, so the CI `lint` job is red by design until this debt is worked down.

This is not a runtime bug. Nothing in `src/` behaves differently. It is a record of what the new gate found,
so the cleanup can be done rule-by-rule instead of rediscovered later.

## Numbers as filed

`bun run lint` — **9933 problems** (9929 errors, 4 warnings) across **456 of 584** linted files.
Runtime 25s, peak RSS 3.5GB (hence `NODE_OPTIONS=--max-old-space-size=8192` in the `lint` script).

By area:

| Errors | Area |
| --- | --- |
| 7401 | `src/__tests__/` |
| 2099 | `src/web/` |
| 379 | `src/` (other) |
| 33 | `scripts/` |
| 20 | `tests/smoke/` |
| 1 | root config files |

68 distinct rules fired. Top 20:

| Errors | Rule | Autofixable |
| --- | --- | --- |
| 2067 | `@typescript-eslint/no-unsafe-member-access` | 0 |
| 1161 | `@typescript-eslint/no-unsafe-assignment` | 0 |
| 659 | `@typescript-eslint/no-unsafe-call` | 0 |
| 519 | `@typescript-eslint/no-non-null-assertion` | 286 |
| 499 | `@typescript-eslint/no-unnecessary-type-assertion` | 499 |
| 488 | `@typescript-eslint/restrict-template-expressions` | 0 |
| 465 | `@typescript-eslint/require-await` | 465 |
| 416 | `@typescript-eslint/no-explicit-any` | 416 |
| 400 | `@typescript-eslint/array-type` | 400 |
| 375 | `@typescript-eslint/no-unnecessary-condition` | 202 |
| 341 | `@typescript-eslint/no-unsafe-argument` | 0 |
| 297 | `@typescript-eslint/dot-notation` | 297 |
| 278 | `@typescript-eslint/no-unused-vars` | 97 |
| 258 | `@typescript-eslint/prefer-nullish-coalescing` | 258 |
| 247 | `@typescript-eslint/no-unsafe-return` | 0 |
| 210 | `@typescript-eslint/no-confusing-void-expression` | 196 |
| 189 | `@typescript-eslint/prefer-regexp-exec` | 189 |
| 105 | `@typescript-eslint/no-empty-function` | 105 |
| 87 | `@typescript-eslint/no-require-imports` | 0 |
| 85 | `vitest/no-conditional-expect` | 0 |

Worst files:

| Errors | File |
| --- | --- |
| 487 | `src/__tests__/fleet-transfer-routes.test.ts` |
| 327 | `src/__tests__/schedule-runner-full.test.ts` |
| 317 | `src/__tests__/index.test.ts` |
| 291 | `src/web/fleet-transfer.ts` |
| 256 | `src/__tests__/fleet-transfer-branches.test.ts` |
| 230 | `src/web/routes/connectors.ts` |
| 168 | `src/web/routes/agents.ts` |

## The separate, pre-existing typecheck failure

`bun run typecheck` (`bun tsc --noEmit`, unchanged by this work) already fails with **1703 errors**:

- **1673** in `src/__tests__/` — overwhelmingly mock-typing noise: `TS2345` (833), `TS2322` (414), `TS7006` (191).
  Typical shape: `vi.fn()` mocks whose inferred signature is `() => never` being called with arguments, and
  partial object literals assigned to full domain types (`DashboardUser`, `FederationPeer`).
- **30** in `src/` proper, almost all `src/db.ts`: `Property 'sql' does not exist on type '{}'` and
  `Type '{} | undefined' is not assignable to type 'DashboardUser | undefined'` — the bun:sqlite `query().get()`
  return type is `{}` and the call sites assume a typed row.

This is independent of ESLint and predates it. It is listed here because the CI `lint` job runs
`bun run typecheck` first, so it is the first thing that goes red.

## Suggested cleanup order

The `no-unsafe-*` family (4475 errors, 45% of the total) is almost entirely downstream of the untyped
`bun:sqlite` rows and untyped `vi.fn()` mocks. Fixing the root types collapses most of it.

1. **`src/db.ts` row typing.** Add a generic row typeguard / `query<T>()` wrapper so `.get()` and `.all()` return
   typed rows instead of `{}`. Kills the 30 `src/` typecheck errors and a large share of `src/web/`
   `no-unsafe-member-access`. Highest leverage single change.
2. **Mock typing helper for tests.** A typed `vi.fn()` factory (or `satisfies`-based mock builders) for the
   repeated mock shapes. Targets the 1673 test typecheck errors and the 7401 test lint errors together.
3. **Pure autofix sweep.** `bun run lint:fix` resolves ~3500 errors mechanically (`array-type`,
   `no-unnecessary-type-assertion`, `require-await`, `dot-notation`, `prefer-nullish-coalescing`,
   `prefer-regexp-exec`, `no-unnecessary-type-conversion`). Do this **after** 1 and 2 so the autofixer is not
   rewriting code that is about to be retyped.
4. **`no-explicit-any` (416).** Project rule already forbids `any` in favour of `unknown`; this is the enforcement
   catching up with the rule.
5. **`no-non-null-assertion` (519) and `restrict-template-expressions` (488).** Case-by-case; the non-null
   assertions overlap heavily with `no-unnecessary-type-assertion`, so item 3 shrinks this set first.
6. **`vitest/no-conditional-expect` (85) and `vitest/expect-expect` (55).** Real test-quality findings, worth
   reading individually — a conditional `expect` can mean a test that silently asserts nothing.

## Reproduce

```
bun run lint                       # 9933 problems
bun run typecheck                  # 1703 errors
bunx eslint . -f json -o /tmp/lint.json   # machine-readable, for per-rule counts
```

## Related

- `.github/workflows/ci.yml` — the `lint` job that surfaces this
- `.github/workflows/CLAUDE.md` — why the job is red on purpose
- `eslint.config.js` — rule selection (`strictTypeChecked` + `stylisticTypeChecked`)
- `tsconfig.eslint.json` — why a second tsconfig exists
