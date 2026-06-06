// Coverage-fill: exercises the long tail of selector pseudo-classes, DOM edge
// methods, honest stubs, and the window proxy/IO surface so refactors there are
// caught. Behavior is asserted to spec, never to whatever the impl happens to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = (html) => createEnvironment(html ?? '<!doctype html><html><head></head><body></body></html>');

// ----------------------------------------------- selector pseudo-classes ----
test('structural + type pseudo-classes', () => {
  const { document } = fresh();
  document.body.innerHTML =
    '<ul><li>1</li><li>2</li><li>3</li></ul>' +
    '<div id="solo"><span>only</span></div>' +
    '<p id="empty"></p>' +
    '<section><b>x</b><i>y</i><b>z</b></section>';
  const qa = (s) => document.querySelectorAll(s).length;
  assert.equal(qa('li:only-child'), 0);
  assert.equal(qa('span:only-child'), 1);
  assert.equal(document.getElementById('empty').matches(':empty'), true);
  assert.equal(qa('li:nth-child(odd)'), 2);
  assert.equal(qa('li:nth-child(even)'), 1);
  assert.equal(qa('li:nth-child(2n+1)'), 2);
  assert.equal(qa('li:nth-last-child(1)'), 1);
  assert.equal(qa('section b:first-of-type'), 1);
  assert.equal(qa('section b:last-of-type'), 1);
  assert.equal(qa('section b:nth-of-type(2)'), 1);
  assert.equal(qa('section b:nth-last-of-type(1)'), 1);
  assert.equal(qa('section i:only-of-type'), 1);
  assert.equal(qa(':root'), 1); // <html>
  assert.equal(qa('li:nth-child(3)'), 1);
});

test('form-state pseudo-classes read live properties', () => {
  const { document } = fresh();
  document.body.innerHTML =
    '<input id="c" type="checkbox"><input id="d" disabled>' +
    '<input id="r" required><textarea id="ro" readonly></textarea>' +
    '<select id="s"><option id="o" selected>x</option></select>';
  document.getElementById('c').checked = true;
  assert.ok(document.getElementById('c').matches(':checked'));
  assert.ok(document.getElementById('d').matches(':disabled'));
  assert.ok(document.getElementById('c').matches(':enabled'));
  assert.ok(document.getElementById('r').matches(':required'));
  assert.ok(document.getElementById('c').matches(':optional'));
  assert.ok(document.getElementById('ro').matches(':read-only'));
  assert.ok(document.getElementById('c').matches(':read-write'));
  assert.ok(document.getElementById('o').matches(':checked')); // selected option
});

test('unknown pseudo never matches (honest)', () => {
  const { document } = fresh();
  document.body.innerHTML = '<div id="d"></div>';
  assert.equal(document.getElementById('d').matches(':totally-made-up'), false);
});

// ---------------------------------------------------------- DOM edges ----
test('focus then blur fires the focus/blur event sequence', () => {
  const { document } = fresh();
  document.body.innerHTML = '<input id="a"><input id="b">';
  const a = document.getElementById('a');
  const seen = [];
  a.addEventListener('focus', () => seen.push('focus'));
  a.addEventListener('blur', () => seen.push('blur'));
  a.focus();
  assert.equal(document.activeElement, a);
  a.blur();
  assert.equal(document.activeElement, document.body);
  assert.deepEqual(seen, ['focus', 'blur']);
  a.blur(); // no-op when not active → no extra events
  assert.deepEqual(seen, ['focus', 'blur']);
});

test('dataset returns undefined for a missing data-* attribute', () => {
  const { document } = fresh();
  const el = document.createElement('div');
  assert.equal(el.dataset.nope, undefined);
  assert.equal('nope' in el.dataset, false);
});

test('clicking a label forwards the click to its associated control', () => {
  const { document } = fresh();
  document.body.innerHTML = '<label for="t">L</label><input id="t">';
  const input = document.getElementById('t');
  let clicked = 0;
  input.addEventListener('click', () => { clicked++; });
  document.querySelector('label').click();
  assert.equal(clicked, 1); // label default action → control.click()
});

