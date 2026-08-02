import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
    setupFiles: ['./src/__tests__/setup/assert-not-live-install.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'src/config-resolution.ts',
        'src/runtime-env.ts',
        'src/providers/registry.ts',
        'src/providers/runtime.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
