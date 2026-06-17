# turbo-dom — performance optimization history (for the Rust port)

Every perf-relevant change across v0.1.0→v0.2.5, mined from the **actual commit diffs** (not just
commit messages) by 6 batch agents. Each entry tags how the technique carries to a pure-Rust core
compiled to WASM:

- **PORTS** — algorithmic / structural / lazy-memoization win; reimplement in Rust (often *cheaper*:
  slices, arenas, `Option`/`OnceCell`, index handles, a `u32` version counter).
- **V8-SPECIFIC** — hidden-class/monomorphism/escape-analysis/read-once/Proxy trick. In Rust these are
  either automatic (structs are monomorphic, field reads + CSE are free) or non-existent → **no win, no cost**.
- **BOUNDARY** — the win lived at the JS↔native marshaling seam (SoA layout, interned ids, byte-blob
  strings, camelCase serde). The internal napi seam *dissolves* in a single Rust→WASM blob; the SoA
  layout itself becomes the in-WASM-linear-memory representation. The **external** JS↔WASM boundary
  (vitest/React/RTL calling the DOM) is new — see `RUST_PORT_PLAN.md` §0/§2.
- **ALREADY-RUST** — lives in `core.rs` today; preserve verbatim, extend to the runtime side.

Companion: **`RUST_PORT_PLAN.md`** (architecture decision + phased migration).

---

## Batch 1 — Foundation

The architectural floor: shared Rust/html5ever core, two thin front-ends (napi + wasm),
the COW lazy-inflation DOM, and the SoA flat buffer that replaced full marshaling. These
five commits establish the load-bearing perf model the Rust→WASM port must preserve or
re-express. The two ideas that matter most: (1) the **SoA typed-array buffer is the
single boundary crossing and stays immutable/read-only**, and (2) **node handles inflate
lazily by index and memoize for identity** — nothing allocates a node until JS reads it.

---

### a2742e1 — (Cargo 0.0.1) — Layer 1: native html5ever parser with napi + wasm front-ends
**Files:** `src/core.rs` (`parse_html_document`, `parse_html_fragment_context`, `walk`, `core::Node`/`Attr`), `src/lib.rs` (`napi_front::JsNode`/`From<core::Node>`, `wasm_front` serde), `Cargo.toml` (feature-gated `napi-bind`/`wasm-bind`, `lto=true opt-level=3`), `build.rs`, generated `index.js` (platform binding loader).

**Optimization (from the diff):** All html5ever contact lives in ONE place (`core.rs`) and produces a binding-free `core::Node` (a plain nested tree: `node_type:u8`, interned-later `name`, `value`, `namespace` as html5lib short form `""`/`"svg"`/`"math"`, doctype `public_id`/`system_id`, `Vec<Attr>`, `Vec<Node>`). The two front-ends are thin `From<core::Node>` conversions — napi via `#[napi(object)]` (camelCases fields: `public_id`→`publicId`), wasm via `serde`. The explicit design note in the file: this is the "full marshaling" milestone — the WHOLE tree crosses the JS boundary in one return value — and the SoA flat buffer is *deliberately deferred* until a bench proves marshaling is the cost. `walk()` already does the non-obvious structural work: `<template>` content (which html5ever keeps in a separate `template_contents` fragment, NOT in `children`) is appended as a synthetic `nodeType 11` node named `content`; foreign-content namespaces collapse to the short form; doctype ids captured. Release profile sets `lto=true`/`opt-level=3`.

**Rust/WASM port note:** PORTS — the "all parsing logic in a binding-free core, front-ends are thin conversions" split is exactly the shape a Rust-core/WASM rewrite wants: keep `core::Node`/SoA construction pure-Rust, make the WASM boundary a thin serializer. The napi `#[napi(object)]` camelCase marshaling is BOUNDARY-specific and goes away in pure WASM (replaced by a typed-array/linear-memory contract — see b9dad9a). The `walk` tree-build itself is the thing you want to NOT do eagerly anymore; it was superseded by SoA.

---

### ed69703 — Add conformance delta + speed benchmarks vs happy-dom/jsdom/parse5
**Files:** `src/core.rs` (`parse_html_document_count`, `count`), `src/lib.rs` (`parse_raw`→`parseRaw`), `index.js` (export `parseRaw`); plus `bench/`, `harness/adapters.mjs`, `harness/delta.mjs` (bench/measurement only).

**Optimization (from the diff):** Not an optimization itself — it adds the *measurement* that justified the next commit. `parseRaw` parses the document and returns only the node count (`count()` recurses `children`), building NO `core::Node` tree and crossing NO marshaled data. Subtracting `parseRaw` time from `parse` time isolates raw html5ever parse cost from tree-build + boundary-marshaling cost. The bench result (parse vs parseRaw gap 2.2–8×) is what proved "marshaling dominates" and unlocked the SoA bet.

**Rust/WASM port note:** PORTS (as methodology) — keep an equivalent "parse-only, return a scalar" path in the Rust core so the WASM rewrite can re-measure the boundary/marshaling cost rather than assume it. The win it *enabled* (SoA) is the real carry-over; this commit's code is a measurement harness.

---

### f49a4bf — Layers 2-5: lazy COW DOM + lazy window + honest stubs + fast reset
**Files:** `src/runtime/dom.mjs` (`Node.__children`, `Document.__inflate`/`__cache`, COW `insertBefore`/`removeChild`, `parseDocument`), `src/runtime/collections.mjs` (`liveNodeList`/`liveHTMLCollection`), `src/runtime/window.mjs` (`createWindow` lazy-global Proxy), `src/runtime/selectors.mjs`, `events.mjs`, `html-serialize.mjs`, `index.mjs`.

**Optimization (from the diff):** Three foundational perf ideas land here:
1. **Lazy inflation + identity memoization.** `Node.__children()` does not build child handles until first access; it walks the immutable backing tree, calls `Document.__inflate(raw)`, and caches `this.__kids`. `__inflate` keeps a `Map<raw, handle>` so one buffer node → exactly one JS handle, preserving `===` identity across repeated reads (`el.childNodes` stable, WeakMap-keyable). A node never touched costs nothing.
2. **Copy-on-write mutation.** Reads come transparently from the buffer; the first mutation goes through `__children()` which materializes/owns `__kids`, and `insertBefore`/`removeChild` splice that owned array. A buffer-backed read and an owned read are indistinguishable — so the immutable parse tree can back many documents.
3. **Lazy self-replacing window globals.** `createWindow` is a `Proxy` whose `lazy` globals (localStorage, matchMedia, observers, location/history, navigator…) are factories materialized on first `get` and then written back onto the target (`t[k] = v`) so subsequent reads skip the Proxy/factory entirely. Universal globals (document, constructors, timers) are eager. The Proxy doubles as a `touched` tracer. Live collections (`collections.mjs`) re-read their backing array on every access (correct liveness) but at this point still use a `^\d+$` regex per index and a generic Proxy.

**Rust/WASM port note:** PORTS (the algorithmic core) — lazy inflation, per-index identity memoization, and COW-over-immutable-buffer are language-agnostic wins; in Rust use an arena/`Vec` of node slots, index handles, and a memo table (`Vec<Option<Handle>>`) keyed by node index instead of a JS `Map<raw,handle>`. The COW "owned child array vs buffer-backed" split maps to "overlay `Vec` per mutated node vs read-through to the SoA slices." V8-SPECIFIC: the self-replacing-Proxy window and the live-collection `Proxy` are JS object-model tricks — in a WASM/Rust runtime exposed to JS you'd still need a JS-side Proxy shim (the laziness/touch-tracing is the portable idea; the Proxy mechanism is not), and the regex index test is a JS detail later replaced by a charCode check.

---

### b9dad9a — SoA flat buffer: Structure-of-Arrays parser + lazy typed-array inflation  ★ load-bearing
**Files:** `src/core.rs` (`Soa` struct, `SoaBuilder` with `intern_tag`/`push_string`/`alloc`, `parse_html_soa`), `src/lib.rs` (`JsSoa` with napi `Uint8Array`/`Uint32Array`/`Int32Array`/`Uint16Array` + `From<core::Soa>`, `parseBuffer`), `src/runtime/buffer.mjs` (new `Buffer` accessor), `src/runtime/dom.mjs` (`Node.__children` walks `firstChild`/`nextSib`, `Document.__nodeAt`, `__inflateNested`, `__load`, `__cache` becomes an array), `index.mjs`.

**Optimization (from the diff):** This replaces the nested-tree full-marshaling path (a2742e1) with a **Structure-of-Arrays flat buffer**. The Rust `Soa` holds parallel arrays indexed by node id (node index *is* its id; node 0 is the document):
- scalars in typed arrays: `node_type:Vec<u8>`, `ns:Vec<u8>` (0/1/2 for html/svg/math), `tag_id:Vec<u32>`, and the tree topology as `parent`/`first_child`/`next_sib:Vec<i32>` (-1 sentinel) — i.e. a **first-child/next-sibling linked tree encoded in flat index arrays**, no per-node child `Vec`;
- `text_id`/`pub_id`/`sys_id:Vec<i32>` index into a pooled `strings` table;
- attrs as a flat CSR-style layout: `attr_start:Vec<i32>` + `attr_count:Vec<u16>` slice into shared `attr_name`/`attr_value`/`attr_prefix` arrays;
- `tag_names` are **interned & deduped** via a `HashMap<String,u32>` (`intern_tag`), and text/comment/doctype data is pooled in `strings` (`push_string`).
`SoaBuilder.alloc` recurses once, pushing scalar placeholders then linking siblings inline (`first_child`/`next_sib`) with no closures to avoid borrow churn; `<template>` content becomes a synthetic `content` fragment node linked as a child. The napi `JsSoa` crosses the boundary as cheap typed-array copies (`Uint8Array::new(...)` etc.) instead of marshaling thousands of objects. On the JS side, `Buffer` (buffer.mjs) is a zero-alloc accessor reading straight from the typed arrays; `Document.__nodeAt(idx)` inflates ONE handle per index, memoized in a plain array `__cache[idx]` (array, not Map — index keys); `Node.__children()` iterates `buf.firstChild(idx)`→`buf.nextSib(c)`. `__inflateNested` is kept for the owned-subtree path (innerHTML=). Measured 1.3–4.2× over the old `parse()`, landing within 1.4–1.65× of the `parseRaw` floor (was 4–8× off) — confirming marshaling was the cost.

**Rust/WASM port note:** PORTS — and this is the single most important thing to preserve. The SoA layout (parallel typed/flat arrays, first-child/next-sibling index topology with -1 sentinels, CSR-style attr slices, interned tag table + pooled string table) is *native Rust idiom* and even more natural in a pure-Rust core than it was as a Rust→JS bridge: build it in arena `Vec`s, hand JS a view over WASM linear memory (or copy the typed arrays out once). The BOUNDARY consideration shifts: in napi it was "typed-array copy beats object marshaling"; in WASM the same SoA can be exposed *zero-copy* as views into linear memory (`memory.buffer` + offsets) — strictly better, but watch string handling (the `strings`/`tag_names`/`attr_*` String vecs need a UTF-8 offset/length table in linear memory rather than `Vec<String>`). Keep node-index-as-identity and the per-index memo cache (a `Vec<Option<handle>>`). Do NOT reintroduce per-node child vectors or a nested tree on the hot path — that's the regression this commit removed.

---

### 72f5cdc — Complete plan §9: all benchmarks + tests (wasm, user-event, suite, liveness)
**Files (substantive):** `src/runtime/dom.mjs` (`Element.__runDefaultAction`, expanded `defaultValueProp` selection API, `Range`, `makeSelection`, `createRange`/`getSelection`), `src/runtime/events.mjs` (post-dispatch default-action hook), `src/runtime/window.mjs` (`DataTransfer`, `ClipboardEvent`, eager `EventTarget`). Plus bench/test files (`bench/wasm.mjs`, `bench/suite.mjs`, `test/userevent.test.mjs`, `test/liveness.test.mjs`).

**Optimization (from the diff):** Largely **feature/correctness + measurement**, not a perf optimization. Adds the click default-action model (checkbox/radio toggle, label→control) wired as a `__runDefaultAction` hook called by `dispatchEvent` after propagation when not `preventDefault`'d; a functional-but-zero-geometry `Range`/`Selection`; input `selectionStart/End`/`setSelectionRange`; `DataTransfer`/`ClipboardEvent`. These exist so `@testing-library/user-event` runs unmodified. The lasting *perf-relevant* artifact is the benches/tests themselves: `bench/suite.mjs` measures the real wall-clock win and explicitly compares lazy-vs-eager nodes and eager-vs-lazy window, and `test/liveness.test.mjs` locks the "lazy ≡ eager, 0 divergences" invariant — the guardrail that keeps the lazy/COW/SoA model honest.

**Rust/WASM port note:** PORTS (as guardrail, not technique) — the default-action-hook-after-dispatch and the lazy↔eager equivalence invariant are behaviors to re-implement and re-assert in the port; the lazy/eager and node-identity property tests in `liveness.test.mjs` are the exact regression net to keep running against the Rust-backed runtime. The Range/Selection/DataTransfer stubs are plain feature surface with no perf characteristic to carry.
## Batch 2 — Packaging + early surface (v0.1.0–v0.1.3)

Range `72f5cdc..f057cb5` (oldest-first). As predicted, most of this batch is renames / CI /
publishing / vitest-jest adapters. Substantive commits below; skips listed at the end.

Classification key:
- **PORTS** — the mechanism is data-structure / algorithm logic that should be re-implemented in the Rust runtime as-is.
- **V8-SPECIFIC** — relies on a JS-engine feature (Proxy, prototype descriptors, microtask queue, `instanceof`) and needs a deliberate Rust analogue, not a literal port.
- **BOUNDARY** — concerns the Rust→JS marshaling format / napi-wasm interface itself; directly relevant to the parser side of the port.

