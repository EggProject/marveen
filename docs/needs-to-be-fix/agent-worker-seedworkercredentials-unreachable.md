# agent-worker.ts: seedWorkerCredentials mkdirSync arm is unreachable

## Location

`src/web/agent-worker.ts`, line 211 (inside `seedWorkerCredentials`).

```ts
function seedWorkerCredentials(ctx: WorkerCtx): boolean {
  if (process.platform === 'darwin') clearWorkerKeychainEntry(ctx)
  const credentialsJson = readClaudeCodeOauthJson()
  if (!credentialsJson) return false
  if (!existsSync(ctx.configDir)) mkdirSync(ctx.configDir, { recursive: true })  // line 211
  writeFileSync(join(ctx.configDir, '.credentials.json'), credentialsJson, { mode: 0o600 })
  return true
}
```

## Excerpt

The `if-true` branch (the `mkdirSync` call) is unreachable through the
public API: the only caller is `ensureWorkerCwd`, which itself creates
`ctx.configDir` at line 341 BEFORE invoking `seedWorkerCredentials` at
line 398. By the time the `existsSync` check runs, the directory is
already on disk, so the `!existsSync` arm is always false and the
`mkdirSync` line is dead code.

The dead `mkdirSync` is a defensive belt against a TOCTOU race where
another writer removes the config dir between the pre-pass and the
credential write. No test-side lever can deterministically reproduce
that race: even a `vi.spyOn(node:fs, 'mkdirSync')` is foiled by the
destructured `import { ... mkdirSync ... } from 'node:fs'` the source
captured at module load -- the same pattern that defeats
`vi.spyOn(node:fs, 'symlinkSync')` for the symlink-catch branch
(covered instead by `agent-worker-symlink-catch.test.ts`'s Proxy mock).

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through the public
API.

1. A caller invokes `ensureWorkerCwd(ctx)`.
2. The function executes `if (!existsSync(ctx.configDir)) mkdirSync(ctx.configDir, { recursive: true })` at line 341.
3. The post-pass then calls `seedWorkerCredentials(ctx)`.
4. Inside `seedWorkerCredentials`, `existsSync(ctx.configDir)` returns `true` (just created), so `!existsSync` is `false`, the `if-true` branch is skipped, and the `mkdirSync` on line 211 is never executed.

The only way to drive the `if-true` branch is to delete `ctx.configDir`
between line 341 and line 211. No test-side API can do that without
mocking `node:fs` at the module level, which the test suite cannot
reliably do because the production module imports the helpers
destructured (see `agent-worker-symlink-catch.md` for the same pattern).

## Pinning test

`src/__tests__/agent-worker-full.test.ts`, the
`'creates the config dir if missing before writing .credentials.json'`
test (inside the `describe('seedWorkerCredentials (via ensureWorkerCwd)')`
block). It exercises the happy path: the config dir is created by the
pre-pass, `seedWorkerCredentials` runs against the existing dir, and
`.credentials.json` is written. The unreachable `mkdirSync` is
documented in the test name's "creates the config dir" phrasing -- the
creation happens at line 341, not line 211.

## Suggested direction

Two independent paths, neither requires a source change to drive the
coverage:

(a) Drop the `mkdirSync` line and rely on the caller's invariant:

    ```ts
    function seedWorkerCredentials(ctx: WorkerCtx): boolean {
      if (process.platform === 'darwin') clearWorkerKeychainEntry(ctx)
      const credentialsJson = readClaudeCodeOauthJson()
      if (!credentialsJson) return false
      writeFileSync(join(ctx.configDir, '.credentials.json'), credentialsJson, { mode: 0o600 })
      return true
    }
    ```

    The `ensureWorkerCwd` already owns the dir-creation invariant;
    `seedWorkerCredentials` becomes a pure "write the credentials" call.

(b) Move `seedWorkerCredentials` to be a member of `WorkerCtx` so the
    test can construct a fresh `WorkerCtx` whose `configDir` is
    deleted between construction and the call, exercising the
    `mkdirSync` arm directly. Bigger refactor.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edit is
blocked until the user overrides; the pinning test documents the
current behaviour and the bug MD tracks the direction.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
