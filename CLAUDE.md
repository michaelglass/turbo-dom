# CLAUDE.md

Dev guide for this repo. See `turbo-dom-spec.md` for the full design and `README.md` for usage.

## What this is

Layer 1 of turboDom: a native HTML parser (Rust + `html5ever`) with napi-rs (native) and
wasm-bindgen (fallback) front-ends over **one shared core**. Parser produces a complete
nested tree and crosses the JS boundary once ("full marshaling"). The SoA flat-buffer from
the architecture doc is **intentionally not built yet** — it's gated on marshaling proving
to be the cost (a later bench). Don't SoA-ify `core.rs`.

## Build & test

```bash
npm run build         # native addon → turbo-dom-parser.<platform>.node + index.js/.d.ts (napi codegen)
npm run build:wasm    # wasm32 fallback
npm test              # JS: node --test  (MUST glob: 'test/*.mjs' — `node --test test/` is misparsed on Node 24)
npm run test:cov      # same suite + coverage gate (runtime lines≥99 / funcs≥92 / branches≥88)
npm run test:rust     # cargo test --lib  (core unit tests live in src/core.rs #[cfg(test)])
npm run conformance   # html5lib-tests gate
```

Toolchain: Node ≥ 24, Rust stable via rustup (`source $HOME/.cargo/env` if cargo isn't on PATH).

**Pre-commit hook** (`.githooks/pre-commit`, zero-dep — wired via the `prepare` script setting
`core.hooksPath=.githooks` on `npm install`): runs `npm run test:cov` when `src/`/`test/` is
staged, so every commit gates tests + coverage + conformance (conformance.test.mjs runs in the
suite). Bypass with `git commit --no-verify`. Coverage-ignore a truly-unreachable defensive line
with `/* node:coverage ignore next */` (sparingly) — prefer restructuring or a test.

## Releasing (`vX.Y.Z`)

Every release is a commit AND a matching lightweight git tag — the tag is not optional. Flow:

1. Bump `"version"` in `package.json` to the new `X.Y.Z`.
2. Commit all changes; subject line is `vX.Y.Z: <summary>` (matches existing history).
3. `git tag vX.Y.Z` (lightweight, no `-a`/message — matches existing tags).
4. `git push origin main && git push origin vX.Y.Z` — push BOTH the branch and the tag.

Tags listed newest-first with `git tag --list --sort=-v:refname` (plain `git tag` sorts
lexically and hides `v0.1.10+` below `v0.1.9`).

## Architecture

- `src/core.rs` — the only place html5ever is touched. `parse_html_document`,
  `parse_html_fragment_context`. Returns `core::Node` (plain, no binding deps).
- `src/lib.rs` — two feature-gated front-ends (`napi-bind` default, `wasm-bind`). Each is a
  thin `From<core::Node>` / serde conversion. Keep logic in core, not here.
- `harness/` — JS conformance tooling (dat parser, serializer, runner). All unit-tested.
- `src/runtime/` — the lazy COW DOM + window (Layers 2–5). `index.mjs` exports
  `createEnvironment(html)` → `{ window, document, reset, touched }`. Nodes inflate lazily
  from the parser tree and memoize for identity (`dom.mjs` `Document.__inflate`); the window
  Proxy (`window.mjs`) self-replaces lazy globals and traces touched ones. Selectors read the
  internal `node.__children()` array, NOT the live `childNodes` Proxy. Honest stubs in
  `stubs.mjs` (never invent layout numbers — `getBoundingClientRect`/offsets stay 0). The one
  exception is the partial style cascade in `cascade.mjs` (see getComputedStyle note below): it
  resolves REAL injected `<style>`/inline values, never fabricated ones. Validated by `test/differential.test.mjs`
  (jsdom oracle + happy-dom), `test/gauntlet.test.mjs` (RTL unmodified), `test/runtime.test.mjs`.

## Non-obvious things (read before editing)

- **Field naming:** napi `#[napi(object)]` camelCases fields. Rust `public_id` → JS `publicId`,
  `node_type` → `nodeType`. The serializer reads the **camelCase** JS names.
- **Scripting flag is OFF** (`opts()` sets `scripting_enabled: false`) to match html5lib-tests'
  default, so `<noscript>` content is parsed as markup, not rawtext. Don't flip it.
- **`<template>` content** is NOT in `children` — html5ever puts it in `template_contents`.
  `walk()` appends it as a synthetic `nodeType 11` `content` fragment node. html5lib prints it
  as the literal word `content`.
- **Foreign content:** elements carry `namespace` ("svg"/"math", else ""); foreign attrs carry
  `prefix` ("xlink" etc). The serializer renders `<svg svg>` and `xlink href="…"`.
- **Fragment context:** `parseFragment(html, context)` where context is `"td"` or namespaced
  `"svg path"` / `"math ms"`. Empty → body.
- **Hot paths are allocation-free — keep them that way.** `querySelectorAll`/`querySelector`/
  `getElementsByTagName`/`getElementsByClassName` and selector matching MUST NOT allocate per
  element: no `el.classList` (allocates a ClassList + splits), no `Array.find`/`.some`/`.filter`
  closures, no regex, no per-node filtered child arrays. Use the `hasClass`/`elHasClass`
  whole-word string scan, index loops over `__children()`, and the for-loop `getAttribute`.
  This is what makes repeated-query throughput ~2.2× happy-dom / ~460× jsdom; a stray `classList`
  in a matcher tanks it.
- **Selector parse cache** (`__selectorCache` in selectors.mjs) memoizes selector STRING → AST.
  Pure (DOM-independent) → no mutation invalidation. Never cache *results* without it.

## Benchmarks

```bash
npm run bench           # parse throughput (parseBuffer vs parse5/happy-dom/jsdom)
npm run bench:construct # per-file construction + surface-usage histogram
npm run bench:suite     # 200-file suite wall-clock; lazy-vs-eager nodes/window
npm run bench:query     # query-heavy DOM work (RTL-style) vs jsdom
npm run bench:wasm      # wasm vs native parseBuffer
npm run bench:all       # all of the above
```
Latest (darwin-arm64, Node 24, `npm run bench:all`), vs jsdom / happy-dom:
- cold per-file construct + light query: ~200k ops/s — ~765× jsdom, ~350× happy-dom
- realistic 200-file suite (construct+query+events): ~0.025 ms/file — ~130× jsdom, ~45× happy-dom
- parse (parseBuffer): real-page/SSR docs ~8–35× both; small/malformed up to ~75× jsdom
- conformance: 99.72% vs jsdom 97.03% vs happy-dom 37.35%
- repeated query throughput: ~1.5M iters/s — ~2.2× happy-dom (~680k) and ~460× jsdom.
  querySelectorAll/getElementsBy*/getElementById results are cached per (selector,
  Document.__version); a static querySelectorAll list is safe to reuse until the next
  mutation. cachedQSA/cachedQS + Document.__byTag/__byClass/__idCache.
- **Per-node memoized live views.** `childNodes`/`children` are cached on the node
  (`__childNodesList`/`__childrenList`) — correct because each reads `__children()` LIVE, so the
  cached object always reflects current state (no version key needed). Bonus:
  `el.childNodes === el.childNodes` is stable (spec-correct). Don't add a variant that snapshots
  the array at creation — must read through live.
- **getComputedStyle is a partial cascade** (`cascade.mjs`), NOT inline-only anymore. It resolves
  injected `<style>` rules (emotion/MUI `.css-HASH{…}`) + inline + specificity/order, memoized as
  `el.__computedStyle` KEYED ON `Document.__version` (`__computedStyle.__v`) — style mutations bump
  the version so the cache auto-invalidates. Do NOT make it version-free/live again: the resolved
  map is a per-version snapshot. Still honest: only returns values from a REAL matched rule/inline;
  unmatched props read `''`. Out of scope (return `''`): `@media`/`@keyframes`, `:hover`/state,
  pseudo-elements, full inheritance, CSS vars, length normalization. ZERO hot-path cost — only
  test-time getComputedStyle calls build the index; parse/query/match/events never touch it.
- **dispatchEvent skips propagation when no listener is on the path.** One ancestor walk builds
  the path AND flags `hasListener`; capture/target/bubble loops run only if true (preClick +
  default actions still run). React fires thousands of listener-less events.
- **Shadow DOM is pay-for-what-you-use, gated on `Document.__hasShadow`** (set by the first
  `attachShadow`; armed eagerly for declarative `<template shadowrootmode>` in `index.mjs`, behind
  a `'shadowroot'` substring check on the HTML). Until then every hot path runs byte-for-byte as
  before: dispatch takes the flat walk (one predicted-false read), the cascade resolves against the
  document, `querySelector`/`getElementsBy*` never see shadow content (the host's `__children()`
  simply doesn't include it — encapsulation is free). Do NOT ungate any of this or move shadow
  retargeting/scoped-cascade work above the `__hasShadow` branch. `ShadowRoot extends
  DocumentFragment`; `__isShadowRoot`/`host` are duck-typed so events.mjs needs no dom.mjs import.
  Slots/`assignedNodes`/`:host`/`::slotted`/inheritance are all computed on demand (test-time only).
- **Cache invalidation = Document.__version.** EVERY mutation must bump it: notifyMutation
  bumps it unconditionally (insert/remove/setAttribute), and __touch() covers direct __kids
  rewrites (innerHTML/textContent/replaceChildren). If you add a new mutation path that
  bypasses these, bump __version or queries go stale. Covered by
  test/liveness.test.mjs "query/getElementById caches invalidate on mutation".
- `getByLabelText` was O(n²) (element.labels → getElementsByTagName('label') per element);
  the caches took it 1342→~270µs.
Numbers in README.md — refresh both (bench against jsdom AND happy-dom) if you touch hot paths.
- **Parse memoization (index.mjs `parseBufferCached`).** The SoA buffer is READ-ONLY — every
  mutation goes to a Document's own `__kids`/`__attrs`/`__cache` overlay, never the buffer — so
  the same buffer backs many Documents. Suites call setup with the same shell HTML per file →
  parsed once, reused (near-free createEnvironment). Realistic suite ~45× happy-dom / ~130× jsdom.
  If you ever write THROUGH to the buffer typed arrays, this breaks — don't.
- **Lazy attrs.** Buffer-backed elements leave `__attrs` undefined + store `__attrIdx`; the array
  builds from the SoA on first attribute touch (`__buildAttrs`, guarded by `?? (this.__attrs = …)`).
  Traversal-only nodes never build attrs. Every `__attrs` read site must keep the guard.
- **Lazy listeners.** `EventTarget.__listeners` starts `null` (most inflated nodes never get a
  listener) and is created on first addEventListener. Every read must null-guard
  (`this.__listeners && …`); dispatchEvent + removeEventListener already do.
- **Live-collection index fast path.** `collections.mjs` detects numeric indices by first charCode
  (48–57), not a `^\d+$` regex, and puts the index path first (hottest: `coll[i]`). `getArray()`
  is called only when needed.

## Conformance gate

`test/conformance.test.mjs` locks the rate ≥ 99.5% AND asserts **zero non-`<select>` failures**.
On `html5ever` 0.39 the 5 known misses are all bleeding-edge `<select>`-family proposals
(`<selectedcontent>`, `<input>`/`<button>`-in-select) the newest html5lib-tests track but the
crate hasn't adopted. If a failure appears whose input has no `<select>`, it's likely a
marshaling/serializer bug in THIS repo and the test will fail loudly. Investigate before
touching the threshold. To improve further: bump `html5ever` (picks up upstream fixes) — never
by loosening the serializer to match.

## Adding a node-type or field

1. Add to `core::Node` (+ all construction sites: walk, fragment root, template content node).
2. Mirror in `src/lib.rs` `JsNode` + the `From` impl (and it flows to wasm via serde).
3. Handle it in `harness/serialize.mjs` `serializeNode`.
4. Add a Rust unit test (`src/core.rs`) and a serializer unit test (`test/serialize.test.mjs`).
