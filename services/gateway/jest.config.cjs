// Gateway tests: extend the shared service base; rootDir is this package.
const base = require('../../jest.config.base.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  rootDir: '.',
};
