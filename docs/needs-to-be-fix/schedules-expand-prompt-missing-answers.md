# Expand-prompt crashes when answers is omitted

## Location
`src/web/routes/schedules.ts`, `POST /api/schedules/expand-prompt`, immediately after prompt validation.

## Excerpt
```ts
const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

const answersText = answers.map((a: { question: string; answer: string }) => `Kerdes: ${a.question}\nValasz: ${a.answer}`).join('\n\n')
```

## Failure scenario
A syntactically valid request body such as `{"prompt":"Brief"}` passes prompt validation but leaves `answers` undefined. Calling `answers.map` throws `TypeError` before the route's `try` block, so the handler rejects and the outer server catch returns a generic 500 instead of a validation response.

## Pinning test
`src/__tests__/routes-schedules.test.ts`, test `pins the missing answers array failure`, passes by asserting the current `TypeError`, no agent invocation, and no route JSON response.

## Suggested direction
Validate `answers` with `Array.isArray` before mapping. Return 400 when it is missing or malformed, or deliberately default a missing value to an empty array if zero clarification answers are supported. Validate each array item before interpolating it.
