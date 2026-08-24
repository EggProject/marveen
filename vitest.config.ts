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
      './src/__tests__/setup/forbid-system-calls.ts',
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
        // NOTE: a prior commit (6e08cf4) tried `'src/web/message-router.ts':
        // { branches: 97 }` as a per-glob override for the 3 structurally-
        // unreachable `??` RHS arms at lines 481-483. It is a structural no-op
        // with `perFile: true`: vitest runs the global 100% check against
        // every file regardless of glob membership (see vitest source
        // coverage.DM_a_rWm.js line 837: "Global threshold is for all files,
        // even if they are included by glob patterns"), so message-router.ts at
        // 97.82% still fails the 100% global check and `bun run coverage`
        // still exits non-zero. The per-glob entry only ADDS a second, looser
        // check; it never relaxes the global one. Verified empirically: running
        // `bun --bun vitest run --coverage` on HEAD emits
        // `ERROR: Coverage for branches (97.82%) does not meet global threshold
        // (100%) for src/web/message-router.ts`. Until either the source cache
        // type changes so the 3 RHS arms disappear (the MD's option (a),
        // blocked by task rule "NEVER modify src/web/message-router.ts"), or
        // vitest adds an exclude-from-global knob, the message-router coverage
        // gate cannot be made green from config alone. MD left open at
        // docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md.
      },
      // json-summary + json are both required by the CI coverage PR comment
      // (davelosert/vitest-coverage-report-action): the summary drives the
      // totals table, the full json drives the per-file breakdown.
      reporter: ['text', 'html', 'json-summary', 'json'],
    },
  },
})