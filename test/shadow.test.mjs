// Shadow DOM: attachShadow, encapsulation, event retargeting + composed
// crossing, scoped getComputedStyle, getRootNode/isConnected boundary hops.
// All of this is gated behind Document.__hasShadow — the no-shadow assertions
// at the bottom prove the fast paths stay untouched until a shadow is attached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const HTML = `<!doctype html><html><head></head><body><div id="host"></div></body></html>`;
const fresh = () => createEnvironment(HTML);

// ----------------------------------------------------- attachShadow ----
test('attachShadow(open) exposes shadowRoot + flips __hasShadow', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  assert.equal(document.__hasShadow, undefined);
  const root = host.attachShadow({ mode: 'open' });
  assert.equal(host.shadowRoot, root);
  assert.equal(root.host, host);
  assert.equal(root.mode, 'open');
  assert.equal(root.nodeType, 11);
  assert.equal(root.nodeName, '#document-fragment');
  assert.equal(root.__isShadowRoot, true);
  assert.equal(document.__hasShadow, true);
});

test('attachShadow(closed) hides shadowRoot but still attaches', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'closed' });
  assert.equal(host.shadowRoot, null);
  assert.equal(root.mode, 'closed');
  assert.equal(host.__shadow, root); // internal handle still set
});

test('delegatesFocus reflected; double attachShadow throws', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open', delegatesFocus: true });
  assert.equal(root.delegatesFocus, true);
  assert.throws(() => host.attachShadow({ mode: 'open' }), /already attached/);
});

// ------------------------------------------------------ encapsulation ----
test('host/document queries never reach into the shadow tree', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="inner" class="x">hi</span>';

  // shadow content is invisible to the light tree
  assert.equal(host.querySelector('#inner'), null);
  assert.equal(host.querySelector('span'), null);
  assert.equal(document.querySelector('#inner'), null);
  assert.equal(document.getElementById('inner'), null);
  assert.equal(document.getElementsByTagName('span').length, 0);
  assert.equal(document.getElementsByClassName('x').length, 0);

  // but the shadow root sees its own content
  const inner = root.querySelector('#inner');
  assert.ok(inner);
  assert.equal(root.getElementById('inner'), inner);
  assert.equal(root.querySelector('.x'), inner);
  assert.equal(root.getElementsByTagName('span').length, 1);
  assert.equal(root.getElementsByClassName('x').length, 1);
  assert.equal(inner.textContent, 'hi');
});

test('shadow innerHTML round-trips + is independently settable', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<b>one</b>';
  assert.match(root.innerHTML, /<b>one<\/b>/);
  root.innerHTML = '<i>two</i>';
  assert.match(root.innerHTML, /<i>two<\/i>/);
  assert.equal(root.querySelector('b'), null);
});

// -------------------------------------------- getRootNode / isConnected ----
test('getRootNode returns shadow root; composed climbs to document', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="inner"></span>';
  const inner = root.querySelector('#inner');

  assert.equal(inner.getRootNode(), root);
  assert.equal(inner.getRootNode({ composed: true }), document);
  // light DOM node unaffected
  assert.equal(host.getRootNode(), document);
  assert.equal(host.getRootNode({ composed: true }), document);
});

test('isConnected is true for shadow content of a connected host', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="inner"></span>';
  const inner = root.querySelector('#inner');
  assert.equal(inner.isConnected, true);

  // detach the host → shadow content no longer connected
  host.remove();
  assert.equal(inner.isConnected, false);
});

// -------------------------------------------------- event retargeting ----
test('event.target is retargeted to host for light-DOM listeners', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');

  const seen = {};
  document.addEventListener('ping', (e) => { seen.docTarget = e.target; seen.docPath = e.composedPath(); });
  root.addEventListener('ping', (e) => { seen.rootTarget = e.target; });
  btn.addEventListener('ping', (e) => { seen.btnTarget = e.target; });

  const { Event } = host.ownerDocument.defaultView;
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));

  // inside the shadow tree the real target is visible
  assert.equal(seen.btnTarget, btn);
  assert.equal(seen.rootTarget, btn);
  // outside (document) it is retargeted to the host
  assert.equal(seen.docTarget, host);
  // full composed path crosses the boundary
  assert.ok(seen.docPath.includes(btn));
  assert.ok(seen.docPath.includes(root));
  assert.ok(seen.docPath.includes(host));
});

