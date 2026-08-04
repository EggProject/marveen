# stuck-tool-call-watcher.ts: `sinceRespawnMs` ternary has a dead `null` arm (unreachable branch)

## Location

`src/web/stuck-tool-call-watcher.ts`, line 192:

```ts
{ label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
```

## Excerpt

```ts
// src/web/stuck-tool-call-watcher.ts:136-142
export function shouldDeferForRecentRespawn(
  lastRespawnMs: number,
  nowMs: number,
  graceMs = MARVEEN_POST_RESPAWN_GRACE_MS,
): boolean {
  return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs   // 141
}

// src/web/stuck-tool-call-watcher.ts:189-195
const lastRespawn = lastMainRespawnAt()                          // 189
if (shouldDeferForRecentRespawn(lastRespawn, Date.now())) {      // 190
  logger.info(
    { label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: ... },  // 192
    'stuck-tool-call-watcher: recent respawn within grace, deferring recovery (avoid double-respawn / boot churn)',
  )
  return
}
```

## Failure scenario

The guarded block at line 191-194 is entered only when
`shouldDeferForRecentRespawn(lastRespawn, ...)` returned `true`. Its first
conjunct (line 141) is `lastRespawnMs > 0`, so entering the block already
proves `lastRespawn > 0`.

`lastRespawn` is typed `number` (`lastMainRespawnAt(): number`,
`src/web/channel-monitor.ts:818`). For a `number`, every falsy value
(`0`, `-0`, `NaN`) fails `> 0`:

| `lastRespawn` | `> 0` | block entered? | ternary arm |
| --- | --- | --- | --- |
| `0` | false | no | unreachable |
| `-0` | false | no | unreachable |
| `NaN` | false | no | unreachable |
| any negative | false | no | unreachable |
| any positive | true | yes | always the `Date.now() - lastRespawn` arm |

So inside the block `lastRespawn` is always truthy and the `: null` arm can
never evaluate. There is no input to `lastMainRespawnAt()` -- and no
combination of the three stamps it maxes over
(`marveenLastKeepaliveRespawn`, `marveenLastHardRestart`,
`fileRespawnStampMs()`) -- that reaches it.

## Observed impact

1. **No runtime impact.** The log field is always populated with the real
   age; the dead arm changes no behaviour.

2. **Coverage gate failure.** v8 branch coverage reports 96.77% (30/31
   branches) for `src/web/stuck-tool-call-watcher.ts` against the repo's
   100% threshold (`vitest.config.ts`). The single uncovered branch is the
   `null` arm of this ternary. Statements 100% (50/50), lines 100% (46/46),
   functions 100% (8/8). No test can exercise the arm without modifying the
   source, which task rule 1 forbids.

3. **Misleading defensiveness.** The `lastRespawn ?` check reads as if a
   zero stamp were possible here, which invites a future reader to weaken
   the `> 0` conjunct in `shouldDeferForRecentRespawn` on the assumption
   that this call site handles it.

## Pinning test

`src/__tests__/stuck-tool-call-watcher.test.ts` exercises every reachable
branch of the file:

* `confirmsWedgeProfile` -- null sample (fail-open), below/at/above the
  30% ceiling,
* `shouldDeferForRecentRespawn` -- zero stamp, inside grace, exactly at the
  grace boundary, past the grace, the omitted-`graceMs` default parameter,
  and the future-dated stamp (see
  `stuck-tool-call-watcher-skew-defer.md`),
* `checkSession` -- null pane, pane without a progress line, advancing
  counter, sub-`minPeakSeconds` counter, pre-threshold stagnation, full
  recovery, the one-shot `attempts` cap, and the failed-respawn error log,
* the idle-prompt guard (residual footer above a live `❯` prompt),
* the post-respawn grace guard (deferred and non-deferred),
* the CPU-profile guard -- recovery at the 30% ceiling, deferral above it,
  and all four fail-open null-sample paths (`tmux` throws, empty pane pid,
  non-numeric pane pid, `ps` throws, unparseable `ps` output),
* `startStuckToolCallWatcher` -- the 35s initial delay, the 30s interval,
  and the sweep-error `logger.debug` path.

38 tests, all passing. Lines 100%, statements 100%, functions 100%.
Branches 96.77% (30/31); only this `: null` arm remains.

## Suggested direction

Two acceptable resolutions (in order of preference):

1. **Drop the ternary.** Inside the block the stamp is provably positive, so
   `sinceRespawnMs: Date.now() - lastRespawn` is both correct and simpler.
   This removes the branch and the misleading defensiveness in one edit.

2. **Add `/* v8 ignore next */`** above the line with a one-line comment
   naming the `lastRespawnMs > 0` precondition that makes the arm dead.
   Silences the gate without changing runtime behaviour.

Until a resolution is chosen, the branch-coverage gate will fail on this
file; treat this MD as the authoritative pin and exclude
`stuck-tool-call-watcher.ts` from the branch threshold
(statements/lines/functions still gate, and remain at 100%).

Per task rule "NEVER modify src/web/stuck-tool-call-watcher.ts" neither fix
has been applied; the test suite is the highest achievable without source
changes.
