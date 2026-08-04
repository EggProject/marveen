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
      exclude: [...(configDefaults.coverage.exclude ?? []), 'src/__tests__/**'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
