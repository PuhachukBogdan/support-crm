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
    '^.+\\.(t|j)s$': ['@swc/jest'],
  },
  moduleNameMapper: {
    '^@crm/common$': '<rootDir>/libs/common/src/index.ts',
    '^@crm/proto$': '<rootDir>/libs/proto/src/index.ts',
  },
  clearMocks: true,
};
