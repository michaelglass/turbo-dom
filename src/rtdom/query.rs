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

fn parse_compound(src: &str) -> Compound {
    let mut c = Compound::default();
    let b = src.as_bytes();
    let mut i = 0;
    // type selector
    if i < b.len() && b[i] != b'.' && b[i] != b'#' && b[i] != b'[' {
        let start = i;
        while i < b.len() && b[i] != b'.' && b[i] != b'#' && b[i] != b'[' {
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
                while i < b.len() && b[i] != b'.' && b[i] != b'#' && b[i] != b'[' {
                    i += 1;
                }
                c.classes.push(src[start..i].to_string());
            }
            b'#' => {
                i += 1;
                let start = i;
                while i < b.len() && b[i] != b'.' && b[i] != b'#' && b[i] != b'[' {
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
            _ => {
                i += 1;
            }
        }
    }
    c
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
        true
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
}
