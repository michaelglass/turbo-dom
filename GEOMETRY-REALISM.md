# Geometry realism (fixes the React/MUI hydration measure-loop)

> **RESOLVED in v0.2.3 (Layer A).** `dom.mjs` now returns a synthetic box model
> (`synthWidth`/`synthHeight`): non-zero, STABLE per `Document.__version`,
> internally consistent (block fills parent width, inline shrink-wraps text,
> children stack; positions stay honest 0). `window.matchMedia` (`stubs.mjs`)
> parses min/max-width/height + orientation against the viewport.
> `ResizeObserver`/`IntersectionObserver` fire once async with one initial entry.
> Tests in `test/coverage-fill.test.mjs` + `test/runtime.test.mjs` +
> `test/surface.test.mjs`. Layer B (render deadline) is turbo-crawl's.

Date: 2026-06-17
Hand-off from turbo-crawl. Full write-up:
`turbo-crawl/docs/render-geometry-loop.md`.

## Why

Hydrating a layout-driven React app (MUI Popper/autosize/virtual lists,
`useMediaQuery`) over turbo-dom **infinite-loops**: components measure geometry,
get `0`/wrong values, `setState` to "fix" it, re-render, measure `0` again, loop.
The methods all exist — they just return **degenerate** values:

```
getBoundingClientRect() → all 0   offsetWidth/clientWidth = 0
matchMedia('(min-width:600px)').matches = false   // even at innerWidth 1024
ResizeObserver callback → never fires
```

## What to change (this repo)

Goal: values that are **non-zero, plausible, STABLE across calls for the same DOM
state, and internally consistent**. Stability is the critical one — a
measure→setState→measure cycle must see the *same* value twice so React settles to
a fixed point. Cheap synthetic box model, no real layout engine:

1. **`src/runtime/dom.mjs` geometry getters** (currently `zeroRect()` / `return 0`):
   - block: `width = parent content width (default innerWidth, e.g. 1024)`,
     `height = lineHeight * roughLineCount(text) || fixed default`.
   - inline/text: `width = textLen * ~8`, `height = lineHeight`.
   - `getBoundingClientRect()` → `{width,height,top,left,right:left+width,
     bottom:top+height,x:left,y:top}`; `offset*`/`client*` mirror width/height.
     Top/left can stay 0 or a running offset — **size** is what matters.

2. **`src/runtime/window.mjs` `matchMedia`**: parse `min/max-width`,
   `min/max-height`, `orientation`; evaluate against `innerWidth`/`innerHeight`;
   return a real `MediaQueryList` (`matches`, `media`, add/removeEventListener).

3. **`src/runtime/stubs.mjs` `ResizeObserver`/`IntersectionObserver`**: fire the
   callback **once**, async, with one initial entry (`contentRect` = element rect;
   IO `isIntersecting:true, intersectionRatio:1`). **Once — not on a loop.**

Bonus: this also sharpens the existing `visible`/cascade accuracy.

## Validate

turbo-crawl is symlinked into `payroll-app-turbocrawl`; Next dev on :3010:

```sh
node e2e/turbo/smoke.mjs    # data-test-id 0 → large, returns in seconds, CPU not pegged
```

turbo-crawl adds a render wall-clock deadline as a backstop (Layer B), but a
*synchronous* loop can't be interrupted from JS — so this geometry realism is the
real unlock; the deadline only catches async-paced loops + guarantees return.
