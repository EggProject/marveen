# memory.ts: runDailyDigest saves an empty digest when runAgent returns whitespace-only text

## Location

`src/memory.ts`, lines 200-206 (`runDailyDigest`):

```ts
if (!text) return null

const digest = text.trim()
const today = new Date().toLocaleDateString('hu-HU')
saveMemory(chatId, `[Napi naplo ${today}] ${digest}`, 'episodic')
logger.info({ chatId, digestCwd, digestConfigDir }, `Napi naplo mentve: ${today}`)
return digest
```

## Excerpt

The early-return only checks `!text` (which is true for `null` or `''`). A
non-empty but whitespace-only payload (e.g. `"   \n\t  "`) slips past the
guard, gets `trim()`'d to `''`, and is then persisted to the `memories`
table as `[Napi naplo 2026. 08. 04.] ` -- an effectively empty daily
digest that pollutes the episodic store.

## Failure scenario

1. `runAgent` returns `{ text: '   ' }` (model produced only whitespace).
   This can happen on a worker that's partially rate-limited, on a model
   that emits a single thinking-style preamble without a real digest,
   or when an upstream prompt-injection succeeds at making the digest
   empty.
2. `runDailyDigest` returns `''` to its caller AND writes a `[Napi naplo ...] `
   row into `memories`.
3. The next `runDailyDigest` call sees the empty row as "memory from today"
   (it has `created_at >= oneDayAgo`), the sub-agent is asked to summarise
   an empty/blank payload, and the loop continues to compound.

A symmetric issue affects the return value: callers using `runDailyDigest`
get back an empty string instead of `null`, so a `if (digest === null)` check
becomes a false-negative.

## Pinning test

`src/__tests__/memory.test.ts` covers the null path (`runAgentResult = { text: null }`)
but does NOT cover the whitespace-only path because the existing public
contract is "null OR non-empty string". The whitespace branch is reachable
today; the fix should make `runDailyDigest` treat trimmed-empty the same as
`null`.

Pinning test should:
- mock `runAgent` to return `{ text: '   \n\t  ' }`
- assert `runDailyDigest` returns `null`
- assert `saveMemory` is NOT called

## Suggested direction

Replace the early-return with a post-trim guard:

```ts
const { text } = await runAgent(...)
const digest = text?.trim() ?? ''
if (!digest) return null
const today = new Date().toLocaleDateString('hu-HU')
saveMemory(chatId, `[Napi naplo ${today}] ${digest}`, 'episodic')
logger.info(...)
return digest
```

This makes the contract explicit: `null` (or `''`-after-trim) means "no
digest produced", and the caller can treat both as `null`. The function
already logs the run either way, so the only behavioural change is the
empty-digest suppression and the return-type guarantee.

## Resolution

Replaced the `!text` early-return with a post-trim guard at
`src/memory.ts:200-202`. The new pair:

```ts
const digest = (text ?? '').trim()
if (!digest) return null
```

collapses the `null`, `''`, and `'   \n\t  '` failure modes into a single
no-op return. `null` and `''` reach the guard as a `''` digest after the
`?? ''` coalesce; whitespace-only payloads reach it after `.trim()`. In
all three cases `runDailyDigest` now returns `null`, emits no
`saveMemory` row, and does not invoke the `Napi naplo mentve` info log
— matching the contract callers already assumed (`if (digest === null)`).

No collateral changes:
- `src/memory.ts` branch coverage unchanged for the happy path; the new
  branch is the missing whitespace-only path that the test now covers.
- The pre-trim `if (!text) return null` line is removed because the
  combined guard subsumes it. The `text ?? ''` keeps the change safe for
  `null` even though `runAgent`'s declared contract (`{ text: string | null }`)
  already shows up only as `null` on the agent side.
- `src/__tests__/memory.test.ts` gets a new case (`'returns null when the
  sub-agent yields whitespace-only text'`) that pins the new contract.
  The pre-existing `'returns null when the sub-agent yields no text'` case
  continues to cover the `null` body, so both branches of the combined
  guard have regression coverage.
