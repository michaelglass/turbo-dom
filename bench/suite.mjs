// Phase 1 + Phase 3 wall-clock benchmarks:
//  (a) "real suite" — many small RTL-style tests, each constructing a fresh
//      per-file environment: turbo-dom vs jsdom vs happy-dom (the per-file cost
//      the design targets).
//  (b) lazy-vs-eager NODES within turbo-dom (does laziness earn its keep?).
//  (c) eager-vs-lazy WINDOW microbench (isolated global-construction cost).

import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { Window } = require('happy-dom');

// a representative component a "test file" renders + interacts with
const COMPONENT = `<!doctype html><html><body>
  <form>
    <label for="q">Search</label><input id="q" type="text" />
    <ul class="results">${Array.from({ length: 30 }, (_, i) => `<li class="row${i % 3 === 0 ? ' active' : ''}"><span>Item ${i}</span><button>buy</button></li>`).join('')}</ul>
    <button type="submit">Go</button>
  </form>
</body></html>`;

// engine-agnostic "test body" — runs the kind of work RTL tests do
function testBody(doc) {
  const items = doc.querySelectorAll('li');
  let n = items.length;
  const active = doc.querySelectorAll('li.active');
  n += active.length;
  const btn = doc.querySelector('button');
  let clicks = 0;
  btn.addEventListener('click', () => clicks++);
  btn.dispatchEvent(new (doc.defaultView || globalThis).Event('click', { bubbles: true }));
  const input = doc.getElementById('q');
  input.setAttribute('value', 'x');
  const first = doc.querySelector('li');
  first.classList.add('seen');
  n += first.textContent.length + clicks;
  return n;
}

const makers = {
  'turbo-dom': () => createEnvironment(COMPONENT).document,
  jsdom: () => new JSDOM(COMPONENT).window.document,
  'happy-dom': () => { const w = new Window(); return new w.DOMParser().parseFromString(COMPONENT, 'text/html'); },
};

function suiteWallClock(make, files = 200) {
  // warmup
  for (let i = 0; i < 10; i++) testBody(make());
  const start = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < files; i++) acc += testBody(make());   // fresh env per "file"
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, perFile: ms / files, acc };
}

console.log('\n(a) Real-suite wall-clock — 200 test files, fresh env each (lower better)\n');
const FILES = 200;
const base = suiteWallClock(makers['turbo-dom'], FILES);
for (const name of ['turbo-dom', 'jsdom', 'happy-dom']) {
  const r = suiteWallClock(makers[name], FILES);
  const rel = r.ms / base.ms;
  console.log(
    name.padEnd(11),
    (r.ms.toFixed(0) + ' ms').padStart(10),
    (r.perFile.toFixed(3) + ' ms/file').padStart(16),
    name === 'turbo-dom' ? '' : `${rel.toFixed(1)}x slower`
  );
}
console.log(`\nturbo-dom per-file setup+test: ${base.perFile.toFixed(3)} ms.`);

// (b) lazy vs eager NODES inside turbo-dom
console.log('\n(b) lazy vs eager nodes (turbo-dom, 200 files)\n');
function suiteEager(files = 200) {
  for (let i = 0; i < 10; i++) { const d = createEnvironment(COMPONENT).document; Array.from(d.getElementsByTagName('*')).forEach((e) => void e.textContent); testBody(d); }
  const start = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < files; i++) {
    const d = createEnvironment(COMPONENT).document;
    Array.from(d.getElementsByTagName('*')).forEach((e) => void e.textContent); // force full inflation
    acc += testBody(d);
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}
const lazyMs = suiteWallClock(makers['turbo-dom'], 200).ms;
const eagerMs = suiteEager(200);
console.log('lazy nodes ', lazyMs.toFixed(0).padStart(6), 'ms');
console.log('eager nodes', eagerMs.toFixed(0).padStart(6), 'ms', `(${(eagerMs / lazyMs).toFixed(2)}x)`);
console.log(`\nLaziness saves ${(100 * (1 - lazyMs / eagerMs)).toFixed(0)}% by not inflating untouched subtrees.`);

// (c) eager vs lazy WINDOW microbench (construction only, no DOM work)
console.log('\n(c) eager vs lazy window — construction only (ops/sec)\n');
const LAZY_GLOBALS = ['localStorage', 'sessionStorage', 'matchMedia', 'getComputedStyle', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'location', 'history', 'navigator', 'performance'];
function micro(fn, ms = 600) {
  for (let i = 0; i < 20; i++) fn();
  let n = 0; const start = process.hrtime.bigint(); const dl = start + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < dl) { fn(); n++; }
  return (n / (Number(process.hrtime.bigint() - start) / 1e6)) * 1000;
}
const lazyWin = micro(() => createEnvironment(COMPONENT));
const eagerWin = micro(() => { const e = createEnvironment(COMPONENT); for (const g of LAZY_GLOBALS) void e.window[g]; return e; });
console.log('lazy window ', Math.round(lazyWin).toLocaleString().padStart(10), 'constructs/sec');
console.log('eager window', Math.round(eagerWin).toLocaleString().padStart(10), 'constructs/sec', `(${(lazyWin / eagerWin).toFixed(2)}x faster lazy)`);
console.log('\nA render-only test pays the lazy column; it never builds the ~12 globals it never touches.');
