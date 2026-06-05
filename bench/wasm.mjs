// Phase 2 benchmark: WASM-vs-native parse delta. Confirms the fallback build is
// acceptable (not catastrophic) for environments that can't load native addons.
//
//   npm run build:wasm:pkg   # wasm-pack build --target nodejs --out-dir pkg ...
//   node bench/wasm.mjs

import { createRequire } from 'node:module';
import { fixtures } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const native = require('../index.js');

let wasm;
try {
  wasm = require('../pkg/fast_dom_parser.js');
} catch (e) {
  console.error('! wasm pkg not built. Run: wasm-pack build --target nodejs --out-dir pkg --no-default-features --features wasm-bind');
  process.exit(1);
}

function bench(fn, html, ms = 700) {
  for (let i = 0; i < 20; i++) fn(html);
  let n = 0;
  const start = process.hrtime.bigint();
  const deadline = start + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < deadline) { fn(html); n++; }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return (n / elapsed) * 1000;
}

console.log('\nWASM vs native — parseBuffer throughput (ops/sec)\n');
console.log('fixture'.padEnd(18), 'native'.padStart(12), 'wasm'.padStart(12), 'wasm/native'.padStart(12));
console.log('-'.repeat(56));
let worst = Infinity;
for (const fx of fixtures) {
  const nat = bench((h) => native.parseBuffer(h), fx.html);
  const wsm = bench((h) => wasm.parseBuffer(h), fx.html);
  const ratio = wsm / nat;
  worst = Math.min(worst, ratio);
  console.log(
    fx.name.padEnd(18),
    Math.round(nat).toLocaleString().padStart(12),
    Math.round(wsm).toLocaleString().padStart(12),
    (ratio * 100).toFixed(0).padStart(11) + '%'
  );
}
console.log(`\nWorst-case wasm throughput: ${(worst * 100).toFixed(0)}% of native.`);
console.log('Verdict:', worst > 0.25 ? 'fallback acceptable (same SoA contract, single boundary copy).' : 'fallback slow — investigate.');
