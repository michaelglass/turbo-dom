//! SPIKE: Servo `selectors` + `cssparser` selector engine over `Tree`.
//!
//! Compiled only with `--features selectors-engine`. When on, the public
//! `Tree::matches` / `query_selector` / `query_selector_all` / `get_element_by_id`
//! / `get_elements_by_tag_name` methods (see `query.rs`, which is then compiled
//! out) delegate here.
//!
//! The point of the spike is to measure the boilerplate: a real `selectors`
//! integration needs (1) a `SelectorImpl` with seven string associated types,
//! (2) string wrapper newtypes implementing `From<&str>` / `ToCss` /
//! `PrecomputedHash` / `Borrow`, (3) a `cssparser`-driven `Parser` that maps the
//! non-standard / form-state pseudo-classes, and (4) a ~25-method `Element`
//! cursor over `(&Tree, Handle)`. All four are below.

use super::tree::{Handle, Namespace, NodeType, Tree};
use std::borrow::Borrow;
use std::fmt;
use std::ptr::NonNull;

use cssparser::{Parser as CssParser, ParserInput, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, QuirksMode,
    SelectorCaches,
};
use selectors::matching::{matches_selector, ElementSelectorFlags};
use selectors::parser::{ParseRelative, SelectorList};
use selectors::{Element, OpaqueElement, SelectorImpl};

// ----------------------------------------------------------------- string type
/// One wrapper covers every `SelectorImpl` string associated type (attr value,
/// identifier, local name, namespace url/prefix). Cheap `String` newtype with the
/// fistful of traits `selectors` demands.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CssString(pub String);

impl<'a> From<&'a str> for CssString {
    fn from(s: &'a str) -> Self {
        CssString(s.to_owned())
    }
}
impl ToCss for CssString {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        // We never serialize selectors back out; a raw write is enough for the
        // trait bound. (A production impl would `serialize_identifier`.)
        dest.write_str(&self.0)
    }
}
impl PrecomputedHash for CssString {
    fn precomputed_hash(&self) -> u32 {
        // selectors only uses this for its ancestor bloom filter (a fast-reject
        // hint); any stable hash is correct. FNV-1a over the bytes.
        let mut h: u32 = 0x811c_9dc5;
        for &b in self.0.as_bytes() {
            h = (h ^ b as u32).wrapping_mul(0x0100_0193);
        }
        h
    }
}
impl Borrow<str> for CssString {
    fn borrow(&self) -> &str {
        &self.0
    }
}
impl AsRef<str> for CssString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

// ----------------------------------------------------------------- pseudo types
/// Non-tree-structural pseudo-classes. The structural ones (`:first-child`,
/// `:nth-*`, `:empty`, `:root`, `:not`, …) are handled natively by `selectors`;
/// these form-state / non-standard ones route through `match_non_ts_pseudo_class`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pc {
    Checked,
    Disabled,
    Enabled,
    Required,
    Optional,
    ReadOnly,
    ReadWrite,
    Selected, // non-standard; mirrors the hand-rolled engine
}

impl ToCss for Pc {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_str(match self {
            Pc::Checked => ":checked",
            Pc::Disabled => ":disabled",
            Pc::Enabled => ":enabled",
            Pc::Required => ":required",
            Pc::Optional => ":optional",
            Pc::ReadOnly => ":read-only",
            Pc::ReadWrite => ":read-write",
            Pc::Selected => ":selected",
        })
    }
}
impl selectors::parser::NonTSPseudoClass for Pc {
    type Impl = SimpleImpl;
    fn is_active_or_hover(&self) -> bool {
        false
    }
    fn is_user_action_state(&self) -> bool {
        false
    }
}

/// No pseudo-elements are supported — an uninhabited type makes
/// `match_pseudo_element` statically unreachable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pe {}

impl ToCss for Pe {
    fn to_css<W: fmt::Write>(&self, _dest: &mut W) -> fmt::Result {
        match *self {}
    }
}
impl selectors::parser::PseudoElement for Pe {
    type Impl = SimpleImpl;
}

// ----------------------------------------------------------------- SelectorImpl
#[derive(Clone, Debug)]
pub struct SimpleImpl;

