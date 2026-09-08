# Workflow tool safety classifier false-positive — session mainloop fallback

The Workflow tool's safety classifier can block `agent()` calls within a workflow with a `[Untrusted Code Integration]` error when the prompt content cannot be verified (the classifier sees `: [object]` — the literal JavaScript `String(object)` coercion of an opaque payload, e.g. a serialized prompt).

## Symptoms

- Workflow tool returns `failed` with `TypeError: parallel() expects an array of functions` (or similar parse error)
- 4+ retry attempts all return `[object] blocked by safety classifier: [Untrusted Code Integration]` and `[object] blocked by safety classifier: [Auto-Mode Bypass]`
- The classifier messages explicitly cite "tunneling" if you retry with the same unverifiable payload

## Resolution protocol

1. **DO NOT retry** the Workflow tool. The classifier considers retry "tunneling" and blocks each attempt.
2. **DO NOT use `resumeFromRunId`** — same problem: the prompt is still unverifiable.
3. **Inform the user** via `AskUserQuestion` that the workflow classifier is blocked and propose the fallback path.
4. **Fall back to session mainloop**: execute the implementation via sequential `Edit`, `Write`, and `Bash` tool calls from the session mainloop, NOT via sub-agents. The session mainloop prompts are always verifiable (plain strings, not opaque serialized payloads).
5. **Commit via session mainloop** using `git -c user.email=... -c user.name=... commit -F <commit-msg-file>` to preserve the EggProjectTeams identity and apply the author pre-check post-commit.

## Precedent

- **2026-09-09 C.1 AuthGate cycle** (`wf_c95e3edc-989`): the workflow was launched, immediately failed on `parallel()` syntax, was patched to use array form, then blocked 4 times by the safety classifier. User approved session mainloop fallback. The C.1 implementation succeeded via session mainloop, the post-fix code-review --fix was committed as `3663c3e`, all gates green.

## Cross-corpus index line

When the Workflow tool safety classifier blocks with `[object]` prompt-preview serialization, fall back to session mainloop Edit/Write/Bash per user approval. Do NOT retry.