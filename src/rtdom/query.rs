//! Selector matching + query API over `Tree`. Mirrors the JS runtime's
//! alloc-free matcher discipline (whole-word class scan, index loops, no regex)
//! and version-keyed result caching (`Document.__version` → `Tree.version`).
//!
//! Selector support: comma lists, descendant (` `) and child (`>`) combinators,
//! compounds of `tag` / `.class` / `#id` / `[attr]` / `[attr=val]`. Enough for
//! RTL-style queries; extend as the gauntlet demands.

use super::tree::{Handle, Tree, ELEMENT_NODE};

#[derive(Debug, Clone)]
struct Attr {
    name: String,
    value: Option<String>, // None = presence only ([attr])
}

#[derive(Debug, Clone, Default)]
struct Compound {
    tag: Option<String>, // None or "*" = any
    id: Option<String>,
    classes: Vec<String>,
    attrs: Vec<Attr>,
    pseudos: Vec<Pseudo>,
}

/// Supported pseudo-classes. Mirrors `src/runtime/selectors.mjs` `matchPseudo`.
/// `Unknown` (anything not parsed into a variant) NEVER matches — honest, not a
/// silent true — matching the JS `default: return false`.
#[derive(Debug, Clone)]
enum Pseudo {
    // Structural
    FirstChild,
    LastChild,
    OnlyChild,
    FirstOfType,
    LastOfType,
    OnlyOfType,
    NthChild(i64, i64),       // (a, b) from `an+b`
    NthLastChild(i64, i64),
    NthOfType(i64, i64),
    NthLastOfType(i64, i64),
    Empty,
    Root,
    // Form-state
    Checked,
    Disabled,
    Enabled,
    Required,
    Optional,
    ReadOnly,
    ReadWrite,
    Selected,
    // Negation of a simple compound
    Not(Box<Compound>),
    // Unrecognized / unparseable → never matches
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Combinator {
    Descendant,
    Child,
}

/// A complex selector = a chain of (combinator, compound), left-to-right.
/// The first compound has no meaningful combinator (use Descendant).
#[derive(Debug, Clone)]
struct Complex {
    parts: Vec<(Combinator, Compound)>,
}

/// is byte a compound-part boundary (start of the next `.`/`#`/`[`/`:` token)?
#[inline]
fn is_part_start(byte: u8) -> bool {
    byte == b'.' || byte == b'#' || byte == b'[' || byte == b':'
}

fn parse_compound(src: &str) -> Compound {
    let mut c = Compound::default();
    let b = src.as_bytes();
    let mut i = 0;
    // type selector (stops at the first `.`/`#`/`[`/`:`)
    if i < b.len() && !is_part_start(b[i]) {
        let start = i;
        while i < b.len() && !is_part_start(b[i]) {
            i += 1;
        }
        let tag = &src[start..i];
        if tag != "*" {
            c.tag = Some(tag.to_string());
        }
    }
    while i < b.len() {
        match b[i] {
            b'.' => {
                i += 1;
                let start = i;
                while i < b.len() && !is_part_start(b[i]) {
                    i += 1;
                }
                c.classes.push(src[start..i].to_string());
            }
            b'#' => {
                i += 1;
                let start = i;
                while i < b.len() && !is_part_start(b[i]) {
                    i += 1;
                }
                c.id = Some(src[start..i].to_string());
            }
            b'[' => {
                i += 1;
                let start = i;
                while i < b.len() && b[i] != b']' {
                    i += 1;
                }
                let inner = &src[start..i];
                if i < b.len() {
                    i += 1; // skip ]
                }
                c.attrs.push(parse_attr(inner));
            }
            b':' => {
                // `:name` then optional `(...)` arg (balanced parens, so a
                // nested `:not(.a)` arg survives intact for recursive parse).
                i += 1;
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphabetic() || b[i] == b'-') {
                    i += 1;
                }
                let name = &src[start..i];
                let mut arg: Option<&str> = None;
                if i < b.len() && b[i] == b'(' {
                    let mut depth = 1usize;
                    let astart = i + 1;
                    i += 1;
                    while i < b.len() && depth > 0 {
                        match b[i] {
                            b'(' => depth += 1,
                            b')' => depth -= 1,
                            _ => {}
                        }
                        i += 1;
                    }
                    // i now points just past the closing ')'
                    let aend = if i > astart { i - 1 } else { astart };
                    arg = Some(&src[astart..aend]);
                }
                c.pseudos.push(parse_pseudo(name, arg));
            }
            _ => {
                i += 1;
            }
        }
    }
    c
}

