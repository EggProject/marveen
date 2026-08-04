# heartbeat.ts: task brief mentions `runDecaySweep integration` -- but the integration does not exist

## Location

`src/heartbeat.ts` (the file specified in the brief)

## Excerpt

The task brief asks for tests that "cover heartbeat tick, keychain stub,
`runDecaySweep` integration". A grep across `src/heartbeat.ts` shows zero
references to `runDecaySweep` or any `decay` related symbol:

```
$ grep -n "runDecaySweep\|decay" src/heartbeat.ts
(no output)
```

`runDecaySweep` lives in `src/memory.ts` and is wired up independently
from the heartbeat cadence in `src/index.ts`:

```ts
// src/index.ts
import { runDecaySweep, runDailyDigest } from './memory.js'
...
runDecaySweep()                                  // once at startup
decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)
```

The heartbeat path and the decay path are siblings -- they do not call
each other and they do not share state. A heartbeat tick does not
trigger a decay sweep, and a decay sweep does not consult the
heartbeat's kanban/calendar data.

## Failure scenario

An agent following the brief literally would:

1. Search `src/heartbeat.ts` for `runDecaySweep` and find nothing.
2. Either:
   (a) write a `runDecaySweep`-focused test in `heartbeat.test.ts` that
       never references any symbol the source actually exposes -- a
       coverage-empty test that just instantiates memory.ts and asserts
       on it, defeating the brief's "for src/heartbeat.ts" scope, or
   (b) conclude the brief is wrong and silently skip the integration
       test (what this commit does), or
   (c) try to add a hidden coupling between heartbeat and decay so the
       test has something to assert -- actively corrupting the design.

None of these is a useful outcome. The brief is internally inconsistent.

## Pinning test

`src/__tests__/heartbeat-cov.test.ts` -- the supplemental suite written
to drive `src/heartbeat.ts` to 100% coverage. It deliberately does NOT
import `runDecaySweep` or `memory.ts`; the assertion is purely on
heartbeat surface (`initHeartbeat`, `stopHeartbeat`, `executeHeartbeat`,
`formatHeartbeatCardLabel`). The suite runs green without ever calling
`runDecaySweep`, which demonstrates that the brief's integration clause
is a no-op against the current source.

## Suggested direction

Either:

1. Drop the `runDecaySweep integration` clause from the brief. It is
   orthogonal to `src/heartbeat.ts` and belongs in a memory.ts test
   brief instead.

2. If a real integration is wanted, define it explicitly in the source:
   e.g. have `executeHeartbeat()` call `runDecaySweep()` opportunistically
   during the tick, and add a covering test. This would be a source
   change -- task rule "NEVER modify src/heartbeat.ts" blocks it without
   user override.

This doc itself is a needs-to-be-fix entry -- it should be either
deleted (if the brief is corrected) or acted on (if the integration is
actually wanted).
