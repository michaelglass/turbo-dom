import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/runtime/selectors.mjs';
import { createEnvironment } from '../src/runtime/index.mjs';

const { parseSelectorList, parseComplex } = _internal;

// Parse a single complex selector (no top-level comma) and return its AST.
const one = (sel) => parseSelectorList(sel)[0];
// Build a fresh compound AST literal with only the fields a test cares about.
const cmp = (o = {}) => ({ tag: null, id: null, classes: [], attrs: [], pseudos: [], ...o });

// ── Parity corpus (mirrors the parallel Rust selector-parser effort) ─────────
// Each entry encodes a tricky tokenization/grammar case; we assert the exact AST
// the unchanged matcher consumes.
test('parity corpus: compounds, combinators, attrs, pseudos', () => {
  assert.deepEqual(one('div.card'), {
    compounds: [cmp({ tag: 'div', classes: ['card'] })],
    combinators: [],
  });
  assert.deepEqual(one('.grid .t'), {
    compounds: [cmp({ classes: ['grid'] }), cmp({ classes: ['t'] })],
    combinators: [' '],
  });
  assert.deepEqual(one('main > div'), {
    compounds: [cmp({ tag: 'main' }), cmp({ tag: 'div' })],
    combinators: ['>'],
  });
  assert.deepEqual(one('a[href]'), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'href', op: null, value: null }] })],
    combinators: [],
  });
  assert.deepEqual(one('a[data-k=v]'), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'data-k', op: '=', value: 'v' }] })],
    combinators: [],
  });
  assert.deepEqual(one("[data-k='v']"), {
    compounds: [cmp({ attrs: [{ name: 'data-k', op: '=', value: 'v' }] })],
    combinators: [],
  });
  assert.deepEqual(one("a[href^='/docs']"), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'href', op: '^=', value: '/docs' }] })],
    combinators: [],
  });
  assert.deepEqual(one("a[data-x*='oba']"), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'data-x', op: '*=', value: 'oba' }] })],
    combinators: [],
  });
  assert.deepEqual(one("a[class~='primary']"), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'class', op: '~=', value: 'primary' }] })],
    combinators: [],
  });
  assert.deepEqual(one("a[lang|='en']"), {
    compounds: [cmp({ tag: 'a', attrs: [{ name: 'lang', op: '|=', value: 'en' }] })],
    combinators: [],
  });
  // value containing spaces (quotes must protect the whitespace from tokenizing)
  assert.deepEqual(one('svg[viewBox="0 0 10 10"]'), {
    compounds: [cmp({ tag: 'svg', attrs: [{ name: 'viewBox', op: '=', value: '0 0 10 10' }] })],
    combinators: [],
  });
  // An+B with interior whitespace preserved in the raw arg
  assert.deepEqual(one('li:nth-child(2n + 1)'), {
    compounds: [cmp({ tag: 'li', pseudos: [{ name: 'nth-child', arg: '2n + 1' }] })],
    combinators: [],
  });
  // nested parens inside :not survive intact for the recursive re-parse
  assert.deepEqual(one(':not(:nth-child(2))'), {
    compounds: [cmp({ pseudos: [{ name: 'not', arg: ':nth-child(2)' }] })],
    combinators: [],
  });
  assert.deepEqual(one('.a > .b .c'), {
    compounds: [cmp({ classes: ['a'] }), cmp({ classes: ['b'] }), cmp({ classes: ['c'] })],
    combinators: ['>', ' '],
  });
  assert.deepEqual(one('p + i'), {
    compounds: [cmp({ tag: 'p' }), cmp({ tag: 'i' })],
    combinators: ['+'],
  });
  assert.deepEqual(one('p ~ b'), {
    compounds: [cmp({ tag: 'p' }), cmp({ tag: 'b' })],
    combinators: ['~'],
  });
  // lenient: a trailing bare type after a full compound is dropped (≡ div[id=x])
  assert.deepEqual(one('div[id=x]y'), {
    compounds: [cmp({ tag: 'div', attrs: [{ name: 'id', op: '=', value: 'x' }] })],
    combinators: [],
  });
});

