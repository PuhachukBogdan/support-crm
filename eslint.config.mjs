// Shared ESLint 9 flat config for the whole monorepo (research R5).
// One ruleset applies to every workspace; a new workspace inherits it with no
// bespoke per-package setup (SC-006). Prettier owns formatting — `eslint-config-prettier`
// disables any stylistic rule that would fight the formatter (spec edge case).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // Not linted: dependencies, build output, generated stubs, Next build cache.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      'libs/proto/gen/**',
      'services/*/src/generated/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // Web + tests also run in a browser/jsdom-ish environment.
    files: ['web/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.jest,
      },
    },
  },
  // Config/CJS files use require/module.
  {
    files: ['**/*.cjs', '**/*.config.*'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
