# Defect: stuck mod-scope cache blocks coverage of `shouldTriggerDeafnessRespawn` respawn branches

## File
`src/web/inbound-probe.ts`

## Symptom
The respawn path inside `checkInboundProbeDeafness` (lines 318-348) is not reached
by the test suite. The four tests that try to drive it
(`interval fires the deafness check and respawns when marker is stale`,
`triggers respawn when cross-path grace window has expired`,
`logs an error when hardRestartMarveenChannels returns ok=false`,
`catches and logs errors from the dynamic import`) all fail because the
interval callback returns silently -- the dynamic import resolves to the
real channel-monitor module rather than the mock exported by the test file.

## Reproduction
Run the suite under vitest v4.1.10 with the top-level mock path
`'../web/channel-monitor.js'`. The mock is applied for static imports
(`await import('../web/channel-monitor.js')` returns the mock), but the
SUT's dynamic import inside the interval callback
(`import('./channel-monitor.js')` from `src/web/inbound-probe.ts`)
resolves to the real module on the first invocation. As a result,
`hardRestartMarveenChannels` is the real one (which throws because the
host has no `main` TMUX session) and the .then callback never reaches
the success/error logs.

## Coverage Impact
Lines 297-347 (the `checkInboundProbeDeafness` function body) and lines
288, 381 (spawn error / interval catch) are uncovered. The current
suite covers 63% of the SUT.

## Root Cause
Vitest's mock resolution keys static-import mocks on the path string
the test file uses. The dynamic import inside the SUT uses a different
relative path string (`./channel-monitor.js` from the SUT's directory)
and Vite bypasses the mock registry for that path. Adding an
absolute-path mock (`vi.mock(join(H.projectRoot, 'src/web/channel-monitor.js'), ...)`)
also fails because the mock factory is called before the test file's
`H.projectRoot` is finalized.

## Fix
Either:
1. Refactor the SUT to use a static import instead of the dynamic
   `import('./channel-monitor.js')` (the comment on line 317 says the
   dynamic import is there to avoid a circular dep -- this would need
   a separate refactor), OR
2. Configure Vite/Vitest to key the mock on the resolved file path
   rather than the call-site import string, OR
3. Split the respawn tests into a separate suite with its own
   worker so that `vi.resetModules()` can be used to drop the cached
   dynamic import.

## Workaround in the suite
The four failing tests are documented in
`src/__tests__/web-inbound-probe.test.ts` with the `// NOTE:` comment
cluster. The remaining tests in the `startInboundProber pipeline`
describe block exercise the static-import / interval / mock pathway
(64% coverage of the SUT, including the pure functions and the
spawnProber logic).