/// Map a pseudo `name` + optional `arg` to a `Pseudo`. Unrecognized → `Unknown`
/// (never matches). Mirrors selectors.mjs `matchPseudo` switch.
fn parse_pseudo(name: &str, arg: Option<&str>) -> Pseudo {
    match name {
        "first-child" => Pseudo::FirstChild,
        "last-child" => Pseudo::LastChild,
        "only-child" => Pseudo::OnlyChild,
        "first-of-type" => Pseudo::FirstOfType,
        "last-of-type" => Pseudo::LastOfType,
        "only-of-type" => Pseudo::OnlyOfType,
        "empty" => Pseudo::Empty,
        "root" => Pseudo::Root,
        "checked" => Pseudo::Checked,
        "disabled" => Pseudo::Disabled,
        "enabled" => Pseudo::Enabled,
        "required" => Pseudo::Required,
        "optional" => Pseudo::Optional,
        "read-only" => Pseudo::ReadOnly,
        "read-write" => Pseudo::ReadWrite,
        "selected" => Pseudo::Selected,
        "nth-child" => {
            let (a, b) = parse_nth(arg.unwrap_or(""));
            Pseudo::NthChild(a, b)
        }
        "nth-last-child" => {
            let (a, b) = parse_nth(arg.unwrap_or(""));
            Pseudo::NthLastChild(a, b)
        }
        "nth-of-type" => {
            let (a, b) = parse_nth(arg.unwrap_or(""));
            Pseudo::NthOfType(a, b)
        }
        "nth-last-of-type" => {
            let (a, b) = parse_nth(arg.unwrap_or(""));
            Pseudo::NthLastOfType(a, b)
        }
        "not" => Pseudo::Not(Box::new(parse_compound(arg.unwrap_or("").trim()))),
        _ => Pseudo::Unknown,
    }
}

/// Parse an `An+B` / `odd` / `even` / integer argument into `(a, b)` coefficients
/// (so the predicate is `nth_match(a, b, index)`). Mirrors selectors.mjs `nthMatch`
/// keyword handling. A pure integer `k` → `(0, k)`; `odd` → `(2, 1)`; `even` → `(2, 0)`.
/// Unparseable → `(0, 0)` which matches index 0 (never, since indices are 1-based).
fn parse_nth(arg: &str) -> (i64, i64) {
    let a0: String = arg.trim().to_ascii_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if a0 == "odd" {
        return (2, 1);
    }
    if a0 == "even" {
        return (2, 0);
    }
    // An+B form
    if let Some(npos) = a0.find('n') {
        let acoef = &a0[..npos];
        let a = match acoef {
            "" | "+" => 1,
            "-" => -1,
            s => s.parse::<i64>().unwrap_or(0),
        };
        let brest = &a0[npos + 1..];
        let b = if brest.is_empty() {
            0
        } else {
            brest.parse::<i64>().unwrap_or(0)
        };
        return (a, b);
    }
    // bare integer
    match a0.parse::<i64>() {
        Ok(n) => (0, n),
        Err(_) => (0, 0),
    }
}

/// Does 1-based `index` satisfy `an+b`? Mirrors selectors.mjs `nthMatch`:
/// for a==0, exact match; otherwise `(index-b) % a == 0 && (index-b)/a >= 0`.
fn nth_match(a: i64, b: i64, index: i64) -> bool {
    if a == 0 {
        return index == b;
    }
    let d = index - b;
    d % a == 0 && d / a >= 0
}

fn parse_attr(inner: &str) -> Attr {
    match inner.find('=') {
        Some(eq) => {
            let name = inner[..eq].trim().trim_end_matches(['~', '^', '$', '*', '|']).trim().to_string();
            let mut val = inner[eq + 1..].trim();
            if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
                val = &val[1..val.len() - 1];
            }
            Attr { name, value: Some(val.to_string()) }
        }
        None => Attr { name: inner.trim().to_string(), value: None },
    }
}

fn parse_complex(src: &str) -> Complex {
    let mut parts = Vec::new();
    let mut combinator = Combinator::Descendant;
    for tok in tokenize_complex(src) {
        if tok == ">" {
            combinator = Combinator::Child;
        } else {
            parts.push((combinator, parse_compound(&tok)));
            combinator = Combinator::Descendant;
        }
    }
    Complex { parts }
}

