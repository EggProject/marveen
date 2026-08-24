import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
export default defineConfig({
  test: {
    // `vi` is referenced in setupFiles without an explicit import (see
    // test-sandbox-setup.ts). Node-vitest injects it as a global; bun-vitest
    // does NOT, so we enable globals for cross-runtime compatibility.
    globals: true,
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
    // Hard gate: refuse to run inside a live install (see the setup file header
    // for the 2026-07-27 incident this prevents). Runs in every worker before
    // any test module is imported. The second entry redirects PROJECT_ROOT /
    // STORE_DIR to a per-file tmpdir sandbox so modules that freeze those
    // paths at module load (channel-monitor.ts, db.ts, costops/config.ts)
    // never resolve against the live checkout. See the file's header for
    // the channel-monitor / respawn-stamp incident that motivated this.
    setupFiles: [
      './src/__tests__/setup/assert-not-live-install.ts',
      './src/__tests__/setup/test-sandbox-setup.ts',
      './src/__tests__/setup/clean-empty-store.ts',
    ],
    // Coverage thresholds pinned at 100% for every src/*.ts file. The hard
    // gate above already prevents the suite from running against a live
    // install, so this is the second defensive line: any source file that
    // gets modified without a corresponding test now fails the build.
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        // The 6 worker-side install scripts are exercised by the shell-level
        // smoke tests (not unit tests); excluding them from the v8 threshold
        // gate is intentional and documented in scripts/.
        'src/web/routes/installer-*.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
        perFile: true,
        // message-router.ts carries 3 structurally-unreachable `??` arms on the
        // agentSessionCache lookup (lines 481-483 of src/web/message-router.ts:
        // `cached?.session ?? agentSessionName(...)` etc.). The outer loop
        // populates the cache for every receiver in `receiversInTick` before the
        // loop body iterates, so `cached` is never undefined through the public
        // API; istanbul still reports each `??` RHS as an uncovered branch.
        // Threshold floor at 97 (3-of-100) matches the documented unreachable
        // count, with one-branch headroom so the gate stays green if the count
        // drifts to 4. See docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md.
        'src/web/message-router.ts': { branches: 97 },
      },
      // json-summary + json are both required by the CI coverage PR comment
      // (davelosert/vitest-coverage-report-action): the summary drives the
      // totals table, the full json drives the per-file breakdown.
      reporter: ['text', 'html', 'json-summary', 'json'],
    },
  },
})