---

### 27f1ead — — Bump html5ever 0.27 → 0.39 (conformance 98.43% → 99.72%)
**Files:** `Cargo.toml`, `src/core.rs` (`parse_html_fragment_context`), `harness/conformance.mjs`, `test/conformance.test.mjs`
**Change (from the diff):** Dependency bump only in code terms — `parse_fragment` gained a 5th bool arg in 0.39, so the single call site in `core.rs` was updated. Conformance gate raised to 99.5%; the former `<select>`-family failure class disappeared because the newer Servo parser adopted the WHATWG `<select>` insertion-mode spec.
**Rust/WASM port note:** BOUNDARY — this is the parser crate, which already IS Rust and carries straight over; the only port constraint is that the runtime must keep tolerating the 5 remaining bleeding-edge `<select>` proposal misses (don't loosen the serializer to mask them).

### ee87e4d — — SoA: intern attribute names + prefixes
**Files:** `src/core.rs` (`Soa`, `SoaBuilder`, `intern_attr_name`, `intern_attr_prefix`), `src/lib.rs` (`JsSoa`), `src/runtime/buffer.mjs` (`Buffer.attrs`), `index.d.ts`
**Change (from the diff):** Attribute names and prefixes are now interned exactly like tag names: per-attribute `attr_name: Vec<String>` / `attr_prefix: Vec<String>` became `attr_name_id: Vec<u32>` / `attr_prefix_id: Vec<u32>` (u32 ids) plus deduped string tables `attr_names` / `attr_prefixes`. `SoaBuilder` gains `attr_name_map` / `attr_prefix_map` HashMaps to assign ids on first sight. `attr_start` now indexes into `attr_value` (the only remaining per-attr `Vec<String>`). On the JS side `Buffer.attrs` resolves `attrNames[attrNameId[i]]` / `attrPrefixes[attrPrefixId[i]]`. Result: SSR with 800 attrs → 2 unique name strings cross the boundary (Storybook 75 → 14); fewer JS string allocations + smaller buffer. Parse throughput unchanged.
**Rust/WASM port note:** BOUNDARY/PORTS — this is the SoA marshaling layout and it is the single most load-bearing data-model decision in the batch. In a pure-Rust runtime the Document can hold the interned `attr_names`/`attr_prefixes` tables directly and store attributes as `(u32 name_id, String value, u32 prefix_id)` with NO string-table crossing at all — the interning win compounds (only `attr_value` need ever materialize). Keep the three flat tables + parallel `attr_start`/`attr_count` index arrays; values stay pooled.

### 8cbd95b — — Fix core DOM gaps: dataset, <select>, real MutationObserver, form props on prototype
**Files:** `src/runtime/dom.mjs` (`Element` form-control getters/setters, `makeDataset`, `notifyMutation`, `MutationObserver`, `Document.__mo*`), `src/runtime/stubs.mjs`, `src/runtime/window.mjs`
**Change (from the diff):** Several data-model decisions:
- **Form-control props moved from per-instance `defineValueProp(el)` to the `Element` prototype** as plain getters/setters (`value`/`checked`/`type`/`selectionStart`/`selectionEnd`/`disabled`/`selected`/`options`/`selectedIndex`/…). The old code `Object.defineProperty`-ed these onto each inflated input/select instance; now they live once on the prototype and branch on `this.localName`. Motivation: user-event reads `element.constructor.prototype` descriptors, which per-instance props don't satisfy. Backing state lives in per-instance fields lazily set on first write (`__value`, `__checked`, `__selStart/__selEnd/__selDir`, `__selected`); reads fall back to the parsed attribute.
- **`element.dataset`** is a `Proxy` over `{}` (get/set/deleteProperty/has/ownKeys/getOwnPropertyDescriptor) mapping camelCase ↔ `data-*` via regex, memoized as `__dataset`.
- **Real MutationObserver**, wired through a single `notifyMutation(target, record)` call placed in `insertBefore`/`removeChild`, the `CharacterData.data` setter, and `setAttribute`/`removeAttribute`. Observers register on `Document.__mo` (array of `{obs, target, options}`); delivery is filtered by `childList`/`attributes`/`characterData`/`subtree`/`attributeFilter`/`*OldValue`, queued per-observer, and flushed via `queueMicrotask` (`__scheduleMO` de-dupes with a `Set`). `takeRecords`/`disconnect` are real. `reset()` drops `__mo`/`__moPending`.
- `attachShadow` creates a detached `DocumentFragment` with `host` back-ref + scoped `querySelector`; `<canvas>.getContext` returns a memoized no-op stub.
**Rust/WASM port note:** Mixed.
  - Form props on the prototype: V8-SPECIFIC. The "descriptors must be on the prototype" requirement is purely a JS-reflection (`constructor.prototype`) concern that vanishes in Rust. In the Rust port, dispatch form-property access by element-kind in one match arm — the per-instance-vs-prototype distinction is moot — but PRESERVE the lazy "explicit state field overrides parsed attribute" fallback (`__value ?? getAttribute('value')`), which is real DOM semantics.
  - `dataset` Proxy: V8-SPECIFIC — implement as a live view object over the attribute list with the same camelCase↔`data-*` mapping; no Proxy needed.
  - MutationObserver: PORTS — the registry-on-Document + single `notifyMutation` chokepoint at every mutation site + filter logic ports verbatim; only the `queueMicrotask` microtask-flush is V8-SPECIFIC (Rust runtime needs its own microtask/turn queue, which the scheduler work later in the project already establishes).

### f963264 — — Vitest/jest env adapters + on<event> props + HTML*Element constructors + host-timer capture
**Files:** `src/runtime/events.mjs` (`ON_EVENTS` loop on `EventTarget.prototype`), `src/runtime/window.mjs` (host-fn capture, `HTML*Element` map, `globalKeys`), `src/runtime/dom.mjs` (`Document` state getters), `src/runtime/index.mjs` (`globalKeys` export), `src/environment/install.mjs` (new)
**Change (from the diff):**
- **`on<event>` handler properties** defined once on `EventTarget.prototype` for ~50 event types. Each `onX` getter/setter is backed by a per-instance slot `__on_<type>`; the setter removes the previous handler and `addEventListener`s the new one. Reason: makes `'oninput' in document` true so React skips its legacy `attachEvent` input polyfill, and lets libs assign `el.onX = fn`.
- **`HTML*Element` constructor map**: `HTMLElement`/`SVGElement` aliased to `Element`; ~20 specific tags (`HTMLInputElement` etc.) ALSO aliased to plain `Element` — but `HTMLIFrameElement` is a *distinct* `class extends Element` so React's `while (el instanceof HTMLIFrameElement)` iframe-descent loop terminates on ordinary elements.
- **Host timer capture**: `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`queueMicrotask`/`structuredClone`/`requestAnimationFrame` captured into module-level `host*` consts at load, BEFORE any `installGlobals()` can shadow the bare names on `globalThis` (otherwise the window's delegates would recurse into themselves).
- `Document` honest-state getters (`visibilityState:'visible'`, `hidden:false`, `readyState:'complete'`, `hasFocus():true`, `characterSet`, `compatMode`).
- `globalKeys` (all base+lazy window key names) exported so the adapter can install lazy getters.
**Rust/WASM port note:** Mostly V8-SPECIFIC / out-of-scope for the Rust runtime core.
  - `on<event>` props: PORTS conceptually — the runtime must expose `onX` accessors that desugar to add/remove a single tracked listener per type; keep the "setter replaces previous handler" semantics. The `'onX' in obj` reflection trick is the load-bearing reason, so the Rust host-binding layer must still surface these names to JS.
  - `HTMLIFrameElement` distinctness: PORTS — the type-identity requirement is real (React relies on it); the Rust element model needs a queryable element-kind so an `instanceof HTMLIFrameElement` analogue is false for non-iframes.
  - Host-timer capture & `installGlobals`/adapters: V8-SPECIFIC — entirely about coexisting with a JS host global object; irrelevant once the runtime is Rust-native, though the "owned timer queue must not delegate back to itself" hazard recurs in any embedding.

### f057cb5 — v0.1.3 — Broaden DOM/window surface for real-suite compatibility
**Files:** `src/runtime/dom.mjs` (`Node`, `CharacterData`, `Text`, `Element`), `src/runtime/window.mjs`
**Change (from the diff):** Large surface fill-in. Data-model-relevant pieces:
- `Node`: `isConnected`/`getRootNode` (walk to root, check DOCUMENT_NODE), `normalize` (merge/drop adjacent/empty text children in a reverse index loop), `replaceChildren` (resets `__kids = []` then appends), `compareDocumentPosition` (contains-checks, else a flat document-order walk + `indexOf`), base `cloneNode(deep)`.
- `CharacterData`: `substringData`/`appendData`/`insertData`/`deleteData`/`replaceData` (all slice-based, routed through the `data` setter so they fire mutation records), `before`/`after`/`replaceWith`.
- `Text`: `wholeText` (walk prev/next text siblings), `splitText` (slice + insert new Text after).
- `Element`: **honest-zero geometry** — `offsetWidth`/`Height`/`Top`/`Left`, `clientWidth`/…, `scrollWidth`/…, `scrollTop`/`scrollLeft` all return 0 (the synthetic-geometry rework comes much later in the project). `getAttributeNS` family delegating to non-NS variants; `getAttributeNode` returning a plain `{name,value,ownerElement}` literal; `insertAdjacentElement`/`Text`.
**Rust/WASM port note:** PORTS — these are pure tree-walk / string-slice algorithms over the node model and port directly to Rust (`normalize`, `compareDocumentPosition`'s flat-walk ordering, `wholeText`/`splitText`, the CharacterData slice ops). Two notes: (1) keep CharacterData edits routed through the single mutation-notifying `data` setter so MutationObserver still fires; (2) the honest-zero geometry here is SUPERSEDED later by synthetic geometry — do NOT port the literal `return 0` getters; port the later synthetic box model instead.

---

### Skipped (no runtime data-model impact)
- **8cfc88e** — skipped: rename fast-dom → gr0gdom + add MIT license.
- **ff81cbe** — skipped: rename gr0gdom → turbodom.
- **ec1e62b** — skipped: rename turbodom → turbo-dom (npm name taken).
- **58da506** — skipped: README rewrite (docs).
- **d408ba6** — skipped: CI cross-platform napi prebuilds / Linux test+conformance / tag publish.
- **98e66c9** — skipped: publishing — platform `optionalDependencies` + CI publish hardening.
- **9a4dc0b** — skipped: CI Node 22 bump (`node --test` glob needs ≥21).
- **a71bfb6** — skipped: CI drop x86_64-apple-darwin prebuild.
- **2b8b86b** — skipped: CI publish single bundled package.
- **205c3c0** — skipped: release v0.1.1 (version bump).
- **7a8606b** — skipped: release v0.1.2 — scope package as `@miaskiewicz/turbo-dom` (packaging).
## Batch 3 — First perf wins + correctness (v0.1.4–v0.1.20)

Range `f057cb5..ac134db`. The headline commits are the first real perf wins: allocation-free
selector/match hot paths (066302f), the version-keyed `getElementsBy*` cache (d2208e1), and the
per-version query-result cache (ac134db). The rest are DOM-correctness fixes that establish the
behavioral contract a Rust runtime must reproduce. Pure docs/CI commits are skipped.

---

### 9f6c247 — v0.1.4 — Fix vitest 4 environment adapter + accessible-name (getByRole)
**Files:** `src/runtime/dom.mjs` (`Node.prototype` static-constant assignment), env adapter.
**Optimization (from the diff):** Not a perf change — a correctness fix. `Object.assign(Node.prototype, {...})`
installs the nodeType constants (`ELEMENT_NODE: 1`, `TEXT_NODE: 3`, …) and `DOCUMENT_POSITION_*`
masks as **instance-resolvable** properties (on the prototype, not just as static class fields).
`dom-accessibility-api` reads `node.TEXT_NODE` off the instance, so `computeAccessibleName` returned
`""` and `getByRole({name})` never matched until the constants lived on the prototype.
**Rust/WASM port note:** PORTS, but trivially. In a Rust tree these constants are just `i32` enum
values; the only reason it matters here is the JS-prototype lookup contract. If the WASM boundary
exposes a JS Node wrapper, the wrapper must still expose these as own/prototype properties for
JS-side a11y libraries (dom-accessibility-api) running on top — BOUNDARY concern, not core.

### d25a20e — v0.1.5 — Verify + CI-guard jest support
Skipped (CI/test-harness only, no `src/runtime/` change).

### da6a932 — v0.1.6 — Event.initEvent + typed createEvent + fix performance.now
**Files:** `src/runtime/events.mjs` (`Event.initEvent`/`initCustomEvent`, `makeTyped`),
`src/runtime/dom.mjs` (`Document.createEvent`), `src/runtime/window.mjs` (`performance.now`).
**Optimization (from the diff):** Correctness. `Event.prototype.initEvent(type,bubbles,cancelable)`
plus `initCustomEvent`/`initMouseEvent`/etc. mutate the event in place (react-dom dev build + RTL
`fireEvent` construct via `createEvent('Event')` then call `initEvent`, which previously threw).
`createEvent(type)` now switches on the string to return the matching typed subclass
(`MouseEvent`/`KeyboardEvent`/`UIEvent`/`FocusEvent`/`CustomEvent`). `performance.now()` switched to
`node:perf_hooks` real ms (was `process.hrtime` seconds, giving vitest bogus multi-million-second
durations).
**Rust/WASM port note:** Event objects PORT as Rust structs. `performance.now()` is V8-SPECIFIC /
BOUNDARY — the v0.2.4 injectable-clock work (later batch) supersedes the host-clock choice here;
the Rust runtime should route `now()` through an injectable clock fn, not hardcode a host timer.
`createEvent` string→subclass dispatch is a plain match arm in Rust.

### a0ba444 — v0.1.7 — Form-control fidelity: change events for all input types
**Files:** `src/runtime/dom.mjs` (`__preClickActivation`, `__radioGroup`, `option.selected` setter,
`valueAsNumber`/`valueAsDate`), `src/runtime/events.mjs`.
**Optimization (from the diff):** Correctness. Checkbox/radio toggle now happens via WHATWG
pre-click activation writing the **internal field `__checked` directly, NOT through the `checked`
setter** — React wraps the `checked`/`value` setters with its value-tracker, so going through the
setter hid the mutation and suppressed `onChange`. Radio activation clears the name-group
(`__radioGroup()`) and stores an `undo` closure run on `preventDefault`. `option.selected = true`
in a single (non-`multiple`) `<select>` deselects sibling options so `select.value` reflects the
choice. Added `valueAsNumber`/`valueAsDate`.
**Rust/WASM port note:** PORTS. The "write the backing field, bypass the IDL setter" rule is the
load-bearing subtlety: in Rust the activation must mutate `node.checked: bool` directly without
firing whatever JS-side property-interception React installs. Note this is a BOUNDARY constraint —
React's value-tracker lives in JS over the wrapper, so the Rust core can't see it; expose a raw
internal-mutation path distinct from the JS-facing setter.

### a690c24 — v0.1.8 — window.open/scrollTo + CSS !important priority
**Files:** `src/runtime/dom.mjs` (`makeStyle` inline-CSSOM rewrite), `src/runtime/window.mjs`
(`open`/`close`/`moveTo`/… own-prop stubs).
**Optimization (from the diff):** Correctness. `makeStyle` reworked from a single `Map` to
`{values, prio}` two-map parse: a trailing `!important` is stripped via regex into the `prio` map,
`getPropertyPriority` returns `'important'`, `setProperty(p,v,'important')` is honored, and `write()`
re-serializes `!important` back into the style attribute. Window methods added as **own properties**
so `vi.spyOn(window,'open')` can find them.
**Rust/WASM port note:** PORTS. Inline-style is parsed lazily from the `style` attribute string on
each access here (`parse()` per get) — a Rust port should keep parse-on-read or memoize keyed on the
attribute string; this is test-time-only CSSOM, never a hot path. `vi.spyOn` needing own-props is
V8-SPECIFIC/BOUNDARY — irrelevant to a Rust core, only to a JS wrapper surface.

### 8cacfe9 — v0.1.9 — Focus blur-on-move, File-preserving FormData
**Files:** `src/runtime/dom.mjs` (`focus`/`blur`), `src/runtime/window.mjs` (`TurboFormData`).
**Optimization (from the diff):** Correctness. `focus()` now reads `doc.__active`, and if a
*different* element was focused, blurs it first (dispatches `blur`+`focusout` with `relatedTarget`)
before setting the new active and firing `focus`/`focusin` — so `onBlur` fires on tab/click-away.
`focus()`/`blur()` early-return when already (un)focused. `TurboFormData` replaces Node's global
FormData (which re-wraps entries into anonymous Blobs, losing File identity) — it stores raw entries
in `__entries` array and preserves the File reference so `fd.get('file') === the appended File`.
**Rust/WASM port note:** PORTS. Active-element tracking is a single `Option<NodeId>` on the document
(`__active`); blur-on-move is straightforward state. FormData/File identity is a BOUNDARY concern —
File objects likely stay JS-side wrappers; the Rust core just needs to not clone them.

### cfd0b7f — v0.1.10 — Date/time value sanitization, :checked pseudo, window===globalThis
**Files:** `src/runtime/dom.mjs` (`sanitizeInputValue`, `value` setter), `src/runtime/selectors.mjs`
(`matchPseudo` form-state cases), env adapter.
**Optimization (from the diff):** Correctness. `value` setter for `<input>` routes through
`sanitizeInputValue(type, v)` — per-type WHATWG regex validation (date/month/week/time/
datetime-local/number/range/color); invalid → returns `null` → setter rejects, keeping the old value
(so user-event char-by-char typing emits one clean onChange, not bogus partials). Selector engine
gained `:checked`/`:disabled`/`:enabled`/`:required`/`:optional`/`:read-only`/`:read-write`/
`:selected` — each reads the **live property** (`el.checked`, what React sets) falling back to the
HTML attribute, NOT the attribute alone.
**Rust/WASM port note:** PORTS. Sanitization is pure regex-per-type → trivial Rust match. The
pseudo-class "read live property OR attribute" rule matters: the Rust matcher must consult the live
DOM-state field (e.g. `node.checked`) plus the parsed attribute, not just the parser's attribute.
These pseudos run inside selector matching (hot path) but only fire when a `:state` pseudo is
present — keep them branch-gated so plain tag/class/id selectors never touch them.

### bff2312 — v0.1.11 — Positional pseudo-classes + anchor reflection
**Files:** `src/runtime/selectors.mjs` (`nthMatch`, `siblingIndex`/`typeIndex`/`typeCount`,
`elementSiblings`), `src/runtime/dom.mjs` (`download`/`rel`/`referrerPolicy`/`src`/`alt` IDL getters).
**Optimization (from the diff):** Correctness. Real `:nth-child`/`:nth-of-type`/`:nth-last-*` via
`nthMatch(arg, index)` parsing An+B / odd / even / integer, and correct `:first/:last/:only-of-type`
(was a wrong always-`true` stub). Index helpers (`elementSiblings`, `siblingIndex`, `typeIndex`,
`typeCount`) compute over the parent's element children.
**Rust/WASM port note:** PORTS, but watch the allocation. `elementSiblings` here does
`kids.filter(n => n.nodeType===1)` and `typeIndex` does `.filter(...).indexOf(el)` — these allocate
arrays and run inside matching. The later allocation-free discipline (066302f) does NOT cover these
positional helpers, so a Rust port should compute sibling/type index with index loops over the
parent's children (no intermediate `Vec`) to stay allocation-free. Only fires when an `:nth`/`:*-of-type`
pseudo is present.

### 0e4eeba — v0.1.12 — Tag-specific HTML*Element instanceof
**Files:** `src/runtime/window.mjs` (`tagClass(matcher)`).
**Optimization (from the diff):** Correctness. Previously every `HTML*Element` was aliased to
`Element`, so `el instanceof HTMLAnchorElement` was true for ALL elements. `tagClass(matcher)`
builds a non-constructible function whose `Symbol.hasInstance` returns true only when
`o.nodeType===1 && (localName===str | regex.test(localName))` — so `instanceof HTMLAnchorElement`
matches only `<a>`, `HTMLHeadingElement` matches `/^h[1-6]$/`, while `HTMLElement` stays `Element`
(true for all). Critically lets React's `while (el instanceof HTMLIFrameElement)` loop terminate.
**Rust/WASM port note:** V8-SPECIFIC / BOUNDARY. `Symbol.hasInstance` is a pure JS mechanism — there
is no Rust equivalent and no core work to port. If the WASM build exposes JS constructor wrappers,
the wrapper layer must reproduce per-tag `Symbol.hasInstance`; the Rust core only needs to expose
`localName` so the JS shim can test it.

### be00916 — v0.1.13 — Fix regression: tag-class prototype === Element.prototype
**Files:** `src/runtime/window.mjs` (`tagClass`: `C.prototype = Element.prototype`).
**Optimization (from the diff):** Correctness regression fix for 0.1.12. The tag classes had their
own empty `.prototype`, so `vi.spyOn(HTMLAnchorElement.prototype,'click')` threw (click/focus/blur
live on `Element.prototype`). Pointing `C.prototype = Element.prototype` makes prototype-level
spies/reads resolve while `instanceof` is still decided by the `Symbol.hasInstance` matcher.
**Rust/WASM port note:** V8-SPECIFIC / BOUNDARY only — same as 0.1.12. No Rust core work.

### b9cf4a8 — v0.1.14 — Proper document.cookie jar
**Files:** `src/runtime/dom.mjs` (`Document` cookie get/set), `src/runtime/index.mjs` (reset clears
`__cookieJar`).
**Optimization (from the diff):** Correctness. `document.cookie` setter now parses `name=value;
path=/; Secure; …`, stores only `name=value` in a `Map` (`__cookieJar`), strips attributes,
dedupes by name, and deletes on `max-age<=0` or past `expires`. Getter serializes the Map back to
`name=value; …`. Was a naive append (attributes leaked, no dedupe). Reset sets `__cookieJar=null`.
**Rust/WASM port note:** PORTS. A `HashMap<String,String>` (or insertion-ordered map) on the
document plus parse-on-set. Pure logic, no boundary issues.

### 2497926 — v0.1.15 — click-in-progress flag fixes programmatic .click() re-entrancy
**Files:** `src/runtime/dom.mjs` (`click()`).
**Optimization (from the diff):** Correctness. `click()` sets `this.__clickInProgress = true` in a
try/finally; a nested `.click()` on the same element (parent onClick re-clicking a child that
bubbles back) early-returns — the WHATWG "click in progress" flag, breaking otherwise-infinite
re-entrancy (file-dropzone pattern → stack overflow). Also upgrades to a real `MouseEvent` with
`detail:1`.
**Rust/WASM port note:** PORTS. A `bool` flag on the node with RAII-style guard (set on entry, clear
on drop/scope-exit). Note: the re-entrant dispatch happens because JS listeners (React handlers) run
synchronously during dispatch — if dispatch crosses the WASM boundary into JS listeners, the flag
must be set BEFORE the boundary call and cleared after, so the guard wraps the whole JS-callback fan-out.

### b688d9c — v0.1.16 — Implicit <label> labels only its first control
**Files:** `src/runtime/dom.mjs` (`labels` getter).
**Optimization (from the diff):** Correctness. The implicit-label walk up `parentNode` now stops at
the first ancestor `<label>` and includes it ONLY if `p.control === this` (the label's first
labelable descendant) — and `break`s. Previously every labelable descendant claimed the label, so
`getByLabelText('Street')` matched both an input and a button.
**Rust/WASM port note:** PORTS. Ancestor walk + a `control` resolution (first labelable descendant).
Pure tree logic. Note `labels`/`control` lean on `getElementsByTagName('label')` — the O(n²)
problem the next commit's cache attacks.

### 75f34d3 — v0.1.17 — Add license field (MIT)
Skipped (package.json metadata only).

---

### 066302f — v0.1.18 — Allocation-free selector/match hot paths (query-heavy ~1.8×)
**Files:** `src/runtime/selectors.mjs` (`__selectorCache`, `hasClass`, `matchCompound`, `matchAttr`,
`simpleMatcher`, `rawChildren`, `querySelector`/`querySelectorAll`), `src/runtime/dom.mjs`
(`getAttribute`/`hasAttribute`, `collectByTag`, `collectByClass`, `elHasClass`).
**Optimization (from the diff):** This is the core hot-path discipline. Concretely:
- `getAttribute`/`hasAttribute` replaced `this.__attrs.find(x=>x.name===name)` / `.some(...)`
  closures with bare `for` loops (no closure allocation per call).
- `matchCompound` class test: instead of `el.classList.contains(cls)` (which allocates a ClassList
  and splits the class string), it reads `el.getAttribute('class')` ONCE and calls `hasClass(cn,cls)`
  — a whole-word string scan using `cn.indexOf(cls)` + `charCodeAt(...) <= 32` boundary checks (no
  split, no array, no regex). `collectByClass` uses the same scan via `elHasClass`.
- `collectByTag`/`collectByClass`/the qS(A) walks iterate `node.__children()` with an **index loop**
  (`for (let i...; i++)`), skipping the previous per-node `elementChildren()` filtered-array
  allocation.
- `matchAttr` does a single `getAttribute` (null = absent) instead of `hasAttribute` THEN
  `getAttribute`.
- Parsed selectors memoized in `__selectorCache` (Map, string→AST, bounded at 10000, cleared on
  overflow) — pure/DOM-independent so NO invalidation needed.
- `simpleMatcher` regex fast-path for the common `#id` / `.class` / `tag` selectors, skipping the
  full parse + `matchComplex` machinery; single-selector lists skip the `list.some(...)` closure.
**Rust/WASM port note:** PORTS — and this is the discipline the Rust port must preserve natively. In
Rust: matching over a `&[Node]` slice with index loops is already allocation-free; the whole-word
class scan becomes byte-scan over the class `&str` (`split_whitespace().any(|c| c==cls)` is clean and
non-allocating, or a manual `find` + boundary check to match exactly). Attribute lookup = linear
scan over the element's attr slice. The selector-AST cache PORTS as a `HashMap<String, Ast>` (pure,
no invalidation). The simple-selector fast path is worth keeping. Note: classList/split was the
dominant cost — a Rust port that builds a `Vec<String>` of classes per element per match would
reintroduce exactly the regression this commit removed.

