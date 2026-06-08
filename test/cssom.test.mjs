// Minimal CSSOM (#4b): <style>.sheet, document.styleSheets, insertRule/deleteRule
// and their integration with the partial cascade (getComputedStyle). Plus the
// bare-V8 utf8Decode fallback (#4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';
import { utf8Decode } from '../src/runtime/buffer.mjs';

const fresh = (html) => createEnvironment(html ?? '<!doctype html><html><head></head><body></body></html>');

test('<style>.sheet is a CSSStyleSheet; non-style elements have no sheet', () => {
  const { document } = fresh();
  const style = document.createElement('style');
  document.head.appendChild(style);
  const sheet = style.sheet;
  assert.ok(sheet, 'style has a sheet');
  assert.equal(style.sheet, sheet, 'sheet is memoized (=== stable)');
  assert.equal(sheet.ownerNode, style);
  assert.deepEqual(sheet.cssRules, []);
  assert.equal(sheet.type, 'text/css');
  assert.equal(document.createElement('div').sheet, null, 'div has no sheet');
});

test('document.styleSheets is a live list keyed by ownerNode', () => {
  const { document } = fresh();
  assert.equal(document.styleSheets.length, 0);
  const a = document.createElement('style'); document.head.appendChild(a);
  const b = document.createElement('style'); document.head.appendChild(b);
  const list = document.styleSheets;
  assert.equal(list.length, 2);
  assert.equal(list[0].ownerNode, a);
  assert.equal(list.item(1).ownerNode, b);
  assert.equal(list.item(5), null, 'item past the end is null');
  assert.ok([...list].length === 2, 'iterable');
});

test('insertRule feeds the cascade; getComputedStyle resolves injected rules', () => {
  const { window, document } = fresh('<!doctype html><html><head></head><body><div class="css-x">hi</div></body></html>');
  const style = document.createElement('style');
  document.head.appendChild(style);
  const i0 = style.sheet.insertRule('.css-x { color: rgb(1, 2, 3); }', 0);
  const i1 = style.sheet.insertRule('.css-x { display: none; }', 1);
  assert.equal(i0, 0);
  assert.equal(i1, 1);
  assert.equal(style.sheet.cssRules.length, 2);
  const el = document.querySelector('.css-x');
  assert.equal(window.getComputedStyle(el).color, 'rgb(1, 2, 3)');
  assert.equal(window.getComputedStyle(el).display, 'none');
});

test('insertRule with default index inserts at 0', () => {
  const { document } = fresh();
  const style = document.createElement('style'); document.head.appendChild(style);
  style.sheet.insertRule('.a { color: red; }');
  style.sheet.insertRule('.b { color: blue; }'); // default index 0 → prepends
  assert.equal(style.sheet.cssRules[0].selectorText, '.b');
  assert.equal(style.sheet.cssRules[1].selectorText, '.a');
});

test('deleteRule removes and invalidates the cascade', () => {
  const { window, document } = fresh('<!doctype html><html><head></head><body><div class="d">x</div></body></html>');
  const style = document.createElement('style'); document.head.appendChild(style);
  style.sheet.insertRule('.d { display: none; }', 0);
  const el = document.querySelector('.d');
  assert.equal(window.getComputedStyle(el).display, 'none');
  style.sheet.deleteRule(0);
  assert.equal(window.getComputedStyle(el).display, '', 'rule gone → honest empty');
  assert.equal(style.sheet.cssRules.length, 0);
});

test('insertRule/deleteRule throw RangeError out of bounds', () => {
  const { document } = fresh();
  const style = document.createElement('style'); document.head.appendChild(style);
  assert.throws(() => style.sheet.insertRule('.a{}', 5), RangeError);
  assert.throws(() => style.sheet.insertRule('.a{}', -1), RangeError);
  assert.throws(() => style.sheet.deleteRule(0), RangeError);
  style.sheet.insertRule('.a{}', 0);
  assert.throws(() => style.sheet.deleteRule(9), RangeError);
});

test('legacy addRule/removeRule and rules alias', () => {
  const { document } = fresh();
  const style = document.createElement('style'); document.head.appendChild(style);
  const ret = style.sheet.addRule('.legacy', 'color: green', 0);
  assert.equal(ret, -1, 'addRule returns -1 (legacy)');
  assert.equal(style.sheet.cssRules.length, 1);
  assert.equal(style.sheet.rules, style.sheet.cssRules, 'rules aliases cssRules');
  assert.match(style.sheet.cssRules[0].cssText, /\.legacy/);
  style.sheet.addRule(); // all defaults
  assert.equal(style.sheet.cssRules.length, 2);
  style.sheet.removeRule(0);
  assert.equal(style.sheet.cssRules.length, 1);
});

test('constructable CSSStyleSheet: replaceSync/replace, no owner = no throw', async () => {
  const { window } = fresh();
  const sheet = new window.CSSStyleSheet();
  assert.equal(sheet.ownerNode, null);
  sheet.replaceSync('.a { color: red; } .b { color: blue; } @media (x) { .c {} }');
  assert.equal(sheet.cssRules.length, 3, 'top-level rules split (incl. @media block as one)');
  const ret = await sheet.replace('.only { color: green; }');
  assert.equal(ret, sheet);
  assert.equal(sheet.cssRules.length, 1);
  // invalidate() on an owner-less sheet is a no-op (covers the null-owner branch)
  sheet.insertRule('.x {}', 0);
  assert.equal(sheet.cssRules.length, 2);
});

test('CSSStyleRule.selectorText handles malformed (no brace) cssText', () => {
  const { window } = fresh();
  const sheet = new window.CSSStyleSheet();
  sheet.insertRule('not a rule', 0);
  assert.equal(sheet.cssRules[0].selectorText, '');
});

test('utf8Decode fallback decodes 1/2/3/4-byte sequences', () => {
  const enc = new TextEncoder();
  for (const s of ['', 'ascii', 'café', 'naïve—dash', '日本語', '😀🎉', 'mix: a→b 日 😀']) {
    assert.equal(utf8Decode(enc.encode(s)), s, `roundtrip: ${s}`);
  }
});
