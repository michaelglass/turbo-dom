// Phase 3, test strategy #2: the real-library gauntlet.
// Run @testing-library/dom UNMODIFIED against the turbo-dom environment. This is
// the test happy-dom fails on real libraries — passing it is the entire point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';

const require = createRequire(import.meta.url);
const {
  getByText, queryByText, getAllByRole, getByRole, getByLabelText,
  fireEvent, within,
} = require('@testing-library/dom');

function envBody(html) {
  const env = createEnvironment(`<!doctype html><html><body>${html}</body></html>`);
  return { env, body: env.document.body };
}

test('RTL getByText / queryByText against turbo-dom', () => {
  const { body } = envBody(`<div><p>Hello world</p><span>other</span></div>`);
  assert.ok(getByText(body, 'Hello world'));
  assert.equal(queryByText(body, 'nonexistent'), null);
});

test('RTL getByRole resolves ARIA roles from real elements', () => {
  const { body } = envBody(`
    <nav>
      <button>One</button>
      <button>Two</button>
      <a href="/x">link</a>
    </nav>
    <ul><li>i1</li><li>i2</li></ul>
  `);
  const buttons = getAllByRole(body, 'button');
  assert.equal(buttons.length, 2);
  assert.ok(getByRole(body, 'link'));
  assert.equal(getAllByRole(body, 'listitem').length, 2);
});

test('RTL getByLabelText (label-for association)', () => {
  const { body } = envBody(`
    <label for="email">Email</label>
    <input id="email" type="text" />
  `);
  const input = getByLabelText(body, 'Email');
  assert.equal(input.localName, 'input');
  assert.equal(input.getAttribute('id'), 'email');
});

test('RTL fireEvent.click drives our event system end-to-end', () => {
  const { body } = envBody(`<button>Press</button>`);
  const btn = getByText(body, 'Press');
  let clicks = 0;
  btn.addEventListener('click', () => clicks++);
  fireEvent.click(btn);
  assert.equal(clicks, 1);
});

test('RTL fireEvent.input updates value + fires listeners', () => {
  const { body } = envBody(`<input aria-label="name" type="text" />`);
  const input = getByLabelText(body, 'name');
  let fired = false;
  input.addEventListener('input', () => { fired = true; });
  fireEvent.input(input, { target: { value: 'typed' } });
  assert.equal(fired, true);
  assert.equal(input.value, 'typed');
});

test('RTL within() scopes queries to a subtree', () => {
  const { body } = envBody(`
    <section data-testid="a"><button>A</button></section>
    <section data-testid="b"><button>B</button></section>
  `);
  const a = body.querySelector('[data-testid="a"]');
  assert.ok(within(a).getByText('A'));
  assert.equal(within(a).queryByText('B'), null);
});

test('RTL event bubbling through turbo-dom tree (delegation)', () => {
  const { body } = envBody(`<ul><li><button>x</button></li></ul>`);
  const ul = body.querySelector('ul');
  let delegated = null;
  ul.addEventListener('click', (e) => { delegated = e.target.localName; });
  fireEvent.click(body.querySelector('button'));
  assert.equal(delegated, 'button');
});