impl SelectorImpl for SimpleImpl {
    type ExtraMatchingData<'a> = ();
    type AttrValue = CssString;
    type Identifier = CssString;
    type LocalName = CssString;
    type NamespaceUrl = CssString;
    type NamespacePrefix = CssString;
    type BorrowedNamespaceUrl = str;
    type BorrowedLocalName = str;
    type NonTSPseudoClass = Pc;
    type PseudoElement = Pe;
}

// ----------------------------------------------------------------- the parser
struct SelParser;

impl<'i> selectors::parser::Parser<'i> for SelParser {
    type Impl = SimpleImpl;
    type Error = selectors::parser::SelectorParseErrorKind<'i>;

    fn parse_non_ts_pseudo_class(
        &self,
        location: cssparser::SourceLocation,
        name: cssparser::CowRcStr<'i>,
    ) -> Result<Pc, cssparser::ParseError<'i, Self::Error>> {
        use selectors::parser::SelectorParseErrorKind as E;
        let pc = match &*name.to_ascii_lowercase() {
            "checked" => Pc::Checked,
            "disabled" => Pc::Disabled,
            "enabled" => Pc::Enabled,
            "required" => Pc::Required,
            "optional" => Pc::Optional,
            "read-only" => Pc::ReadOnly,
            "read-write" => Pc::ReadWrite,
            "selected" => Pc::Selected,
            _ => {
                return Err(location
                    .new_custom_error(E::UnsupportedPseudoClassOrElement(name)))
            }
        };
        Ok(pc)
    }
}

// ----------------------------------------------------------------- the cursor
/// A `Copy` cursor over one node of a `Tree`. `selectors` clones it freely as it
/// walks ancestors/siblings, so it must be cheap — `(&Tree, Handle)` is two words.
#[derive(Clone, Copy)]
pub struct El<'a> {
    tree: &'a Tree,
    h: Handle,
}

impl<'a> fmt::Debug for El<'a> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "El({:?})", self.tree.local_name(self.h))
    }
}

impl<'a> El<'a> {
    fn new(tree: &'a Tree, h: Handle) -> Self {
        El { tree, h }
    }
    fn with(&self, h: Handle) -> Self {
        El { tree: self.tree, h }
    }
    fn is_element(&self, h: Handle) -> bool {
        self.tree.node_type(h) == NodeType::Element
    }
    fn ns_url(ns: Namespace) -> &'static str {
        match ns {
            Namespace::Html => "http://www.w3.org/1999/xhtml",
            Namespace::Svg => "http://www.w3.org/2000/svg",
            Namespace::MathMl => "http://www.w3.org/1998/Math/MathML",
        }
    }
}

impl<'a> Element for El<'a> {
    type Impl = SimpleImpl;

    fn opaque(&self) -> OpaqueElement {
        // Stable per-handle identity without a real allocation: the handle's
        // raw index + 1 (so handle 0 is never the null pointer).
        let ptr = (self.h.0 as usize).wrapping_add(1) as *mut ();
        OpaqueElement::from_non_null_ptr(NonNull::new(ptr).unwrap())
    }

    fn parent_element(&self) -> Option<Self> {
        let p = self.tree.parent(self.h)?;
        if self.is_element(p) {
            Some(self.with(p))
        } else {
            None
        }
    }

    fn parent_node_is_shadow_root(&self) -> bool {
        self.tree
            .parent(self.h)
            .map_or(false, |p| self.tree.is_shadow_root(p))
    }

