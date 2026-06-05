const { resolve } = require('node:path');
module.exports = {
  rootDir: resolve(__dirname, '..'),
  testEnvironment: resolve(__dirname, '../src/environment/jest.cjs'),
  testEnvironmentOptions: { url: 'http://localhost/' },
  testMatch: ['<rootDir>/test-jest/**/*.test.js'],
  transform: {},
};
