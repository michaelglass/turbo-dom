import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDatFile, _internal } from '../harness/dat.mjs';

test('parses a single case: data + errors + document', () => {
  const f = `#data
<p>x</p>
#errors
(1,3): some-error
#document
| <html>
|   <head>
|   <body>
|     <p>
|       "x"
`;
  const tests = parseDatFile(f);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].data, '<p>x</p>');
  assert.equal(tests[0].fragmentContext, null);
  assert.equal(tests[0].scriptMode, null);
  assert.equal(
    tests[0].document,
    ['| <html>', '|   <head>', '|   <body>', '|     <p>', '|       "x"'].join('\n')
  );
});

test('parses multiple cases separated by blank line', () => {
  const f = `#data
a
#errors
#document
| <html>
|   <head>
|   <body>
|     "a"

#data
b
#errors
#document
| <html>
|   <head>
|   <body>
|     "b"
`;
  const tests = parseDatFile(f);
  assert.equal(tests.length, 2);
  assert.equal(tests[0].data, 'a');
  assert.equal(tests[1].data, 'b');
  // separator blank line must NOT leak into the first case's document
  assert.ok(!tests[0].document.endsWith('\n'));
  assert.ok(tests[0].document.endsWith('"a"'));
});

test('captures fragment context', () => {
  const f = `#data
<td>x</td>
#errors
#document-fragment
td
#document
| "x"
`;
  const [t] = parseDatFile(f);
  assert.equal(t.fragmentContext, 'td');
});

test('captures namespaced fragment context', () => {
  const f = `#data
<path/>
#errors
#document-fragment
svg path
#document
| <svg path>
`;
  const [t] = parseDatFile(f);
  assert.equal(t.fragmentContext, 'svg path');
});

test('captures script-on / script-off markers', () => {
  const on = parseDatFile(`#data
x
#errors
#script-on
#document
| "x"
`);
  assert.equal(on[0].scriptMode, 'on');

  const off = parseDatFile(`#data
x
#errors
#script-off
#document
| "x"
`);
  assert.equal(off[0].scriptMode, 'off');
});

test('preserves multi-line text in #data and #document', () => {
  const f = `#data
<pre>line1
line2</pre>
#errors
#document
| <html>
|   <head>
|   <body>
|     <pre>
|       "line1
line2"
`;
  const [t] = parseDatFile(f);
  assert.equal(t.data, '<pre>line1\nline2</pre>');
  assert.ok(t.document.includes('"line1\nline2"'));
});

test('trimTrailingBlank drops only trailing empties', () => {
  assert.deepEqual(_internal.trimTrailingBlank(['a', '', 'b', '', '']), ['a', '', 'b']);
  assert.deepEqual(_internal.trimTrailingBlank(['a']), ['a']);
  assert.deepEqual(_internal.trimTrailingBlank([]), []);
});
