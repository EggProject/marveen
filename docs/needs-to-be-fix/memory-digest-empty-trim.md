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

Per task rule "NEVER modify src/memory.ts" this requires an explicit
override from the user; the test suite documents the gap and the pinning
case above should be added when the fix is applied.
