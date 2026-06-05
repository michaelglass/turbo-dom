# turbo-dom

A faster, more spec-correct DOM for test runners — a drop-in-style alternative to
**jsdom** and **happy-dom** for **vitest** and **jest**.

The HTML parser is native ([html5ever](https://github.com/servo/html5ever), Servo's
WHATWG tree constructor, via Rust/N-API with a WASM fallback). The DOM itself stays in
JavaScript but is **lazy** — nodes inflate from a compact typed-array buffer only when a
test touches them, and `window` globals materialize only on first use.

```bash
npm install -D @miaskiewicz/turbo-dom
```

- ✅ **More compatible than happy-dom** — 99.72% on html5lib-tests vs happy-dom's 37%.
  Runs React Testing Library, `user-event`, downshift, Radix UI, and Headless UI unmodified.
- ⚡ **Faster than both** — ~23× jsdom / ~10× happy-dom on per-file setup, 18–37× faster HTML parsing, and (with per-version query-result caching) it matches/beats happy-dom on repeated queries while staying 99.7% spec-correct.
- 🎯 **Honest, not lying** — no fake layout numbers; `getBoundingClientRect()` is zeros and
  `getComputedStyle` reflects only what you set. Geometry tests belong in a real browser.

## Quick start

### vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

const envPath = createRequire(import.meta.url).resolve('@miaskiewicz/turbo-dom/environment/vitest');

export default defineConfig({
  test: {
    environment: envPath, // vitest resolves a bare name only for `vitest-environment-*`
                          // packages, so a scoped package is referenced by file path
  },
});
```

Works on vitest 1–4.

### jest

```js
// jest.config.js
module.exports = {
  testEnvironment: '@miaskiewicz/turbo-dom/jest',
};
```

Now `document`, `window`, and friends are global in your tests — write them exactly like
you would against jsdom/happy-dom:

```js
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

test('counter increments', async () => {
  render(<Counter />);
  await userEvent.click(screen.getByRole('button'));
  expect(screen.getByText('count: 1')).toBeInTheDocument();
});
```

### Without a test runner

```js
import { createEnvironment } from '@miaskiewicz/turbo-dom/runtime';

const env = createEnvironment('<!doctype html><body><div id="app"></div></body>');
env.document.querySelector('#app');     // nodes inflate lazily from the parse buffer
env.window.localStorage;                // globals materialize on first touch
env.reset();                            // fast per-file reset (reuses the parse buffer)
```

### Just the parser

```js
const { parse, parseBuffer, parseFragment } = require('@miaskiewicz/turbo-dom');

parse('<div id=a><span>hi</span></div>');         // nested tree
parseBuffer('<div id=a>...</div>');                // compact SoA typed-array buffer
parseFragment('<rect/>', 'svg path');              // fragment in a context element
```

## Compatibility

| | turbo-dom | happy-dom | jsdom |
|---|---|---|---|
| html5lib-tests conformance | **99.72%** | 37.35% | 97.03% |
| @testing-library/dom + user-event | ✅ | ✅ | ✅ |
| React + Radix / Headless UI / downshift | ✅ | partial | ✅ |
| Real layout / `getComputedStyle` cascade | ❌ (honest stub) | partial | partial |

turbo-dom inherits Servo's tree constructor, so the "messy input" cases hand-rolled parsers
get wrong — adoption-agency reparenting (`<a><p></a></p>`), table foster-parenting, optional
end tags, `<template>` content, SVG/MathML — all match the spec. The 5 remaining
conformance misses are bleeding-edge `<select>`-family proposals upstream `html5ever` hasn't
adopted yet.

## Performance

Measured on darwin-arm64, Node 24 (`npm run bench:all`). Higher = faster, except
the suite row (ms/file, lower = faster):

| benchmark | turbo-dom | happy-dom | jsdom |
|---|---:|---:|---:|
| **per-file setup + 1 query** (ops/s) | **5,950** | 611 | 260 |
| **realistic suite**, 200 files (ms/file) | **0.13** | 1.50 | 3.38 |
| **parse 56 KB SSR** (ops/s) | **478** | 43 | 26 |
| **parse 20 KB real page** (ops/s) | **4,203** | 190 | 114 |
| repeated query throughput (iters/s) | **915k** | 615k | 3k |
| html5lib conformance | **99.72%** | 37.35% | 97.03% |

**turbo-dom wins across the board on what test suites actually do**: per-file
construction (~10× happy-dom, ~23× jsdom), parsing, realistic suites (~10× happy-dom,
~23× jsdom), spec-correctness (99.7% vs 37%), **and** repeated queries.

How the query speed holds up against happy-dom (whose whole design trades correctness
for query speed): the selector/match engine is allocation-free on the hot paths (no
per-element `classList`/`split`/regex), and `querySelectorAll`/`getElementsBy*`/
`getElementById` results are **cached per (selector, DOM-version)** — a static
`querySelectorAll` list is safe to reuse until the next mutation. So the repeated
queries RTL/`findBy`/`waitFor` run against an unchanged tree are near-free, and
`getByLabelText` went from O(n²) (1.3 ms) to ~270 µs.

## How it works

```
test code (RTL, user-event)
   └─ lazy window (Proxy, self-replacing globals)        ← JS
   └─ lazy copy-on-write node tree (memoized identity)   ← JS
   └─ immutable Structure-of-Arrays parse buffer          ← shared
        └─ Rust: html5ever → flat typed-array buffer       ← native (N-API / WASM)
```

The parser runs in Rust (compute-bound, one boundary crossing per parse). The DOM stays in
JS (chatty, fine-grained) but pays only for what a test touches. Full design notes:
[turbo-dom-spec.md](./turbo-dom-spec.md).

## Limitations (by design)

- **No layout.** `getBoundingClientRect()` returns zeros; `getClientRects()` is empty.
- **`getComputedStyle` is inline-only** — it reflects the `style` attribute and explicitly
  set properties, never an invented cascade. Style/geometry assertions belong in a real
  browser (Playwright/WebDriver).
- Canvas, `<select>` rendering, and similar visual APIs are honest no-op stubs.

## Development

Requires Node ≥ 18 and a Rust toolchain (`rustup`, stable).

```bash
npm install
npm run build          # native addon (.node)
npm test               # JS suite (unit, conformance, differential, gauntlets)
npm run test:rust      # Rust core tests
npm run conformance    # html5lib-tests report
npm run bench:all      # benchmarks
npm run build:wasm     # wasm32 fallback
```

Contributions welcome — issues and PRs at
[github.com/miaskiewicz/turbo-dom](https://github.com/miaskiewicz/turbo-dom).

## License

[MIT](./LICENSE).
