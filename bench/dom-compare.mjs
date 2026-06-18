// Cross-DOM benchmark: the SAME chatty workload across jsdom, happy-dom, the
// turbo-dom JS runtime, and (printed alongside) the rtdom native Rust runtime.
//
//   node bench/dom-compare.mjs
//
// Workload (identical to src/rtdom/bench.rs / bench/spike.mjs): parse a 300-card
// grid + querySelectorAll('div.card') ONCE (outside timing), then per-node:
// getAttribute('class') + getAttribute('data-testid') + tagName + parent-walk to
// root. Measures per-node DOM access throughput (best-of-6).

import { JSDOM } from 'jsdom';
import { Window } from 'happy-dom';
import { createEnvironment } from '../src/runtime/index.mjs';

const N = 300;
let html = '<!doctype html><html><body><main class="grid">';
for (let i = 0; i < N; i++) {
  html += `<div class="card sx-${i % 7}" data-testid="card-${i}" id="c${i}">` +
          `<h2 class="title">T${i}</h2><p>body</p><button type="button">Go</button></div>`;
}
html += '</main></body></html>';

// identical per-node workload over a fixed element list
function workload(els) {
  let sink = 0;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const c = el.getAttribute('class');
    if (c) sink += c.length;
    const t = el.getAttribute('data-testid');
    if (t) sink += t.length;
    const tag = el.tagName;
    if (tag) sink += tag.length;
    let p = el.parentNode, depth = 0;
    while (p) { depth++; p = p.parentNode; }
    sink += depth;
  }
  return sink;
}

function bestOf(getEls, ms = 500, runs = 6) {
  const els = getEls();
  let best = 0, sink = 0;
  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < 100; i++) sink += workload(els);
    let iters = 0;
    const start = process.hrtime.bigint();
    const deadline = start + BigInt(ms) * 1_000_000n;
    while (process.hrtime.bigint() < deadline) { sink += workload(els); iters++; }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const ops = (iters / elapsed) * 1000;
    if (ops > best) best = ops;
  }
  return { best, sink, count: els.length };
}

// --- impls: parse + qsa once → fixed element list ---
const impls = {
  jsdom: () => [...new JSDOM(html).window.document.querySelectorAll('div.card')],
  'happy-dom': () => {
    const w = new Window();
    const doc = new w.DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('div.card')];
  },
  'turbo-dom (JS runtime)': () => [...createEnvironment(html).document.querySelectorAll('div.card')],
};

console.log(`fixture: ${N} cards, ${html.length} bytes`);
console.log(`workload: qsa('div.card') once → per-node getAttribute x2 + tagName + parent-walk\n`);

const results = {};
for (const [name, setup] of Object.entries(impls)) {
  const r = bestOf(setup);
  results[name] = r.best;
  console.log(`  ${name.padEnd(24)} ${Math.round(r.best).toLocaleString().padStart(10)} ops/s   (${r.count} cards, sink ${r.sink % 100003})`);
}

// rtdom native number is measured separately (Rust bench); pass via env for the ratio table
const rtdom = Number(process.env.RTDOM_OPS || 0);
console.log('\n=== summary (ops/s, higher = faster) ===');
const base = results['turbo-dom (JS runtime)'];
const rows = Object.entries(results);
if (rtdom > 0) rows.push(['rtdom (native Rust, in-process)', rtdom]);
rows.sort((a, b) => a[1] - b[1]);
for (const [name, ops] of rows) {
  const vsBase = base ? (ops / base).toFixed(2) + '× turbo-dom-JS' : '';
  console.log(`  ${name.padEnd(32)} ${Math.round(ops).toLocaleString().padStart(10)}   ${vsBase}`);
}
if (rtdom === 0) console.log('\n(run with RTDOM_OPS=<n> to include the rtdom native number — see npm run bench:rtdom-native)');
