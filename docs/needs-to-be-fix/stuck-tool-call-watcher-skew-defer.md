# stuck-tool-call-watcher.ts: a future-dated respawn stamp suppresses recovery indefinitely (clock skew)

## Location

`src/web/stuck-tool-call-watcher.ts`, line 141:

```ts
return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs
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

// src/web/channel-monitor.ts:818-820 -- one of the three stamps is read
// from a file written by an OUT-OF-PROCESS watchdog:
export function lastMainRespawnAt(): number {
  return Math.max(marveenLastKeepaliveRespawn, marveenLastHardRestart, fileRespawnStampMs())
}

// src/web/channel-monitor.ts:829-836
const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')
function fileRespawnStampMs(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0   // no upper bound: a future stamp passes
  } catch {
    return 0
  }
}
```

## Failure scenario

The guard measures the age of the last respawn as a raw subtraction with no
lower bound. When `lastRespawnMs > nowMs` the age is **negative**, and a
negative number is trivially `< graceMs`, so the guard returns `true` for
the entire duration of the skew -- not for the intended 6-minute window.

Concretely, with `graceMs = 360_000`:

| `lastRespawnMs` | `nowMs` | age (ms) | `< graceMs`? | defers? | intended? |
| --- | --- | --- | --- | --- | --- |
| `now - 1_000` | `now` | `1_000` | yes | yes | yes |
| `now - 360_000` | `now` | `360_000` | no | no | yes |
| `now + 60_000` | `now` | `-60_000` | yes | yes | **no** |
| `now + 86_400_000` | `now` | `-86_400_000` | yes | yes | **no** (defers for 24h) |

Two realistic ways `lastMainRespawnAt()` returns a future stamp:

1. **The system clock steps backwards.** `marveenLastKeepaliveRespawn` /
   `marveenLastHardRestart` are in-process `Date.now()` captures. An NTP
   correction, a VM resume from a snapshot, or a manual clock fix taken
   *after* a respawn leaves those stamps ahead of the new `Date.now()`.

2. **The out-of-process watchdog's clock is ahead.** `fileRespawnStampMs()`
   reads `store/.channel-last-respawn`, written in epoch SECONDS by
   `scripts/channel-watchdog.sh` (a systemd timer). The reader validates
   only `Number.isFinite(s) && s > 0` -- there is no upper bound -- so a
   stamp written by a host whose clock runs ahead, or a hand-edited /
   corrupted file, is accepted verbatim and multiplied by 1000.

Because `lastMainRespawnAt()` takes the `Math.max` of the three stamps, a
single future-dated source wins and pins the guard on.

## Observed impact

The stuck-tool-call watchdog is the recovery path for the 2026-06-02
user-facing freeze (Marveen's TUI wedged at "Worked for 31s"; the user sees
"Marveen válaszol, de a válasz nem jön meg Telegramra"). While the guard is
pinned on:

1. **Recovery never fires.** Every sweep that reaches the grace check
   returns at line 195 before the CPU-profile guard and before
   `resumeMarveenSession()`. The session stays wedged until the clock skew
   resolves -- potentially indefinitely if the stamp file is the source and
   nothing rewrites it.

2. **The deferral is silent-ish.** `logger.info` fires each sweep with a
   **negative** `sinceRespawnMs`, which is the only signal that anything is
   wrong. Nothing escalates and nothing alerts.

3. **Inconsistent with the sibling logic.** `decideStuckToolCallRecovery`
   (`src/pane-state.ts:1616-1632`) explicitly handles the same hazard --
   "Backwards clock skew: restart the spell rather than stall" -- and
   restarts the spell rather than deadlocking. The guard in this file has no
   equivalent protection, so the module is internally asymmetric about a
   failure mode it already knows about.

4. **Not limited to this watcher.** `lastMainRespawnAt()` is the shared
   cross-path grace accessor; `channel-monitor.ts:1274` applies the same
   bare subtraction, so the same skew suppresses the keepalive cascade too.
   Fixing it here alone is insufficient.

## Pinning test

`src/__tests__/stuck-tool-call-watcher.test.ts`, test
`"defers indefinitely on a future-dated respawn stamp (clock skew)"`:

```ts
expect(watcher.shouldDeferForRecentRespawn(2_000_000, 1_000_000)).toBe(true)
expect(watcher.shouldDeferForRecentRespawn(Number.MAX_SAFE_INTEGER, 1_000_000)).toBe(true)
```

The test pins CURRENT behaviour, not desired behaviour, and carries a
comment pointing at this MD. The surrounding tests pin the correct-clock
cases (zero stamp, inside grace, exactly at the boundary, past the boundary,
and the omitted-`graceMs` default), so a fix that clamps the negative age
will fail only this one assertion.

## Suggested direction

Clamp the age at zero-or-treat-future-as-stale in
`shouldDeferForRecentRespawn`:

```ts
const age = nowMs - lastRespawnMs
return lastRespawnMs > 0 && age >= 0 && age < graceMs
```

`age >= 0` makes a future stamp fall through to recovery (fail-open, which
matches the module's stated posture everywhere else: "Fail-open: a null
sample does NOT block recovery", "a null pane does NOT block recovery").

Two follow-ups worth doing in the same change:

1. Apply the same clamp at `src/web/channel-monitor.ts:1274`, which shares
   the stamp and the bare subtraction.
2. Bound `fileRespawnStampMs()` so an out-of-process stamp more than a
   grace window in the future is rejected as garbage
   (`s * 1000 <= Date.now() + SOME_SLACK`), rather than trusted.

Per task rule "NEVER modify src/web/stuck-tool-call-watcher.ts" no fix has
been applied.
