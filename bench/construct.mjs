// Phase 1 benchmark: "is per-file construction the cost?" — cold environment
// construction + a typical light test, turbodom (lazy) vs jsdom vs happy-dom.
// Plus the lazy-vs-eager split within turbodom and a surface-usage histogram.

import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { Window } = require('happy-dom');

const HTML = `<!doctype html><html><head><title>t</title></head><body>
  <main id="app">${Array.from({ length: 50 }, (_, i) => `<section class="s${i}"><h2>Item ${i}</h2><p>body ${i}</p><button>act ${i}</button></section>`).join('')}</main>
</body></html>`;

function bench(fn, ms = 800) {
  for (let i = 0; i < 10; i++) fn();
  let n = 0;
  const start = process.hrtime.bigint();
  const deadline = start + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < deadline) { fn(); n++; }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return (n / elapsed) * 1000;
}

// A *typical* light test: construct env, query one element, read its text.
const lightFast = () => { const e = createEnvironment(HTML); return e.document.querySelector('#app h2').textContent; };
const lightJsdom = () => { const d = new JSDOM(HTML); return d.window.document.querySelector('#app h2').textContent; };
const lightHappy = () => { const w = new Window(); const doc = new w.DOMParser().parseFromString(HTML, 'text/html'); return doc.querySelector('#app h2').textContent; };

console.log('\nPhase 1 — cold per-file construction + 1 light query (ops/sec, higher better)\n');
const f = bench(lightFast), j = bench(lightJsdom), h = bench(lightHappy);
const row = (name, v) => console.log(name.padEnd(12), Math.round(v).toLocaleString().padStart(10), (v / j).toFixed(2).padStart(7) + 'x jsdom');
row('turbodom', f); row('jsdom', j); row('happy-dom', h);
console.log(`\nturbodom is ${(f / j).toFixed(1)}x jsdom and ${(f / h).toFixed(1)}x happy-dom on the light-test path.`);

// Lazy vs eager WITHIN turbodom: same construction, touch little vs touch everything.
console.log('\nLazy payoff inside turbodom (ops/sec)\n');
const touchOne = () => { const e = createEnvironment(HTML); return e.document.querySelector('#app').id; };
const touchAll = () => {
  const e = createEnvironment(HTML);
  const all = e.document.getElementsByTagName('*');
  let s = 0; for (let i = 0; i < all.length; i++) s += all[i].textContent.length; // force full inflation
  void e.window.localStorage; void e.window.matchMedia('(x)'); void e.window.getComputedStyle(e.document.body);
  return s;
};
const one = bench(touchOne), all = bench(touchAll);
console.log('touch 1 node  ', Math.round(one).toLocaleString().padStart(10));
console.log('touch all+globs', Math.round(all).toLocaleString().padStart(10));
console.log(`\nNot building what isn't touched: light path is ${(one / all).toFixed(1)}x the full-inflation path.`);

// Surface-usage histogram across representative "tests".
console.log('\nSurface-usage histogram (globals materialized per representative test)\n');
const tests = {
  'render-only': (e) => { e.document.querySelectorAll('button'); },
  'reads-storage': (e) => { e.window.localStorage.getItem('x'); },
  'responsive': (e) => { e.window.matchMedia('(min-width: 600px)'); },
  'measures-style': (e) => { e.window.getComputedStyle(e.document.body); },
  'routing': (e) => { e.window.history.pushState({}, '', '/x'); },
  'observers': (e) => { new e.window.IntersectionObserver(() => {}); },
};
const histogram = new Map();
for (const [name, run] of Object.entries(tests)) {
  const e = createEnvironment(HTML);
  run(e);
  const touched = e.touched();
  for (const g of touched) histogram.set(g, (histogram.get(g) || 0) + 1);
  console.log(`  ${name.padEnd(16)} → ${touched.length ? touched.join(', ') : '(none — pure DOM)'}`);
}
console.log('\nGlobal materialization counts across tests:');
for (const [g, c] of [...histogram].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c)}×  ${g}`);
console.log('\nTakeaway: render-only tests construct ZERO lazy globals — the per-file win the design predicts.');
