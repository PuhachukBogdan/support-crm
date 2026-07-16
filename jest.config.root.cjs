/**
 * Root-level Jest config — runs cross-cutting tests that live at the repo root
 * (e.g. the workspace-linking integration test), not owned by any single workspace.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  transform: {
    // Explicit TypeScript parser (matches jest.config.base.cjs) so TS-only syntax like
    // `as const` in root integration specs parses reliably regardless of @swc defaults.
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@crm/common$': '<rootDir>/libs/common/src/index.ts',
    '^@crm/proto$': '<rootDir>/libs/proto/src/index.ts',
  },
  clearMocks: true,
};
