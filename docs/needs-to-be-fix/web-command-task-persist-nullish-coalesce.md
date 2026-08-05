# Dead branch in `persist()`: `healthMap ?? {}` fallback is unreachable

## Summary
`src/web/command-task.ts:34` contains a `healthMap ?? {}` nullish-coalescing
expression whose right-hand side is unreachable through any code path the
module exposes. `persist()` is only called from `runCommandTask()`, which
always invokes `load()` first; `load()` assigns either a parsed object or
`{}` to the module-level `healthMap` before returning. So `healthMap` is
guaranteed to be a truthy object at every `persist()` call site, and the
`{}` fallback can never be selected.

## Evidence
SUT source (`src/web/command-task.ts:26-36`):
```ts
let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}
```

`runCommandTask()` always calls `load()` immediately before `persist()`
(`src/web/command-task.ts:88, 92`). After `load()` returns, `healthMap` is
either a parsed JSON object or `{}`. Both are truthy, so `healthMap ?? {}`
always evaluates to `healthMap` and the `{}` fallback is dead.

## Branch coverage evidence
v8 branch coverage on `src/__tests__/web-command-task.test.ts` reports
the binary-expr branch at line 34 as `[28, 0]` -- the `{}` location has
zero hits across every test that drives `persist()` (28 successful
persists, 0 fallbacks).

## Why it matters
The vitest coverage gate at `vitest.config.ts` is hard-pinned to 100% on
all four metrics (lines / branches / functions / statements). With this
defect in the source, `src/web/command-task.ts` is unreachable at 100%
branch coverage no matter how thorough the test is. Either:

- `persist()` should drop the `?? {}` (it never fires), OR
- the coverage gate should learn about this specific exception.

The first option is cleaner and removes the dead branch.

## Fix sketch
```ts
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}
```
(plus a type narrowing / invariant if the team prefers `!` instead.)

## Reproduce
```sh
npx vitest run src/__tests__/web-command-task.test.ts \
  --coverage --coverage.include='src/web/command-task.ts'
# Branch coverage caps at 98.07% (51/52); line 34 reports an uncovered branch.
```