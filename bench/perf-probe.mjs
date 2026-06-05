// Three independent micro-benches, one per candidate optimization.
// Run with `node bench/perf-probe.mjs <A|B|C>` (or no arg = all).
// A = cold .class qSA   B = getElementsBy* hot loop   C = cold #id qS
import { createEnvironment } from '../src/runtime/index.mjs';

const rows = Array.from({ length: 200 }, (_, i) =>
  `<div class="row r${i}"><input id="i${i}" class="field on" data-k="${i}"><button class="btn primary">B${i}</button></div>`).join('');
const html = `<!doctype html><body><main id="app">${rows}</main></body>`;

function median(fn, runs = 7, ms = 500) {
  for (let i = 0; i < 4; i++) fn(120);                 // warm JIT
  const xs = Array.from({ length: runs }, () => fn(ms)).sort((a, b) => a - b);
  return xs[runs >> 1];
}
function loopOps(body, ms) {
  let it = 0, n = 0;
  const s = process.hrtime.bigint(), dl = s + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < dl) { n += body(); it++; }
  void n;
  return it / (Number(process.hrtime.bigint() - s) / 1e6) * 1000;
}

// A — cold .class querySelectorAll (fresh env per iter = cache miss)  [#1]
const A = (ms) => loopOps(() => {
  const d = createEnvironment(html).document;
  return d.querySelectorAll('.field').length + d.querySelectorAll('.btn').length;
}, ms);

// B — getElementsByTagName/ByClassName called repeatedly on one warm doc  [#2]
const docB = createEnvironment(html).document;
const B = (ms) => loopOps(() =>
  docB.getElementsByTagName('input').length + docB.getElementsByClassName('field').length, ms);

// C — cold querySelector('#id') (fresh env per iter)  [#3]
const C = (ms) => loopOps(() => {
  const d = createEnvironment(html).document;
  return (d.querySelector('#i40') ? 1 : 0) + (d.querySelector('#i150') ? 1 : 0);
}, ms);

const which = (process.argv[2] || 'ABC').toUpperCase();
const fmt = (v) => Math.round(v).toLocaleString().padStart(10);
if (which.includes('A')) console.log('A  cold .class qSA          ', fmt(median(A)), 'iters/s');
if (which.includes('B')) console.log('B  getElementsBy* hot loop  ', fmt(median(B)), 'iters/s');
if (which.includes('C')) console.log('C  cold #id qS              ', fmt(median(C)), 'iters/s');