test('event.target restored to original after dispatch', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');
  document.addEventListener('ping', () => {});
  const { Event } = document.defaultView;
  const ev = new Event('ping', { bubbles: true, composed: true });
  btn.dispatchEvent(ev);
  assert.equal(ev.target, btn);
});

test('composed:false event does NOT escape the shadow boundary', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');

  let docFired = 0, rootFired = 0;
  document.addEventListener('ping', () => { docFired++; });
  root.addEventListener('ping', () => { rootFired++; });

  const { Event } = document.defaultView;
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: false }));
  assert.equal(rootFired, 1);  // reaches the shadow root
  assert.equal(docFired, 0);   // but not past it
});

test('composed:true event bubbles all the way to document', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');

  let docFired = 0;
  document.addEventListener('ping', () => { docFired++; });
  const { Event } = document.defaultView;
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.equal(docFired, 1);
});

test('capture + bubble order is correct across the boundary', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');

  const order = [];
  document.addEventListener('ping', () => order.push('doc-capture'), true);
  document.addEventListener('ping', () => order.push('doc-bubble'), false);
  btn.addEventListener('ping', () => order.push('btn'));

  const { Event } = document.defaultView;
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.deepEqual(order, ['doc-capture', 'btn', 'doc-bubble']);
});

test('nested shadow retargets through each host', () => {
  const { document } = fresh();
  const outerHost = document.getElementById('host');
  const outer = outerHost.attachShadow({ mode: 'open' });
  outer.innerHTML = '<div id="mid"></div>';
  const mid = outer.querySelector('#mid');
  const inner = mid.attachShadow({ mode: 'open' });
  inner.innerHTML = '<button id="b">x</button>';
  const btn = inner.querySelector('#b');

  const seen = {};
  document.addEventListener('ping', (e) => { seen.doc = e.target; });
  outer.addEventListener('ping', (e) => { seen.outer = e.target; });
  inner.addEventListener('ping', (e) => { seen.inner = e.target; });

  const { Event } = document.defaultView;
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.equal(seen.inner, btn);        // same tree → real target
  assert.equal(seen.outer, mid);        // one boundary out → mid host
  assert.equal(seen.doc, outerHost);    // two boundaries out → outer host
});

// ----------------------------------------------------- scoped cascade ----
test('getComputedStyle scopes <style> to the shadow root (both directions)', () => {
  const { window, document } = fresh();
  // document-level style that names .leaf — must NOT apply inside the shadow
  document.head.innerHTML = '<style>.leaf { color: red; }</style>';
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.leaf { color: green; }</style><span class="leaf" id="inner">hi</span>';
  const inner = root.querySelector('#inner');

  // a light-DOM element with the same class still gets the document rule
  document.body.insertAdjacentHTML('beforeend', '<span class="leaf" id="lite">x</span>');
  const lite = document.getElementById('lite');

  const gcs = window.getComputedStyle;
  assert.equal(gcs(inner).color, 'rgb(0, 128, 0)'); // shadow rule wins inside
  assert.equal(gcs(lite).color, 'rgb(255, 0, 0)');    // document rule for light DOM
});

test('document <style> does not leak into shadow tree', () => {
  const { window, document } = fresh();
  document.head.innerHTML = '<style>span { color: red; }</style>';
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="inner">hi</span>'; // no shadow rule for span
  const inner = root.querySelector('#inner');
  // encapsulated → no matching rule in scope → honest empty string
  assert.equal(window.getComputedStyle(inner).color, '');
});

