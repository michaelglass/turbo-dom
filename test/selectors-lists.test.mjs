import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

// :is() / :where() / :not() selector-list pseudo-classes (parity with the Rust
// rtdom port). Each argument is a comma-separated list of complex selectors,
// anchored at the element under test.
test(':is() matches if any complex in the list matches', () => {
  const { document } = createEnvironment(
    '<!doctype html><body><div class="a">1</div><div class="b">2</div><div class="c">3</div></body>',
  );
  assert.equal(document.querySelectorAll(':is(.a, .b)').length, 2);
  assert.equal(document.querySelectorAll(':is(.c)').length, 1); // single-item degenerate
  assert.equal(document.querySelectorAll(':is(.nope)').length, 0);
});

test(':is() anchors the list at the element and composes with combinators', () => {
  const { document } = createEnvironment(
    '<!doctype html><body>' +
      '<div class="x"><span class="y">hit</span></div>' +
      '<div class="z"><span class="y">miss</span></div>' +
      '<section><p class="t">a</p></section><p class="t">b</p>' +
      '</body>',
  );
  // div:is(.x) .y -> only the .y inside the div.x
  const r = document.querySelectorAll('div:is(.x) .y');
  assert.equal(r.length, 1);
  assert.equal(r[0].textContent, 'hit');
  // a complex selector inside :is()
  const r2 = document.querySelectorAll(':is(section .t, .nope)');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].textContent, 'a');
});

test(':where() matches identically to :is()', () => {
  const { document } = createEnvironment(
    '<!doctype html><body><i class="a">1</i><i class="b">2</i><i>3</i></body>',
  );
  assert.equal(document.querySelectorAll(':where(.a,.b)').length, 2);
  assert.equal(document.querySelectorAll('i:where(.a)').length, 1);
});

test(':not() takes a selector list (none of the list may match)', () => {
  const { document } = createEnvironment(
    '<!doctype html><body><ul>' +
      '<li class="a">1</li><li class="b">2</li><li class="c">3</li>' +
      '</ul></body>',
  );
  const r = document.querySelectorAll('li:not(.a, .b)');
  assert.equal(r.length, 1);
  assert.equal(r[0].textContent, '3');
  // tag list: none of these <li> are div/span -> all three survive
  assert.equal(document.querySelectorAll('li:not(div, span)').length, 3);
  // single-item :not still works (degenerate list)
  assert.equal(document.querySelectorAll('li:not(.a)').length, 2);
});

test('matches() honors :is/:where/:not on a single element', () => {
  const { document } = createEnvironment(
    '<!doctype html><body><p class="lead big">x</p></body>',
  );
  const p = document.querySelector('p');
  assert.equal(p.matches(':is(.lead, .nope)'), true);
  assert.equal(p.matches(':where(.nope, .big)'), true);
  assert.equal(p.matches(':not(.lead, .big)'), false);
  assert.equal(p.matches(':not(.x, .y)'), true);
});
