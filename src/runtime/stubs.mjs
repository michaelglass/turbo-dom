// Layer 4 — aggressively but HONESTLY stub the unobservable. Headless runners
// have no layout, so we don't pretend. Honest absence over a plausible lie.

export class Storage {
  constructor() { this.__map = new Map(); }
  get length() { return this.__map.size; }
  key(i) { return [...this.__map.keys()][i] ?? null; }
  getItem(k) { return this.__map.has(String(k)) ? this.__map.get(String(k)) : null; }
  setItem(k, v) { this.__map.set(String(k), String(v)); }
  removeItem(k) { this.__map.delete(String(k)); }
  clear() { this.__map.clear(); }
}

export function makeMatchMedia() {
  return (query) => ({
    matches: false,                 // honest: no real media context in a headless runner
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},               // deprecated, kept for compatibility
    removeListener() {},
    dispatchEvent() { return false; },
  });
}

// getComputedStyle: honest — reflects ONLY inline + explicitly-set values, never
// invents cascade/layout numbers. A property that wasn't set reads as ''.
export function makeGetComputedStyle() {
  return (el) => {
    const style = el && el.style ? el.style : null;
    return new Proxy({}, {
      get(_t, key) {
        if (key === 'getPropertyValue') return (p) => (style ? style.getPropertyValue(p) : '');
        if (key === '__honest') return 'computed style is inline-only; no layout/cascade available';
        if (typeof key !== 'string') return undefined;
        return style ? style[key] : '';
      },
    });
  };
}

class ObserverStub {
  constructor(cb) { this.__cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
export class IntersectionObserver extends ObserverStub {
  constructor(cb) { super(cb); this.root = null; this.rootMargin = '0px'; this.thresholds = [0]; }
}
export class ResizeObserver extends ObserverStub {}

// MutationObserver: real enough to be useful — fires on observed mutations would
// require hooking every mutation; v1 is an honest queue-based stub that records
// nothing automatically. Documented as opt-in faithful later.
export class MutationObserver {
  constructor(cb) { this.__cb = cb; this.__records = []; }
  observe() {}
  disconnect() {}
  takeRecords() { const r = this.__records; this.__records = []; return r; }
}

export function makeLocation(href = 'http://localhost/') {
  const u = new URL(href);
  return {
    get href() { return u.href; }, set href(v) { /* navigation is a no-op in headless */ },
    get protocol() { return u.protocol; },
    get host() { return u.host; },
    get hostname() { return u.hostname; },
    get port() { return u.port; },
    get pathname() { return u.pathname; },
    get search() { return u.search; },
    get hash() { return u.hash; },
    get origin() { return u.origin; },
    assign() {}, replace() {}, reload() {}, toString() { return u.href; },
  };
}

export function makeHistory(location) {
  const stack = [{ state: null, url: location.href }];
  let idx = 0;
  return {
    get length() { return stack.length; },
    get state() { return stack[idx].state; },
    pushState(state, _title, url) { stack.splice(idx + 1); stack.push({ state, url }); idx++; },
    replaceState(state, _title, url) { stack[idx] = { state, url: url ?? stack[idx].url }; },
    back() { if (idx > 0) idx--; },
    forward() { if (idx < stack.length - 1) idx++; },
    go(n) { idx = Math.max(0, Math.min(stack.length - 1, idx + (n || 0))); },
  };
}