test('shadow style cache invalidates on shadow mutation', () => {
  const { window, document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.leaf{color:green}</style><span class="leaf" id="i">x</span>';
  const inner = root.querySelector('#i');
  assert.equal(window.getComputedStyle(inner).color, 'rgb(0, 128, 0)');
  root.querySelector('style').textContent = '.leaf{color:blue}';
  assert.equal(window.getComputedStyle(inner).color, 'rgb(0, 0, 255)');
});

// --------------------------------------------- fast path stays intact ----
test('no-shadow document: event.target + cascade behave exactly as before', () => {
  const { window, document } = fresh();
  assert.equal(document.__hasShadow, undefined);
  document.head.innerHTML = '<style>#host{color:red}</style>';
  const host = document.getElementById('host');
  let target = null;
  document.addEventListener('ping', (e) => { target = e.target; });
  const { Event } = window;
  host.dispatchEvent(new Event('ping', { bubbles: true }));
  assert.equal(target, host); // never retargeted
  assert.equal(window.getComputedStyle(host).color, 'rgb(255, 0, 0)');
});

test('ShadowRoot is a global constructor reference', () => {
  const { window } = fresh();
  assert.equal(typeof window.ShadowRoot, 'function');
  assert.equal(window.ShadowRoot.name, 'ShadowRoot');
});

// ---------------------------------------------------------------------------
// Regression guards: propagation control across the boundary, the once-shadow-
// is-attached-the-whole-doc-uses-the-slow-walk latch, scoping, clone isolation.
// ---------------------------------------------------------------------------

// helper: host + open shadow with a button inside
function withShadowButton(mode = 'open') {
  const env = fresh();
  const host = env.document.getElementById('host');
  const root = host.attachShadow({ mode });
  root.innerHTML = '<button id="b">x</button>';
  return { ...env, host, root, btn: root.querySelector('#b'), Event: env.window.Event };
}

test('stopPropagation inside shadow halts the composed climb', () => {
  const { document, root, btn, Event } = withShadowButton();
  let docFired = 0, rootFired = 0;
  document.addEventListener('ping', () => { docFired++; });
  root.addEventListener('ping', () => { rootFired++; });
  btn.addEventListener('ping', (e) => { e.stopPropagation(); });
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.equal(rootFired, 0);
  assert.equal(docFired, 0);
});

test('stopImmediatePropagation skips later listeners on the same node', () => {
  const { document, btn, Event } = withShadowButton();
  const hits = [];
  btn.addEventListener('ping', (e) => { hits.push('a'); e.stopImmediatePropagation(); });
  btn.addEventListener('ping', () => { hits.push('b'); });
  document.addEventListener('ping', () => { hits.push('doc'); });
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.deepEqual(hits, ['a']);
});

test('preventDefault from a document listener crosses back as return value', () => {
  const { document, btn, Event } = withShadowButton();
  document.addEventListener('ping', (e) => { e.preventDefault(); });
  const ok = btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true, cancelable: true }));
  assert.equal(ok, false);
});

test('once listener across the boundary fires exactly once', () => {
  const { document, btn, Event } = withShadowButton();
  let n = 0;
  document.addEventListener('ping', () => { n++; }, { once: true });
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.equal(n, 1);
});

test('closed shadow root retargets exactly like open', () => {
  const { document, host, btn, Event } = withShadowButton('closed');
  let seen = null;
  document.addEventListener('ping', (e) => { seen = e.target; });
  btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true }));
  assert.equal(seen, host);
});

test('capture reaches shadow root before target; composedPath order is exact', () => {
  const { document, host, root, btn, Event } = withShadowButton();
  const order = [];
  root.addEventListener('ping', () => order.push('root-capture'), true);
  btn.addEventListener('ping', () => order.push('btn'));
  document.addEventListener('ping', () => order.push('doc-bubble'));
  const ev = new Event('ping', { bubbles: true, composed: true });
  let path;
  btn.addEventListener('ping', (e) => { path = e.composedPath(); });
  btn.dispatchEvent(ev);
  assert.deepEqual(order, ['root-capture', 'btn', 'doc-bubble']);
  // path is target → ... → host → ... → document → window (target first)
  assert.equal(path[0], btn);
  assert.ok(path.indexOf(root) < path.indexOf(host)); // shadow root below host
  assert.ok(path.indexOf(host) < path.indexOf(document));
});

