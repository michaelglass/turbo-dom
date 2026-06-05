// Phase 3, test strategy #1: differential testing vs jsdom AND happy-dom.
// Generate deterministic random DOM op sequences, apply identically to all three
// engines, and compare canonical trees.
//
// jsdom is the strict oracle (spec-correct): fast-dom MUST match it exactly.
// happy-dom is also compared — but where happy-dom disagrees with jsdom, that is
// happy-dom's bug, and fast-dom is allowed to side with jsdom. The test fails only
// if fast-dom diverges from jsdom, or if fast-dom diverges from happy-dom on an op
// where happy-dom and jsdom actually agree (i.e. a real fast-dom bug).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { Window } = require('happy-dom');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// canonical structural serialization over the STANDARD DOM API (works on all three)
function canon(node) {
  const attrs = Array.from(node.attributes)
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(',');
  let kids = '';
  node.childNodes.forEach((c) => {
    if (c.nodeType === 1) kids += canon(c);
    else if (c.nodeType === 3 && c.data.trim() !== '') kids += `"${c.data.trim()}"`;
  });
  return `${node.localName}[${attrs}]{${kids}}`;
}

const INITIAL = `<!doctype html><html><body><div id="root"><span class="a">1</span><span class="b">2</span></div></body></html>`;

function happyDoc() {
  const w = new Window();
  return new w.DOMParser().parseFromString(INITIAL, 'text/html');
}

function applyOps(document, rng) {
  const root = document.getElementById('root');
  for (let i = 0; i < 60; i++) {
    const els = Array.from(document.getElementsByTagName('*')).filter(
      (e) => e.localName !== 'html' && e.localName !== 'head' && e.localName !== 'body'
    );
    const pick = () => els[Math.floor(rng() * els.length)];
    const el = pick();
    if (!el) continue;
    const choice = Math.floor(rng() * 7);
    try {
      switch (choice) {
        case 0: { const c = document.createElement('div'); c.setAttribute('data-n', String(i)); el.appendChild(c); break; }
        case 1: el.setAttribute('data-k', 'v' + (i % 5)); break;
        case 2: el.removeAttribute('data-k'); break;
        case 3: el.classList.toggle('on'); break;
        case 4: { const t = pick(); if (t && t !== el && el.parentNode && !t.contains(el)) el.parentNode.insertBefore(t, el); break; }
        case 5: { const c = document.createElement('span'); c.textContent = 'x' + i; el.appendChild(c); break; }
        case 6: if (el !== root && el.parentNode && el.parentNode.localName !== 'body') el.remove(); break;
      }
    } catch { /* a rejected op must be rejected by all; divergence shows in canon */ }
  }
}

for (const seed of [1, 7, 42, 1337, 90210]) {
  test(`3-way differential — seed ${seed}`, () => {
    const fast = createEnvironment(INITIAL).document;
    const jdom = new JSDOM(INITIAL).window.document;
    const hdom = happyDoc();

    applyOps(fast, mulberry32(seed));
    applyOps(jdom, mulberry32(seed));
    applyOps(hdom, mulberry32(seed));

    const cf = canon(fast.body), cj = canon(jdom.body), ch = canon(hdom.body);

    // hard oracle: fast-dom must match jsdom exactly
    assert.equal(cf, cj, `fast-dom diverged from jsdom @ seed ${seed}`);

    // happy-dom: only a fast-dom bug if happy-dom AGREES with jsdom yet fast-dom doesn't.
    // (cf===cj already holds here, so this just records when happy-dom itself diverged.)
    if (ch !== cj) {
      // happy-dom is the diverger; fast-dom correctly sided with jsdom. Informational.
      // (no assertion — this is happy-dom's known incorrectness)
    } else {
      assert.equal(cf, ch, `fast-dom diverged from happy-dom where happy-dom matched jsdom @ seed ${seed}`);
    }
  });
}

test('querySelectorAll parity vs jsdom AND happy-dom', () => {
  const html = `<!doctype html><body>
    <ul><li class="x">a</li><li>b</li><li class="x sel">c</li></ul>
    <div data-role="m"><p>one</p><p class="p">two</p></div>
  </body>`;
  const fast = createEnvironment(html).document;
  const jdom = new JSDOM(html).window.document;
  const hdom = (() => { const w = new Window(); return new w.DOMParser().parseFromString(html, 'text/html'); })();

  const selectors = ['li', 'li.x', 'ul > li', '[data-role="m"] p', '.x.sel', 'li:not(.x)', 'div p.p', 'li + li'];
  for (const sel of selectors) {
    const f = fast.querySelectorAll(sel).length;
    const j = jdom.querySelectorAll(sel).length;
    const h = hdom.querySelectorAll(sel).length;
    assert.equal(f, j, `selector "${sel}": fast-dom ${f} != jsdom ${j}`);
    // happy-dom must also agree on these simple selectors
    assert.equal(f, h, `selector "${sel}": fast-dom ${f} != happy-dom ${h}`);
  }
});

test('liveness property holds in all three engines', () => {
  const html = `<!doctype html><body><ul><li>a</li><li>b</li></ul></body>`;
  const docs = [
    createEnvironment(html).document,
    new JSDOM(html).window.document,
    (() => { const w = new Window(); return new w.DOMParser().parseFromString(html, 'text/html'); })(),
  ];
  for (const doc of docs) {
    const ul = doc.querySelector('ul');
    const live = ul.children;
    const before = live.length;
    ul.appendChild(doc.createElement('li'));
    assert.equal(live.length, before + 1);
  }
});
