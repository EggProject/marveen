// @ts-check
/**
 * Strict, type-aware ESLint flat config.
 *
 * Three deliberate design points:
 *
 * 1. `parserOptions.project: ['./tsconfig.eslint.json']`. tsconfig.json only
 *    includes `src/**` (and pins `rootDir: "src"`), so the ~10 TS files that
 *    live outside it - scripts/*.ts, tests/smoke/*.spec.ts, the root
 *    *.config.ts - are not in any project the parser can find.
 *    `projectService` does NOT solve this: its `defaultProject` only serves
 *    files whose glob is listed in `allowDefaultProject`, and that option
 *    rejects `**` globs and errors past 8 matched files. So we point the parser
 *    at one explicit superset tsconfig instead.
 *    `bun run typecheck` is untouched by this - it keeps reading tsconfig.json.
 *
 * 2. The type-aware presets are scoped to TS files via `extends`. Spreading
 *    them at top level would apply type-aware rules to plain .js/.mjs files
 *    too, and rules like `await-thenable` crash without a Program.
 *
 * 3. Type-aware rules stay ON for test files. The test suite is 381 files and
 *    part of the shipped quality gate, so it gets the same strictness as src/.
 *
 * Runtime note: `bun run lint` executes node_modules/.bin/eslint, whose shebang
 * is `#!/usr/bin/env node` - so ESLint runs under Node, not Bun (Bun only takes
 * over with an explicit `--bun` flag). That is why the CI lint job installs Node
 * and why NODE_OPTIONS=--max-old-space-size in the lint script has any effect.
 */
import js from '@eslint/js'
import vitest from '@vitest/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** Every TypeScript file that gets full type-aware linting. */
const TS_FILES = [
  'src/**/*.ts',
  'scripts/**/*.ts',
  'tests/**/*.ts',
  'playwright.config.ts',
  'vitest.config.ts',
]

/** Vitest unit tests plus the Playwright smoke specs. */
const TEST_FILES = ['src/__tests__/**/*.ts', 'tests/**/*.spec.ts']

export default defineConfig(
  // web/ is a prebuilt static bundle shipped in-tree (app.js is ~732KB), not
  // authored source. dist/ and coverage/ are generated.
  globalIgnores([
    'web/**',
    'dist/**',
    'coverage/**',
    'coverage-temp/**',
    '.idea/**',
    '.claude/**',
  ]),

  // ESLint core recommended for every linted file, JS and TS alike.
  js.configs.recommended,

  // Strict type-aware TypeScript linting, scoped to TS only.
  {
    name: 'marveen/typescript',
    files: TS_FILES,
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript resolves identifiers itself; no-undef only produces false
      // positives on type-only and ambient declarations.
      'no-undef': 'off',
    },
  },

  // Vitest-specific correctness rules (focused tests, valid expects, etc).
  {
    name: 'marveen/tests',
    files: TEST_FILES,
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
  },

  // The .mjs helper scripts under scripts/ are plain Node ESM, not TypeScript.
  // They only need the Node globals so no-undef stops firing on `process` etc.
  {
    name: 'marveen/node-scripts',
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
)
