// Live collections. Each reads its backing array on every access, so they
// reflect mutations immediately — the exact place happy-dom bleeds liveness bugs.

function makeLive(getArray, extra = {}) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      const arr = getArray();
      if (key === 'length') return arr.length;
      if (key === 'item') return (i) => arr[i] ?? null;
      if (key === 'forEach') return (cb, thisArg) => arr.forEach(cb, thisArg);
      if (key === 'entries') return () => arr.entries();
      if (key === 'keys') return () => arr.keys();
      if (key === 'values') return () => arr[Symbol.iterator]();
      if (key === Symbol.iterator) return () => arr[Symbol.iterator]();
      if (key === 'toString') return () => '[object NodeList]';
      if (key in extra) return extra[key](arr);
      if (typeof key === 'string' && /^\d+$/.test(key)) return arr[Number(key)] ?? undefined;
      return undefined;
    },
    has(_t, key) {
      const arr = getArray();
      if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < arr.length;
      return key === 'length' || key === 'item' || key === 'forEach' || key in extra;
    },
    ownKeys() {
      const arr = getArray();
      return [...arr.keys()].map(String).concat('length');
    },
    getOwnPropertyDescriptor(_t, key) {
      const arr = getArray();
      if (key === 'length') return { configurable: true, enumerable: false, value: arr.length };
      if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < arr.length) {
        return { configurable: true, enumerable: true, value: arr[Number(key)] };
      }
      return undefined;
    },
  });
}

export function liveNodeList(getArray) {
  return makeLive(getArray);
}

export function liveHTMLCollection(getArray) {
  return makeLive(getArray, {
    namedItem: (arr) => (name) =>
      arr.find((el) => el.getAttribute('id') === name || el.getAttribute('name') === name) ?? null,
  });
}
