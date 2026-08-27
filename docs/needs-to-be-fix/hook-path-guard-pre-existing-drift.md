# hook-path-guard.test.ts: 7 pre-existing drift (mock works, tests diverge)

## Location

`src/__tests__/hook-path-guard.test.ts`, lines 56, 61 (a-block), 130, 175 (c-block), 243, 280, 317 (e-block).

## Failure scenario

These seven tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). The `2a28a54` commit (which added `vi.importActual<typeof import('node:child_process')>('node:child_process')` at line 33-35) was claimed to fix 6 of these, but empirical re-measurement on `4ed3519` shows all 7 still fail. The BETA verifier on the 2026-08-27 cycle found that NONE of the 7 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`, meaning the vi.importActual mock IS effective and the failures are not blanket-driven.

## Three distinct root causes

### Block (a) at lines 56:62, 61:38 — `isUnsafeHookCommand` path resolution

The tests use `existsSync(STALENESS_HOOK)` where `STALENESS_HOOK` is resolved via `fileURLToPath(import.meta.url)` (test file line 13-14). Under vitest's module loader, the resolved path differs from the test author's expectation at write-time, so `existsSync` returns false and the assertion fails.

### Block (c) at lines 130:76, 175:49 — `boot-hook-prune.py` python3 invocation

The tests use `execFileSync('python3', [STALENESS_HOOK])` to run real `scripts/boot-hook-prune.py`. Real `python3` is required on the test host's PATH, AND the script's output must match the assertion. Either `python3` is missing or the fixture script's output diverged from the test expectation.

### Block (e) at lines 243:21, 280:21, 317:73 — `upgradeLegacyHookCommands` mutations

These are pure in-memory `upgradeLegacyHookCommands` calls + `isUnsafeHookCommand` checks. No subprocess. The implementation's behaviour diverged from the test expectations.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/hook-path-guard.test.ts
 Test Files  1 failed (1)
      Tests  7 failed | 11 passed (18)
```

7 fails pre-existed on `a330462` (pre-forbid).

```
$ git -C /tmp/claw-test-baseline bun --bun vitest run src/__tests__/hook-path-guard.test.ts
 Test Files  1 failed (1)
      Tests  7 failed | 11 passed (18)
```

7 fails STILL present at HEAD after the 16 per-file opt-in commits (the mock is in place but does not affect these failures).

## Pinning test

`src/__tests__/hook-path-guard.test.ts`, describe blocks `isUnsafeHookCommand (registration guard)` (a), `boot-hook-prune.py` (c), `upgradeLegacyHookCommands (automatic migration)` (e).

## Suggested direction

Block (a): fix `STALENESS_HOOK` path resolution to be vitest-loader-agnostic (e.g., use `path.resolve(__dirname, ...)` instead of `fileURLToPath(import.meta.url)`).
Block (c): verify `python3` is available on the test host's PATH, AND verify the boot-hook-prune.py output matches the assertion (run it manually and compare).
Block (e): read `src/web/agent-scaffold.ts:upgradeLegacyHookCommands` and the test expectations; update one to match the other.

## Resolution

Open. Deferred to the next cycle (cycle 54+).

## Scope

Pre-existing on `a330462` baseline. The vi.importActual mock IS effective; the failures are not blanket-driven. Filing this as a separate needs-fix item because the three blocks have three different root causes that each need their own investigation.