### d2208e1 — v0.1.19 — Version-keyed getElementsBy* cache (getByLabelText 4.8×)
**Files:** `src/runtime/dom.mjs` (`Node.__touch`, `notifyMutation` version bump, `Document.__byTag`/
`__byClass`/`__tagCache`/`__classCache`, `getElementsByTagName`/`getElementsByClassName`, `__load`
cache reset; `__touch` calls added to `replaceChildren`/`textContent` setter/`innerHTML` setter).
**Optimization (from the diff):** Introduces the **`Document.__version` mutation counter** — the
invalidation key the whole runtime is built on. `notifyMutation` bumps `doc.__version`
unconditionally on every structural/attribute mutation (independent of MutationObservers).
`__touch()` bumps it for the direct-`__kids`-rewrite paths that bypass insert/remove
(`innerHTML`/`textContent`/`replaceChildren`). `getElementsByTagName`/`ClassName` now go through
`__byTag(t)`/`__byClass(key,classes)` which cache `{v, arr}` keyed on the current version in
`__tagCache`/`__classCache` Maps; a cache hit (`c.v === v`) returns the prior array. Fixes the
O(n²) RTL `getByLabelText` (calls `element.labels` per element → `getElementsByTagName('label')`
per element → full tree walk each time): 1342→277µs. `__load` (reset) clears the caches.
**Rust/WASM port note:** PORTS — port `__version` as a `u64` mutation counter on the Rust tree/
document, bumped by EVERY mutation entry point. The cache becomes `HashMap<Key, (u64 version, Vec<NodeId>)>`;
return the cached `Vec` when the stored version equals the current. CRITICAL invariant for the port:
any new mutation path MUST bump the counter or these caches go stale (CLAUDE.md flags this; the JS
version learned it the hard way with the `__touch` additions here). The collection is still LIVE
(re-walks on version change), so the cache is a memo, not a snapshot.

