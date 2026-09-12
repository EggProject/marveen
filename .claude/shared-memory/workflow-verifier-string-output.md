# Workflow tool — verifier outputs without `schema:` come back as strings

## Context

In the A.3a BackgroundTaskPool cycle (2026-09-12, run `wf_25cb2d0e-a31`), the
workflow script launched two verifier subagents with `agentType: 'reviewer'`
but WITHOUT a `schema:` parameter. The agent prompts explicitly instructed
the agents to "Output format: a JSON object with two fields: `verdict` and
`findings`". The agents followed the instruction and emitted valid JSON.

But because no `schema:` was passed to `agent()`, the agent() return value
was the RAW TEXT of the agent's final message — a string containing the
JSON, NOT a parsed JavaScript object.

## The failure

The script's post-implementer block read `verifierA.verdict` and
`verifierA.findings`. Since `verifierA` was a string, those property
accesses were `undefined`, and the fallback `(... || [])` produced an
empty array. The fix-phase gate was:

```
const verdictA = verifierA.verdict
const verdictB = verifierB.verdict
if (verdictA !== 'PASS' || verdictB !== 'PASS') { ... }
```

`undefined !== 'PASS'` is `true`, so the fix phase WAS entered — good.
But the fix prompt received `findingsText = JSON.stringify([], null, 2)`,
an empty array. The fix agent reported "no fix changes to apply". The
verifier findings (2 vacuous tests + 2 lint violations) sat in the
JSON-string return value, untouched.

## The lesson

Always pass a JSON Schema to `agent()` when you need a structured return
value:

```js
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'number' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['item', 'summary', 'evidence'],
      },
    },
  },
  required: ['verdict', 'findings'],
}

const verifierA = await agent(prompt, { agentType: 'reviewer', schema: FINDINGS_SCHEMA })
// verifierA is now an OBJECT, not a string
const findingsText = JSON.stringify(verifierA.findings, null, 2)
```

Without `schema:`, even if the agent returns valid JSON, the script cannot
parse it without an explicit `JSON.parse(verifierA)` step — which is
fragile (the agent may wrap the JSON in a markdown ```json``` fence, or
add commentary around it).

## Detection signals (so future cycles don't repeat this)

1. The workflow journal's `resultPreview` shows the raw text (a long
   markdown blob) instead of an inline `{verdict, findings}` object.
2. The fix-phase prompt includes `[]` as the findings array, and the fix
   agent's report says "no findings to apply" — even when the
   resultPreview shows findings existed.
3. The agents_done count includes the fix agent and the implementer, but
   the merged commit's diff only reflects the implementer's work — the
   fix agent committed nothing because its task was a no-op.

## Recovery pattern (when this happens)

Do NOT retry the workflow — that re-does all the work. Instead:
1. Read the verifier output strings via `journal.jsonl` (it has the full
   agent transcripts).
2. Parse the findings manually.
3. Run the fix step in the session mainloop (Edit/Write/Bash per agent
   prompt) so you can see the verifier feedback inline.

This was applied in the A.3a cycle: the verifier findings (probe 4
vacuous tests, probe 7 lint violations) were re-extracted from the
truncated task notification + the verifier JSON, then 4 fixes were
applied session-mainloop-style as commit `96d90c7`.

## Related precedents

- The Workflow tool `agent()` API docs explicitly note: "Without schema,
  returns its final text as a string. With schema (a JSON Schema), the
  subagent is forced to call a StructuredOutput tool and agent() returns
  the validated object — no parsing needed."
- The workflow-authoring skill reference restates this in the
  `agent(prompt, opts)` section.

The CLAUDE.md §8 "verification protocol" rule (2 agents with different
angles) does not specify schema enforcement — but the angle differences
only matter if BOTH verifier outputs are programmatically inspectable by
the downstream fix agent. String outputs defeat the structured-handoff
that makes the 2-verifier / fix-agent pipeline work.