# command-task.ts: `persist()` `healthMap ?? {}` empty-fallback arm is unreachable

## Location

`src/web/command-task.ts`, line 34:

```ts
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}
```

The right arm of the `??` operator (`{}`) is dead.

## Excerpt

```ts
// src/web/command-task.ts:26-36
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

`persist` is module-private (not exported). Its only call site is inside
`runCommandTask`, which always calls `load()` first:

```ts
// src/web/command-task.ts:81-94
export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  ...
  const map = load()  // <-- guarantees healthMap is non-null
  const { ok, detail } = runCommand(task.command, timeoutMs)
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()           // <-- called AFTER load()
  ...
}
```

`load()` is the only writer of `healthMap` (alongside the module-level
init at line 26 which sets it to `null`). The two writers inside `load()`
both assign non-null values:
- Line 29: `healthMap = JSON.parse(...)` — assigns a parsed object (or throws into the catch)
- Line 30: `healthMap = {}` (catch path)

So when `persist()` is reached, `healthMap` is always either an object
parsed from disk or `{}`. The `??` right arm `{}` never fires.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

The `load + persist` suite in
`src/__tests__/web-command-task.test.ts` covers every reachable branch:
file missing → `{}`, malformed JSON → `{}`, valid file → parsed map.
Each scenario exercises `runCommandTask` (the only caller of `persist`),
which always goes through `load()` first. v8 coverage of line 34's
`healthMap ?? {}` binary-expr reports `counts=[28, 0]` — 28 left-arm
hits, 0 right-arm hits.

## Pinning test

`src/__tests__/web-command-task.test.ts` —
`describe('load + persist')` covers every reachable branch of the
load/persist cycle. The `??` empty-fallback arm has no reachable input
and is documented here without a test-side assertion.

## Suggested direction

Drop the `??`, since `persist()` cannot be reached while `healthMap` is
null:

```ts
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}
```

`healthMap` is typed as `HealthMap | null` at the module level, so
without `?? {}` TypeScript will require `healthMap!` or a similar
non-null assertion. A cleaner fix is to type the module-level binding
as `HealthMap` (initialized to `{}`) and remove the `let ... = null`
shape entirely; then the `load()` function's null check becomes
simpler:

```ts
let healthMap: HealthMap = {}
function load(): HealthMap {
  try { return healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { return healthMap = {} }
}
```

Per task rule "NEVER modify src/web/command-task.ts" the source edits
are blocked until the user overrides; the test suite documents the
gap and pins every reachable sibling branch.
