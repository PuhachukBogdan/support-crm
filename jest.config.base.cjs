/**
 * Shared Jest base for backend (NestJS) service workspaces.
 * Uses the @swc/jest transform (fast; no type-checking in the transform —
 * types are covered by the separate `tsc --noEmit` lint step). Research R3.
 *
 * Each service extends this via its own jest.config.cjs.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  transform: {
    // NestJS relies on legacy decorators + emitted decorator metadata; the SWC transform
    // must be told to parse and keep them (otherwise `@Module(...)` fails to compile).
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
  // Resolve shared workspace packages to their TypeScript source so tests need no
  // prior build step (the source lives under libs/, outside node_modules, so the
  // @swc/jest transform still applies). rootDir is the service package dir.
  moduleNameMapper: {
    '^@crm/common$': '<rootDir>/../../libs/common/src/index.ts',
    '^@crm/proto$': '<rootDir>/../../libs/proto/src/index.ts',
  },
  clearMocks: true,
};
