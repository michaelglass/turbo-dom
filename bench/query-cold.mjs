// Cold-cache .class querySelectorAll — the real RTL path: fresh env per test,
// every query is a cache MISS so the per-element matcher runs. Isolates the
// simpleMatcher('.class') allocation cost.
import { createEnvironment } from '../src/runtime/index.mjs';

const rows = Array.from({ length: 200 }, (_, i) =>
  `<div class="row r${i}"><input class="field on" data-k="${i}"><button class="btn primary">B${i}</button></div>`).join('');
const html = `<!doctype html><body><main id="app">${rows}</main></body>`;

function bench(ms = 1500) {
  let it = 0, n = 0;
  const s = process.hrtime.bigint(), dl = s + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < dl) {
    const d = createEnvironment(html).document;   // fresh → cold caches
    n += d.querySelectorAll('.field').length;
    n += d.querySelectorAll('.btn').length;
    n += d.querySelector('.primary') ? 1 : 0;
    it++;
  }
  void n;
  return it / (Number(process.hrtime.bigint() - s) / 1e6) * 1000;
}
for (let i = 0; i < 5; i++) bench(200);              // warm JIT
const runs = Array.from({ length: 7 }, () => bench(600));
const med = runs.slice().sort((a, b) => a - b)[3];
console.log(`cold .class querySelectorAll: ${Math.round(med).toLocaleString()} iters/sec (median of 7)`);
