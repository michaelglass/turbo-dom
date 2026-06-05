const React = require('react');
const { render, screen } = require('@testing-library/react');
const h = React.createElement;

test('globals installed + Symbol intact + dataset', () => {
  expect(typeof window).toBe('object');
  expect(typeof globalThis.Symbol).toBe('function');
  const d = document.createElement('div');
  d.dataset.x = '1';
  expect(d.getAttribute('data-x')).toBe('1');
});

test('React + RTL getByRole(name) through turbo-dom jest env', () => {
  function Counter() { return h('button', null, 'count: 0'); }
  render(h(Counter));
  expect(screen.getByRole('button', { name: /count: 0/ })).toBeTruthy();
});
