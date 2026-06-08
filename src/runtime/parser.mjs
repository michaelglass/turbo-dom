// Parser binding loader, shared by the whole runtime (dom.mjs, index.mjs).
//
// Native addon first; fall back to the wasm build on platforms/arches with no
// prebuilt .node (or where it can't load). Both front-ends expose the same
// parse* contract (parse/parseBuffer/parseFragment) over one shared Rust core,
// so the runtime is agnostic to which one is live. If wasm isn't built either,
// surface the original native load error — it's the more actionable one.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let parser;
try {
  parser = require('../../index.js');
} catch (nativeErr) {
  try {
    parser = require('../../pkg/turbo_dom_parser.js');
  } catch {
    throw nativeErr;
  }
}

export default parser;
