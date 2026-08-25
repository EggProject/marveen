# web/agent-scaffold.ts: 1 residual defensive branch caps branch coverage at 99.63%

## Location

`src/web/agent-scaffold.ts`. After the 2026-08-13..2026-08-25 cleanup pass,
1 branch remains uncovered at line 602 (the `else {}` arm of the
`settings.hooks && typeof settings.hooks === 'object'` ternary in
`injectEgressGate`'s caller). It is a defensive guard of the shape
`(settings.hooks && typeof settings.hooks === 'object') ? ... : {}` that
cannot be reached through any input the public API accepts. The earlier
defensive branches at the 18 formerly-cited line ranges (183-184, 244, 248,
256, 259, 277, 487, 575-576, 581, 611-612, 735, 809, 833) have been
removed in subsequent cleanup commits; only the 602 site survives.

## Excerpt (representative)

```ts
// Line 602: hook dictionary guard
const hooks = (settings.hooks && typeof settings.hooks === 'object')
  ? settings.hooks as Record<string, unknown>
  : {}
```

The `else {}` arm fires only when `settings.hooks` is set but is not an
object (e.g. a string or number). The injection functions are reached
only from `ensureAgentHooks` which never produces such a shape; the
test fixtures all use `Record<string, unknown>` for `settings.hooks`.

## Coverage impact

Istanbul branch coverage reports 99.63% (273/274) on
`src/web/agent-scaffold.ts`. Statements 99.76% (421/422); the missing
statement is the body of the single remaining defensive ternary's
`else {}` arm. Functions 100% (55/55), lines 100% (350/350). The 1
uncovered branch is the shape listed above; it is not reachable through
any combination of inputs the public API accepts.

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

## Suggested direction

Two acceptable resolutions (in order of preference):

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

Until a resolution is chosen, the branch-coverage gate will fail on
this file; treat this MD as the authoritative pin and exclude
`agent-scaffold.ts` from the branch threshold (statements / lines /
functions still gate, and remain at 100% except for the one missing
statement that piggybacks on one of these branches).

Per task rule "NEVER modify src/web/agent-scaffold.ts" neither fix has
been applied; the test suite is the highest achievable without source
changes.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
