# index.ts:283 -- buildPidfileLockContext.log.error is pinned by TS strict + a test

## Location

`src/index.ts:279-283` -- the `log: { info, warn, error }` block inside `buildPidfileLockContext`:

```ts
log: {
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => logger.warn(obj, msg),
  error: (obj, msg) => logger.error(obj, msg),     // <-- line 283
},
```

## Excerpt

The production caller (`acquirePidfileLock` in `src/process-lock.ts:289-352`) only
calls `ctx.log.info` (lines 301, 346) and `ctx.log.warn` (lines 328, 336, 350, 352).
`ctx.log.error` is never invoked through the real lock path.

So the entry looks structurally dead, the same way the MD
`docs/needs-to-be-fix/index-unreachable-coverage.md` describes the line 283 site.
Removing the `error:` arrow appears to be a clean dead-code drop. It is not.

## Why the safe-delete fails on this site

Two independent pinning paths block the removal:

### 1. The `PidfileLockContext` type REQUIRES the `error` property

`src/process-lock.ts:253` declares:

```ts
log: { info: LogFn; warn: LogFn; error: LogFn }
```

`error` is a required property, not optional. With the project's strict TS settings
(`noImplicitAny`, `strictNullChecks`, `exactOptionalPropertyTypes`), omitting it
produces:

```
src/index.ts(279,5): error TS2741: Property 'error' is missing in type
  '{ info: ...; warn: ...; }' but required in type
  '{ info: LogFn; warn: LogFn; error: LogFn }'.
```

So the line 283 entry is **not** an unreachable defensive arm -- it is the
fulfilment of a type-system contract. Production `acquirePidfileLock` may never
call it, but the type declares that any future caller CAN, and that capability
is part of the interface. This is structurally identical to the
`agent-terminal-218-ts-strict-blocks-delete` and
`channel-invites-108-ts-strict-blocks-delete` rows in the orphan addenda.

### 2. The test suite exercises the wiring contract

`src/__tests__/index.test.ts:1382-1394` deliberately synthesizes a
`ctx.log.error(...)` call inside a mocked `acquirePidfileLock` and asserts that
`logger.error` is forwarded with the same arguments:

```ts
it('forwards pidfile context errors to logger.error', async () => {
  mockAcquirePidfileLock.mockImplementation(async (_path, _selfPid, ctx) => {
    ...
    log.error({ source: 'test' }, 'synthetic pidfile error')
  })
  await loadIndexFresh()
  expect(mockLogger.error).toHaveBeenCalledWith(
    { source: 'test' },
    'synthetic pidfile error',
  )
})
```

Without the line 283 entry this assertion fails
(`Number of calls: 0`). The test is not pinning a dead arm -- it is pinning the
forwarding *contract* that the type also pins. Both pinning paths agree.

## What was attempted in the closure pass (2026-08-19)

The closure-pass subagent for `index-unreachable-coverage` line 283 was instructed
to:

> "Remove the dead `error: (obj, msg) => logger.error(obj, msg)` line from the
>  `log: { info, warn, error }` block inside buildPidfileLockContext in src/index.ts
>  (around line 283)."

The subagent verified production deadness correctly
(`grep -n "ctx.log" src/process-lock.ts` showed no `ctx.log.error` call from
`acquirePidfileLock`) and then ran the full test suite. The test pin at
`index.test.ts:1382` failed (1 fail / 123 pass), and a follow-up `bun run typecheck`
showed `+1` error (TS2741). The subagent reverted the change with
`git checkout -- src/index.ts docs/needs-to-be-fix/INDEX.md` and reported the
situation back instead of forcing a broken commit.

## Forward path

Three acceptable resolutions, in order of preference (do NOT guess -- confirm
with the maintainer):

1. **Tighten the `PidfileLockContext.log` type to make `error` optional**
   (`error?: LogFn`) and drop the line 283 entry plus its test pin. The
   contract becomes "info and warn are mandatory, error is best-effort". This
   matches the production reality (acquirePidfileLock never calls error) and
   removes the synthetic test. This is a **type-shape change** with consumer
   audit (every code path that touches `ctx.log.error` on a PidfileLockContext
   must be reviewed). 1 source + 1 type + 1 test removal.

2. **Keep the wiring but document the asymmetry.** The line 283 entry stays,
   the test stays, but a code comment in `buildPidfileLockContext` explains that
   the error arm is forwarder-only (no production caller) and the test
   exercises the forwarding contract. No code change; doc-only.

3. **Delete the test pin only.** If the maintainer considers the forwarding
   contract to be vestigial (no real consumer ever calls `ctx.log.error` on a
   PidfileLockContext, so the forwarding is dead infrastructure), drop the test
   at `index.test.ts:1382-1394` and the `error:` arrow together. This is the
   least-defensible option because it weakens an explicit API contract.

Until a maintainer picks one, the entry stays, the test stays, and this MD
documents why the obvious "drop the dead arm" move does not work.

## Pinning test

`src/__tests__/index.test.ts:1382-1394` -- `forwards pidfile context errors to logger.error`.

The test is a positive contract assertion, not a dead-arm pinning. Deleting the
line 283 source entry without also deleting the test breaks the build.

## Suggested direction

Pick option 1 (tighten the type + drop the test) only after auditing every
PidfileLockContext consumer for `ctx.log.error` use. The current repo
(`grep -rn "PidfileLockContext" src/`) shows only the test synthesizes the call;
no production code path does. If that audit confirms it, the type narrowing is
safe.

## See also

- `docs/needs-to-be-fix/index-unreachable-coverage.md` -- the original MD that
  described line 283 as dead code. The MD missed the test pin and the type
  requirement; this addendum corrects it.
- `docs/needs-to-be-fix/agent-terminal-218-ts-strict-blocks-delete.md` and
  `channel-invites-108-ts-strict-blocks-delete.md` -- sibling cases where
  TS strict blocks the same shape of safe-delete.

## Update 2026-08-24 -- forwarder now exercised in production

The contract chosen in commit 87cd76f (option 2: keep the wiring, document the
asymmetry) left the forwarder live but unused. A targeted audit of
`acquirePidfileLock` (process-lock.ts:289-363) found exactly one site where
`ctx.log.error` should have been called but was absent: the final `throw` at
process-lock.ts:363 after the retry loop is exhausted. That throw happened with
zero observability -- operators saw only the uncaught exception.

Fix: add `ctx.log.error({ path, maxAttempts, selfPid }, 'Failed to acquire
pidfile lock after maxAttempts')` at process-lock.ts:362, immediately before
the existing `throw` at process-lock.ts:363. This makes the existing forwarder
at index.ts:285 actively used, exercises the `error: LogFn` type contract, and
gives operators a structured log entry before the exception bubbles. No type
change needed; the existing forwarder and the existing synthetic pinning test
(index.test.ts:1382-1394) both stay.

Test: the existing "gives up after maxAttempts" case at
`src/__tests__/process-lock.test.ts:570` (the `it(...)` block opener) is the
regression sentinel. The new assertion sits at lines 593-597 inside that
block: it asserts the throw AND the error log was emitted with the expected
level, message, and structured fields.
