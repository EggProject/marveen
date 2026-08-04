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
      //  - src/shell/backup.ts archiver lines (80-105): integration with
      //    the `archiver` npm dep, which is opt-in (separate consent).
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
