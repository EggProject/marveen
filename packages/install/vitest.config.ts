import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'src/smoke/**'],
    setupFiles: [],
    coverage: {
      provider: 'v8',
      perFile: true,
      all: true,
      include: ['src/**/*.ts'],
      // Excluded from coverage:
      //  - src/types.ts: pure type declarations, no executable code
      //  - src/__tests__/: test files themselves
      //  - src/shell/backup.ts: the archiver-v8 integration is opt-in
      //    (the bun-workspace install command requires user consent); the
      //    helper has its own unit test via the writer seam, so the
      //    factory functions are 100% covered -- only the live
      //    archiver-stream invocation needs real I/O to exercise.
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        'src/__tests__/**',
        'src/types.ts',
        'src/shell/backup.ts',
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
