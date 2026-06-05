// Phase 3, test strategy #2 (cont.): @testing-library/user-event UNMODIFIED.
// user-event simulates real user interaction (pointer, keyboard, focus) and is far
// more demanding of DOM fidelity than fireEvent — the hard half of the gauntlet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';

const require = createRequire(import.meta.url);
const userEvent = require('@testing-library/user-event').default;
const { getByText, getByRole, getByLabelText } = require('@testing-library/dom');

function setup(html) {
  const env = createEnvironment(`<!doctype html><html><body>${html}</body></html>`);
  // user-event resolves the document/window off the element's ownerDocument.
  const user = userEvent.setup({ document: env.document });
  return { env, user, body: env.document.body };
}

test('user-event click fires through the real event path', async () => {
  const { user, body } = setup(`<button>Save</button>`);
  const btn = getByText(body, 'Save');
  let clicks = 0;
  btn.addEventListener('click', () => clicks++);
  await user.click(btn);
  assert.equal(clicks, 1);
});

test('user-event type updates input value char-by-char', async () => {
  const { user, body } = setup(`<input aria-label="name" type="text" />`);
  const input = getByLabelText(body, 'name');
  await user.type(input, 'hello');
  assert.equal(input.value, 'hello');
});

test('user-event keyboard fires keydown/keyup with the right key', async () => {
  const { user, body } = setup(`<input aria-label="k" type="text" />`);
  const input = getByLabelText(body, 'k');
  const keys = [];
  input.addEventListener('keydown', (e) => keys.push(e.key));
  input.focus();
  await user.keyboard('ab');
  assert.deepEqual(keys, ['a', 'b']);
});

test('user-event click toggles a checkbox', async () => {
  const { user, body } = setup(`<input type="checkbox" aria-label="agree" />`);
  const cb = getByRole(body, 'checkbox');
  assert.equal(cb.checked, false);
  await user.click(cb);
  assert.equal(cb.checked, true);
});
