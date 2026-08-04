# prompt-safety origin-note tab-strip

## Location

`src/prompt-safety.ts:96-103` — `sanitizeOriginNote(raw)`

## Excerpt

```ts
export function sanitizeOriginNote(raw: string | null | undefined): string | null {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9 _.\-/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : null
}
```

The first regex character class lists the allowed chars as
`a-zA-Z0-9`, space (literal ` `), `.`, `_`, `-`, `/`. It does NOT include
`\t`, `\n`, `\r`, `\f`, `\v`, or NBSP. Every whitespace char outside ASCII
space is therefore dropped by the first replace BEFORE the
`/\s+/g → ' '` collapse ever runs.

## Failure scenario

Input: `"a    b\tc"`

Step-by-step trace:

1. `String("a    b\tc")` → `"a    b\tc"`
2. `.replace(/[^a-zA-Z0-9 _.\-/]/g, '')` strips the `\t` (tab is not in the
   whitelist) → `"a    bc"` (4 spaces preserved, tab gone)
3. `.replace(/\s+/g, ' ')` collapses the 4-space run → `"a bc"`
4. `.trim().slice(0, 60)` → `"a bc"`

Actual return: `"a bc"`

Contract per the function's docstring: "collapse whitespace". Caller
expectation: `"a b c"` (the tab between `b` and `c` should collapse to a
single space, like the run of 4 spaces does).

Same defect affects newlines, carriage returns, form feeds, vertical tabs,
and any unicode whitespace — all are stripped silently instead of being
collapsed.

This breaks origin notes generated from sources that use tabs (e.g.
tab-separated logs, copy-paste from spreadsheets, markdown table cells) —
the chars just vanish from the label, producing labels like `"workerfast"`
instead of `"worker fast"`.

## Pinning test

`src/__tests__/prompt-safety.test.ts` → `describe('sanitizeOriginNote')` →
`'collapses internal whitespace runs to a single space (regression: tabs
and other \s must be collapsed, not stripped)'`

The test asserts the **actual** (buggy) return value so the suite stays
green; when the fix lands, the assertion needs to be updated to
`"a b c"`.

## Suggested direction

Add `\s` to the allowed charset in the first replace so all whitespace
chars pass through to the `\s+` collapse:

```ts
.replace(/[^a-zA-Z0-9\s_.\-/]/g, '')
```

(or restructure to strip disallowed chars AFTER the whitespace collapse —
either is correct; the current ordering is the bug). Update the pinning
test to assert `"a b c"` for input `"a    b\tc"` and add coverage for `\n`,
`\r`, NBSP cases.
