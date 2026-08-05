# Defect: ALLOWED_CHAT_ID cache never invalidated, breaking the "reset" branch

## File
`src/web/inbound-probe.ts` (lines 211-217)

## Symptom
The `readAllowedChatId` function caches the env value at module scope
and never resets it. The "reset chat-id-absent flag if the value is now
present" branch on line 246 is therefore unreachable in practice: the
SUT only reaches line 246 when `allowedChatId` is truthy, but for that
to change from `null` to a string, `_cachedAllowedChatId` would have to
be invalidated, which never happens.

## Reproduction
1. Start with `ALLOWED_CHAT_ID` absent in `.env`.
2. Operator restarts the dashboard with `ALLOWED_CHAT_ID` now set.
3. The SUT still emits the `inbound-prober: ALLOWED_CHAT_ID absent in .env`
   warn log on every interval tick until `startInboundProber` is re-invoked
   (which only happens at server restart).

## Why This Matters
The "reset" branch on line 246 was intended to allow the operator to
add `ALLOWED_CHAT_ID` to .env without restarting the server. The
implementation is dead code.

## Fix
Either:
1. Re-read `ALLOWED_CHAT_ID` on every tick (the SUT explicitly chose
   to cache this for performance, per the W4 comment on line 53), OR
2. Watch the `.env` mtime and invalidate the cache when it changes, OR
3. Remove the dead "reset" branch and document that the operator must
   restart the dashboard after editing `.env`.

## Workaround in the suite
The `web-inbound-probe.test.ts` suite avoids this branch by setting
`H.envMap` to the desired ALLOWED_CHAT_ID value BEFORE the first call
to `IP.startInboundProber()`, so the cache is initialized to the
test's intended value.
