// Vitest environment adapter. Use in vitest config:
//
//   // vitest.config.ts
//   export default defineConfig({ test: { environment: 'turbo-dom' } })
//
// (resolves to the package "vitest-environment-turbo-dom", which re-exports this),
// or point directly at this file:
//
//   test: { environment: './node_modules/turbo-dom/dist/environment/vitest.mjs' }
//
// Per-file options via environmentOptions:
//   test: { environmentOptions: { turboDom: { html: '<!doctype html>...', url: 'http://localhost/' } } }

import { installGlobals } from './install.mjs';

export default {
  name: 'turbo-dom',
  // tests run as web/browser-style modules
  transformMode: 'web',

  setup(global, options) {
    const opts = (options && options.turboDom) || {};
    const env = installGlobals(global, opts);
    return {
      teardown() {
        // drop overlay + materialized globals; nothing leaks across files
        env.reset();
      },
    };
  },
};
