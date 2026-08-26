# Defect: stuck mod-scope cache blocks coverage of `shouldTriggerDeafnessRespawn` respawn branches

## File
`src/web/inbound-probe.ts`

## Symptom (historical -- no longer reproducible)
The respawn path inside `checkInboundProbeDeafness` was originally blocked by
the dynamic-import / vitest mock mismatch described below. After the fix in
c333a6f (see the Resolution footer), the suite
`describe('checkInboundProbeDeafness via setInterval tick', ...)` in
`src/__tests__/inbound-probe-full.test.ts` (lines 735-1059) drives the
respawn branches. The relevant test names are:

- line 784: `it('triggers a hard restart when shouldTriggerDeafnessRespawn returns true', ...)`
- line 803: `it('skips the respawn when lastMainRespawnAt is within the grace window', ...)`
- line 821: `it('does NOT skip when lastMainRespawnAt is 0 (the cross-path grace check)', ...)`
- line 839: `it('logs an error when hardRestartMarveenChannels returns ok:false', ...)`
- line 998: `it('logs an error when the dynamic import rejects (line 347)', ...)`

All five tests pass. The original symptom (interval callback returning
silently because the dynamic import resolved to the real channel-monitor
module) only existed before c333a6f landed.

## Reproduction (historical -- pre-c333a6f)
Run the suite under vitest v4.1.10 with the top-level mock path
`'../web/channel-monitor.js'`. The mock is applied for static imports
(`await import('../web/channel-monitor.js')` returns the mock), but the
SUT's dynamic import inside the interval callback
(`import('./channel-monitor.js')` from `src/web/inbound-probe.ts`)
resolves to the real module on the first invocation. As a result,
`hardRestartMarveenChannels` is the real one (which throws because the
host has no `main` TMUX session) and the .then callback never reaches
the success/error logs.

## Coverage Impact (historical -- now superseded)
The measured coverage of `src/web/inbound-probe.ts` after the fix is 100%
across every dimension:

- lines: 100% (145/145)
- branches: 100% (74/74)
- functions: 100% (16/16)
- statements: 100% (158/158)

Measured via `bun --bun vitest run <9 channel-coordinator test files +
inbound-probe.test.ts + inbound-probe-full.test.ts> --coverage` with the
istanbul provider and `coverage.include` restricted to
`src/web/inbound-probe.ts` (plus `src/channel-coordinator.ts` which also
hits 100%). No `MARVEEN_TEST_*` env flags were set; 11 test files passed,
0 test failures.

## Root Cause (historical -- pre-c333a6f)
Vitest's mock resolution keys static-import mocks on the path string
the test file uses. The dynamic import inside the SUT uses a different
relative path string (`./channel-monitor.js` from the SUT's directory)
and Vite bypasses the mock registry for that path. Adding an
absolute-path mock (`vi.mock(join(H.projectRoot, 'src/web/channel-monitor.js'), ...)`)
also fails because the mock factory is called before the test file's
`H.projectRoot` is finalized.

## Fix (applied -- see Resolution)
The chosen approach was option 3, with a twist: the dynamic channel-monitor
mock was registered on the absolute path the source uses
(`vi.mock('../web/channel-monitor.js', ...)` at line 124 of
`src/__tests__/inbound-probe-full.test.ts`), and a per-test
`loadInboundProbeFresh()` helper at line 145 calls `vi.resetModules()`
(line 146) before re-applying `vi.doMock('../web/channel-monitor.js', ...)`
at lines 196-199 and re-doing the dynamic `import('../web/inbound-probe.js')`
at line 200. This drops the cached dynamic import between tests without
needing a separate worker. The mock state (closures held by `mockState`)
survives `vi.resetModules()` because it lives in a hoisted `vi.hoisted(...)`
factory rather than in the SUT module scope.

Options 1 (refactor to static import) and 2 (vitest mock-resolution change)
were not taken.

## Workaround in the suite (historical, now obsolete)
The original MD referenced `src/__tests__/web-inbound-probe.test.ts` -- that
file does not exist. The real files are:

- `src/__tests__/inbound-probe.test.ts`: the pure-exports suite (covers
  `shouldTriggerDeafnessRespawn` and `readLastIngestionTimestamp` only).
- `src/__tests__/inbound-probe-full.test.ts`: the lifecycle suite that
  covers everything else (`startInboundProber`, `spawnProber`,
  `checkInboundProbeDeafness`, `TRANSCRIPT_DIR`).

Combined coverage is 100% (145/145 lines, 74/74 branches, 16/16
functions, 158/158 statements) -- the 64% figure was the pre-fix
`inbound-probe.test.ts`-only snapshot.

## Resolution (2026-08-26, this commit)
- The defect was closed by commit `c333a6f` (2026-08-08), which landed
  `src/__tests__/inbound-probe-full.test.ts` (1149 lines).
- Option 3 was applied with the `vi.mock` + `loadInboundProbeFresh()` +
  `vi.doMock` re-application pattern. Verified line numbers in
  `src/__tests__/inbound-probe-full.test.ts`:
    - `vi.mock('../web/channel-monitor.js', ...)` at line 124
    - `async function loadInboundProbeFresh()` defined at line 145,
      `vi.resetModules()` at line 146
    - `vi.doMock('../web/channel-monitor.js', ...)` re-application at
      lines 196-199
- The measured coverage of `src/web/inbound-probe.ts` is now
  100% (lines 145/145, branches 74/74, functions 16/16, statements
  158/158). The previously-listed "lines 297-347 + 288 + 381 uncovered"
  claim is now falsified.
- `src/web/inbound-probe.ts` was NOT modified by c333a6f -- the fix lives
  entirely in the new test file plus the existing pre-2026-08-08 helper
  surface. The MD was simply never back-annotated after c333a6f landed.
- Sections above are retained verbatim (with a "(historical)" prefix on
  the falsified ones) so the original analysis is still auditable.
