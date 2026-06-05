import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTree, _internal } from '../harness/serialize.mjs';
import { parse, parseFragment } from '../index.js';

// minimal node builders matching the addon's camelCase shape
const el = (name, attrs = [], children = [], extra = {}) => ({
  nodeType: 1, name, value: '', namespace: '', publicId: '', systemId: '', attrs, children, ...extra,
});
const text = (value) => ({ nodeType: 3, name: '#text', value, namespace: '', attrs: [], children: [] });
const comment = (value) => ({ nodeType: 8, name: '#comment', value, namespace: '', attrs: [], children: [] });
const attr = (name, value, prefix = '') => ({ name, value, prefix });
const doc = (...children) => ({ nodeType: 9, name: '#document', children });

test('serializes nested elements with correct indentation', () => {
  const tree = doc(el('html', [], [el('body', [], [el('div', [], [text('hi')])])]));
  assert.equal(
    serializeTree(tree),
    ['| <html>', '|   <body>', '|     <div>', '|       "hi"'].join('\n')
  );
});

test('attributes sorted by name, one per line at depth+1', () => {
  const tree = doc(el('div', [attr('z', '1'), attr('a', '2'), attr('m', '3')]));
  assert.equal(
    serializeTree(tree),
    ['| <div>', '|   a="2"', '|   m="3"', '|   z="1"'].join('\n')
  );
});

test('comment uses double-space html5lib form', () => {
  // input <!-- BAR --> has value " BAR " -> "<!--  BAR  -->"
  const tree = doc(comment(' BAR '));
  assert.equal(serializeTree(tree), '| <!--  BAR  -->');
});

test('doctype without ids', () => {
  const tree = doc({ nodeType: 10, name: 'html', publicId: '', systemId: '', children: [] });
  assert.equal(serializeTree(tree), '| <!DOCTYPE html>');
});

test('doctype with public/system ids', () => {
  const tree = doc({
    nodeType: 10, name: 'html', publicId: '-//W3C//DTD HTML 4.01//EN',
    systemId: 'http://www.w3.org/TR/html4/strict.dtd', children: [],
  });
  assert.equal(
    serializeTree(tree),
    '| <!DOCTYPE html "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">'
  );
});

test('foreign element prints namespace prefix', () => {
  const tree = doc(el('svg', [], [], { namespace: 'svg' }));
  assert.equal(serializeTree(tree), '| <svg svg>');
});

test('namespaced attribute prints "prefix local"', () => {
  const tree = doc(el('svg', [attr('href', 'x.png', 'xlink')], [], { namespace: 'svg' }));
  assert.equal(
    serializeTree(tree),
    ['| <svg svg>', '|   xlink href="x.png"'].join('\n')
  );
});

test('template content fragment prints `content`', () => {
  const contentFrag = { nodeType: 11, name: 'content', namespace: '', attrs: [], children: [text('hi')] };
  const tree = doc(el('template', [], [contentFrag]));
  assert.equal(
    serializeTree(tree),
    ['| <template>', '|   content', '|     "hi"'].join('\n')
  );
});

// ---- round-trip: real addon output must serialize to the expected dump ----

test('round-trip: spec example matches html5lib dump', () => {
  const tree = parse('<div id=a><span>hi</span></div>');
  assert.equal(
    serializeTree(tree),
    [
      '| <html>',
      '|   <head>',
      '|   <body>',
      '|     <div>',
      '|       id="a"',
      '|       <span>',
      '|         "hi"',
    ].join('\n')
  );
});

test('round-trip: doctype + comment + text', () => {
  const tree = parse('<!doctype html>FOO<!-- BAR -->BAZ');
  const out = serializeTree(tree);
  assert.ok(out.startsWith('| <!DOCTYPE html>'), out);
  assert.ok(out.includes('|     "FOO"'));
  assert.ok(out.includes('|     <!--  BAR  -->'));
  assert.ok(out.includes('|     "BAZ"'));
});

test('round-trip: template fragment content', () => {
  const tree = parseFragment('<template>Hello</template>');
  assert.equal(
    serializeTree(tree),
    ['| <template>', '|   content', '|     "Hello"'].join('\n')
  );
});

test('indent helper', () => {
  assert.equal(_internal.indent(0), '| ');
  assert.equal(_internal.indent(1), '|   ');
  assert.equal(_internal.indent(2), '|     ');
});