### aef7cbd — docs: honest benchmarks vs jsdom AND happy-dom
Skipped (docs only).

### ac134db — v0.1.20 — Per-version query-result cache (repeated queries beat happy-dom)
**Files:** `src/runtime/dom.mjs` (`cachedQSA`/`cachedQS`, `__qCache` on Element/DocumentFragment/
Document, `getElementById` `__idCache` + index-loop rewrite).
**Optimization (from the diff):** Caches the RESULTS of `querySelector`/`querySelectorAll` per node,
keyed on `(selector, Document.__version)`. `cachedQSA(node, sel)` reads `doc.__version`, looks up
`node.__qCache` (a Map, key `'a:'+sel` for All / `'s:'+sel` for single), returns the stored result
if `c.v === v`, else runs `qselAll` and stores `{v, r}`. Bounded at 512 entries (cleared on
overflow). Safe because `querySelectorAll` returns a STATIC list per spec — valid until the next
mutation bumps the version. `getElementById` gained `__idCache` (id→`{v, el}`) and was rewritten to
an index loop with `nodeType !== ELEMENT_NODE` skip. Result: 24k→915k iters/s on the query bench.
**Rust/WASM port note:** PORTS — same `(selector, version)` keying. In Rust: per-node
`HashMap<(String, u64), Vec<NodeId>>` (or store version alongside and compare). The `'a:'`/`'s:'`
prefix is just to share one Map between QSA and QS — in Rust use two maps or an enum key. CRITICAL:
this cache returns a stored result list; per spec QSA is static so reuse-until-mutation is correct,
but the Rust port must guarantee `__version`/counter bumps on EVERY mutation (same invariant as
d2208e1) or stale node lists leak. The bound (512, clear-on-overflow) is a pragmatic memory cap —
port it or use an LRU. The `getElementById` index-loop + nodeType-skip rewrite is the same
allocation-free discipline from 066302f.
## Batch 4 — Perf core: memoization, lazy fields, packed SoA (v0.1.20–v0.1.28)

Range `ac134db..23ab9ea` (oldest-first). This batch is the performance heart of the JS runtime: hoist stateless constructors, memoize live views, split the window into static/dynamic halves, memoize parsing, lazy-init per-node fields (`__attrs`, `__listeners`), an allocation-free `.class` matcher, and the packed single-blob SoA marshaling format with dictionary-encoded attr values and direct-from-buffer attribute reads. For the Rust→WASM rewrite, most of these map to deliberate choices about *when* to allocate and *what* to share, not algorithmic changes — the lazy/memoized fields become `Option`/`OnceCell` and per-node cached vecs derived from a live source.

---

### a7abb9c — (pre-v0.1.21) — Hoist stateless URL/File classes out of createWindow
**Files:** `src/runtime/window.mjs` — `createWindow`, `makeURL`/`makeFile`, new module-level `TURBO_URL`/`TURBO_FILE`.
**Optimization (from the diff):** `makeURL()` and `makeFile()` each *build a class* (subclassing the host `URL`/`Blob` with extra methods). They were called inside `createWindow`, i.e. once per environment / per test file, rebuilding identical classes every time. The classes are stateless (capture nothing per-env), so they're now built ONCE at module load into `const TURBO_URL = makeURL(); const TURBO_FILE = makeFile();` and the window base object just references them. createEnvironment 48.5→36µs (~25%). Correct because the classes hold no per-environment state.
**Rust/WASM port note:** PORTS (concept) / partly V8-SPECIFIC (the cost is JS class re-creation). In Rust there are no per-instance "classes"; the window's interface objects (`URL`, `File` constructors) would be static descriptors created once. The lesson — don't rebuild stateless interface objects per environment — applies: build the prototype/constructor table once (a `static`/`Lazy` table), reference it from each new window/environment.

---

### 8b87363 — v0.1.21 — Memoize live views + skip listener-less event propagation
**Files:** `src/runtime/dom.mjs` (`Node.childNodes`, `Element.children`, `DocumentFragment.children`), `src/runtime/events.mjs` (`EventTarget.dispatchEvent`), `src/runtime/stubs.mjs` (`makeGetComputedStyle`).
**Optimization (from the diff):** Three independent hot-path wins.
1. **Listener-less dispatch skip.** `dispatchEvent` replaced `event._path = this.__eventPath()` with a SINGLE ancestor walk (`while (node) { path.push(node); … node = parentNode || __owner }`) that simultaneously builds the path AND sets `hasListener` by checking `node.__listeners && node.__listeners.get(type)` along the way. The capture/at-target/bubble invoke loops are wrapped in `if (hasListener) { … }`, so when no node on the path has a listener for that type (React fires thousands of these), all three phases are skipped. preClick activation + default actions still run outside the guard. 0.88→0.61µs.
2. **Memoized live `childNodes`/`children`.** `get childNodes()` now caches the Proxy on `this.__childNodesList` (and `children` on `__childrenList`), returning the cached object on later access. Correct WITHOUT a version key because the cached `liveNodeList`/`liveHTMLCollection` reads `self.__children()` LIVE on every property access — the same object always reflects current state. Bonus: `el.childNodes === el.childNodes` is now stable (spec-correct identity). 0.086→0.021µs.
3. **Memoized getComputedStyle Proxy** on `el.__computedStyle` (reads `el.style` live). NOTE: this third mechanism was later SUPERSEDED — getComputedStyle became a version-keyed partial cascade (`cascade.mjs`), so don't port this exact inline-only Proxy; port the cascade version from a later batch.
**Rust/WASM port note:** PORTS. (1) The skip-when-no-listener branch ports verbatim — one ancestor walk collecting the path and an `any_listener: bool`; guard the three phases on it. With `__listeners` as `Option`, the per-node check is a cheap `is_some()` + map lookup. (2) Memoized live views → in Rust, cache the collection wrapper on the node (`OnceCell<NodeListHandle>` / `RefCell<Option<…>>`) where the handle re-derives its contents from the live children vec on read — do NOT snapshot the children at creation. Identity stability (`childNodes === childNodes`) requires returning the same handle each call, so the cell must persist on the node.

---