    fn containing_shadow_host(&self) -> Option<Self> {
        self.tree
            .shadow_root_of(self.h)
            .and_then(|sr| self.tree.shadow_host(sr))
            .map(|host| self.with(host))
    }

    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        let mut cur = self.tree.previous_sibling(self.h);
        while let Some(s) = cur {
            if self.is_element(s) {
                return Some(self.with(s));
            }
            cur = self.tree.previous_sibling(s);
        }
        None
    }

    fn next_sibling_element(&self) -> Option<Self> {
        let mut cur = self.tree.next_sibling(self.h);
        while let Some(s) = cur {
            if self.is_element(s) {
                return Some(self.with(s));
            }
            cur = self.tree.next_sibling(s);
        }
        None
    }

    fn first_element_child(&self) -> Option<Self> {
        self.tree
            .children(self.h)
            .into_iter()
            .find(|&c| self.is_element(c))
            .map(|c| self.with(c))
    }

    fn is_html_element_in_html_document(&self) -> bool {
        // Drives case-insensitive type + attr-name matching. Mirrors the
        // hand-rolled engine's `eq_ignore_ascii_case` on tags.
        self.tree.namespace(self.h) == Namespace::Html
    }

    fn has_local_name(&self, local_name: &str) -> bool {
        self.tree.local_name(self.h) == Some(local_name)
    }

    fn has_namespace(&self, ns: &str) -> bool {
        Self::ns_url(self.tree.namespace(self.h)) == ns
    }

    fn is_same_type(&self, other: &Self) -> bool {
        self.tree.local_name(self.h) == other.tree.local_name(other.h)
            && self.tree.namespace(self.h) == other.tree.namespace(other.h)
    }

    fn attr_matches(
        &self,
        _ns: &NamespaceConstraint<&CssString>,
        local_name: &CssString,
        operation: &AttrSelectorOperation<&CssString>,
    ) -> bool {
        // The hand-rolled engine ignores attribute namespaces (looks attrs up by
        // qualified/local name). Mirror that: match the first attr whose name
        // equals the selector's local name, regardless of `_ns`.
        match self.tree.get_attribute(self.h, &local_name.0) {
            Some(got) => operation.eval_str(got),
            None => false,
        }
    }

    fn match_non_ts_pseudo_class(
        &self,
        pc: &Pc,
        _ctx: &mut MatchingContext<'_, SimpleImpl>,
    ) -> bool {
        let t = self.tree;
        let h = self.h;
        let ln = t.local_name(h);
        match pc {
            Pc::Checked => {
                if ln == Some("option") {
                    t.has_attribute(h, "selected")
                } else {
                    t.has_attribute(h, "checked")
                }
            }
            Pc::Disabled => t.has_attribute(h, "disabled"),
            Pc::Enabled => {
                matches!(
                    ln,
                    Some("input")
                        | Some("button")
                        | Some("select")
                        | Some("textarea")
                        | Some("optgroup")
                        | Some("option")
                        | Some("fieldset")
                ) && !t.has_attribute(h, "disabled")
            }
            Pc::Required => t.has_attribute(h, "required"),
            Pc::Optional => {
                matches!(ln, Some("input") | Some("select") | Some("textarea"))
                    && !t.has_attribute(h, "required")
            }
            Pc::ReadOnly => t.has_attribute(h, "readonly"),
            Pc::ReadWrite => !t.has_attribute(h, "readonly"),
            Pc::Selected => t.has_attribute(h, "selected"),
        }
    }

    fn match_pseudo_element(
        &self,
        pe: &Pe,
        _ctx: &mut MatchingContext<'_, SimpleImpl>,
    ) -> bool {
        match *pe {}
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        // Bonus over the hand-rolled engine (which had no :link): an a/area/link
        // with an href. Not exercised by the ported tests.
        matches!(
            self.tree.local_name(self.h),
            Some("a") | Some("area") | Some("link")
        ) && self.tree.has_attribute(self.h, "href")
    }

    fn is_html_slot_element(&self) -> bool {
        self.tree.local_name(self.h) == Some("slot")
            && self.tree.namespace(self.h) == Namespace::Html
    }

    fn has_id(&self, id: &CssString, case: CaseSensitivity) -> bool {
        match self.tree.get_attribute(self.h, "id") {
            Some(got) => case.eq(got.as_bytes(), id.0.as_bytes()),
            None => false,
        }
    }

    fn has_class(&self, name: &CssString, case: CaseSensitivity) -> bool {
        match self.tree.get_attribute(self.h, "class") {
            Some(cv) => cv
                .split_ascii_whitespace()
                .any(|w| case.eq(w.as_bytes(), name.0.as_bytes())),
            None => false,
        }
    }

    fn has_custom_state(&self, _name: &CssString) -> bool {
        false
    }

    fn imported_part(&self, _name: &CssString) -> Option<CssString> {
        None
    }
    fn is_part(&self, _name: &CssString) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        // Mirror the hand-rolled engine: empty = no child nodes at all (it checks
        // `children(h).is_empty()`, which counts text/comment children too).
        self.tree.children(self.h).is_empty()
    }

    fn is_root(&self) -> bool {
        // Mirror hand-rolled: root iff no parent, or the parent is not an element
        // (i.e. the document/fragment container).
        match self.tree.parent(self.h) {
            None => true,
            Some(p) => self.tree.node_type(p) != NodeType::Element,
        }
    }

    fn add_element_unique_hashes(&self, _filter: &mut selectors::bloom::BloomFilter) -> bool {
        false
    }
}

