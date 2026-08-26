# web/agent-scaffold.ts: 1 residual defensive branch caps branch coverage at 99.63%

## Resolution (2026-08-26, 642b883)

The line 602 defensive guard was replaced with
`(settings.hooks ?? {}) as Record<string, unknown>` in commit `642b883`
(2026-08-26). The "Suggested direction" option 1 ("drop the defensive
guards where they are unreachable") was applied. Per the `642b883`
commit message, branch coverage went 99.63% -> 100% (all four
dimensions at 100% per the gate). The Location, Excerpt, and Coverage
impact sections below describe the **pre-642b883** state and are kept
verbatim for audit reference; the current state is captured by the
642b883 source diff. The MD's headline is stale; the file is at 100%.

Refs: 642b883 (fix agent-scaffold defensive `settings.hooks` ternary
at L602, branch coverage 99.63% -> 100%).

## Location

`src/web/agent-scaffold.ts`. After the 2026-08-13..2026-08-25 cleanup pass,
1 branch remained uncovered at line 602 (the `else {}` arm of the
`settings.hooks && typeof settings.hooks === 'object'` ternary in
`injectEgressGate`'s caller). It was a defensive guard of the shape
`(settings.hooks && typeof settings.hooks === 'object') ? ... : {}` that
could not be reached through any input the public API accepts. The
earlier defensive branches at the 18 formerly-cited line ranges
(183-184, 244, 248, 256, 259, 277, 487, 575-576, 581, 611-612, 735, 809,
833) had been removed in subsequent cleanup commits; only the 602 site
survived -- until `642b883` collapsed it. **Post-642b883: no surviving
defensive guard at L602; line 602 is now a `?? {}` fallback.**

## Excerpt (representative)

```ts
// Line 602 (pre-642b883): hook dictionary guard
const hooks = (settings.hooks && typeof settings.hooks === 'object')
  ? settings.hooks as Record<string, unknown>
  : {}

// Line 602 (post-642b883): hook dictionary fallback
const hooks = (settings.hooks ?? {}) as Record<string, unknown>
```

The `else {}` arm fired only when `settings.hooks` was set but was not an
object (e.g. a string or number). The injection functions were reached
only from `ensureAgentHooks` which never produces such a shape; the
test fixtures all use `Record<string, unknown>` for `settings.hooks`.
**Post-642b883: the guard is gone, replaced with a `?? {}` fallback that
synthesises an empty object on undefined.**

## Coverage impact

Istanbul branch coverage reports 99.63% (273/274) on
`src/web/agent-scaffold.ts` **at the time of this MD's filing** (the
pre-642b883 state). Statements 99.76% (421/422); the missing statement
was the body of the single remaining defensive ternary's `else {}`
arm. Functions 100% (55/55), lines 100% (350/350). **Post-642b883:
branch coverage reached 100% per the commit message** (all four
dimensions at 100% per the gate; the `?? {}` fallback is reachable on
undefined input which the test suite exercises). Coverage numbers
above are preserved verbatim for audit reference and are NOT
re-measured here -- the `bun run coverage` artifact is git-ignored
(CLAUDE.md §8).

## Pinning test

`src/__tests__/agent-scaffold-full.test.ts` exercises every reachable
branch of the file:

- `agentSettingsPath` -- every branch of the main/sub-agent path split
- `upgradeLegacyHookCommands` -- empty inputs, missing basename, unsafe
  command, single existing, identical entries, basename match, no
  hooks array, tpl hook without timeout, tpl hook with same basename
  but different command (lines 187-189 pinned), every documented
  defensive branch
- `ensureAgentHooks` -- missing template, unparseable template, missing
  hooks key, fresh seed, merge with no hooks, preserve existing
  PreToolUse, idempotent dedup with timeout sync, drop unsafe commands,
  drop empty entries after unsafe filter, MAIN_AGENT_ID path, malformed
  existing settings.json
- `injectEmailSendGate` / `injectSelfPaceGate` / `injectEgressGate` --
  every dedup branch, replacement branch, fresh-add branch, type-only
  skip, replace-with-different-cmd, no-prior-entry, missing-script skip
- `ensureDefaultScheduledTasks` -- every reachable branch including the
  non-task-config catch (line 711: pinned by the in-file test in
  `describe('ensureDefaultScheduledTasks: non-task-config catch (line 711)')`
  via `vi.doMock('node:fs')` + `vi.resetModules()`; the placeholder
  survives verbatim, proving the catch fell back to `copyFileSync`. The
  earlier in-file version of the test made the SKILL.md source a directory,
  which is silently skipped by the `statSync(...).isDirectory()` guard at
  line 701 and never reaches the try/catch -- the test was rewritten
  during the catch-branch coverage sweep to use the `vi.doMock` technique
  instead. The sibling test file
  `agent-scaffold-scheduled-tasks-catch.test.ts` covers the same case
  via a module-level `vi.mock('node:fs')` and is now redundant -- kept
  for the moment so the catch-branch test is duplicated at file level)
- `scaffoldAgentDir` -- mkdir / copy / file rewrite / atomicWrite
  branches, every placeholder substitution path
- `copyTaskConfigWithAgentRewrite` -- valid JSON, malformed JSON,
  missing agent field, agent rewrite, all placeholder substitutions
- `resolveTemplatePlaceholders` -- every substitution, missing
  placeholder, empty value, escaped braces, unknown placeholder passthrough
- `buildFleetRosterBody` -- empty fleet, single agent, sanitization of
  capability strings, comma joining, the `(nincs regisztrált ágens)`
  fallback
- `generateSkillMd` -- every LLM-driven branch, the empty-LLM fallback
- `hookCommand` -- script existence, interpreter probe, both error
  reasons, the Hungarian error message
- `isUnsafeHookCommand` -- every TMP_PREFIX path, the
  existsSync-missing-path path, the safe-command path, the no-extension
  path

177 tests passing in the full file alone, 178 with the sibling
catch-test file. Statements 99.76% (421/422), branches 99.63%
(273/274), functions 100% (55/55), lines 100% (350/350). The gap is
the single defensive `else {}` arm of the `settings.hooks` guard at
line 602.

## Suggested direction (applied)

The two options were:

1. **Drop the defensive guards where they are unreachable.** Each
   branch is accompanied by an upstream check that already rejects the
   shape the guard defends against. Removing them has no runtime
   impact and turns the branch-coverage gate green. The pattern is
   identical to the cleanup applied to `store-watcher.ts`,
   `http-helpers.ts`, and `mcp-list.ts` -- see their respective
   `docs/needs-to-be-fix/*.md` entries.

2. **Add `/* v8 ignore next */` annotations** above each branch with a
   one-line comment naming the upstream check that makes the arm dead.
   Silences the gate without changing runtime behaviour.

**Option 1 was applied in `642b883` (2026-08-26)** at line 602
(`settings.hooks ?? {}`). No other defensive guard survived the
2026-08-13..2026-08-25 cleanup pass. The branch-coverage gate is now
green on `agent-scaffold.ts`; no exclusion is required.

Per task rule "NEVER modify src/web/agent-scaffold.ts" this was
blocked during the original survey. Outside the baseline closure
cycle (see the "Scope note" at the bottom of this MD) source edits
were permitted when the fix was justified; the `642b883` commit
applied that user override for the line 602 case.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
