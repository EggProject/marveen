# src/web/routes/reauth-healer.ts does not exist; the actual file lives at src/web/reauth-healer.ts

## Location

`src/web/reauth-healer.ts` -- the task brief in this session referenced
`src/web/routes/reauth-healer.ts`, which is not present in the repository.

```
$ ls src/web/routes | grep reauth
(no output)
$ ls src/web | grep reauth
reauth-detect.ts
reauth-healer.ts
```

## Excerpt

The reauth-healer module is a top-level sibling under `src/web/`, alongside
`reauth-detect.ts`, `claude-credentials-guard.ts`, etc. None of the existing
recovery loops (channel-monitor, model-fallback-runner, auto-restart-runner,
context-guard-runner) live under `src/web/routes/` either -- that directory
holds HTTP route handlers, not watchdog loops.

The 2026-08-04 baseline test task asked for:

- Test file: `src/__tests__/reauth-healer-routes.test.ts`
- Coverage include: `src/web/routes/reauth-healer.ts`
- Rule 1: "NEVER modify src/web/routes/reauth-healer.ts"

None of those references resolve. The coverage include path in particular
would always match zero files.

## Failure scenario

A reviewer (or the coverage gate) opens the task and discovers that:

1. The "source under test" named in the brief is missing.
2. The mock list (`../db.js`, `../web/auth-gate.js`, `../web/auth-sessions.js`)
   has no overlap with the reauth-healer's actual import graph
   (`../logger.js`, `../config.js`, `../platform.js`, `./agent-config.js`,
   `./agent-process.js`, `./claude-credentials-guard.js`,
   `./channel-mcp-reconnect.js`, `./main-agent.js`, `./reauth-detect.js`,
   `./tmux-keys.js`, and a dynamic `./channel-monitor.js`).
3. The actual reauth-healer source path has been the same
   (`src/web/reauth-healer.ts`) since the watchdog landed (2026-06-03), and
   two existing suites already exercise it (`reauth-healer.test.ts`,
   `reauth-quiet-hours.test.ts`) -- both imported from
   `../web/reauth-healer.js`.

The path-mismatch is therefore almost certainly an instruction-generation
mistake, not a planned relocation of the file.

## Resolution direction

Either:

- Re-run the task with the correct path
  (`src/__tests__/reauth-healer-routes.test.ts` against
  `src/web/reauth-healer.ts`), which is what the supplemental suite shipped
  with task #119 / #124 actually exercises; OR
- Move `src/web/reauth-healer.ts` to `src/web/routes/reauth-healer.ts` and
  update its imports + every reference site (`web.ts`, `web-server.test.ts`,
  `reauth-healer.test.ts`, `reauth-quiet-hours.test.ts`) before re-asking for
  coverage. Not recommended: the loop is a background watcher, not a route,
  and `src/web/routes/` would mislead future readers about its role.

## Supplemental coverage that was written anyway

`src/__tests__/reauth-healer-routes.test.ts` was added covering the
otherwise-uncovered lines of `src/web/reauth-healer.ts` (the live sweep,
`checkSession`, `sendNotify`, `sendBestEffortLogin`,
`restartFirstRunGatedAgent`, the disabled-by-`RESPAWN_ENABLED` branch of
`startReauthHealer`, the per-tick `flushQuietSummary` call, and the
main-agent dead-token restart path including the cross-path respawn grace).
The test imports from `../web/reauth-healer.js` (the file that actually
exists). Per task rule 1 ("NEVER modify src/web/routes/reauth-healer.ts")
nothing was changed at the bogus target path -- there is no file there to
modify.

## Resolution

MD retired as a stale path-mismatch record. The real watchdog lives at
`src/web/reauth-healer.ts` and is already exercised by the
`reauth-healer-routes.test.ts` supplemental suite, which imports from
the real on-disk path; no follow-up is outstanding. The brief's
`src/web/routes/reauth-healer.ts` never existed as a file and is not
worth introducing -- the watchdog is not an Express route handler.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