/// split on whitespace but keep `>` as its own token (with or without surrounding ws).
fn tokenize_complex(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in src.chars() {
        match ch {
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            '>' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                out.push(">".to_string());
            }
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// whole-word class scan, alloc-free — mirrors JS `hasClass`.
fn has_class(class_attr: &str, cls: &str) -> bool {
    if cls.is_empty() {
        return false;
    }
    let bytes = class_attr.as_bytes();
    let mut search = 0;
    while let Some(rel) = class_attr[search..].find(cls) {
        let pos = search + rel;
        let before_ok = pos == 0 || bytes[pos - 1].is_ascii_whitespace();
        let end = pos + cls.len();
        let after_ok = end == bytes.len() || bytes[end].is_ascii_whitespace();
        if before_ok && after_ok {
            return true;
        }
        search = end;
    }
    false
}

impl Tree {
    fn matches_compound(&self, h: Handle, c: &Compound) -> bool {
        if self.node_type(h) != ELEMENT_NODE {
            return false;
        }
        if let Some(tag) = &c.tag {
            match self.local_name(h) {
                Some(ln) if ln.eq_ignore_ascii_case(tag) => {}
                _ => return false,
            }
        }
        if let Some(id) = &c.id {
            if self.get_attribute(h, "id") != Some(id.as_str()) {
                return false;
            }
        }
        if !c.classes.is_empty() {
            let cv = match self.get_attribute(h, "class") {
                Some(v) => v,
                None => return false,
            };
            for cls in &c.classes {
                if !has_class(cv, cls) {
                    return false;
                }
            }
        }
        for a in &c.attrs {
            match (&a.value, self.get_attribute(h, &a.name)) {
                (None, Some(_)) => {}
                (Some(want), Some(got)) if want == got => {}
                _ => return false,
            }
        }
        for p in &c.pseudos {
            if !self.matches_pseudo(h, p) {
                return false;
            }
        }
        true
    }

    /// Element-only siblings of `h` (children of its parent that are elements).
    /// Returns `[h]` if `h` has no parent — mirrors selectors.mjs `elementSiblings`.
    fn element_siblings(&self, h: Handle) -> Vec<Handle> {
        match self.parent(h) {
            Some(p) => self
                .children(p)
                .into_iter()
                .filter(|&c| self.node_type(c) == ELEMENT_NODE)
                .collect(),
            None => vec![h],
        }
    }

    fn matches_pseudo(&self, h: Handle, p: &Pseudo) -> bool {
        match p {
            Pseudo::FirstChild => {
                let sibs = self.element_siblings(h);
                sibs.first() == Some(&h)
            }
            Pseudo::LastChild => {
                let sibs = self.element_siblings(h);
                sibs.last() == Some(&h)
            }
            Pseudo::OnlyChild => self.element_siblings(h).len() == 1,
            Pseudo::FirstOfType => {
                let ln = self.local_name(h);
                self.element_siblings(h)
                    .into_iter()
                    .find(|&c| self.local_name(c) == ln)
                    == Some(h)
            }
            Pseudo::LastOfType => {
                let ln = self.local_name(h);
                self.element_siblings(h)
                    .into_iter()
                    .rev()
                    .find(|&c| self.local_name(c) == ln)
                    == Some(h)
            }
            Pseudo::OnlyOfType => {
                let ln = self.local_name(h);
                self.element_siblings(h)
                    .into_iter()
                    .filter(|&c| self.local_name(c) == ln)
                    .count()
                    == 1
            }
            Pseudo::NthChild(a, b) => {
                let sibs = self.element_siblings(h);
                match sibs.iter().position(|&c| c == h) {
                    Some(idx) => nth_match(*a, *b, idx as i64 + 1),
                    None => false,
                }
            }
            Pseudo::NthLastChild(a, b) => {
                let sibs = self.element_siblings(h);
                match sibs.iter().position(|&c| c == h) {
                    Some(idx) => nth_match(*a, *b, sibs.len() as i64 - idx as i64),
                    None => false,
                }
            }
            Pseudo::NthOfType(a, b) => {
                let ln = self.local_name(h);
                let same: Vec<Handle> = self
                    .element_siblings(h)
                    .into_iter()
                    .filter(|&c| self.local_name(c) == ln)
                    .collect();
                match same.iter().position(|&c| c == h) {
                    Some(idx) => nth_match(*a, *b, idx as i64 + 1),
                    None => false,
                }
            }
            Pseudo::NthLastOfType(a, b) => {
                let ln = self.local_name(h);
                let same: Vec<Handle> = self
                    .element_siblings(h)
                    .into_iter()
                    .filter(|&c| self.local_name(c) == ln)
                    .collect();
                match same.iter().position(|&c| c == h) {
                    Some(idx) => nth_match(*a, *b, same.len() as i64 - idx as i64),
                    None => false,
                }
            }
            // :empty — no child nodes at all (any node type counts in the JS, which
            // checks childNodes.length). We have only element children via children();
            // mirror "no children" honestly.
            Pseudo::Empty => self.children(h).is_empty(),
            Pseudo::Root => match self.parent(h) {
                None => true,
                // parent is the document/root container, not an element
                Some(p) => self.node_type(p) != ELEMENT_NODE,
            },
            // Form-state. selectors.mjs reads the live DOM property (el.checked etc.);
            // this Rust port reads the corresponding attribute.
            // TODO: live prop — JS reads el.checked / el.selected (set by React).
            Pseudo::Checked => {
                let ln = self.local_name(h);
                if ln == Some("option") {
                    self.has_attribute(h, "selected")
                } else {
                    self.has_attribute(h, "checked")
                }
            }
            // TODO: live prop — JS reads el.disabled.
            Pseudo::Disabled => self.has_attribute(h, "disabled"),
            // TODO: live prop — JS reads el.disabled.
            Pseudo::Enabled => {
                matches!(
                    self.local_name(h),
                    Some("input") | Some("button") | Some("select") | Some("textarea")
                        | Some("optgroup") | Some("option") | Some("fieldset")
                ) && !self.has_attribute(h, "disabled")
            }
            // TODO: live prop — JS reads el.required.
            Pseudo::Required => self.has_attribute(h, "required"),
            // TODO: live prop — JS reads el.required.
            Pseudo::Optional => {
                matches!(
                    self.local_name(h),
                    Some("input") | Some("select") | Some("textarea")
                ) && !self.has_attribute(h, "required")
            }
            // TODO: live prop — JS reads el.readOnly.
            Pseudo::ReadOnly => self.has_attribute(h, "readonly"),
            // TODO: live prop — JS reads el.readOnly.
            Pseudo::ReadWrite => !self.has_attribute(h, "readonly"),
            // TODO: live prop — JS reads el.selected.
            Pseudo::Selected => self.has_attribute(h, "selected"),
            Pseudo::Not(inner) => !self.matches_compound(h, inner),
            Pseudo::Unknown => false,
        }
    }

    /// Does `h` match the full complex selector, anchored at its rightmost compound?
    fn matches_complex(&self, h: Handle, cx: &Complex) -> bool {
        let n = cx.parts.len();
        let (_, last) = &cx.parts[n - 1];
        if !self.matches_compound(h, last) {
            return false;
        }
        // walk leftwards matching ancestors
        let mut cur = h;
        for k in (0..n - 1).rev() {
            let (combinator, compound) = &cx.parts[k];
            match combinator_for(cx, k + 1) {
                Combinator::Child => {
                    let p = match self.parent(cur) {
                        Some(p) => p,
                        None => return false,
                    };
                    if !self.matches_compound(p, compound) {
                        return false;
                    }
                    cur = p;
                }
                Combinator::Descendant => {
                    let mut anc = self.parent(cur);
                    let mut found = None;
                    while let Some(a) = anc {
                        if self.matches_compound(a, compound) {
                            found = Some(a);
                            break;
                        }
                        anc = self.parent(a);
                    }
                    match found {
                        Some(a) => cur = a,
                        None => return false,
                    }
                }
            }
            let _ = combinator; // combinator stored on the RIGHT part; see combinator_for
        }
        true
    }

    pub fn matches(&self, h: Handle, selector: &str) -> bool {
        selector.split(',').any(|s| {
            let cx = parse_complex(s.trim());
            !cx.parts.is_empty() && self.matches_complex(h, &cx)
        })
    }

    /// querySelectorAll, document-order, version-cached by selector string.
    pub fn query_selector_all(&self, selector: &str) -> Vec<Handle> {
        {
            let mut cache = self.qcache.borrow_mut();
            if cache.version != self.version {
                cache.version = self.version;
                cache.map.clear();
            }
            if let Some(hit) = cache.map.get(selector) {
                return hit.clone();
            }
        }
        let selectors: Vec<Complex> = selector
            .split(',')
            .map(|s| parse_complex(s.trim()))
            .filter(|cx| !cx.parts.is_empty())
            .collect();
        let mut out = Vec::new();
        let mut stack = vec![self.root()];
        // document-order DFS
        let mut order = Vec::new();
        while let Some(h) = stack.pop() {
            order.push(h);
            let kids = self.children(h);
            for &c in kids.iter().rev() {
                stack.push(c);
            }
        }
        for h in order {
            if self.node_type(h) == ELEMENT_NODE
                && selectors.iter().any(|cx| self.matches_complex(h, cx))
            {
                out.push(h);
            }
        }
        self.qcache.borrow_mut().map.insert(selector.to_string(), out.clone());
        out
    }

    pub fn query_selector(&self, selector: &str) -> Option<Handle> {
        self.query_selector_all(selector).first().copied()
    }

    pub fn get_element_by_id(&self, id: &str) -> Option<Handle> {
        let mut stack = vec![self.root()];
        while let Some(h) = stack.pop() {
            if self.node_type(h) == ELEMENT_NODE && self.get_attribute(h, "id") == Some(id) {
                return Some(h);
            }
            for &c in self.children(h).iter().rev() {
                stack.push(c);
            }
        }
        None
    }

    pub fn get_elements_by_tag_name(&self, tag: &str) -> Vec<Handle> {
        let any = tag == "*";
        let mut out = Vec::new();
        let mut stack = vec![self.root()];
        let mut order = Vec::new();
        while let Some(h) = stack.pop() {
            order.push(h);
            for &c in self.children(h).iter().rev() {
                stack.push(c);
            }
        }
        for h in order {
            if self.node_type(h) == ELEMENT_NODE
                && (any || self.local_name(h).map_or(false, |ln| ln.eq_ignore_ascii_case(tag)))
            {
                out.push(h);
            }
        }
        out
    }
}

/// The combinator that connects part `k` to part `k-1` is stored on part `k`.
fn combinator_for(cx: &Complex, k: usize) -> Combinator {
    cx.parts[k].0
}

#[cfg(test)]
mod tests {
    use super::super::tree::Tree;

    #[test]
    fn qsa_compound_and_descendant() {
        let tree = Tree::parse(
            "<main class=grid><div class='card x'><span class=t>a</span></div><div class=card><b>b</b></div></main>",
        );
        assert_eq!(tree.query_selector_all("div.card").len(), 2);
        assert_eq!(tree.query_selector_all(".grid .t").len(), 1);
        assert_eq!(tree.query_selector_all("main > div").len(), 2);
        assert_eq!(tree.query_selector_all("main > span").len(), 0);
    }

    #[test]
    fn qsa_id_and_attr() {
        let tree = Tree::parse("<a id=home href='/x' data-k=v>hi</a><a href='/y'>z</a>");
        assert_eq!(tree.query_selector("#home").is_some(), true);
        assert_eq!(tree.query_selector_all("a[href]").len(), 2);
        assert_eq!(tree.query_selector_all("a[data-k=v]").len(), 1);
        assert_eq!(tree.query_selector_all("[data-k='v']").len(), 1);
    }

    #[test]
    fn cache_invalidates_on_mutation() {
        let mut tree = Tree::parse("<ul><li class=x>1</li></ul>");
        assert_eq!(tree.query_selector_all(".x").len(), 1);
        let ul = tree.get_elements_by_tag_name("ul")[0];
        let li = tree.create_element("li");
        tree.set_attribute(li, "class", "x");
        tree.append_child(ul, li);
        assert_eq!(tree.query_selector_all(".x").len(), 2); // cache cleared by version bump
    }

    #[test]
    fn matches_and_get_by_id() {
        let tree = Tree::parse("<div id=root><p class=lead>hi</p></div>");
        let p = tree.query_selector("p.lead").unwrap();
        assert!(tree.matches(p, "div#root p.lead"));
        assert!(tree.matches(p, ".lead"));
        assert!(!tree.matches(p, "span"));
        assert_eq!(tree.get_element_by_id("root").is_some(), true);
    }

    #[test]
    fn pseudo_structural_first_last() {
        let tree = Tree::parse("<ul><li>1</li><li>2</li><li>3</li></ul>");
        assert_eq!(tree.query_selector_all("li:first-child").len(), 1);
        assert_eq!(tree.query_selector_all("li:last-child").len(), 1);
        // the first li matches :first-child and contains text "1"
        let first = tree.query_selector("li:first-child").unwrap();
        assert_eq!(tree.text_content(first), "1");
        let last = tree.query_selector("li:last-child").unwrap();
        assert_eq!(tree.text_content(last), "3");
    }

    #[test]
    fn pseudo_nth_child() {
        let tree = Tree::parse("<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>");
        // nth-child(2) → exactly the 2nd
        let two = tree.query_selector_all("li:nth-child(2)");
        assert_eq!(two.len(), 1);
        assert_eq!(tree.text_content(two[0]), "2");
        // odd → 1st and 3rd
        let odd = tree.query_selector_all("li:nth-child(odd)");
        assert_eq!(odd.len(), 2);
        assert_eq!(tree.text_content(odd[0]), "1");
        assert_eq!(tree.text_content(odd[1]), "3");
        // even → 2nd and 4th
        assert_eq!(tree.query_selector_all("li:nth-child(even)").len(), 2);
        // 2n+1 == odd
        assert_eq!(tree.query_selector_all("li:nth-child(2n+1)").len(), 2);
    }

    #[test]
    fn pseudo_of_type() {
        let tree = Tree::parse("<div><span>a</span><b>x</b><span>b</span></div>");
        assert_eq!(tree.query_selector_all("span:first-of-type").len(), 1);
        assert_eq!(tree.query_selector_all("span:last-of-type").len(), 1);
        assert_eq!(tree.query_selector_all("b:only-of-type").len(), 1);
        assert_eq!(tree.query_selector_all("span:only-of-type").len(), 0);
    }

    #[test]
    fn pseudo_checked() {
        let tree = Tree::parse("<form><input checked><input></form>");
        let checked = tree.query_selector_all("input:checked");
        assert_eq!(checked.len(), 1);
        // option[selected] also counts as :checked
        let t2 = Tree::parse("<select><option>a</option><option selected>b</option></select>");
        assert_eq!(t2.query_selector_all("option:checked").len(), 1);
    }

    #[test]
    fn pseudo_disabled_required() {
        let tree = Tree::parse("<form><input disabled><input required><button></button></form>");
        assert_eq!(tree.query_selector_all(":disabled").len(), 1);
        assert_eq!(tree.query_selector_all("input:required").len(), 1);
        // enabled: input/button that isn't disabled (the required input + the button)
        assert_eq!(tree.query_selector_all(":enabled").len(), 2);
    }

    #[test]
    fn pseudo_not() {
        let tree = Tree::parse("<ul><li class=x>1</li><li>2</li><li class=x>3</li></ul>");
        let not_x = tree.query_selector_all("li:not(.x)");
        assert_eq!(not_x.len(), 1);
        assert_eq!(tree.text_content(not_x[0]), "2");
        // :not with a tag
        assert_eq!(tree.query_selector_all("li:not(li)").len(), 0);
    }

    #[test]
    fn pseudo_empty() {
        let tree = Tree::parse("<ul><li></li><li>x</li><li></li></ul>");
        assert_eq!(tree.query_selector_all("li:empty").len(), 2);
    }

    #[test]
    fn pseudo_unknown_matches_nothing() {
        let tree = Tree::parse("<div><p>a</p><p>b</p></div>");
        // an unsupported pseudo never matches (honest)
        assert_eq!(tree.query_selector_all("p:hover").len(), 0);
        assert_eq!(tree.query_selector_all("p:focus-within").len(), 0);
        // but the rest of the compound is still parsed: p without the pseudo matches
        assert_eq!(tree.query_selector_all("p").len(), 2);
    }

    #[test]
    fn pseudo_combined_with_combinator() {
        let tree = Tree::parse(
            "<ul><li class=a>1</li><li class=a>2</li></ul><ol><li>x</li></ol>",
        );
        // descendant + pseudo
        assert_eq!(tree.query_selector_all("ul li:first-child").len(), 1);
        assert_eq!(tree.query_selector_all("ul > li:last-child.a").len(), 1);
    }
}