### fbeccb1 — v0.1.22 — Static/dynamic window split (createWindow 15→2.5µs)
**Files:** `src/runtime/window.mjs` — `createWindow` (slimmed `base`), new module-level `STATIC_BASE`, Proxy `get`/`has`/`set`/new `getOwnPropertyDescriptor` traps, `globalKeys`.
**Optimization (from the diff):** The window base was an ~80-property object literal rebuilt per `createWindow` (per test file). ~70 entries are stateless (DOM/event constructors, tag-interface classes via `tagClass`, timers delegating to captured host fns, `btoa`/`atob`, `CSS`, `XMLHttpRequest`, `scrollTo`/`open`/etc.) and identical every time. They moved to a module-level `STATIC_BASE` built ONCE. `createWindow` now builds only the ~11 per-env entries that capture `document`/`url`/`windowProxy` (`document`, `origin`, `customElements`, `Image`/`Audio`, `getSelection`, `dispatch/add/removeEventListener`). The Proxy resolves `get` as base → `STATIC_BASE` → lazy; `window.x = y` writes to `base`, shadowing `STATIC_BASE` per-env so overrides stay isolated. A new `getOwnPropertyDescriptor` trap synthesizes a descriptor for `STATIC_BASE` keys so `vi.spyOn(window, 'scrollTo')` finds them as own props (spy then defineProperty's onto `base`, shadowing). `has` and `globalKeys` union both. createWindow 15→2.5µs (6×). Correct because nothing in `STATIC_BASE` captures per-env state, and per-env writes shadow it.
**Rust/WASM port note:** PORTS (concept) / V8-SPECIFIC (the Proxy traps). In Rust split the window's global namespace into a `static`/`Lazy` shared table of stateless globals and a small per-environment map for document-capturing slots; lookup falls through per-env → shared → lazy, and a per-env write inserts into the per-env map (shadowing). The spyOn/`getOwnPropertyDescriptor` trap is a JS-test-tooling concern — only relevant if the WASM build still exposes a JS Proxy window; a pure-Rust DOM wouldn't need it.

---

### e3f6c2c — v0.1.23 — Parse memoization + lazy attrs
**Files:** `src/runtime/index.mjs` (`parseBufferCached`, `__parseCache`; used in `createEnvironment` + `reset`), `src/runtime/dom.mjs` (`Element.__buildAttrs` + lazy guards on `getAttribute`/`hasAttribute`/`getAttributeNames`/`setAttribute`/`removeAttribute`/`attributes`/`getAttributeNode`/`cloneNode`; `Document.__nodeAt` sets `__attrIdx`; `splitClasses` memo; `getElementsByClassName`).
**Optimization (from the diff):**
1. **Parse memoization.** `parseBufferCached(html)` memoizes `native.parseBuffer(html)` in `__parseCache` (Map, cleared past 64 entries). The SoA buffer is READ-ONLY — every mutation goes to a Document's own `__kids`/`__attrs`/`__cache` overlay, never the buffer — so the same buffer safely backs many Documents. Suites call setup with the same shell HTML per file → parsed once, reused. createEnvironment cache-hit 39→0.89µs (~40×). (NOTE: this commit calls `native.parseBuffer` directly; the lazy parser registry came in a later batch.)
2. **Lazy attrs.** Buffer-backed elements set `__attrIdx = idx` and leave `__attrs = undefined`; `__buildAttrs()` builds the `{name,value,prefix}` array from the SoA (`buf.attrs(idx)`) only when first touched. Every read site uses `this.__attrs ?? (this.__attrs = this.__buildAttrs())`. Traversal-only nodes (most inflated nodes) never build the array. `getAttribute` unchanged in cost — the `??` guard is free.
3. **`splitClasses`** memoizes `cls.split(/\s+/).filter(Boolean)` (the regex split showed per-call in `getElementsByClassName` profiles); pure, so a plain Map keyed on the string (cleared past 2000).
**Rust/WASM port note:** PORTS / BOUNDARY. (1) Parse memoization is BOUNDARY-relevant: the read-only SoA shared across Documents is exactly the model a Rust core wants — parse → immutable `Arc<Soa>`, each Document holds an overlay of mutations. Keep an HTML→`Arc<Soa>` LRU. (2) Lazy attrs → in Rust, the attr vec is `Option<Vec<Attr>>` built from the SoA columns on first mutation/full-read via the index; reads can go straight to columns (see 354b966). (3) `splitClasses` → a memo map or, better, store class tokens pre-split per buffer entry.

---

### e2afd29 — v0.1.24 — Live-collection index fast path + lazy event listeners
**Files:** `src/runtime/collections.mjs` (`makeLive` Proxy `get`/`has`/`getOwnPropertyDescriptor`), `src/runtime/events.mjs` (`EventTarget` constructor, `addEventListener`, `removeEventListener`).
**Optimization (from the diff):**
1. **Index fast path.** The live NodeList/HTMLCollection Proxy `get` ran ~8 string `===` comparisons then a `/^\d+$/.test(key)` regex on every access, with indexed access (`coll[i]`, the hottest) falling through ALL of it. Reordered so a numeric index is detected FIRST via `key.charCodeAt(0)` in 48–57 (no regex) and returns `getArray()[+key]`; only then the `length`/`item`/`forEach`/iterator branches. `getArray()` is now called only when actually needed (it used to be called once at the top of every `get`). Same charCode trick in `has`/`getOwnPropertyDescriptor`. Proxy `get` 4.7%→2.0% of profile; the regex is gone.
2. **Lazy listeners.** `EventTarget.__listeners` now starts `null` (was `new Map()` per construction); the Map is created on first `addEventListener` (`if (!this.__listeners) this.__listeners = new Map()`). Most inflated nodes never get a listener, so this skips a Map allocation per node. `dispatchEvent` already null-guards (`node.__listeners && …`); `removeEventListener` got an early `if (!this.__listeners) return`.
**Rust/WASM port note:** PORTS. (1) The index fast path is V8-Proxy-specific in form but the principle (cheap numeric-key detection, lazy array materialization) applies — a WASM collection should index without scanning a key table. If the Rust DOM still exposes JS Proxies for collections, port the charCode check. (2) Lazy listeners → `__listeners: Option<HashMap<…>>` initialized `None`, allocated on first `add_event_listener`; every read site `match`/`if let` guards it. This is a pure win and idiomatic Rust.

---

### ac784d3 — (v0.1.25 prep) — Drop eager `__attrs=[]` alloc
**Files:** `src/runtime/dom.mjs` — `Element` constructor, `Document.__nodeAt`.
**Optimization (from the diff):** The `Element` constructor still allocated `this.__attrs = []`. But the buffer-inflate path overwrites it and `__buildAttrs()` already returns `[]` when there's no attr index, so no element needs the array until an attr is touched. Constructor now leaves `__attrs = undefined`; `__nodeAt` drops its now-redundant `node.__attrs = undefined` (constructor already did it). Strictly removes one array allocation per inflated element.
**Rust/WASM port note:** PORTS. Trivial — the attr store is `Option<Vec<Attr>>` defaulting `None`; no empty-vec allocation at construction. Same idea as the lazy-listeners cell.

### b85abd9 — v0.1.25 — Release (package.json version bump). Skipped (no code).

---

### e1c9170 — v0.1.26 — Allocation-free `.class` matcher + memoized HTMLCollection
**Files:** `src/runtime/selectors.mjs` (`simpleMatcher`), `src/runtime/dom.mjs` (`cachedQS`/`cachedQSA` cache split, `Document.getElementsByTagName`/`getElementsByClassName`).
**Optimization (from the diff):**
1. **Allocation-free `.class` matcher.** `simpleMatcher('.cls')` returned `(el) => el.classList.contains(cls)`, which allocates a ClassList + regex-splits per element on every cache-miss query. Now `(el) => { const cn = el.getAttribute('class'); return cn ? hasClass(cn, cls) : false; }` — a whole-word string scan over the raw class attribute, zero allocation. Cold `.class` querySelectorAll 2.06×.
2. **Memoized live HTMLCollection per key.** `getElementsByTagName`/`getElementsByClassName` allocated a new Proxy per call though the backing array is already version-cached (`__byTag`/`__byClass`). Now the Proxy is memoized in a per-Document `__tagColl`/`__classColl` Map keyed by tag/class; the `getArray` closure still re-reads the version-cached array on each access, so liveness is preserved — only the Proxy allocation is saved. Hot loop 1.26×.
3. **Cache split.** `__qCache` (keyed `'s:'+sel`/`'a:'+sel`) split into separate `__qsCache`/`__qaCache` maps keyed by bare `sel`, dropping the per-query string concat.
**Rust/WASM port note:** PORTS. (1) The `.class` matcher maps to the existing `hasClass`/whole-word scan invariant — in Rust, scan the class attribute string for the token (split on ASCII whitespace, compare slices); never build a ClassList per match. (2) Memoized collections → cache the collection handle per (node, key) in a map; the handle re-derives from the version-cached result vec (same live-view-cell pattern as childNodes). (3) Separate caches keyed by the bare selector avoid string concatenation — in Rust just two maps keyed by `&str`.

---

### 354b966 — v0.1.27 — Packed SoA blob, dict-encoded attr values, lazy attr reads
**Files:** `src/core.rs` (`Soa` fields, `SoaBuilder.intern_attr_value`/`attr_value_map`, `alloc`), `src/lib.rs` (`JsSoa` → single `packed: Uint8Array` + `n`/`m` + string dicts; `From<core::Soa>` packing), `src/runtime/buffer.mjs` (`unpack`, `Buffer` ctor, new `attrGet`/`attrHas`, `attrs`), `src/runtime/dom.mjs` (`Element.getAttribute`/`hasAttribute` direct-column reads).
**Optimization (from the diff):** Three kept wins (A, C, F) of six A/B-tested candidates.
1. **A — packed blob.** Instead of ~13 separate napi typed-array buffers (each its own ArrayBuffer + finalizer per parse), ALL numeric SoA columns are concatenated into ONE little-endian `Vec<u8>` (`packed: Uint8Array`) plus `n` (node count) and `m` (attr count). Layout is order-sensitive: 4-byte block FIRST (keeps Int32/Uint32 views 4-aligned) — `tag_id` then `parent,first_child,next_sib,text_id,pub_id,sys_id,attr_start` then `attr_name_id,attr_value_id,attr_prefix_id`; then u16 `attr_count`; then u8 `node_type`,`ns`. JS `unpack()` (buffer.mjs) walks an offset cursor creating zero-copy `Int32Array`/`Uint32Array`/`Uint16Array`/`Uint8Array` views over the one ArrayBuffer in the EXACT same order. parseBuffer small +126%, attr-heavy +8%.
2. **C — dictionary-encoded attr values.** `attr_value: Vec<String>` (one string per attr occurrence) became `attr_value_id: Vec<u32>` indexing a deduped `attr_values: Vec<String>` dictionary, interned in the builder via `intern_attr_value`/`attr_value_map`. Repeated values (`class`/`role`/`type`) cross the boundary once. attr-heavy +20%.
3. **F — lazy direct-column attr reads.** New `Buffer.attrGet(i,name)`/`attrHas(i,name)` scan the `attrNameId`/`attrValueId` columns for a node directly, returning the value/bool WITHOUT materializing the `{name,value,prefix}` array. `Element.getAttribute`/`hasAttribute` now: if `__attrs` already built, scan it; else read the column via `buf.attrGet/attrHas(__attrIdx, name)`. Selectors hammer `getAttribute('class')`/`('id')`, so this avoids building the attr array on the query hot path entirely. Cold `.class` querySelectorAll 1.86×.
Rejected (measured, reverted): B lazy text decode (regressed the small/attr-heavy case that dominates test runners), D Buffer-instead-of-String input (transcode unavoidable), E childNodes memo (already shipped).
**Rust/WASM port note:** BOUNDARY (critical) for a Rust→WASM rewrite. (A) In WASM the boundary is `memory` + offsets, not napi typed arrays — the SoA can stay as native Rust `Vec`s and JS reads via views into linear memory; the single-blob lesson (one allocation, ordered/aligned columns, zero-copy views) is exactly the right shape — keep the 4-byte-first alignment rule. If the runtime itself becomes Rust, the columns are just struct fields, no marshaling at all. (C) Dictionary interning of attr values stays a pure-Rust win regardless of front-end — keep `attr_value_id` + `attr_values`, and the `attr_value_map` HashMap during build. (F) Direct-column attr read → in a Rust DOM, `get_attribute` indexes `attr_start[i]`/`attr_count[i]` and scans `attr_name_id`/`attr_value_id` against the interned dictionaries; never build a `Vec<Attr>` for a read. This is the canonical hot path.

---

### 23ab9ea — v0.1.28 — Fix: serializer crash on lazy `__attrs` (buffer-backed elements)
**Files:** `src/runtime/html-serialize.mjs` — `serializeNode`; test in `test/runtime.test.mjs`.
**Optimization (from the diff):** Correctness fix for the lazy-attr regime. After v0.1.27, all buffer-backed elements leave `__attrs` undefined (real attrs in the SoA behind `__attrIdx`). `serializeNode` was the ONE `__attrs` read site that iterated `node.__attrs` directly without the `?? (node.__attrs = node.__buildAttrs())` guard that every other site has, so reading `innerHTML`/`outerHTML` of any unmutated buffer-backed subtree threw `TypeError: node.__attrs is not iterable`. Fixed by building from the buffer: `const attrs = node.__attrs ?? (node.__attrs = node.__buildAttrs())`. A `?? []` would have silenced the crash but DROPPED all attributes (`<li class="sel">` → `<li>`); building from the buffer preserves them. TDD test reads innerHTML of an unmutated subtree and asserts class/value attrs survive.
**Rust/WASM port note:** BOUNDARY/INVARIANT. The portable lesson: when a field is lazily materialized (`Option<Vec<Attr>>`), EVERY read site must funnel through the same "build-if-None" accessor — in Rust enforce this by making the only public reader a method (`fn attrs(&self) -> &[Attr]` that fills the `OnceCell`/`RefCell` from columns), so no call site can bypass it and read a `None`/empty. The serializer must read attributes through that accessor, not a raw field, or buffer-backed (unmutated) elements serialize without attributes.
## Batch 5 — Cascade, Shadow DOM, monomorphism, lazy globals (v0.1.29–v0.1.47)

Range `23ab9ea..bb45ea9`. The throughline of this batch: V8-microarchitecture wins
(monomorphic hidden classes, read-field-once locals, lazy-global hoisting, escape-analysis
allocation elision) that are **N/A or trivial in a Rust→WASM port** (structs are already
monomorphic, field reads are free, no GC to placate), interleaved with a handful of
genuinely **algorithmic/structural** wins (partial getComputedStyle cascade, Shadow-DOM
gating, primitive-arg mutation notification, lazy `_path`, single-text-child fast path,
unpack-SoA-once, version-cached child filter) that **port and matter**.

Classification key for the port: monomorphism / read-once / lazy-global-hoist = V8-SPECIFIC.
Skipping wasted work that is also wasted in Rust (no observer → no record, no slice, no
re-unpack, no re-filter) = PORTS.

---

### e20c892 — v0.1.29 — DOM-correctness batch + partial getComputedStyle cascade
**Files:** new `src/runtime/cascade.mjs` (141 lines); `dom.mjs`, `events.mjs`, `index.mjs`, `stubs.mjs`, `window.mjs`
**Optimization (from the diff):** Not primarily a perf commit — 7 correctness fixes (normalize() now routes through `notifyMutation` so it bumps `__version`/feeds observers; checkbox/radio `.click()` fires input/change; `form.reset()` restores defaults; ~45 missing `HTML*Element` globals; `adoptNode` materializes attrs+children off the old SoA buffer before re-homing so reads don't go through the new doc's buffer; single-oldest LRU eviction replaces wholesale cache clear; longhand reads fall back to a single-token shorthand). The structural addition is `cascade.mjs`: getComputedStyle becomes a **partial cascade** — resolves injected `<style>` rules + inline + specificity/order + inheritance of a curated `INHERITED` set down the flattened tree, memoized as `el.__computedStyle` keyed on `Document.__version`. Test-time only; zero hot-path cost (only a getComputedStyle/`el.style` call builds the index).
**Rust/WASM port note:** **PORTS (algorithmic/structural).** The cascade is a real selector-matching + specificity + inheritance engine — language-independent and a direct port target (a `ComputedStyle` resolver keyed on a document-version counter; the `el.__computedStyle.__v` memo becomes a struct field + version check). The correctness fixes (`adoptInto`, normalize→notifyMutation, click activation default actions, shorthand→longhand expansion) are all behavior the Rust DOM must replicate verbatim. None of this is V8-specific.

### fb3e644 — v0.1.30 — WHATWG number sanitize + computed-style px-normalize & shorthand expand
**Files:** `cascade.mjs`, input value setter (`dom.mjs`)
**Optimization (from the diff):** Correctness, not perf. Invalid typed `<input>` value sanitizes to `''` (WHATWG) instead of retaining the prior value (so React's value tracker sees a change and onChange fires). getComputedStyle px-normalizes bare `0` for length props (`0`→`0px`) but leaves non-lengths (opacity/z-index) bare; expands `border`/`margin`/`padding`/`background` shorthands into longhands preserving cascade order.
**Rust/WASM port note:** **PORTS (algorithmic).** Pure value-normalization + shorthand-expansion logic, identical in Rust. Part of the cascade/style subsystem the port must reproduce. Not V8-related.

### 6934ca2 — v0.1.31 — normalize font-family comma spacing in computed style
**Files:** `cascade.mjs` (4 lines)
**Optimization (from the diff):** Correctness. getComputedStyle re-serializes `font-family` with `\s*,\s* → ", "` (browsers always space commas; emotion minifies them out) — scoped to font-family only so it doesn't rewrite commas inside `rgb()`/`cubic-bezier()`.
**Rust/WASM port note:** **PORTS (algorithmic, trivial).** A scoped string normalization in the style serializer; same in Rust.

### b5bd896 — v0.1.32 — README cascade docs
Skipped (docs only).

### e0573b9 — release-flow docs in CLAUDE.md
Skipped (docs only).

### 7bdd3a5 — v0.1.33 — full Shadow DOM (slots, retargeting, :host/::slotted, declarative) + coverage gate
**Files:** `events.mjs`, `dom.mjs`, `cascade.mjs`, `index.mjs`
**Optimization (from the diff):** Adds full Shadow DOM but makes it **pay-for-what-you-use, gated on `Document.__hasShadow`** (set on first `attachShadow`; declarative `<template shadowrootmode>` promotion is gated by a cheap `'shadowroot'` substring check on the HTML). Until armed, every hot path (dispatch flat-walk, cascade, querySelector, getElementsBy*) runs byte-for-byte as before — encapsulation is free because a host's `__children()` never includes its shadow subtree. Capture/target/bubble cross the boundary with composed crossing + target/relatedTarget retargeting; scoped per-shadow-root cascade with `:host`/`::slotted` and inheritance into shadow content only. (Also fixed: textarea.value defaults to child text, collection proxy target `function(){}`→`{}`, Range/Selection methods.)
**Rust/WASM port note:** **PORTS (structural — the gating is the key design).** The `__hasShadow` flag that keeps all hot paths shadow-free until a shadow root exists is an algorithmic boundary, not a V8 trick — replicate it as a `bool` on the Document and branch on it the same way. The retargeting/scoped-cascade/slot-assignment logic ports directly. CRITICAL for the port: do NOT hoist any shadow work above the `__hasShadow` branch (CLAUDE.md reinforces this) — in Rust the cost is a predicted-false branch, even cheaper than in V8.

### 87278bb — v0.1.34 — monomorphic Element shape (~7–8% faster real-world suites)
**Files:** `dom.mjs` Element constructor (+10 lines)
**Optimization (from the diff):** Predeclares the six hot lazy fields (`__childNodesList`, `__childrenList`, `__qaCache`, `__qsCache`, `__computedStyle`, `__shadow`) at `undefined` in a fixed order in the constructor, so every Element shares ONE V8 hidden class. Without it, fields added on demand in varying order make the shared query/match/style/event code megamorphic on property loads.
**Rust/WASM port note:** **V8-SPECIFIC → N/A in Rust.** Hidden-class monomorphism is purely a V8 JIT inline-cache concern. A Rust struct has exactly one layout by definition; all six fields are already declared (`Option<…>`) in the struct. This optimization simply disappears — the port is monomorphic for free, with zero in-object-slot cost (the JS version even paid a few wasted slots/construct overhead to buy it).

### f26d5c6 — v0.1.35 — hoist env-independent lazy globals to module scope (~29% faster window construct)
**Files:** `window.mjs` (`SHARED_LAZY` module constant; per-env `lazy` shrunk to location/history/origin)
**Optimization (from the diff):** `createWindow` rebuilt a ~30-entry `lazy` object literal (~28 closures) per test file. The ~28 factories that capture nothing env-specific (localStorage, matchMedia, getComputedStyle, navigator, performance, screen, geometry constants, observers) moved to a module-level `SHARED_LAZY` built once; per-env `lazy` keeps only those capturing `url`/`windowProxy`. The Proxy checks `lazy` then `SHARED_LAZY`; materialization still self-replaces onto the per-env base (each env gets its own instance, only the factory closures are shared). Saves ~28 allocations per file.
**Rust/WASM port note:** **V8-SPECIFIC / BOUNDARY → largely N/A.** This is closure-allocation avoidance specific to the JS Proxy-based window. A Rust window won't allocate per-field closures at all — methods are static fns or a `match` on the accessed key; constants (`innerWidth: 1024`, navigator strings) are `const`/`static`. The lazy-materialization *concept* (don't build a subsystem until touched) can port as `Option`-on-first-access, but the specific "hoist closures out of the per-env literal" mechanism evaporates because there are no per-env closures to hoist.

### 9136d60 — test: cover window honest-stub surface
Skipped (test only).

### e4d407e — v0.1.36 — lazy Document.__mo (~6% faster createEnvironment)
**Files:** `dom.mjs` Document ctor + `__moRegister`/`__moUnregister`
**Optimization (from the diff):** `__mo` (MutationObserver registry array) was allocated eagerly in every Document ctor; most files never `observe()`. Starts `null`, initialized on first `__moRegister`; `__moUnregister` null-guards; `notifyMutation` already short-circuits on null/empty (identical hot-path cost). One fewer allocation per createEnvironment.
**Rust/WASM port note:** **PORTS (trivial — and nearly free in Rust).** Maps directly to `Option<Vec<Registration>>` initialized `None`, allocated on first register. The win is smaller in Rust (a `Vec` is one heap alloc vs V8 object header + array), but the lazy pattern is correct and worth keeping. Algorithmic, not V8-specific.

### b9b23f6 — v0.1.37 — zero-alloc mutations when no MutationObserver (~17% faster)
**Files:** `dom.mjs` `notifyMutation` + all call sites (insertBefore/removeChild/normalize/setAttribute/removeAttribute/characterData)
**Optimization (from the diff):** Call sites built a `MutationRecord` object literal + `addedNodes`/`removedNodes` arrays unconditionally, only for `notifyMutation` to discard them when no observer is registered (the common case). `notifyMutation` now takes **primitives** (`type, added, removed, nextSibling, attributeName, oldValue`); it bumps `__version` unconditionally and builds the record + node arrays ONLY inside the `if (observer)` branch. Shared `EMPTY_NODES` const for empty arrays. Behavior with an observer is byte-identical.
**Rust/WASM port note:** **PORTS (algorithmic — the whole point).** Allocating a record only when an observer exists is real work-skipping, not GC appeasement: in Rust the eager version would `Box`/`Vec`-allocate a `MutationRecord` per mutation for nothing. Port the primitive-argument signature and the observer-gated record construction directly — it's arguably more valuable in Rust where every allocation is explicit. (Escape analysis would NOT have saved the JS here because the record escapes into the discard path; the structural fix is what wins, and it ports.)

### 61c1b8b — v0.1.38 — lazy Event._path (~2× faster Event construction)
**Files:** `events.mjs` Event ctor + `composedPath()`
**Optimization (from the diff):** Event ctor allocated `this._path = []` eagerly, immediately overwritten by dispatchEvent and only read by `composedPath()`. Now `null`; `composedPath()` returns `[]` when null (spec-correct pre-dispatch), dispatch assigns the real path. Removing the per-Event array alloc also lets V8 escape-analysis scalar-replace short-lived events.
**Rust/WASM port note:** **PORTS (algorithmic) + partly V8-SPECIFIC tail.** The structural part — don't allocate the path vector at construction, only at dispatch — ports cleanly (`path: Option<Vec<…>>`, `None` until dispatch). The "lets V8 scalar-replace the event" tail is V8-specific and N/A. In Rust a never-dispatched `Event` simply holds `None` (no heap alloc); the port keeps the win without the JIT dependency.

### cddde8d — v0.1.39 — textContent fast-path for single-text-child elements (~28% faster reads)
**Files:** `dom.mjs` `Node.textContent` getter
**Optimization (from the diff):** Hot leaf case (RTL `getByText` reads textContent on every element): if the node has exactly one child and it's a text node, return its `.data` directly — skip the iterator + string accumulator. General path also switched from `for-of` (iterator alloc) to an index loop.
**Rust/WASM port note:** **PORTS (algorithmic) — but the iterator-alloc motivation is V8-specific.** The single-text-child short-circuit (return the child's data without building a new `String`) is a real win in any language and ports as a `match`/length check. The `for-of`→index-loop part is a V8 iterator-allocation fix that's N/A in Rust (slice iteration is zero-cost). Net: keep the fast-path branch; the loop form is irrelevant.

### 926b225 — v0.1.40 — skip parse-cache LRU re-insert when key is already MRU
**Files:** `index.mjs` `parseBufferCached` (+ `__parseCacheMRU`)
**Optimization (from the diff):** On a cache hit, the LRU bump did `Map.delete` + `Map.set` every time. A suite reusing one shell HTML hits the same key every file — already MRU — so the delete+set is pure waste. Tracks `__parseCacheMRU`; skips the re-insert when the hit key equals it. Eviction semantics unchanged.
**Rust/WASM port note:** **PORTS (algorithmic, trivial).** Pure LRU-bookkeeping skip — language-independent. In a Rust LRU (e.g. an index-map or `lru` crate) the same "if already at front, do nothing" guard applies. Not V8-specific.

### fffa3f7 / 9bbe170 — EXPERIMENTS.md docs (perf loop, ditched simpleMatcher attr fast-path)
Skipped (docs only). Note: 9bbe170 records that a `simpleMatcher` attr fast-path was ditched because the result-cache already gates matcher cost — a lesson, not a code change.

### 88f5924 — v0.1.41 — inline addEventListener option parsing (~33% faster listener attach)
**Files:** `events.mjs` `addEventListener`/`removeEventListener` (removed `normalizeOptions`)
**Optimization (from the diff):** `addEventListener` allocated a throwaway `normalizeOptions` object AND a `.some()` dedup closure per attach (hot during React mount). Inlined boolean/object option parsing into locals (`capture`/`once`/`passive`); replaced the `.some()` dedup and `removeEventListener`'s `findIndex` closure with plain index loops.
**Rust/WASM port note:** **V8-SPECIFIC → mostly N/A.** Closure/object allocation avoidance and `.some()`/`.findIndex()` closure elision are JS-engine concerns. Rust parses options into stack locals and iterates a `Vec` with a `for` loop natively — there is no closure or temp object to eliminate. The dedup-on-`(callback, capture)` *semantics* port, but the optimization itself doesn't exist as a separate step in Rust.

### c46372e / af83a30 — EXPERIMENTS.md ledger (incl. ditched dispatch invoke-closure move — no win, escape analysis)
Skipped (docs only). Note: af83a30 records that moving the dispatch invoke to a closure showed no win because V8 escape-analysis already handled it — pure V8 lore, irrelevant to the port.

### 6f6c2f5 — v0.1.42 — skip listener-snapshot slice for single-listener dispatch (~13% faster)
**Files:** `events.mjs` `dispatchEvent` invoke loop
**Optimization (from the diff):** The invoke loop did `list.slice()` per (node, phase) to snapshot listeners (so mid-dispatch additions don't fire this round). For the common React-delegated case — exactly ONE listener for the type — the slice is wasted: a single, length-captured iteration can't be disturbed. `const snap = list.length === 1 ? list : list.slice();` then an index loop. Multi-listener keeps the slice (concurrent-mutation guard).
**Rust/WASM port note:** **PORTS (algorithmic).** The "don't copy a 1-element list to snapshot it" skip is a real allocation avoidance that ports — in Rust the snapshot is a `Vec` clone; eliding it for `len == 1` (iterate by captured index instead) saves a heap alloc just as it does in JS. The mid-dispatch-mutation snapshot semantics must be preserved identically. Not V8-specific.

### 2753bf3 — EXPERIMENTS.md ledger v0.1.42
Skipped (docs only).

### 3137d91 — v0.1.43 — read tagName once in __nodeAt inflation (~5.5% faster inflation)
**Files:** `dom.mjs` `Document.__nodeAt`
**Optimization (from the diff):** `__nodeAt` read `buf.tagName(idx)` twice per element (Element ctor + the `=== 'template'` check). Read into a local `tag` once.
**Rust/WASM port note:** **V8-SPECIFIC → N/A in Rust.** `buf.tagName(idx)` is a function-call SoA lookup that V8 won't reliably CSE across a constructor call. In Rust the compiler does common-subexpression-elimination on a pure indexed read for free, and the idiomatic port reads it into a `let tag` anyway. The optimization is invisible / automatic in the port.

### f8c76a2 / 1c5c333 / f0921dd / 65cf2a9 — EXPERIMENTS.md ledger + bench/scorecard.mjs + ditched experiments
Skipped (docs/bench-tooling only). Note: f0921dd ditched a setAttribute index-loop (V8's `.find` beat a manual loop+splice — V8 lore, N/A); 65cf2a9 ditched classList-memoize (overlap, ClassList cheap).

### 3c6629f — v0.1.44 — read nodeType once during child inflation (~5% faster inflation)
**Files:** `dom.mjs` `Node.__children()` + `Document.__nodeAt(idx, nt)`
**Optimization (from the diff):** `__children()` read `buf.nodeType(c)` for the template-content skip, then `__nodeAt(c)` read it AGAIN in its type switch. `__children` now reads it once and passes `nt` to `__nodeAt(idx, nt)`; other callers leave `nt` undefined and `__nodeAt` reads it as before.
**Rust/WASM port note:** **V8-SPECIFIC → N/A in Rust.** Same class as v0.1.43 — redundant pure-read elimination across a call boundary. Rust's optimizer eliminates this automatically (or the port threads the value as a fn parameter idiomatically with no perf thought required). The optional-`nt`-parameter plumbing is a V8 workaround that the port doesn't need.

### f376c1a / 4ae3071 / cfd6c01 / d699b39 — EXPERIMENTS.md ledger + KPI + ditched experiments
Skipped (docs only). Notes: 4ae3071 ditched a textContent nodeType-cache (getter inlined anyway); cfd6c01 ditched eager installGlobals value-descriptors (eager resolution slower than lazy getters — reinforces the lazy-global theme, V8-specific).

### 3b076ad — v0.1.45 — lazy customElements registry (~5% faster createEnvironment)
**Files:** `window.mjs` (moved `customElements` factory into `SHARED_LAZY`)
**Optimization (from the diff):** `window.customElements` (`makeCustomElements` → two Maps + an object) was built eagerly per `createWindow`; most files never touch custom elements. Moved to `SHARED_LAZY`, materialized (fresh registry per env) on first access.
**Rust/WASM port note:** **PORTS (algorithmic, trivial) — same lazy concept as v0.1.36.** The "don't build the custom-element registry until used" is a real lazy-init that ports as `Option<CustomElementRegistry>`. The `SHARED_LAZY` *mechanism* is V8-closure-specific (see v0.1.35) and N/A, but the deferral intent ports.

### 06ccdb5 — EXPERIMENTS.md ledger v0.1.45
Skipped (docs only).

### 186e976 — v0.1.46 — lazy window.origin (~18% faster createEnvironment)
**Files:** `window.mjs` (`origin` moved from eager field to per-env `lazy`)
**Optimization (from the diff):** `origin: new URL(url).origin` was computed eagerly in every `createWindow`, but `window.origin` is rarely read and URL parsing is heavy in V8. Moved into per-env `lazy` (captures `url`), materialized on first access. The win was the **deferred URL parse**, not the deferral overhead per se (3ecdcab confirms: deferring Image/Audio/getSelection showed no win because those closures are cheap — only `origin` had an expensive body).
**Rust/WASM port note:** **PORTS (algorithmic) — defer the expensive parse, not the field.** The real lesson (per 3ecdcab) is that deferral only pays when the deferred work is expensive (URL parsing). That lesson is language-independent: in the Rust port, defer the `url::Url` parse for `origin` until read (store the raw `url` string, parse on access). Cheap fields should stay eager. The `lazy`-closure mechanism is V8-specific, but "lazily parse the URL" is the portable, correct takeaway.

### c9a473e / 3ecdcab — EXPERIMENTS.md ledger v0.1.46 + ditched Image/Audio/getSelection lazy
Skipped (docs only). Key lesson captured above: deferral wins came from the URL-parse cost, not the deferral.

### 9ec9010 — v0.1.47 — unpack the SoA blob once per cached HTML (~27% faster createEnvironment)
**Files:** `buffer.mjs` (`unpack` exported), `index.mjs` `parseBufferCached`
**Optimization (from the diff):** The native parser returns a PACKED SoA blob; `Buffer`'s ctor unpacked it (~14 typed-array views over the ArrayBuffer) on **every** `new Buffer` — i.e. every createEnvironment. The parse cache memoized the packed blob but re-unpacked per Document (×982 same-shell files for payroll). Now `parseBufferCached` unpacks ONCE and caches the unpacked soa; the views are read-only over the shared immutable buffer, so every Document backed by that cache entry reuses them. (Biggest createEnvironment win in the loop; cumulative ~768k→1.22M ops/s, +60%, across v0.1.43–47.)
**Rust/WASM port note:** **PORTS (structural — and is the key shared-immutable-buffer insight).** Building the column views once and sharing them across all read-only consumers of the same parsed buffer is a real architectural win that ports directly: in the Rust/WASM core, parse once → hold the SoA columns as slices over one shared immutable buffer → every Document is a cheap overlay referencing it (matches the existing "buffer is read-only, mutations go to per-Document overlay" model in CLAUDE.md). The only caveat — already noted in CLAUDE.md — is that nothing may write THROUGH to the buffer; that invariant is even more naturally enforced in Rust via `&` shared borrows / `Arc<[T]>`. This is the single most port-relevant commit in the batch.

### 469feaf / 63e2c5b / 3a5bed3 — EXPERIMENTS.md ledger + ditched __load trim + env-path audit
Skipped (docs only).

### bb45ea9 — v0.1.48 — version-cache the children element filter (~58% faster children access)
**Files:** `dom.mjs` `Element.children` getter
**Optimization (from the diff):** `el.children` re-ran `__children().filter(nodeType===1)` on EVERY access (`children[i]`, `.length`, iteration) — an O(n) scan + array alloc each time (childNodes returns the live array directly; only `children`, being element-filtered, rebuilt). Now the filtered array is cached on the element (`__childrenArr`) keyed on `Document.__version` (`__childrenArrV`), re-filtered only when a mutation bumps the version. Stays live because every mutation bumps the version.
**Rust/WASM port note:** **PORTS (algorithmic — same version-keyed-memo pattern as the cascade/qsa caches).** Caching a derived array keyed on a document-version counter, invalidated by the version bump every mutation already performs, is a structural pattern that ports directly (struct fields `children_arr: Option<Vec<…>>` + `children_arr_v: u64`). It's a genuine O(n)-per-access → O(1)-amortized win in any language. The `.filter` closure is the only V8-flavored bit and is irrelevant; the memo-on-version is the portable substance.

---

## Port-relevance summary for this batch

**PORT (do these in Rust — algorithmic/structural):**
- Partial getComputedStyle cascade + px-normalize + shorthand-expand + font-family serialization (e20c892, fb3e644, 6934ca2) — a real style resolver keyed on version.
- Shadow DOM **gated on `__hasShadow`** (7bdd3a5) — keep the gate; all retargeting/scoped-cascade/slot logic ports.
- Observer-gated mutation notification — build the record only when an observer exists (b9b23f6).
- Lazy `Event` path vector, `None` until dispatch (61c1b8b).
- single-text-child textContent short-circuit (cddde8d), single-listener snapshot skip (6f6c2f5).
- Lazy registries: `__mo`, customElements (e4d407e, 3b076ad) as `Option`.
- **Unpack SoA once + share read-only views across all Documents** (9ec9010) — the central shared-immutable-buffer architecture.
- Version-keyed memo for derived collections: children filter, qsa, computed style (bb45ea9 + the cascade) — one pattern, reused everywhere.
- Lazily PARSE the origin URL (defer expensive work, not the field) (186e976); LRU "already-MRU skip" (926b225).

**V8-SPECIFIC → N/A or automatic in Rust:**
- Monomorphic Element hidden class (87278bb) — Rust structs are monomorphic by definition.
- `SHARED_LAZY` per-env closure hoisting (f26d5c6) — no per-env closures exist in the Rust window.
- Inlined addEventListener option parsing / closure elision (88f5924) — stack locals + native loops, nothing to elide.
- read-tagName-once / read-nodeType-once (3137d91, 3c6629f) — pure-read CSE the Rust compiler does for free.
- The escape-analysis tails of cddde8d/61c1b8b and the ditched-experiment lore (`.find` vs manual loop, eager descriptors) — engine-specific, no port action.
## Batch 6 — Version-cached collections, clone, Rust parser wins, compat (v0.1.48–v0.2.5)

Range `bb45ea9..3b4107d` (oldest-first). This batch mixes three distinct categories:
1. **Algorithmic DOM wins** — version-cached element-child arrays, scoped getElementsBy*, sibling O(n²)→O(n), direct clone builds. These PORT directly to Rust as a `version: u64` counter on the document + a cached `Vec<NodeId>` per node.
2. **Rust-parser-side wins** — FxHashMap interning, reserve, byte-blob string tables. These ALREADY live in `src/core.rs`/`src/lib.rs` → preserve in core; the byte-blob is a napi-boundary trick that dissolves in a pure-WASM design.
3. **Correctness/compat machinery** — lazy parser registry, SVG wrappers, CSSOM fidelity, bare-isolate load, attr-node API, synthetic geometry, injectable clock, live NamedNodeMap. Reimplement as behavior; note the perf-sensitivity (all memoized per `Document.__version`, all gated test-time-only).

---

### bb45ea9 — v0.1.48 — version-cache the children element filter
**Files:** `src/runtime/dom.mjs` — `Element.get children`
**Optimization (from the diff):** `el.children` previously re-ran `__children().filter(nodeType===1)` on EVERY access (`children[i]`, `.length`, iteration) — O(n) scan + array alloc each time (unlike `childNodes`, which returns the live array directly). Now the filtered array is cached on the element (`__childrenArr`) keyed on `Document.__version` (`__childrenArrV`): re-filtered only when a mutation bumps the version, so it stays live. ~4.5M→7.1M ops/s (+58%).
**Rust/WASM port note:** PORTS. Cache a `Vec<NodeId>` of element children on the node struct alongside a stored `version: u64`; recompute only when `doc.version != cached_version`. This is the canonical "version counter + cached Vec" pattern that recurs through this whole batch — the Rust port should have ONE shared helper for it.

### 5335164 — v0.1.49 — share the version-cached element-child array across child*-getters
**Files:** `src/runtime/dom.mjs` — new `Element.__elementChildren()`; rerouted `children`/`childElementCount`/`firstElementChild`/`lastElementChild`
**Optimization (from the diff):** `childElementCount`/`lastElementChild` still re-ran `.filter(nodeType===1)` and `firstElementChild` re-ran `.find` on every access. Extracted the v0.1.48 version-cached filter into `__elementChildren()` and routed all four getters through it — one shared cached array per element. `childElementCount`→`.length`, `first`→`[0]`, `last`→`[len-1]`, all O(1) after the first filter. ~18.3M→336M ops/s for the count/first/last microbench.
**Rust/WASM port note:** PORTS. Same cached `Vec<NodeId>` as v0.1.48 — just expose `len()`/`first()`/`last()` over the one cache instead of recomputing. Consolidate: all element-child accessors must read one memoized vector, never re-walk children.

### 0e246b6 — v0.1.50 — version-cache Element/ShadowRoot getElementsBy* subtree walks
**Files:** `src/runtime/dom.mjs` — `Element.getElementsByTagName`/`getElementsByClassName`, `ShadowRoot.getElementsByTagName`/`getElementsByClassName`
**Optimization (from the diff):** Document-scoped getElementsBy* were already cached (`__byTag`/`__byClass`); the Element/ShadowRoot-scoped variants re-ran the full subtree walk (`collectByTag`/`collectByClass`) on every `.length`/`[i]`/iterate. Now each returned collection version-caches its walk in closure-local state (`cv`/`ca`): a reused collection walks once per `Document.__version`, re-walks on mutation; a fresh per-call collection is neutral (one walk either way). ~2130ms→795ms (~2.7×).
**Rust/WASM port note:** PORTS. The "cache lives in the collection object, keyed by version" works in Rust too, but the cleaner port is to make the scoped collection hold `(scope_node, query, cached_version, cached_vec)` and recompute lazily on access. Note: this is per-collection-instance memoization, not per-node — distinct from v0.1.48.

### 09439a9 — v0.1.51 — nextElementSibling/previousElementSibling O(n²)→O(n)
**Files:** `src/runtime/dom.mjs` — `Element.get nextElementSibling`/`previousElementSibling`
**Optimization (from the diff):** Both getters walked via `this.nextSibling`/`previousSibling` in a loop, and EACH sibling step re-ran `parent.__children().indexOf(this)` — so skipping past text nodes between elements (whitespace-indented DOM) cost an indexOf per step → O(n²). Now: one `indexOf` to locate self, then a forward/backward scan over `__children()` for the next element node. Reads live, no cache, identical result. ~51ms→26ms (~2×).
**Rust/WASM port note:** PORTS, and the Rust port avoids the problem structurally. If children are stored as a `Vec` (or nodes carry sibling links/indices), sibling lookup is already O(1)/O(scan); never reimplement sibling traversal as repeated `indexOf`/position-search. A node should know its own index in its parent (or have prev/next links).

### 6cd36c2 — v0.1.52 — deep cloneNode builds child array directly
**Files:** `src/runtime/dom.mjs` — `Element.cloneNode(deep)`
**Optimization (from the diff):** `cloneNode(true)` appended each cloned child via `el.appendChild`, which runs `notifyMutation` (a `Document.__version` bump) + a reparent check per node — pure waste, N times, on a DETACHED clone nothing observes. Now it builds `el.__kids = new Array(src.length)` directly, setting `parentNode`/`ownerDocument` per cloned child, skipping `appendChild`. Tree is identical; the version bump happens once later when the caller appends the clone. ~179k→370k ops/s (~2×).
**Rust/WASM port note:** PORTS as a general principle: **bulk-build detached subtrees without per-node mutation bookkeeping.** A clone has no observers and no cached queries, so skip version bumps / parent-reparent checks during construction; assign parent/owner fields directly into the children Vec. Defer the single version bump to the eventual insertion.

### b02e662 — v0.1.53 — DocumentFragment.cloneNode builds child array directly
**Files:** `src/runtime/dom.mjs` — `DocumentFragment.cloneNode(deep)`
**Optimization (from the diff):** Same detached-clone optimization as v0.1.52, applied to `DocumentFragment` (the `template.content.cloneNode(true)` path used by web components / lit): build `f.__kids` directly instead of per-child `appendChild`. +8%.
**Rust/WASM port note:** PORTS. Same bulk-detached-build helper as v0.1.52 — share it between Element and DocumentFragment clone paths. One direct-build routine for any detached subtree clone.

### 496e13d — v0.1.54 — FxHashMap for SoA string interning
**Files:** `src/core.rs` — `SoaBuilder` intern maps (`tag_map`/`attr_name_map`/`attr_prefix_map`/`attr_value_map`), `parse_html_soa`
**Optimization (from the diff):** Swapped the four `std::collections::HashMap` intern tables (SipHash — crypto-strength, slow for short string keys) to `rustc_hash::FxHashMap` (non-crypto, fast for small keys). IDs are assigned from a length counter, not map iteration, so packed output is byte-identical regardless of hasher — pure speed. ~+7% parse.
**Rust/WASM port note:** ALREADY-RUST — **preserve in core.** This is core's own interning and stays exactly as is in a pure-Rust design. Keep `rustc-hash` as a dep; the runtime port has no equivalent (the JS side never interned).

### 3ed3512 — v0.1.55 — pre-reserve intern-map capacity
**Files:** `src/core.rs` — `parse_html_soa` SoaBuilder construction
**Optimization (from the diff):** The four FxHashMaps started empty and rehashed as they grew. Pre-reserve typical sizes via `with_capacity_and_hasher` (tag 32 / attr-name 64 / prefix 8 / attr-value 128) so the build loop doesn't rehash. Byte-identical output. ~+6% on a realistic doc.
**Rust/WASM port note:** ALREADY-RUST — **preserve in core.** Trivially carries over; keep the reserve hints. General lesson for any hot Rust map/Vec in the port: `with_capacity` the known-bounded collections.

### 9091fbc — v0.1.56 — SoA string tables as one byte blob
**Files:** `src/lib.rs` — `JsSoa` struct (`napi_front`), `From<core::Soa>` impl; (consumed by `buffer.mjs unpack()`)
**Optimization (from the diff):** The five string tables (tag/attr names, prefixes, attr values, text/comment data) crossed napi as `Vec<String>`, forcing a UTF-8→UTF-16 conversion of EVERY string at the boundary even for strings a parse never reads (~12% of REAL parse). Now they cross as ONE raw-byte `Uint8Array` (`str_blob`) + a `Uint32Array` (`str_meta` = 5 counts then per-string byte lengths). JS `unpack()` decodes once per cached parse; `parseBuffer` (no string read) skips decode entirely. ~+9% parse.
**Rust/WASM port note:** BOUNDARY — this win is specifically a napi marshaling cost (Rust String → JS string conversion). In a **pure-Rust runtime there is NO boundary**, so the byte-blob trick dissolves: the runtime would hold the string tables as native Rust `Vec<String>`/`&str` slices directly, zero conversion, zero decode. Do NOT port the blob+meta packing into the Rust runtime — it's an artifact of the JS/native split. Keep the SoA layout in core; drop the marshaling layer. (If a JS-callable WASM surface is still needed for embedders, the same lazy-decode-at-boundary trick reappears at the wasm-bindgen edge — but that's the embedder seam, not the internal DOM.)

### 0dd9c33 — v0.1.58 — build + ship the wasm fallback, wire native→wasm load
**Files:** `src/runtime/parser.mjs` (new), `src/runtime/dom.mjs`, `index.mjs`; `src/core.rs` serde `rename_all="camelCase"` under `wasm-bind` feature only
**Optimization (from the diff):** Not perf — packaging/correctness. Added `parser.mjs` (try native, fall back to wasm pkg). Gave `core::{Node,Attr,Soa}` `serde(rename_all="camelCase")` ONLY under `wasm-bind` so the wasm SoA/tree shapes match the unpacked native shapes (native marshals via `From` impls; wasm via serde). Makes the runtime front-end-agnostic.
**Rust/WASM port note:** BOUNDARY/ALREADY-RUST. The camelCase serde rename is purely to make two JS-facing front-ends agree; in a pure-Rust runtime the field names stay snake_case Rust and this concern vanishes. Note the field-naming gotcha (napi camelCases, serde renamed to match) is a JS-boundary artifact to drop.

### 3e6d6f7 — v0.1.59 — minimal CSSOM for CSS-in-JS, host-global load guards
**Files:** `src/runtime/cssom.mjs` (new — `CSSStyleSheet`/`CSSStyleRule`), `cascade.mjs`, `buffer.mjs`, `window.mjs`, `src/environment/install.mjs` exports
**Optimization (from the diff):** Correctness/compat. New `cssom.mjs`: lazy `<style>.sheet` (only emotion-touched styles allocate one), live `document.styleSheets`, `insertRule`/`deleteRule`/`replaceSync`/etc. `insertRule` bumps `Document.__version` via owner `__touch()`; `cascade.mjs` reads `style.__sheet.cssRules` so getComputedStyle resolves injected rules. Plus bare-V8 load guards (TextDecoder/URL/Blob/URLSearchParams fallbacks).
**Rust/WASM port note:** PORTS as behavior, perf-sensitive. The `.sheet`/`__sheet` laziness is load-bearing: plain documents must NEVER allocate a CSSOM sheet (gated on `__sheet` being undefined). In Rust: keep stylesheet state `Option<...>`, allocated only on first emotion-style touch; `insertRule` bumps the doc version so the cascade cache invalidates. Do not eagerly build sheets.

### e20db60 — v0.1.60 — lazy parser registry
**Files:** `src/runtime/parser.mjs` (rewritten), runtime entry re-exports `setParser`/`setParserMode`/`getParser`
**Optimization (from the diff):** Correctness/embedding. `getParser()` resolves once in order: injected binding (`setParser`/`globalThis.__TURBO_DOM_PARSER__`) → mode (`setParserMode`/`createEnvironment({parser})`/`TURBO_DOM_PARSER` env) → auto (native `.node`, then `pkg/` wasm). `node:module` acquired via GUARDED top-level await so the module loads in a bare V8; with an injected parser the Node loaders never run. Call sites use memoized `getParser().parseBuffer(…)`.
**Rust/WASM port note:** BOUNDARY/ALREADY-RUST. In a pure-Rust runtime the parser is a direct in-process function call — no registry, no native-vs-wasm selection, no node:module guard. This entire indirection dissolves. Keep only the embedder injection seam IF the WASM build must accept an externally-supplied parser; otherwise delete. The memoized single-field-read call pattern is irrelevant in-process.

### 49844a6 — v0.1.62 — SVG DOM-property wrappers (SVGElement)
**Files:** `src/runtime/svg.mjs` (new), `dom.mjs` `newElement()` ns dispatch
**Optimization (from the diff):** Correctness/compat. New `SVGElement extends Element` + wrappers: `className`→`SVGAnimatedString`, geometry attrs (`SVG_LENGTH_ATTRS`)→`SVGAnimatedLength` (`.baseVal.value` number, `valueOf` for numeric coercion), `viewBox`→`SVGAnimatedRect`, honest `getBBox`/`getCTM` stubs. Wrappers built LAZILY on access (live over the attribute, no snapshot). `newElement(doc,tag,ns)` picks `SVGElement` when `ns==='svg'` at every construction site (inflate/innerHTML/cloneNode/createElementNS); HTML elements stay plain `Element`.
**Rust/WASM port note:** PORTS as behavior, perf-conscious. Pick the SVG vs HTML element type by namespace at every node-construction site (cheap branch, no hot-path cost for HTML). The wrappers must stay lazy/live (computed on property access over the attribute, never materialized at construction). In Rust: an enum or trait-object element kind chosen at inflate; SVG IDL getters computed on demand.

### 3cfb602 — v0.2.0 — CSSOM fidelity (rgb canon, light-DOM inheritance, <style> textContent)
**Files:** `src/runtime/color.mjs` (new), `cascade.mjs`, `dom.mjs` `<style>.textContent` getter
**Optimization (from the diff):** Correctness/compat. (1) `color.mjs` canonicalizes every `<color>` to `rgb()`/`rgba()` for getComputedStyle (names/hex 3-4-6-8/rgb/hsl); inline `el.style` read-back canonicalizes hex/rgb/hsl but keeps named keywords (browser parity for `toHaveStyle`). (2) Curated `INHERITED` set cascades down the flattened tree (global `body{color}` reaches descendants), memoized per `Document.__version`, terminates at root, never invents initials. (3) `<style>.textContent` reflects `sheet.insertRule()`-injected rules (emotion speedy mode), gated on `this.__sheet` (one predicted-false read).
**Rust/WASM port note:** PORTS as behavior; perf-sensitive — the inheritance cascade is memoized per `Document.__version` (`__computedStyle.__v`) and the `<style>` textContent reflection is a single gated read on a hot path. In Rust: keep getComputedStyle a per-version snapshot map (invalidated by version bump), keep the `__sheet`-gated textContent path a cheap `Option` check, and color canonicalization a pure function. All test-time-only — parse/query/events never touch color or cascade.

### 7017e8f — v0.2.1 — bare-isolate runtime load (drop node:perf_hooks, Buffer-free base64)
**Files:** `src/runtime/window.mjs` — `performanceNow` host-capture, `turboBtoa`/`turboAtob`
**Optimization (from the diff):** Correctness (bare V8). Replaced static `import { performance } from 'node:perf_hooks'` (throws at load in a bare isolate) with a host `performance` reference CAPTURED BEFORE turbo-dom installs its own `performance` global (capturing pre-install avoids infinite recursion from the installed global shadowing the host clock), falling back to `Date.now()`. `btoa`/`atob` prefer platform → Buffer → pure-JS base64 fallback.
**Rust/WASM port note:** V8-SPECIFIC / mostly dissolves. In pure Rust/WASM there is no `node:perf_hooks` import to fail and no `Buffer` dependency — time comes from a host import/`instant`, base64 from a crate. The "capture host clock before shadowing" subtlety is a JS-globals artifact. Note for the port: time source must still be injectable (sets up v0.2.4's clock seam).

### 3349ead — v0.2.2 — Element.removeAttributeNode/setAttributeNode
**Files:** `src/runtime/dom.mjs` — `Element` attribute-node methods (+ NS aliases)
**Optimization (from the diff):** Correctness/compat. React 19's `releaseSingletonInstance` iterates `node.attributes` and removes each via `removeAttributeNode(attr)`, which was missing → threw, aborting React's commit during Next.js 15 hydration. Added `removeAttributeNode`/`setAttributeNode` (+NS) as thin shims over the existing name-based attribute API. React reads a detached `attributes` copy then removes each, so mutating `__attrs` while iterating the copy is safe (paired with v0.2.5).
**Rust/WASM port note:** PORTS as behavior (not perf). Implement the attr-node methods as thin wrappers over the name-based attribute store. No hot-path impact. Note this is the FIRST half of the React-19 singleton-release fix; v0.2.5 (live NamedNodeMap) is the second half and is the one that actually terminates the loop.

### 6ce3629 — v0.2.3 — synthetic geometry
**Files:** `src/runtime/dom.mjs` — `synthWidth`/`synthHeight`, rewired `getBoundingClientRect`/`getClientRects`/`offset*`/`client*`/`scroll*` size getters; `stubs.mjs` `matchMedia`/`ResizeObserver`/`IntersectionObserver`
**Optimization (from the diff):** Correctness (anti-deadlock), NOT layout. Honest-zero geometry deadlocks layout-driven React (measure 0 → setState → re-render → measure 0 → ∞). New cheap synthetic box model: block elements (non-`INLINE_TAGS`) fill parent content width (root = `defaultView.innerWidth || 1024`); inline elements shrink-wrap text (`len*CHAR_W=8`, capped at parent); height stacks element children (`Math.max(LINE_HEIGHT=18, sum)`) or `lineCount*18`. **Positions stay 0** (top/left/offsetTop/scrollTop) — only SIZE is faked. The three required properties: non-zero, STABLE per DOM state (so the measure loop sees the same value twice and settles), internally consistent (`right-left===width`, children fit parents). `matchMedia` evaluates min/max-width/height + orientation against the viewport; `ResizeObserver`/`IntersectionObserver` fire once async with one entry, never looping.
**Optimization mechanism (perf):** Memoized per node on `__rw`/`__rh` keyed by `Document.__version`. Width depends ONLY on ancestors, height ONLY on descendants → no cycle, so a mutation invalidates and recomputes cleanly. Test-time only.
**Rust/WASM port note:** PORTS as behavior; perf-sensitive memoization is essential. In Rust: store `__rw`/`__rh` as `Option<(version, value)>` on the node; width recurses up parents, height recurses down children — the no-cycle property MUST be preserved (do not let width depend on descendants or height on ancestors, or you reintroduce the deadlock you're fixing). The STABILITY-per-version property is what lets React's measure loop reach a fixed point — it is a correctness requirement, not just an optimization. Parse/query/events must never call these.

### 6f3a4f2 — v0.2.4 — injectable clock + virtual-time scheduler
**Files:** `src/runtime/window.mjs` — `setClock(fn)`/`now()`, `requestAnimationFrame`/`cancelAnimationFrame`, `MessageChannel`/`MessagePort` polyfill, `performance.now`
**Optimization (from the diff):** Correctness (anti-deadlock TIME loop; geometry fixed the SPACE loop). (1) `setClock(fn)` installs a clock that BOTH `window.performance.now()` and the rAF callback timestamp read through `now()` (`__clock ? __clock() : performanceNow()`); default null = real host clock (vitest/jest unchanged). (2) `requestAnimationFrame` now schedules via the LIVE `globalThis.setTimeout` (read at call time, not the module-captured host) at a 16ms frame delay, so a render tier owning `setTimeout` (a virtual-clock pump) catches every reschedule and advances time per frame — letting time-gated transitions (MUI Fade/Grow, react-transition-group `progress=(now-start)/dur`) reach progress≥1 and stop. (3) `MessageChannel`/`MessagePort` are a real built-in polyfill (not a host passthrough) whose delivery routes through live `globalThis.setTimeout` (delay 0 = a yield) — React 19's scheduler posts its work loop through a MessagePort, so it runs in the owned/virtual queue, and a MessageChannel exists in the bare V8 isolate. `Date.now` stays the embedder's to override.
**Rust/WASM port note:** PORTS as behavior; this is the injectability seam, not perf. The Rust port MUST expose an injectable time source that both `performance.now` and rAF timestamps read through, and a scheduler whose rAF/MessagePort delivery routes through a swappable timer queue so an external virtual-clock driver can advance time per frame and bound the work. This is a structural requirement for turbo-crawl's virtual-clock drain — design the WASM runtime's timer/scheduler as injectable from the start. Default = real host clock (no behavior change).

### 3b4107d — v0.2.5 — live NamedNodeMap attributes
**Files:** `src/runtime/collections.mjs` — `makeLive(getArray, extra, tag)` + new `liveNamedNodeMap`; `dom.mjs` `Element.get attributes`
**Optimization (from the diff):** Correctness (anti-deadlock) + identity. `Element.attributes` returned a fresh snapshot array per access. React 19's `releaseSingletonInstance` captures it once and loops `while (attrs.length) removeAttributeNode(attrs[0])`; the snapshot never shrank → 100% CPU spin when React deleted a subtree containing a host singleton. Now `attributes` is a live `NamedNodeMap` (`liveNamedNodeMap` over `makeLive` with a `'NamedNodeMap'` tag): length/indexing read `__attrs` live, so a captured reference shrinks as attributes are removed and the loop terminates. Memoized on `__attributesMap` for spec-correct identity (reads through live, NO version key needed — like `__childNodesList`). Named accessors (`get`/`set`/`removeNamedItem` +NS) mutate through the owner element. Now a spec iterable NamedNodeMap, not an Array (`.length`/index/`forEach`/spread work; `.find`/`.map` don't — matches browsers).
**Rust/WASM port note:** PORTS as behavior; the LIVENESS is load-bearing. The returned attributes view must read the backing attribute store on every length/index access (never snapshot at creation) — exactly like the live childNodes/children collections. Memoize the view object for identity but key it on nothing (it reads through live), NOT on version. This (the live view) is what actually terminates the React loop; v0.2.2 (the attr-node methods) is the prerequisite. In Rust: a live attributes collection backed by a borrow/index into the node's attr Vec.

---

**Skipped (pure docs/CI/test):** bbf7c1d, af7653a, bb3b8b6, c29db3b, 006902c, e53016f, 261d67b, 30529f0, 97b038f, 0df51c7, 10096ab, 98db2f6, cc609bd, 9b7bf6d, d67bb55, d4f0634, 78b384a, e527fad, a765f76, 238a624, 7cd3d05, 04a493e, feaa589, e52723a, 953fe70, 1786eb5, 11c2fc8, 32dd5e4, 3d3c3d5, a9703e1, 57c6606, 01728ee, b1a8d78, e048d05, 2935068, 37d58c8 (index.d.ts regen — codegen only), 81011cb, 1a57bd9, 8a1bfd1, 7137a00 (CI publish fix), fbfa7a9 (CHANGELOG), 3ea20a8 (test coverage gate raise).

**Batch summary for the Rust port:**
- ONE shared "version counter + cached Vec" helper covers v0.1.48/49/50 (element children, scoped getElementsBy*) — the most reusable port artifact.
- Bulk-build detached subtrees without per-node mutation bookkeeping (v0.1.52/53 clone).
- Sibling traversal must be O(1)/O(scan), never repeated index-search (v0.1.51).
- Core Rust wins (FxHashMap, reserve) PRESERVE AS-IS; the byte-blob string table (v0.1.56) is a napi-boundary artifact that DISSOLVES in pure Rust.
- Parser registry / native-vs-wasm selection / serde-camelCase (v0.1.58/60) dissolve in-process.
- Geometry / clock / scheduler / CSSOM / NamedNodeMap are correctness behaviors to reimplement; geometry+clock+attributes-liveness are the React-19/MUI anti-deadlock trio and their per-version memoization + no-cycle/live-read invariants are load-bearing, not incidental.
