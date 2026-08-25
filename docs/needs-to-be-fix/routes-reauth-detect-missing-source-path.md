# routes/reauth-detect: task target path does not exist on disk

## Location

Task brief expected the source module at:

`src/web/routes/reauth-detect.ts`

The actual module lives at:

`src/web/reauth-detect.ts` (one level above `routes/`, sibling of
`auth-gate.ts`, `auth-sessions.ts`, `reauth-healer.ts`, etc.)

`git ls-files src/web/routes/ | grep -i reauth` returns no rows; the only
tracked reauth modules in the tree are `src/web/reauth-detect.ts` and
`src/web/reauth-healer.ts`.

## Excerpt

The route-tree import in `src/web/routes/agents.ts:111` confirms the real
path:

```ts
// src/web/routes/agents.ts:111
import { detectReauthNeeded } from '../reauth-detect.js'
```

The `../` (not `./`) hop is consistent with every other routes-side
import in the file: `agents.ts` reaches `reauth-detect.ts` as a sibling
of itself, via `../reauth-detect.js`.

## Failure scenario

The task brief listed mock targets appropriate for a routes-side file
(`../db.js`, `../config.js`, `../logger.js`, `../web/auth-gate.js`,
`../web/auth-sessions.js`) and the run command

```
npx vitest run src/__tests__/reauth-detect-routes.test.ts \
  --coverage --coverage.include='src/web/routes/reauth-detect.ts'
```

targets a non-existent file. Running the brief verbatim reports 0% on
that path (no source to instrument). The route module that the brief
implies would presumably be a thin Express handler that calls
`detectReauthNeeded` over the active agent's captured pane and returns
the `ReauthState` JSON; it does not exist in the tree today.

## Observed impact

1. **No runtime impact.** The existing helper at
   `src/web/reauth-detect.ts` is already imported by `agents.ts:111` and
   invoked at `agents.ts:462`:

   ```ts
   // src/web/routes/agents.ts:462
   const reauth = running ? detectReauthNeeded(capturePane(agentSessionName(name))) : { needsReauth: false }
   ```

   The agent-card reauth badge ships through that path, not through a
   dedicated route.

2. **Test-coverage mismatch.** A test suite named
   `src/__tests__/reauth-detect-routes.test.ts` that imports from
   `'../web/reauth-detect.js'` covers the real file. The coverage gate
   passes when `--coverage.include` is corrected to
   `'src/web/reauth-detect.ts'`. The suite is shipped with that
   correction applied; see the test file header for the inline note.

3. **Mocking surface is moot.** The real `reauth-detect.ts` is a pure
   module with zero imports (no `db`, `config`, `logger`, `auth-gate`,
   `auth-sessions` references). The mocks listed in the brief would be
   no-ops even if the source file lived under `routes/`. The suite
   therefore imports the real module directly without mocking.

## Pinning test

`src/__tests__/reauth-detect-routes.test.ts` (32 tests, all passing):

* nullish / empty inputs (null, undefined, empty string)
* one test per `REAUTH_MARKERS` entry in declaration order
  (`Select login method`, `Use the url below / Paste code here`,
  `Invalid authentication credentials`, `Please run /login`,
  `Not logged in`, bare `API Error: 401`, `OAuth token has expired`,
  `OAuth token expired`, `Invalid API key`, `session has expired ... /login`)
* most-specific-wins when multiple markers are present
* `liveStatusRegion` dispatch -- two borders (uses the region), one
  border (falls back to `tailOf`), zero borders (`tailOf` only)
* healthy live status line vs. broken live status line above the input box
* both `ESCALATION_QUOTE_MARKERS` substrings (OAuth-token escalation,
  picker-reason escalation) plus the morning quiet-hours summary and a
  case-insensitive guard match
* negative cases (chat-topic `/login`, idle pane, marker above the
  tail, 14-line pane under threshold)
* `ReauthState` shape contract -- both negative and positive paths,
  invariant: `needsReauth:true` iff `reason` is a non-empty string

Coverage: Statements 100% (26/26), Branches 100% (14/14), Functions
100% (4/4), Lines 100% (19/19) for `src/web/reauth-detect.ts`.

## Suggested direction

Pick one of the following and drop the temporary path note in the test
file header:

1. **Create `src/web/routes/reauth-detect.ts`** as a thin wrapper
   handler -- e.g. `GET /api/agents/:name/reauth` returning
   `detectReauthNeeded(capturePane(...))` -- and migrate the import in
   `agents.ts:111` from `'../reauth-detect.js'` to
   `'./reauth-detect.js'`. Then the existing coverage suite runs
   unchanged against the new path and the brief's mock list starts
   mattering. Removes the path-mismatch defect.

2. **Rename the test file** from `reauth-detect-routes.test.ts` to
   `reauth-detect.test.ts` (or co-locate as `reauth-detect-supplemental.test.ts`)
   and drop the "routes" framing entirely. Aligns with the file naming
   convention used for every other `src/web/*.ts` test pair
   (`sanitize.test.ts`, `keychain.test.ts`, etc.).

Until a resolution is chosen, treat this MD as the authoritative pin:
the routes path is a brief-only artefact and the coverage gate should
be evaluated against `src/web/reauth-detect.ts`. Per task rule
"NEVER modify src/web/routes/reauth-detect.ts" neither fix has been
applied -- the file does not exist to modify.

## Resolution

MD retired as a stale path-mismatch record. The actual SUT lives at
`src/web/reauth-detect.ts` and is already imported directly by the
test file (`src/__tests__/reauth-detect-routes.test.ts`); coverage for
the real module is at 100% across statements, branches, functions
and lines. The routes-side brief framing has no on-disk target and
no follow-up is required.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
