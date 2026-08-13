// Web tests use next/jest (Next's SWC transform) + jsdom + React Testing Library (R4).
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/*.test.{ts,tsx}'],
  // Include jsx so untyped JS components (e.g. the React Bits Ferrofluid) resolve + mock.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // ⓘ ESM-only dependencies (react-resizable-panels) are declared via `transpilePackages` in
  // next.config.mjs — next/jest reads that and adjusts its own transformIgnorePatterns; a bare
  // override HERE is silently overwritten by next/jest and does nothing.
};

module.exports = createJestConfig(config);
