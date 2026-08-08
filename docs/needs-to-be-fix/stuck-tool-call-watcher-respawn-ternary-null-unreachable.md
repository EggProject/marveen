# stuck-tool-call-watcher: sinceRespawnMs ternary `:null` arm is unreachable

## Where
`src/web/stuck-tool-call-watcher.ts:192`

```ts
logger.info(
  { label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
  'stuck-tool-call-watcher: recent respawn within grace, deferring recovery (avoid double-respawn / boot churn)',
)
```

## What
The enclosing guard on line 190:

```ts
if (shouldDeferForRecentRespawn(lastRespawn, Date.now())) {
```

requires `lastRespawnMs > 0` (see line 141:
`return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs`). The only
value `lastMainRespawnAt()` returns that is falsy in JS is `0` (the
"never-respawned" sentinel), and a `0` return trips the guard and skips the
log entirely. Therefore inside the log call `lastRespawn` is guaranteed to be
truthy, so the `null` arm of the ternary never fires.

## Coverage impact
`branches = 96.77% (30/31)`. The v8 tool flags the ternary's `:null` arm as
uncovered.

## How to fix
Replace the ternary with the always-truthy form:

```ts
sinceRespawnMs: Date.now() - lastRespawn,
```

If the operator-facing log really needs to distinguish "no stamp" from
"stamp present", `lastRespawn` would need a richer shape than `number` --
out of scope for a bugfix; today the log is internal.

Pinning test:
`src/__tests__/stuck-tool-call-watcher.test.ts` --
"documents that the :null arm of the sinceRespawnMs ternary is unreachable
in production"
