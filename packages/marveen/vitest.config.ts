import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
export default defineConfig({
  test: {
    root: REPO_ROOT,
    exclude: [...configDefaults.exclude, 'tests/smoke/**', '.claude/worktrees/**'],
    // The vitest config lives under packages/marveen/ but the source tree
    // (src/) is at the workspace root. Use absolute paths resolved from the
    // config file's location so the workspace stays as a thin slice.
    include: [`${REPO_ROOT}/src/__tests__/**/*.test.ts`],
    // Hard gate: refuse to run inside a live install (see the setup file header
    // for the 2026-07-27 incident this prevents). Runs in every worker before
    // any test module is imported. The sandbox-store-dir entry must come
    // FIRST so it redirects paths.ts before the live-install check evaluates.
    setupFiles: [
      `${REPO_ROOT}/src/__tests__/setup/sandbox-store-dir.ts`,
      `${REPO_ROOT}/src/__tests__/setup/assert-not-live-install.ts`,
    ],
  },
})
