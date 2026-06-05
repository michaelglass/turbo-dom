import { test, expect, vi } from 'vitest';
test('3: window.scrollTo sees vi.stubGlobal', () => {
  const fn = vi.fn();
  vi.stubGlobal('scrollTo', fn);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  expect(fn).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  expect(window).toBe(globalThis);
  vi.unstubAllGlobals();
});
