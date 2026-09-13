# Workflow tool name parameter — inline scripts not registered globally

## Symptom

The Workflow tool accepts `script` (inline string), `name` (label), and
`scriptPath` (file path) as alternative ways to invoke a workflow.
The first invocation with `{script: "...", name: "g3-liveness-tracker"}`
succeeded and persisted the script to a file. A second invocation with
`{name: "g3-liveness-tracker"}` returned:

```
Workflow "g3-liveness-tracker" not found. Available: deep-research
```

The persisted file was at
`/Users/eggp/.claude/projects/-Users-eggp-marveen-develop-test-baseline/3a4147ed-cca8-46be-9a92-b5bec4237a72/workflows/scripts/g3-liveness-tracker-wf_9d09f297-da2.js`
and could be re-invoked via `Workflow({scriptPath, resumeFromRunId})`,
but NOT via `Workflow({name})`.

## Root cause

Inline-passed scripts are persisted to a file under the session's
`workflows/scripts/` directory, but the `name` parameter is just a label
for the permission dialog and progress display. It does NOT register the
workflow in any cross-session name registry. The named-workflow registry
is populated only through:

1. `.claude/workflows/` directory files (project-scoped)
2. Bundled skills like `deep-research` (built-in)
3. Skill-creator workflows (cross-session registration)

A session-created inline script is NOT in any of these buckets.

## Mitigation

For first invocation: `Workflow({script, name, resumeFromRunId?})` works.
For subsequent invocations in the same session: `Workflow({scriptPath,
resumeFromRunId})`. For cross-session discovery: carry the scriptPath
forward explicitly via shared-memory or Honcho.

## Workaround for retry / recovery

If a workflow dies mid-flight and the user wants to resume it later:

- Same session: read the journal file at
  `<transcript-dir>/subagents/workflows/wf_<id>/journal.jsonl` (per
  workflow-authoring skill docs); use `Workflow({scriptPath,
  resumeFromRunId})` from the original Workflow call's tool result.
- Different session: the scriptPath must be discovered via Honcho or
  shared-memory. The runId is also session-scoped and may not survive
  across sessions — the safer pattern is to write the script to a
  known path (e.g., `.claude/workflows/<name>.js`) and invoke via
  `Workflow({name})` after the file is committed.

## Implications for the G.3 retrospective proposal

The G.3 retrospective proposed adding a "CLAUDE.md compliance check" to
the dual-verifier template (CLAUDE.md §8). A separate, lower-priority
proposal was to document this workflow-name limitation. This file is the
deliverable for the second proposal. No CLAUDE.md change is required for
this one — it is informational only, surfaced for the next session that
hits the same limitation.

## Honcho dual-write

The Honcho `create_conclusion` invocation in this session carries the
same content as this file. If Honcho retrieval fails in a future
session, this file is the persistent project-local record.

## Related references

- Workflow tool skill description (auto-loaded)
- workflow-authoring skill reference (loaded before authoring scripts)
- G.3 plan file: `.claude/plans/tranquil-coalescing-spring.md`
- G.3 retrospective: `.claude/retrospectives/2026-09-13-3a4147ed.md`