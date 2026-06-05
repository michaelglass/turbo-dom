import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseFragment } from '../index.js';

// node typing helpers
const ELEMENT = 1, TEXT = 3, COMMENT = 8, DOCUMENT = 9, DOCTYPE = 10;

const findFirst = (node, pred) => {
  if (pred(node)) return node;
  for (const c of node.children) {
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return null;
};
const tag = (node, name) => findFirst(node, n => n.nodeType === ELEMENT && n.name === name);

test('parses a full document with html/head/body', () => {
  const doc = parse('<!doctype html><div id="a" class="x"><span>hi</span></div>');
  assert.equal(doc.nodeType, DOCUMENT);
  assert.ok(tag(doc, 'html'), 'has <html>');
  assert.ok(tag(doc, 'head'), 'head synthesized');
  assert.ok(tag(doc, 'body'), 'body synthesized');
});

test('doctype emitted as nodeType 10', () => {
  const doc = parse('<!doctype html><p>x</p>');
  const dt = findFirst(doc, n => n.nodeType === DOCTYPE);
  assert.ok(dt, 'doctype present');
  assert.equal(dt.name, 'html');
});

test('attributes marshaled in order', () => {
  const doc = parse('<div id="a" class="x" data-k="v"></div>');
  const div = tag(doc, 'div');
  assert.deepEqual(
    div.attrs.map(a => ({ name: a.name, value: a.value })),
    [
      { name: 'id', value: 'a' },
      { name: 'class', value: 'x' },
      { name: 'data-k', value: 'v' },
    ]
  );
});

test('text content marshaled', () => {
  const doc = parse('<span>hello world</span>');
  const span = tag(doc, 'span');
  const txt = span.children.find(c => c.nodeType === TEXT);
  assert.equal(txt.value, 'hello world');
});

test('comment marshaled as nodeType 8', () => {
  const doc = parse('<div><!-- note --></div>');
  const c = findFirst(doc, n => n.nodeType === COMMENT);
  assert.ok(c);
  assert.equal(c.value, ' note ');
});

test('the spec example: <div id=a><span>hi</span></div>', () => {
  const doc = parse('<div id=a><span>hi</span></div>');
  const div = tag(doc, 'div');
  assert.equal(div.attrs[0].name, 'id');
  assert.equal(div.attrs[0].value, 'a');
  const span = tag(div, 'span');
  assert.equal(span.children[0].value, 'hi');
});

test('html5ever table foster-parenting (the happy-dom killer)', () => {
  // Stray text inside <table> must be foster-parented before the table,
  // per WHATWG tree construction. Hand-rolled parsers get this wrong.
  const doc = parse('<table>oops<tr><td>x</td></tr></table>');
  const body = tag(doc, 'body');
  const fosteredText = body.children.find(
    c => c.nodeType === TEXT && c.value.includes('oops')
  );
  assert.ok(fosteredText, 'stray text fostered out of <table>');
  assert.ok(tag(doc, 'table'), 'table still present');
});

test('parseFragment returns fragment root with parsed children', () => {
  const frag = parseFragment('<li>one</li><li>two</li>');
  assert.equal(frag.name, '#document-fragment');
  const lis = frag.children.filter(c => c.nodeType === ELEMENT && c.name === 'li');
  assert.equal(lis.length, 2);
  assert.equal(lis[0].children[0].value, 'one');
});