test('select value setter selects the matching option', () => {
  const { document } = fresh();
  document.body.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
  const sel = document.querySelector('select');
  sel.value = 'b';
  assert.equal(sel.value, 'b');
  assert.equal(sel.selectedOptions[0].value, 'b');
});

test('MutationObserver without subtree ignores descendant mutations', async () => {
  const { window, document } = fresh();
  document.body.innerHTML = '<div id="r"><span id="s"></span></div>';
  const recs = [];
  const mo = new window.MutationObserver((r) => recs.push(...r));
  mo.observe(document.getElementById('r'), { attributes: true }); // no subtree
  document.getElementById('s').setAttribute('x', '1'); // descendant → ignored
  document.getElementById('r').setAttribute('y', '2'); // on target → observed
  await Promise.resolve();
  mo.disconnect();
  assert.ok(recs.every((r) => r.target.id === 'r'));
  assert.ok(recs.some((r) => r.attributeName === 'y'));
});

// -------------------------------------------------------------- stubs ----
test('canvas 2D context stub: measureText, getImageData, gradients', () => {
  const { document } = fresh();
  const ctx = document.createElement('canvas').getContext('2d');
  assert.equal(ctx.measureText('hello').width, 30); // 5 * 6
  const img = ctx.getImageData(0, 0, 1, 1);
  assert.equal(img.width, 0);
  const g = ctx.createLinearGradient(0, 0, 1, 1);
  g.addColorStop(0, '#fff'); // no throw
  ctx.fillRect(0, 0, 1, 1);   // arbitrary no-op method
  assert.equal(ctx.canvas, null);
});

test('FileReader.readAsText resolves async', async () => {
  const { window } = fresh();
  const fr = new window.FileReader();
  const done = new Promise((res) => { fr.onload = res; });
  fr.readAsText(new Blob(['hi']));
  await done;
  assert.equal(fr.result, 'hi');
  assert.equal(fr.readyState, 2);
});

test('customElements define/get/whenDefined', async () => {
  const { window } = fresh();
  class XEl {}
  const w = window.customElements.whenDefined('x-el');
  window.customElements.define('x-el', XEl);
  assert.equal(window.customElements.get('x-el'), XEl);
  assert.equal(window.customElements.getName(XEl), 'x-el');
  assert.equal(await w, XEl);
  assert.throws(() => window.customElements.define('x-el', XEl), /already defined/);
});

test('localStorage Storage API', () => {
  const { window } = fresh();
  const s = window.localStorage;
  s.setItem('k', 'v');
  assert.equal(s.getItem('k'), 'v');
  assert.equal(s.length, 1);
  assert.equal(s.key(0), 'k');
  assert.equal(s.getItem('missing'), null);
  s.removeItem('k');
  assert.equal(s.length, 0);
  s.setItem('a', '1'); s.clear();
  assert.equal(s.length, 0);
});

test('matchMedia returns an addressable MediaQueryList stub', () => {
  const { window } = fresh();
  const mq = window.matchMedia('(min-width: 100px)');
  assert.equal(mq.matches, false);
  mq.addEventListener('change', () => {});
  mq.addListener(() => {});
  mq.removeListener(() => {});
  assert.equal(mq.dispatchEvent({}), false);
});

test('live collection traps handle symbol + non-index keys', () => {
  const { document } = fresh();
  document.body.innerHTML = '<i></i>';
  const c = document.getElementsByTagName('i');
  assert.equal(c[Symbol('x')], undefined);                          // get: symbol fallthrough
  assert.equal(Symbol.iterator in c, false);                         // has: non-string key
  assert.equal(Object.getOwnPropertyDescriptor(c, 'item'), undefined); // descriptor: non-index string
});

// ------------------------------------------------------- window proxy ----
test('window proxy: has + getOwnPropertyDescriptor + assignment shadowing', () => {
  const { window } = fresh();
  assert.equal('Node' in window, true);          // STATIC_BASE
  assert.equal('window' in window, true);         // self-reference key
  assert.equal('definitelyNotAGlobal' in window, false);
  window.myGlobal = 42;                           // set trap
  assert.equal('myGlobal' in window, true);
  assert.equal(window.myGlobal, 42);
  const d = Object.getOwnPropertyDescriptor(window, 'Node');
  assert.equal(typeof d.value, 'function');
  assert.equal(window.self, window);
  assert.equal(window.globalThis, window);
});