test('LIGHT-DOM events are unaffected once a shadow exists elsewhere', () => {
  // attach a shadow somewhere → __hasShadow latches → every dispatch takes the
  // shadow-aware walk. A plain light-DOM event must still behave identically.
  const { document, window } = fresh();
  document.getElementById('host').attachShadow({ mode: 'open' });
  assert.equal(document.__hasShadow, true);

  document.body.insertAdjacentHTML('beforeend', '<div id="outer"><span id="leaf">x</span></div>');
  const outer = document.getElementById('outer');
  const leaf = document.getElementById('leaf');

  const order = [];
  let leafTarget = null, docTarget = null, stopFired = 0;
  document.addEventListener('tap', (e) => { docTarget = e.target; order.push('doc'); });
  outer.addEventListener('tap', () => order.push('outer'));
  leaf.addEventListener('tap', (e) => { leafTarget = e.target; order.push('leaf'); });

  const { Event } = window;
  leaf.dispatchEvent(new Event('tap', { bubbles: true }));
  assert.equal(leafTarget, leaf);  // NOT retargeted (no boundary crossed)
  assert.equal(docTarget, leaf);
  assert.deepEqual(order, ['leaf', 'outer', 'doc']);

  // stopPropagation in light DOM still works under the shadow walk
  let blocked = 0;
  outer.addEventListener('halt', (e) => e.stopPropagation());
  document.addEventListener('halt', () => { blocked++; });
  leaf.dispatchEvent(new Event('halt', { bubbles: true }));
  assert.equal(blocked, 0);
});

test('cloneNode on host does NOT carry the shadow root', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<span>x</span>';
  const clone = host.cloneNode(true);
  assert.equal(clone.shadowRoot, null);
  assert.equal(clone.__shadow, undefined);
});

test('two shadow roots scope queries + styles independently', () => {
  const { window, document } = fresh();
  document.body.insertAdjacentHTML('beforeend', '<div id="h2"></div>');
  const r1 = document.getElementById('host').attachShadow({ mode: 'open' });
  const r2 = document.getElementById('h2').attachShadow({ mode: 'open' });
  r1.innerHTML = '<style>.leaf{color:green}</style><b class="leaf" id="i1">a</b>';
  r2.innerHTML = '<style>.leaf{color:blue}</style><b class="leaf" id="i2">b</b>';

  // queries don't bleed across roots
  assert.ok(r1.getElementById('i1'));
  assert.equal(r1.getElementById('i2'), null);
  assert.equal(r2.getElementById('i1'), null);

  // each scope resolves its own rule
  const gcs = window.getComputedStyle;
  assert.equal(gcs(r1.querySelector('#i1')).color, 'rgb(0, 128, 0)');
  assert.equal(gcs(r2.querySelector('#i2')).color, 'rgb(0, 0, 255)');
});

test('shadow getElementById / querySelectorAll honest + scoped', () => {
  const { document } = fresh();
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<p class="x">1</p><p class="x">2</p><span>3</span>';
  assert.equal(root.getElementById('nope'), null);
  assert.equal(root.querySelectorAll('p').length, 2);
  assert.equal(root.querySelectorAll('.x').length, 2);
  assert.equal(root.querySelectorAll('span').length, 1);
});

test('inline style + specificity resolve within shadow scope', () => {
  const { window, document } = fresh();
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>.c{color:green} #t{color:red}</style>' +
    '<b id="t" class="c" style="color:purple">x</b>';
  const el = root.querySelector('#t');
  // inline beats id beats class — all resolved against the shadow stylesheet
  assert.equal(window.getComputedStyle(el).color, 'rgb(128, 0, 128)');
});

test('closest / matches do not escape the shadow boundary', () => {
  const { document } = fresh();
  const host = document.getElementById('host');
  host.id = 'host'; host.setAttribute('data-zone', 'outer');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<section><span id="leaf">x</span></section>';
  const leaf = root.querySelector('#leaf');
  assert.ok(leaf.closest('section'));        // found within shadow
  assert.equal(leaf.closest('[data-zone]'), null); // host attr is across the boundary
  assert.equal(leaf.matches('#host'), false);
});

test('listener-less composed event runs without error and returns true', () => {
  const { document } = fresh();
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">x</button>';
  const btn = root.querySelector('#b');
  const { Event } = document.defaultView;
  assert.equal(btn.dispatchEvent(new Event('ping', { bubbles: true, composed: true })), true);
});
