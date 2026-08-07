# agent-worker.ts: array-valued host .claude.json silently drops the worker's trust flags

## Location

`src/web/agent-worker.ts`, lines 406-423 (the `.claude.json` materialise
block in `ensureWorkerCwd`).

```ts
try {
  const homeClaudeJson = join(homedir(), '.claude.json')
  const parsed: { projects?: ...; hasCompletedOnboarding?: boolean; ... } =
    existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
  stampWorkerFirstRun(parsed)
  ...
  parsed.projects = projects
  writeFileSync(join(ctx.configDir, '.claude.json'), JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
} catch (err) {
  logger.warn({ err }, 'worker: failed to materialise .claude.json (worker may park on a first-run modal)')
}
```

## Excerpt

When the host's `~/.claude.json` is an array (the result of a malformed
write from a different tool, or a fresh install where Claude Code wrote
`[]` instead of `{}`), the worker writes `[]\n` to its isolated
`.claude.json` -- **silently dropping** every property the
`stampWorkerFirstRun` helper set.

Root cause: `JSON.stringify` on an array only serialises numeric-indexed
elements. `parsed.hasCompletedOnboarding = true` and
`parsed.projects = { ... }` are non-numeric properties on the array
object, so `JSON.stringify(parsed)` returns `'[]'`.

Consequence: the worker's first generation after this silent failure
parks on the theme picker + login onboarding + trust dialog for the
whole boot. `ensureWorkerCwd` reports no error (the `try/catch` only
fires on actual throw), so the operator never sees the regression.

## Failure scenario

1. A host whose `~/.claude.json` is `[]` (or `["anything"]`) runs the
   worker boot.
2. `ensureWorkerCwd` succeeds, the worker starts, and the first
   interactive turn parks on a first-run modal -- instead of reaching
   its idle prompt within the 90-second `WORKER_BOOT_TIMEOUT_MS`.
3. `alertWorkerStuck` notifies the operator an hour later, but the root
   cause (the empty `.claude.json`) is invisible in the logs.

A test can reproduce it deterministically: write `[]` to the host
`.claude.json`, call `ensureWorkerCwd`, and read back the worker's
`.claude.json` -- it's `[]\n`.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`. The reachable siblings are
covered so the gap is exactly the array-coerce arm:

- `describe('ensureWorkerCwd')` -- "stamps the worker .claude.json with
  hasCompletedOnboarding + trust flags" covers the object-valued host
  case (the success path).
- "handles an array-valued host .claude.json (current behaviour: silently
  no-op the trust stamp)" asserts the CURRENT (buggy) `[]\n` output and
  the missing `hasCompletedOnboarding` flag.

## Suggested direction

Three independent fixes; each removes the silent drop.

(a) Coerce non-object `parsed` values to `{}` at the top of the block:

    ```ts
    const raw = existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
    const parsed = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
    ```

(b) Use `structuredClone(parsed)` (or `JSON.parse(JSON.stringify(parsed))`
    wrapped in a try) so the worker's `.claude.json` is always a fresh
    object -- but option (a) is simpler.

(c) Validate `parsed.projects` as a non-array object before iterating:

    ```ts
    const projects: Record<string, unknown> = (parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) ? parsed.projects : {}
    ```

    The pinning test "handles a host .claude.json whose projects field is
    an array" exercises this branch too.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edits are
blocked until the user overrides; the test suite pins the current
behaviour and documents the direction.
