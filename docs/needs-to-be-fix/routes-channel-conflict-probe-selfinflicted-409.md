# channel-conflict-probe.ts: the diagnostic probe issues a competing `getUpdates` and can *cause* the 409 it exists to observe

## Location

`src/web/channel-conflict-probe.ts`, lines 45 and 51:

```ts
const url = `https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`
...
const res = await fetch(url, { signal: controller.signal })
```

## Excerpt

```ts
// src/web/channel-conflict-probe.ts:39-51
export async function probeTelegramConflict(token: string): Promise<TelegramConflictResult> {
  if (!token) return { conflicted: false, status: 0, description: null }

  // offset=-1 + timeout=0 = fetch the most recent update without long-poll.
  // This is the cheapest call that still triggers the 409 if another poller
  // holds the slot.
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`   // 45

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })                        // 51
```

```ts
// src/web/channel-monitor.ts:1276-1291 -- the only caller. Fires on the FIRST
// transition into the down state, i.e. stage 1 "soft", before any recovery.
if (!marveenDownState) {
  marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
  logger.warn({ provider: providerLabel }, 'Marveen channel plugin down -- stage 1 (soft /mcp reconnect, silent)')
  if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {
    marveenDownState.conflictProbed = true
    const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
    const tok = readChannelToken(providerLabel, tokenPath)
    if (tok) {
      probeTelegramConflict(tok)                                                       // 1290
```

## Failure scenario

Telegram's Bot API permits exactly one in-flight `getUpdates` per bot token.
A second call does not queue and does not fail itself: it **terminates the
first**, and the *first* caller receives

```
409 Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```

The probe is itself a `getUpdates` call on the production bot token. So when
the probe runs against a token whose legitimate poller is alive, the probe is
not a passive observer — it is the second poller, and it evicts the healthy
one.

That matters because of *when* the probe fires. `handleMarveenDown()` calls it
on the first transition into the down state, and the down state is derived
from tmux pane scanning. This module's own header comment states the premise:

```
// the existing health monitor flags the plugin as "down" based on pane
// scanning - it does not record what the upstream provider actually returned.
```

A pane scan is a heuristic over rendered terminal text. On a false-positive
(pane capture returns partial/garbled output, the TUI redraws mid-capture, the
plugin is alive but its status line scrolled out), the sequence is:

| step | state of the real poller | what happens |
| --- | --- | --- |
| 1 | healthy, long-poll in flight | pane scan mis-reads the pane as down |
| 2 | healthy | `handleMarveenDown()` runs, `conflictProbed = true` |
| 3 | healthy | probe issues `getUpdates` on the same token |
| 4 | **terminated by Telegram** | probe returns `409`, `conflicted: true` |
| 5 | down, for real | monitor logs "orphan poller is contending", escalates to reap + respawn |

The probe reports `conflicted: true` and the caller logs

```
Telegram getUpdates 409 Conflict confirmed -- orphan poller is contending
for the bot token. Recovery will reap and respawn.
```

which is the exact opposite of what happened: there was no orphan poller. The
probe manufactured the contention, then attributed it to a bug that was not
occurring, and the monitor escalates to a reap-and-respawn cycle that was not
needed. The diagnostic is self-confirming — it cannot return `conflicted:
false` for a live-and-healthy poller, because observing it destroys it.

`offset=-1&timeout=0` reduces the *duration* of the probe's occupancy but not
its exclusivity: the eviction is triggered by the arrival of the second
request, not by how long it is held open.

Note this is not the orphan-poller bug the module was written for. In the real
orphan case (PR #225) two pollers already contend and the probe's verdict is
correct. The defect is that the false-positive case is indistinguishable from
the true-positive case *by construction*, and the false-positive case is made
worse by the act of probing.

## Observed impact

1. **False evidence in `dashboard.log`.** The module exists to give the
   operator "hard evidence of the real cause instead of leaving the operator to
   infer it from a pane scan" (header comment). On a pane-scan false-positive
   it produces hard evidence of a cause that did not exist, which is worse than
   the inference it replaced — the operator now has a log line that reads as
   confirmed fact.

2. **Escalation of a non-incident into a real outage.** Step 4 above leaves the
   legitimate poller genuinely terminated. Inbound Telegram messages stop until
   the respawn completes. The monitor then observes a real down state on the
   next sweep, which corroborates the false reading.

3. **One-shot, so it is not self-correcting.** `conflictProbed` is latched to
   `true` for the whole down-cycle, so there is no second probe that could
   report a differing result and expose the first as an artifact.

4. **Blast radius is the production bot token.** `readChannelToken` reads the
   live token from `channelStateDir(...)/.env`; there is no separate diagnostic
   token or test bot, so the probe cannot be run against anything but the
   channel it is trying to diagnose.

## Pinning test

**None.** In isolation the function's behaviour is correct and fully pinned by
`src/__tests__/channel-conflict-probe.test.ts` and
`src/__tests__/channel-conflict-probe-cov.test.ts` (all six response shapes,
the empty-token guard, and the 4s abort path). The defect is in the
interaction between the probe and the live poller that shares the token, which
a unit test of this module cannot observe — the tests mock `fetch`, so no real
`getUpdates` slot is contended. Reproducing it requires an integration test
against a real bot token with a second live poller.

This is recorded rather than pinned deliberately: a pinning test here would
assert only that the probe sends a request, which is already covered and is
not the defect.

## Suggested direction

The probe cannot be made non-destructive while it uses `getUpdates`. Three
options, cheapest first:

1. **Use `getWebhookInfo` instead.** It is a read-only method, does not take
   the long-poll slot, and its response includes `last_error_message`, which
   carries the upstream error text for the bot. This loses the direct 409
   status but gains a probe that is safe to run against a healthy poller.

2. **Gate the probe on independent evidence that the poller is actually
   dead** — e.g. require `probeChannelPluginLiveness` / `getClaudePidForSession`
   (already imported in `channel-monitor.ts`) to confirm the process is gone
   before probing. This keeps `getUpdates` but restricts it to states where
   there is no live poller left to evict.

3. **Downgrade the log wording** so a `conflicted: true` result is reported as
   consistent-with rather than confirmation-of orphan contention, and note in
   the line that the probe itself contends for the slot. This does not fix the
   escalation, only the false certainty in the log.

Options 1 and 2 are complementary; 3 is a mitigation to apply regardless.

Per task rule "NEVER modify src/web/channel-conflict-probe.ts" no fix has been
applied.

## Sources

- https://kuoo.uk/en/blog/openclaw-telegram-409-conflict-getupdates-fix-2026/ —
  "Telegram long polling supports only one active [getUpdates]"
- https://www.answeroverflow.com/m/1471626337709195294 — "409 getUpdates
  conflict means: some other process/machine is also running Telegram
  long-polling for the same bot token"
- https://github.com/yagop/node-telegram-bot-api/issues/550 — "There are two or
  more bots that listen updates at same bot token"