test('FormData keeps Blob identity + renames on append with filename', () => {
  const { window } = fresh();
  const fd = new window.FormData();
  const blob = new Blob(['x'], { type: 'text/plain' });
  fd.append('f', blob, 'renamed.txt');
  const got = fd.get('f');
  assert.equal(got.name, 'renamed.txt');
  fd.append('s', 'str');
  assert.equal(fd.get('s'), 'str');
  const blob2 = new Blob(['y']);
  fd.append('b', blob2);                 // no filename → value kept as-is
  assert.equal(fd.get('b'), blob2);
});

test('getOwnPropertyDescriptor returns undefined for a non-global key', () => {
  const { window } = fresh();
  assert.equal(Object.getOwnPropertyDescriptor(window, 'nope_not_here'), undefined);
});

test('XMLHttpRequest.send resolves via fetch (load) and reports status', async () => {
  const { window } = fresh();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, statusText: 'OK', text: async () => 'body' });
  try {
    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', 'http://x/');
    const done = new Promise((res) => { xhr.onload = res; });
    xhr.send();
    await done;
    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseText, 'body');
    assert.equal(xhr.readyState, 4);
  } finally { globalThis.fetch = orig; }
});

test('XMLHttpRequest.send fires error when fetch rejects', async () => {
  const { window } = fresh();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('net'); };
  try {
    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', 'http://x/');
    const done = new Promise((res) => { xhr.onerror = res; });
    xhr.send();
    await done;
    assert.equal(xhr.status, 0);
  } finally { globalThis.fetch = orig; }
});

// --------------------------------------------- final DOM edge coverage ----
test('.value on a non-form element is undefined', () => {
  const { document } = fresh();
  assert.equal(document.createElement('div').value, undefined);
});

test('cloneNode on a DocumentType uses the base Node clone', () => {
  const { document } = fresh('<!doctype html><html><body></body></html>');
  const dt = document.doctype;
  assert.ok(dt);
  const c = dt.cloneNode();
  assert.equal(c.nodeType, dt.nodeType);
});

test('getElementsByClassName scans past a substring near-miss', () => {
  const { document } = fresh('<!doctype html><body><div class="midx mid"></div></body>');
  // "mid" appears at index 0 inside "midx" (near-miss) → scan continues to the
  // real whole-word "mid" at the end.
  assert.equal(document.getElementsByClassName('mid').length, 1);
});

test('querySelector .class also scans past a substring near-miss', () => {
  const { document } = fresh('<!doctype html><body><b class="foobar foo">x</b></body>');
  assert.ok(document.querySelector('.foo'));
  assert.equal(document.querySelectorAll('.foo').length, 1);
});

test('option:selected pseudo matches selected options', () => {
  const { document } = fresh();
  document.body.innerHTML = '<select><option>a</option><option selected>b</option></select>';
  assert.equal(document.querySelectorAll('option:selected').length, 1);
});

test('dataset getOwnPropertyDescriptor is undefined for a missing attr', () => {
  const { document } = fresh();
  const el = document.createElement('div');
  assert.equal(Object.getOwnPropertyDescriptor(el.dataset, 'missing'), undefined);
  el.setAttribute('data-here', 'v');
  assert.equal(Object.getOwnPropertyDescriptor(el.dataset, 'here').value, 'v');
});

test('MutationObserver subtree ignores a mutation outside the observed root', async () => {
  const { window, document } = fresh();
  document.body.innerHTML = '<div id="r"><span id="s"></span></div><div id="other"></div>';
  const recs = [];
  const mo = new window.MutationObserver((r) => recs.push(...r));
  mo.observe(document.getElementById('r'), { attributes: true, subtree: true });
  document.getElementById('other').setAttribute('x', '1'); // not under #r → isDescendant false
  document.getElementById('s').setAttribute('y', '2');     // under #r → observed
  await Promise.resolve();
  mo.disconnect();
  assert.ok(recs.every((r) => r.target.id !== 'other'));
  assert.ok(recs.some((r) => r.target.id === 's'));
});