// ── Leniency the matcher relies on ───────────────────────────────────────────
test('lenient div[id=x]y matches a <div id="x"> (no throw)', () => {
  const { document } = createEnvironment('<!doctype html><body><div id="x">hi</div></body>');
  assert.equal(document.querySelectorAll('div[id=x]y').length, 1);
  assert.equal(document.querySelector('div[id=x]y').textContent, 'hi');
});

test('redundant leading type / * is dropped (first wins)', () => {
  // a second type after a class is ignored; `*` only fills an unset tag
  assert.deepEqual(one('.foo*'), { compounds: [cmp({ tag: '*', classes: ['foo'] })], combinators: [] });
  assert.deepEqual(one('*'), { compounds: [cmp({ tag: '*' })], combinators: [] });
  assert.deepEqual(one('DIV'), { compounds: [cmp({ tag: 'div' })], combinators: [] }); // type lowercased
  assert.deepEqual(one('div*'), { compounds: [cmp({ tag: 'div' })], combinators: [] }); // redundant * dropped
});

// ── Throw cases preserved exactly ────────────────────────────────────────────
test('malformed selectors still throw SyntaxError', () => {
  assert.throws(() => parseSelectorList('>'), SyntaxError); // leading combinator ⇒ empty compound
  assert.throws(() => parseSelectorList('div!p'), SyntaxError); // unexpected char
  assert.throws(() => parseSelectorList('[href'), SyntaxError); // unterminated attribute
  assert.throws(() => parseSelectorList('a > > b'), SyntaxError); // empty compound between combinators
  assert.throws(() => parseSelectorList('a + > b'), SyntaxError);
});

// ── Empty / comma / whitespace edges (no throw — match old behavior) ─────────
test('empty complex selectors parse to empty (no throw)', () => {
  assert.deepEqual(parseSelectorList(''), [{ compounds: [], combinators: [] }]);
  assert.deepEqual(parseSelectorList('   '), [{ compounds: [], combinators: [] }]); // all-whitespace ⇒ empty
  assert.deepEqual(parseSelectorList(','), [
    { compounds: [], combinators: [] },
    { compounds: [], combinators: [] },
  ]);
  assert.equal(parseSelectorList('a,,b').length, 3);
  assert.deepEqual(parseSelectorList('a,,b')[1], { compounds: [], combinators: [] });
});

test('leading/trailing/repeated whitespace is trimmed; all whitespace kinds work', () => {
  assert.deepEqual(one('  a  b  '), {
    compounds: [cmp({ tag: 'a' }), cmp({ tag: 'b' })],
    combinators: [' '],
  });
  assert.deepEqual(one(' div '), { compounds: [cmp({ tag: 'div' })], combinators: [] });
  // tab + newline behave as descendant whitespace just like a space
  assert.deepEqual(one('a\tb'), { compounds: [cmp({ tag: 'a' }), cmp({ tag: 'b' })], combinators: [' '] });
  assert.deepEqual(one('a\r\n>\fb'), { compounds: [cmp({ tag: 'a' }), cmp({ tag: 'b' })], combinators: ['>'] });
});

test('dangling trailing combinator is kept harmlessly (a >)', () => {
  // mirrors the old behavior: `a >` yields a single compound + a stray combinator
  assert.deepEqual(one('a >'), { compounds: [cmp({ tag: 'a' })], combinators: ['>'] });
  const { document } = createEnvironment('<!doctype html><body><a>x</a></body>');
  assert.equal(document.querySelectorAll('a >').length, 1); // matches like `a`
});

