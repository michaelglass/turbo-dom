# Spike: swap the hand-rolled selector engine for Servo `selectors` + `cssparser`

**Branch:** `selectors-spike` · **Scope:** `crates/turbo-dom` (the rtdom Rust runtime) ·
**Status:** prototype compiles and runs; 194/195 rtdom lib tests pass through the new engine.

The hand-rolled engine in `src/rtdom/query.rs` (parse_compound / tokenize_complex /
matches_complex / matches_pseudo + the public `Tree` methods) was kept and gated behind
`#[cfg(not(feature = "selectors-engine"))] mod handrolled`. The new engine lives in
`src/rtdom/sel.rs` and is compiled in by `--features selectors-engine`, replacing the public
`Tree::matches` / `query_selector` / `query_selector_all` / `get_element_by_id` /
`get_elements_by_tag_name` with `selectors`-backed versions. Same signatures; the
version-keyed query cache is preserved verbatim.

---

## 1. Dependency cost

Measured with `cargo tree -p turbo-dom --edges normal` (unique crates, incl. the crate itself).

| | direct deps | unique transitive crates | clean build (real / user) |
|---|---|---|---|
| **BEFORE** (hand-rolled) | 3 | **25** | 5.67 s / 8.03 s |
| **AFTER, feature OFF** | 3 | **25** (unchanged) | 5.62 s / 8.03 s |
| **AFTER, `selectors-engine`** | 5 | **43** (+18) | 5.89 s / 11.83 s |

- The deps are **optional** (`selectors`/`cssparser`/`precomputed-hash` behind the feature), so
  with the feature **off the lean 3-direct-dep / 25-crate profile is byte-for-byte preserved** —
  the crate's "clean deps, vendorable" advertisement is intact unless an embedder opts in.
- Turning the feature **on adds 18 transitive crates** (25 → 43): `selectors`, `cssparser`,
  `cssparser-macros`, `derive_more` (+impl), `servo_arc`, `stable_deref_trait`, `bitflags`,
  `dtoa`/`dtoa-short`, `itoa`, `phf_macros`/`phf_generator`, `fastrand`, plus the proc-macro
  toolchain `syn` / `quote` / `proc-macro2` / `unicode-ident`. `phf` (0.13) is **shared** with
  the existing `web_atoms` dep — no duplicate.
- **Clean-build delta:** wall-clock is +0.2 s (this is a many-core machine; the new proc-macro
  crates parallelize away), but **CPU work is +47 % (8.0 s → 11.8 s user)**. On a CPU-bound / few-core
  CI runner that +3.8 s of `syn`/`derive_more`/`cssparser-macros` compilation is what you'd feel.
- Several of the 18 are heavyweight proc-macro / Servo-infra crates (`derive_more`, `servo_arc`,
  `syn`). For a crate whose pitch is *minimal, vendorable, 3 deps*, this is the headline cost.

