# approvals PATCH logger receives untrimmed resolved_by

## Source

`src/web/routes/approvals.ts:183`

```ts
logger.info({ id: idMatch[1], status, resolved_by }, 'Approval resolved')
```

## Behaviour

`resolveApproval(idMatch[1], status, resolved_by.trim(), msgId)` is called
with the trimmed value, but the log call uses the raw `resolved_by` from
the body. A request with `resolved_by: "  owner  "` logs the whitespace
even though the resolution itself was attributed to `owner`.

Pinning test in `src/__tests__/routes-approvals-full.test.ts` (PATCH
"resolves approval successfully" suite) asserts the CURRENT behaviour
exactly; a future fix that trims for the log will trip it.

## Suggested fix

Pass the trimmed value through to the log call:

```ts
const trimmedResolvedBy = resolved_by.trim()
logger.info({ id: idMatch[1], status, resolved_by: trimmedResolvedBy }, 'Approval resolved')
```