// ── Attribute interior parsing ───────────────────────────────────────────────
test('attribute parsing: presence, every operator, quote stripping, empty values', () => {
  assert.deepEqual(one('[a]').compounds[0].attrs, [{ name: 'a', op: null, value: null }]);
  // whitespace around name/op/value is tolerated and trimmed
  assert.deepEqual(one('[ data-k = v ]').compounds[0].attrs, [{ name: 'data-k', op: '=', value: 'v' }]);
  // empty quoted values
  assert.deepEqual(one('[title=""]').compounds[0].attrs, [{ name: 'title', op: '=', value: '' }]);
  assert.deepEqual(one("[title='']").compounds[0].attrs, [{ name: 'title', op: '=', value: '' }]);
  assert.deepEqual(one('[href^=""]').compounds[0].attrs, [{ name: 'href', op: '^=', value: '' }]);
  // bare (unquoted) empty value after '='
  assert.deepEqual(one('[a=]').compounds[0].attrs, [{ name: 'a', op: '=', value: '' }]);
  // bare (unquoted) multi-char value is NOT quote-stripped
  assert.deepEqual(one('[href=index.html]').compounds[0].attrs, [{ name: 'href', op: '=', value: 'index.html' }]);
  // a ']' inside a quoted value must NOT close the attribute
  assert.deepEqual(one('[a="]"]').compounds[0].attrs, [{ name: 'a', op: '=', value: ']' }]);
  // value that opens with a quote but doesn't end with one is left intact (not stripped)
  assert.deepEqual(one('[x="a"b]').compounds[0].attrs, [{ name: 'x', op: '=', value: '"a"b' }]);
  // multiple attributes in one compound
  assert.deepEqual(one('a[b][c]').compounds[0].attrs, [
    { name: 'b', op: null, value: null },
    { name: 'c', op: null, value: null },
  ]);
  // each operator
  assert.equal(one('[x~=y]').compounds[0].attrs[0].op, '~=');
  assert.equal(one('[x|=y]').compounds[0].attrs[0].op, '|=');
  assert.equal(one('[x$=y]').compounds[0].attrs[0].op, '$=');
});

// ── Pseudo parsing ───────────────────────────────────────────────────────────
test('pseudo parsing: no-arg, arg, nested + quoted parens, unterminated arg', () => {
  assert.deepEqual(one(':first-child').compounds[0].pseudos, [{ name: 'first-child', arg: null }]);
  assert.deepEqual(one(':nth-child()').compounds[0].pseudos, [{ name: 'nth-child', arg: '' }]);
  assert.deepEqual(one(':not(.x)').compounds[0].pseudos, [{ name: 'not', arg: '.x' }]);
  // a quoted ')' inside the arg does not terminate it (double- and single-quoted)
  assert.deepEqual(one(':not([title=")"])').compounds[0].pseudos, [{ name: 'not', arg: '[title=")"]' }]);
  assert.deepEqual(one(":not([title=')'])").compounds[0].pseudos, [{ name: 'not', arg: "[title=')']" }]);
  // double colon + empty pseudo name are tolerated (unknown ⇒ never matches)
  assert.deepEqual(one('div::before').compounds[0].pseudos, [
    { name: '', arg: null },
    { name: 'before', arg: null },
  ]);
  // unterminated pseudo arg: take everything after '(' (lenient, no throw)
  assert.deepEqual(one(':not(.x').compounds[0].pseudos, [{ name: 'not', arg: '.x' }]);
});

// ── id / class edges + selector list + cache ────────────────────────────────
test('id/class names, empty names, comma list and parse cache', () => {
  assert.deepEqual(one('#app').compounds[0].id, 'app');
  assert.deepEqual(one('.x.y').compounds[0].classes, ['x', 'y']);
  assert.equal(one('#').compounds[0].id, ''); // empty id name tolerated
  assert.deepEqual(one('.').compounds[0].classes, ['']); // empty class name tolerated
  const list = parseSelectorList('h1, h2 , h3');
  assert.equal(list.length, 3);
  assert.equal(list[2].compounds[0].tag, 'h3');
  // cache: a second call returns the identical (cached) object
  assert.equal(parseSelectorList('.cached.sel'), parseSelectorList('.cached.sel'));
});

// ── the string-taking _internal.parseComplex wrapper ────────────────────────
test('_internal.parseComplex parses a single complex selector string', () => {
  assert.deepEqual(parseComplex('ul > li.active'), {
    compounds: [cmp({ tag: 'ul' }), cmp({ tag: 'li', classes: ['active'] })],
    combinators: ['>'],
  });
});