**Version friction:** none of note. `cargo add selectors` resolved `selectors 0.38.0` →
`cssparser 0.37.0` automatically (they are co-versioned upstream). The only manual step was adding
`precomputed-hash = "0.1"` as a *direct* dep so the string-wrapper can name the `PrecomputedHash`
trait (it's already in the tree transitively via `string_cache`). No duplicate-version conflicts,
no git deps, no nightly. `selectors` did briefly go unpublished historically, but 0.38 is on
crates.io and builds on stable 1.86.

---

## 2. Diff stat / boilerplate

```
 Cargo.lock                          | 125 +++
 crates/turbo-dom/Cargo.toml         |  14 +
 crates/turbo-dom/src/rtdom/mod.rs   |   4 +
 crates/turbo-dom/src/rtdom/query.rs |   9 +-   (just the cfg-gate wrapper)
 crates/turbo-dom/src/rtdom/sel.rs   | 552 +++   (the whole new engine)
```

`sel.rs` is 552 lines (448 non-comment). Where the lines go — i.e. the **API friction**:

| section | lines | nature |
|---|---|---|
| `CssString` newtype + `From`/`ToCss`/`PrecomputedHash`/`Borrow`/`AsRef` | ~40 | pure boilerplate; one type covers all 7 string assoc-types |
| `Pc` (8 form-state/non-std pseudo-classes) + `Pe` (uninhabited) + their `ToCss`/marker impls | ~65 | boilerplate |
| `SimpleImpl: SelectorImpl` (7 assoc types) | ~15 | boilerplate |
| `SelParser: cssparser` parser (maps `:checked`…`:selected`) | ~30 | the only *real* parser code we write |
| **`impl Element for El` — the ~25-method cursor** | **~214** | **the dominant cost; each method is a 1–5-line tree access** |
| `parse_list` / `matches_list` / `MatchingContext` glue | ~35 | boilerplate (context needs 6 args + a per-match `SelectorCaches`) |
| public `impl Tree` (qSA/byId caching + DFS) | ~110 | copied near-verbatim from `query.rs` — **not** selectors-specific |

So the selectors-specific friction is **~340 lines, ~214 of it the mechanical `Element` trait**.
For comparison the hand-rolled engine it replaces is ~470 lines of *parser + matcher + pseudo
logic* (excluding the shared ~110-line public API). Net: the new engine is **slightly fewer
code lines**, but they are almost entirely trait plumbing — the actual selector *semantics*
(combinators, nth, `:not`, backtracking, specificity) move out of our code and into the library.

Three non-obvious API snags worth recording:
- **`OpaqueElement` for a `Copy` cursor with no stable address** — solved with
  `OpaqueElement::from_non_null_ptr((handle.0 + 1) as *mut ())`; the `+1` avoids the null pointer
  for handle 0. Identity is otherwise unused because we build a fresh `SelectorCaches` per match.
- **`PseudoElement`** must implement the trait but we support none → an **uninhabited enum** makes
  `match_pseudo_element` statically `match *pe {}`.
- **Case-insensitive HTML matching** is free: `is_html_element_in_html_document() == (ns == Html)`
  makes `selectors` use the lowercased type/attr names, matching the hand-rolled
  `eq_ignore_ascii_case`. (Foreign SVG/MathML elements then match case-*sensitively*, which is
  actually more correct — see §3.)

---

## 3. Parity results

Ran the **existing** `query.rs` test module (and the rest of the rtdom lib suite, since
cascade/events/node_ref all call the query API) through the new engine:

```
cargo test -p turbo-dom --features selectors-engine --lib
→ 194 passed; 1 failed; 4 ignored
   (query::tests alone: 31 passed; 1 failed)
```

**The single failure — `compound_trailing_non_part_byte`:**
`div[id=x]y` — a malformed selector (a type selector `y` *after* an attribute selector, which is
invalid CSS). The hand-rolled tolerant parser silently **ignores the trailing `y` → 1 match**;
`cssparser`/`selectors` correctly **rejects the whole selector → 0 matches**. This is the new
engine being *more spec-correct*, not a regression in capability. The test encodes a quirk of the
hand-rolled parser, not a desirable behavior.

**Behavioral deltas (beyond the one failing test):**

| area | hand-rolled | `selectors` | tested? |
|---|---|---|---|
| Malformed selectors (`div[id=x]y`) | tolerated, junk ignored | rejected → no match | yes → the 1 failure |
| Unsupported pseudo (`:hover`) | rest of compound parses; pseudo never matches | whole selector fails to parse → no match | `p:hover`→0 in both ✓; **but** a comma list `p:hover, span` would drop `span` too under the new engine (untested) |
| `:not(...)` argument | single compound only | full complex selector list | parity on tested compounds; selectors is *more* capable |
| Type-selector case for SVG/MathML | always case-insensitive | case-sensitive for foreign elements | untested; selectors is more correct |
| `:empty` (comment/whitespace children) | `children().is_empty()` (counts text+comment) | **mirrored** to match hand-rolled | ✓ |
| Specificity, `:is`/`:where`/`:has` | unsupported | available (left disabled to match the current feature set) | n/a |
| `:link`/`:any-link`, `[attr=v i]` flags | unsupported | **work** (cursor implements `is_link`; cssparser parses the flag) | untested bonus |
| nth (`2n + 1`, `odd`, `even`, `:nth-of-type`) | custom `parse_nth` | `cssparser::parse_nth` | parity ✓ |
| attribute ops `~= |= ^= $= *=`, exact, presence | custom | `AttrSelectorOperator::eval_str` | parity ✓ |
| `:checked/:disabled/:enabled/:required/:optional/:read-only/:read-write/:selected` | attribute-based | **re-implemented identically** in `match_non_ts_pseudo_class` | parity ✓ |

Note the form-state pseudos keep the **deliberately honest, attribute-based** semantics (we did
*not* let the library invent property-driven matching) — they live in our `Element` impl, so the
intentional non-honest choices from `query.rs` are preserved exactly.

**Worth flagging:** the two most recent commits on `main` are
`3cdf298 fix selector matcher missing matches with mixed child/descendant combinators` and
`0c23def keep pseudo-argument parens intact in the selector tokenizer` — i.e. **two real,
recent bugs in exactly the hand-rolled parser+matcher that `selectors` would never have had.**
That is the concrete bug-class this swap eliminates.

---

## 4. JS-parity recommendation (NOT implemented)

`src/runtime/selectors.mjs` (366 lines) is a structural twin of the Rust hand-rolled engine: a
recursive-descent `parseCompound`/`parseComplex`/`splitTopLevel` + a `matchCompound`/`matchPseudo`
matcher + `__selectorCache`. The two hand-rolled **parsers** are where the runtimes can silently
drift (tolerant-vs-strict, nth whitespace, escapes, `:is()` nesting) — and where the recent Rust
bugs lived. The **matchers** are already mirrored method-for-method and encode intentional honest
semantics (custom `:selected`, attribute-based form state, alloc-free class scan).

So to get parity *without a char-by-char re-port*, **swap the parser, keep the matcher**, on both
sides:

- **JS:** replace `parseCompound`/`parseComplex`/`splitTopLevel`/nth-parsing with a tiny real
  selector parser → AST. Best fit: **`css-what`** (~2 KB, zero-dep, the parser behind
  `css-select`/cheerio) or **`parsel-js`** (~2 KB, zero-dep). Both emit a clean token AST you map
  once into the existing `matchCompound`/`matchPseudo`. Keep the matcher and `__selectorCache`
  untouched, so the alloc-free hot-path discipline and honest pseudo semantics survive.
- **Rust:** use `cssparser`'s tokenizer (or the `selectors` parse AST) the same way — parse to a
  shared AST shape, keep the existing honest matcher.

This eliminates the **parser-divergence bug class** (one spec-compliant parser per side, fed by the
same grammar) while leaving the deliberately-shared *matching* semantics in hand-written code that's
already kept in lockstep. It's strictly smaller and lower-risk than adopting `selectors` (Rust) +
`css-select` (JS) wholesale — the latter would also import each library's *matching* behavior
(property-driven `:checked`, allocation, different `:empty`/whitespace rules), breaking the
honest-semantics + alloc-free contracts in CLAUDE.md.

If full-library adoption is ever desired for robustness, do it on **both** sides together
(`selectors` ⇄ `css-select`) and accept re-baselining the honest semantics and the query
benchmarks — but the parser-only swap gives ~90 % of the parity win for ~10 % of the cost.

---

## 5. Verdict

**Recommendation: keep the hand-rolled engine as the default; do _not_ make `selectors` a
mandatory dependency. Optionally keep this feature-gated path for embedders who want
maximal correctness and don't care about the dep footprint.**

Reasoning, weighed against this crate's stated *minimal-vendorable-deps* ethos:

- **Against the swap (dominant for this crate):** +18 transitive crates (25 → 43) and +47 % build
  CPU directly contradicts the "3 deps, clean, vendorable" pitch. The crate publishes to crates.io
  on that promise; pulling in `syn`/`derive_more`/`servo_arc`/the `phf` macro toolchain is a large,
  visible regression in footprint for a DOM-query feature that the hand-rolled code already covers
  at ~2.2× happy-dom / 460× jsdom query throughput.
- **For the swap:** it deletes ~470 lines of bug-prone parser+matcher and the *entire class* of
  selector-correctness bugs — and we have **proof those bugs are real and recent** (the two latest
  `main` commits both fix this exact code). `selectors` is the literal engine Servo/Firefox ship,
  with full specificity, `:is`/`:where`/`:has`, attribute case flags, and correct combinator
  backtracking for free. Parity is **31/32** out of the box; the one miss is the new engine being
  *more* correct.
- **The deciding factor:** the win (robustness) is real but the cost (dep footprint) strikes at the
  crate's core differentiator. The hand-rolled engine's bug surface is *bounded and shrinking* (the
  recent fixes), the feature set it must support is *small and stable* (no `:has`/`:is` demand from
  the gauntlet yet), and its perf is a headline number. Adopting `selectors` trades the crate's
  identity for correctness it doesn't yet need.

**Net:** the better investment is the §4 **parser-only** swap — adopt one real *parser* on each
runtime (a 2 KB JS lib + `cssparser`, which is already pulled by `selectors` if ever needed) to kill
the parser-divergence bug class and lock the two runtimes' grammars together, while keeping the
hand-written honest matchers and the lean dependency profile. Reserve full `selectors` adoption for
an embedder-opt-in feature (this branch) or for the day the gauntlet actually demands `:has`/`:is`.
