import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@stylistic/quotes': ['error', 'single'], '@stylistic/semi': ['error', 'always'], '@stylistic/indent': ['error', 2],
    },
  },
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off', '@typescript-eslint/strict-boolean-expressions': 'off' } },
)