// ----------------------------------------------------------------- parse + match
/// Parse a selector string into a `SelectorList`. Returns `None` on any parse
/// error (an unsupported pseudo, malformed compound, …) — the caller then treats
/// the selector as matching nothing.
fn parse_list(selector: &str) -> Option<SelectorList<SimpleImpl>> {
    let mut input = ParserInput::new(selector);
    let mut parser = CssParser::new(&mut input);
    SelectorList::parse(&SelParser, &mut parser, ParseRelative::No).ok()
}

fn new_caches() -> SelectorCaches {
    SelectorCaches::default()
}

fn matches_list(tree: &Tree, h: Handle, list: &SelectorList<SimpleImpl>) -> bool {
    let el = El::new(tree, h);
    let mut caches = new_caches();
    let mut ctx = MatchingContext::new(
        MatchingMode::Normal,
        None,
        &mut caches,
        QuirksMode::NoQuirks,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    list.slice()
        .iter()
        .any(|sel| matches_selector(sel, 0, None, &el, &mut ctx))
}

// ----------------------------------------------------------------- public API
// These replace the hand-rolled versions in query.rs (compiled out under this
// feature). Same signatures, same version-keyed caching for query_selector_all /
// get_element_by_id.
impl Tree {
    pub fn matches(&self, h: Handle, selector: &str) -> bool {
        match parse_list(selector) {
            Some(list) => matches_list(self, h, &list),
            None => false,
        }
    }

    pub fn query_selector_all(&self, selector: &str) -> std::rc::Rc<[Handle]> {
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
        let list = parse_list(selector);
        let mut out = Vec::new();
        if let Some(list) = list {
            // document-order DFS (same as the hand-rolled engine)
            let mut order = Vec::new();
            let mut stack = vec![self.root()];
            while let Some(h) = stack.pop() {
                order.push(h);
                let kids = self.children(h);
                for &c in kids.iter().rev() {
                    stack.push(c);
                }
            }
            for h in order {
                if self.node_type(h) == NodeType::Element && matches_list(self, h, &list) {
                    out.push(h);
                }
            }
        }
        let rc: std::rc::Rc<[Handle]> = out.into();
        self.qcache.borrow_mut().map.insert(selector.to_string(), rc.clone());
        rc
    }

    pub fn query_selector(&self, selector: &str) -> Option<Handle> {
        self.query_selector_all(selector).first().copied()
    }

    pub fn get_element_by_id(&self, id: &str) -> Option<Handle> {
        let key = {
            let mut k = String::with_capacity(id.len() + 1);
            k.push('\u{1}');
            k.push_str(id);
            k
        };
        {
            let mut cache = self.qcache.borrow_mut();
            if cache.version != self.version {
                cache.version = self.version;
                cache.map.clear();
            }
            if let Some(hit) = cache.map.get(&key) {
                return hit.first().copied();
            }
        }
        let mut found = None;
        let mut stack = vec![self.root()];
        while let Some(h) = stack.pop() {
            if self.node_type(h) == NodeType::Element && self.get_attribute(h, "id") == Some(id) {
                found = Some(h);
                break;
            }
            for &c in self.children(h).iter().rev() {
                stack.push(c);
            }
        }
        self.qcache.borrow_mut().map.insert(key, found.into_iter().collect());
        found
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
            if self.node_type(h) == NodeType::Element
                && (any || self.local_name(h).map_or(false, |ln| ln.eq_ignore_ascii_case(tag)))
            {
                out.push(h);
            }
        }
        out
    }
}
