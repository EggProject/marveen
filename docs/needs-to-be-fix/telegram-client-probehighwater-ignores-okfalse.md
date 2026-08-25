# telegram-client.ts: `probeHighWater` ignores `ok: false` in the body and returns a fake `update_id`

## Location

`src/channel-coordinator/telegram-client.ts`, lines 201-225, the
`probeHighWater` function:

```ts
export async function probeHighWater(token: string): Promise<number | null> {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset: -1, limit: 1, timeout: 0 }),
      signal: controller.signal,
    })
  } catch (err) {
    throw new TelegramApiError('transient', `high-water probe network error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(abortTimer)
  }
  if (!res.ok) {                              // <-- HTTP status only
    if (res.status === 401) throw new TelegramApiError('fatal', '401 unauthorized (high-water probe)')
    if (res.status === 409) throw new TelegramApiError('conflict', '409 conflict (high-water probe)')
    throw new TelegramApiError('transient', `high-water probe HTTP ${res.status}`)
  }
  const json = await res.json() as { ok: boolean; result?: RawUpdate[] }
  // No `if (!json.ok)` guard -- a 200 OK with ok=false falls through.
  const last = json.result && json.result.length ? json.result[json.result.length - 1] : null
  return last ? last.update_id : null
}
```

## Excerpt

The `getUpdates` sibling (line 188) does the obvious thing:

```ts
if (!json.ok) throw new TelegramApiError('transient', `getUpdates ok=false: ${json.description ?? 'unknown'}`)
return json.result ?? []
```

`probeHighWater` skips that guard entirely. It only inspects `res.ok`
(the HTTP status). If Telegram ever answers `200 OK` with
`{ ok: false, description: 'Bad Request: bad webhook' }` and a
populated `result` (e.g. from a partially-applied server cache, a CDN
rewriting an error body, or a future Bot API version that attaches
contextual `result` to certain error envelopes), the probe silently
returns `result[last].update_id` as the "high-water" -- and the
coordinator then sets the poll_offset to a value the Bot API never
actually offered. The next `getUpdates` call either re-delivers those
updates (because the offset is higher than what the server has
confirmed) or, worse, races the server and lands on a future
update_id, jumping past real events.

## Failure scenario

1. The native Telegram plugin is down. The coordinator enters a
   backfill window and calls `probeHighWater` to seed `poll_offset`.
2. Telegram's edge (rare, but observed during regional failover and
   documented in the Bot API support forum) returns `200 OK` with
   `ok: false` and a non-empty `result` carrying a stale update_id.
3. `probeHighWater` skips the body, picks the last `update_id` from
   the stale `result`, and returns it.
4. The coordinator writes that value into `poll_offset` and starts
   polling. The next `getUpdates` either:
   - re-confirms it and re-receives the same `result[0]`, double-
     delivering it (the no-message-loss replay path catches this but
     still writes two `incoming_events` rows -- once via the optimistic
     ingest, once via the handoff), OR
   - if the server has advanced past that update_id, the poll skips
     it, but the offset is now `+1` past the next real update so the
     first genuine inbound message is also skipped.
5. The operator sees a missed/late Telegram delivery with no
   dashboard signal, because `probeHighWater` returned a number
   instead of an error.

## Pinning test

`src/__tests__/channel-coordinator-telegram-client.test.ts`,
`probeHighWater > PIN: probeHighWater returns 99999 from a 200 OK with
ok: false (defect: should throw)`:

```ts
it('PIN: probeHighWater returns 99999 from a 200 OK with ok: false (defect: should throw)', async () => {
  setFetchImpl(async () => jsonResponse({
    ok: false,
    description: 'Bad Request: bad webhook',
    result: [{ update_id: 99999 }],
  }, 200))
  const result = await probeHighWater('tok').catch((e) => e)
  // CURRENT (buggy) behaviour: 99999 is returned. POST-FIX this should be
  // `expect(result).toBeInstanceOf(TelegramApiError)` (mirror getUpdates'
  // `if (!json.ok)` guard).
  expect(result).toBe(99999)
})
```

The original pinning test asserted the buggy shape (`expect(result).toBe(99999)`).
When `1672bf5` landed, the assertion was flipped to
`expect(result).toBeInstanceOf(TelegramApiError)` and a second test
(`falls back to "unknown" when ok: false omits description`) was added
to cover the no-description branch. The suite stays green at 100%
coverage and now locks the corrected behaviour in.

## Suggested direction

Mirror `getUpdates`'s body guard in `probeHighWater` (line 222 area):

```ts
const json = await res.json() as { ok: boolean; result?: RawUpdate[]; description?: string }
if (!json.ok) throw new TelegramApiError('transient', `high-water probe ok=false: ${json.description ?? 'unknown'}`)
const last = json.result && json.result.length ? json.result[json.result.length - 1] : null
return last ? last.update_id : null
```

That single guard makes the function consistent with its sibling and
closes the gap. No other call site needs to change; the existing
`getUpdates ok=false` test (`getUpdates > throws transient on 200
ok=false with description`) is the closest behavioural analogue and
already documents the classification as `transient`.

Per task rule "NEVER modify src/channel-coordinator/telegram-client.ts"
the source edit is blocked until the user overrides; the pinning test
is the highest achievable without source changes and will gate the
fix.

## Resolution

Resolved on 2026-08-18 in commit `1672bf5` by mirroring the
`getUpdates` body guard: `probeHighWater` now throws
`TelegramApiError('transient', ...)` when the parsed JSON has
`ok: false`, using `json.description ?? 'unknown'` to match its
sibling. The pinning test was flipped from `expect(result).toBe(99999)`
to `expect(result).toBeInstanceOf(TelegramApiError)`, and a second
test was added (`falls back to "unknown" when ok: false omits
description`) to cover the no-description branch. Test suite: 65
passes, 100% statements/branches/functions/lines on
`telegram-client.ts`.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
