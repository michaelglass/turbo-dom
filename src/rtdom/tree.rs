//! Rust-native DOM tree (pure Rust API, no JS boundary) — Phase-0 core of the
//! pivoted runtime (RUST_PORT_PLAN §7 verdict: dual-runtime, Rust consumer gets
//! a native API). Mirrors the JS runtime's load-bearing model:
//!   * immutable parse buffer (`core::Soa`) is the read-only source of truth,
//!   * COW overlay: a node only allocates owned state when it is mutated,
//!   * handle (`u32` node index) is stable; identity is the handle itself,
//!   * `version` counter bumped on EVERY mutation = the cache-invalidation key.
//!
//! Reads come straight off the buffer (zero alloc) unless an overlay exists.

use crate::core::{self, Soa};
use std::cell::RefCell;
use std::collections::HashMap;

pub const ELEMENT_NODE: u8 = 1;
pub const TEXT_NODE: u8 = 3;
pub const COMMENT_NODE: u8 = 8;
pub const DOCUMENT_NODE: u8 = 9;
pub const DOCTYPE_NODE: u8 = 10;
pub const FRAGMENT_NODE: u8 = 11;

/// A node handle. Index into the buffer, or (>= buf_len) into `new_nodes`.
pub type Handle = u32;

struct NewNode {
    node_type: u8,
    name: String, // local name (elements) or data (text/comment)
    ns: u8,
}

pub struct Tree {
    buf: Soa,
    buf_len: u32,
    new_nodes: Vec<NewNode>,
    // --- COW overlays (present only for mutated/created nodes) ---
    parent_ov: HashMap<Handle, i32>,
    children_ov: HashMap<Handle, Vec<Handle>>,
    attrs_ov: HashMap<Handle, Vec<(String, String)>>,
    text_ov: HashMap<Handle, String>,
    pub version: u64,
    /// version-keyed query result cache (mirrors JS cachedQSA / Document.__version).
    pub(crate) qcache: RefCell<QueryCache>,
}

#[derive(Default)]
pub(crate) struct QueryCache {
    pub version: u64,
    pub map: HashMap<String, Vec<Handle>>,
}

impl Tree {
    pub fn parse(html: &str) -> Tree {
        let buf = core::parse_html_soa(html);
        let buf_len = buf.node_type.len() as u32;
        Tree {
            buf,
            buf_len,
            new_nodes: Vec::new(),
            parent_ov: HashMap::new(),
            children_ov: HashMap::new(),
            attrs_ov: HashMap::new(),
            text_ov: HashMap::new(),
            version: 0,
            qcache: RefCell::new(QueryCache::default()),
        }
    }

    #[inline]
    fn is_new(&self, h: Handle) -> bool {
        h >= self.buf_len
    }
    #[inline]
    fn new_ref(&self, h: Handle) -> &NewNode {
        &self.new_nodes[(h - self.buf_len) as usize]
    }

    pub fn node_count(&self) -> u32 {
        self.buf_len + self.new_nodes.len() as u32
    }

    /// The document root (node 0 in the SoA).
    pub fn root(&self) -> Handle {
        0
    }

    // ----------------------------------------------------------------- reads
    pub fn node_type(&self, h: Handle) -> u8 {
        if self.is_new(h) {
            self.new_ref(h).node_type
        } else {
            self.buf.node_type[h as usize]
        }
    }

    pub fn namespace_id(&self, h: Handle) -> u8 {
        if self.is_new(h) {
            self.new_ref(h).ns
        } else {
            self.buf.ns[h as usize]
        }
    }

    /// localName (lowercase as parsed). None for non-elements.
    pub fn local_name(&self, h: Handle) -> Option<&str> {
        if self.node_type(h) != ELEMENT_NODE {
            return None;
        }
        if self.is_new(h) {
            Some(&self.new_ref(h).name)
        } else {
            Some(&self.buf.tag_names[self.buf.tag_id[h as usize] as usize])
        }
    }

    /// tagName: uppercased for HTML-namespace elements (DOM contract), as-is otherwise.
    pub fn tag_name(&self, h: Handle) -> Option<String> {
        let ln = self.local_name(h)?;
        if self.namespace_id(h) == 0 {
            Some(ln.to_ascii_uppercase())
        } else {
            Some(ln.to_string())
        }
    }

    pub fn parent(&self, h: Handle) -> Option<Handle> {
        if let Some(&p) = self.parent_ov.get(&h) {
            return if p < 0 { None } else { Some(p as Handle) };
        }
        if self.is_new(h) {
            return None; // detached unless set via overlay
        }
        let p = self.buf.parent[h as usize];
        if p < 0 {
            None
        } else {
            Some(p as Handle)
        }
    }

    /// Live child list. Reads overlay if the node was structurally mutated,
    /// else walks the buffer first-child/next-sib chain (zero overlay alloc).
    pub fn children(&self, h: Handle) -> Vec<Handle> {
        if let Some(c) = self.children_ov.get(&h) {
            return c.clone();
        }
        if self.is_new(h) {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut c = self.buf.first_child[h as usize];
        while c >= 0 {
            out.push(c as Handle);
            c = self.buf.next_sib[c as usize];
        }
        out
    }

    pub fn first_child(&self, h: Handle) -> Option<Handle> {
        self.children(h).first().copied()
    }
    pub fn last_child(&self, h: Handle) -> Option<Handle> {
        self.children(h).last().copied()
    }

    pub fn next_sibling(&self, h: Handle) -> Option<Handle> {
        let p = self.parent(h)?;
        let sibs = self.children(p);
        let i = sibs.iter().position(|&x| x == h)?;
        sibs.get(i + 1).copied()
    }
    pub fn previous_sibling(&self, h: Handle) -> Option<Handle> {
        let p = self.parent(h)?;
        let sibs = self.children(p);
        let i = sibs.iter().position(|&x| x == h)?;
        if i == 0 {
            None
        } else {
            sibs.get(i - 1).copied()
        }
    }

    // ----------------------------------------------------------------- attrs
    /// getAttribute. Reads overlay if attrs were mutated, else the buffer slice
    /// (lazy — no owned Vec built for unmutated nodes).
    pub fn get_attribute(&self, h: Handle, name: &str) -> Option<&str> {
        if let Some(ov) = self.attrs_ov.get(&h) {
            return ov.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        }
        if self.is_new(h) {
            return None;
        }
        let i = h as usize;
        let start = self.buf.attr_start[i];
        if start < 0 {
            return None;
        }
        let start = start as usize;
        let count = self.buf.attr_count[i] as usize;
        for j in start..start + count {
            let nid = self.buf.attr_name_id[j] as usize;
            if self.buf.attr_names[nid] == name {
                return Some(&self.buf.attr_values[self.buf.attr_value_id[j] as usize]);
            }
        }
        None
    }

    pub fn has_attribute(&self, h: Handle, name: &str) -> bool {
        self.get_attribute(h, name).is_some()
    }

    /// All (name, value) pairs for a node (owned copy).
    pub fn attributes(&self, h: Handle) -> Vec<(String, String)> {
        if let Some(ov) = self.attrs_ov.get(&h) {
            return ov.clone();
        }
        if self.is_new(h) {
            return Vec::new();
        }
        let i = h as usize;
        let start = self.buf.attr_start[i];
        if start < 0 {
            return Vec::new();
        }
        let start = start as usize;
        let count = self.buf.attr_count[i] as usize;
        let mut out = Vec::with_capacity(count);
        for j in start..start + count {
            let nid = self.buf.attr_name_id[j] as usize;
            let vid = self.buf.attr_value_id[j] as usize;
            out.push((self.buf.attr_names[nid].clone(), self.buf.attr_values[vid].clone()));
        }
        out
    }

    // ----------------------------------------------------------------- text
    pub fn node_value(&self, h: Handle) -> Option<String> {
        let nt = self.node_type(h);
        if nt != TEXT_NODE && nt != COMMENT_NODE {
            return None;
        }
        if let Some(t) = self.text_ov.get(&h) {
            return Some(t.clone());
        }
        if self.is_new(h) {
            return Some(self.new_ref(h).name.clone());
        }
        let tid = self.buf.text_id[h as usize];
        if tid < 0 {
            Some(String::new())
        } else {
            Some(self.buf.strings[tid as usize].clone())
        }
    }

    /// textContent: concatenated descendant text.
    pub fn text_content(&self, h: Handle) -> String {
        let nt = self.node_type(h);
        if nt == TEXT_NODE || nt == COMMENT_NODE {
            return self.node_value(h).unwrap_or_default();
        }
        let mut out = String::new();
        self.collect_text(h, &mut out);
        out
    }
    fn collect_text(&self, h: Handle, out: &mut String) {
        for c in self.children(h) {
            match self.node_type(c) {
                TEXT_NODE => out.push_str(&self.node_value(c).unwrap_or_default()),
                COMMENT_NODE => {}
                _ => self.collect_text(c, out),
            }
        }
    }

    // ------------------------------------------------------------- mutations
    fn bump(&mut self) {
        self.version += 1;
    }

    /// Ensure a node's attr overlay exists (copy buffer attrs in on first write).
    fn ensure_attrs(&mut self, h: Handle) -> &mut Vec<(String, String)> {
        if !self.attrs_ov.contains_key(&h) {
            let init = self.attributes(h);
            self.attrs_ov.insert(h, init);
        }
        self.attrs_ov.get_mut(&h).unwrap()
    }

    pub fn set_attribute(&mut self, h: Handle, name: &str, value: &str) {
        let ov = self.ensure_attrs(h);
        if let Some(slot) = ov.iter_mut().find(|(n, _)| n == name) {
            slot.1 = value.to_string();
        } else {
            ov.push((name.to_string(), value.to_string()));
        }
        self.bump();
    }

    pub fn remove_attribute(&mut self, h: Handle, name: &str) {
        let ov = self.ensure_attrs(h);
        ov.retain(|(n, _)| n != name);
        self.bump();
    }

    /// Ensure a node's child overlay exists (copy buffer children in on first mutate).
    fn ensure_children(&mut self, h: Handle) -> &mut Vec<Handle> {
        if !self.children_ov.contains_key(&h) {
            let init = self.children(h);
            self.children_ov.insert(h, init);
        }
        self.children_ov.get_mut(&h).unwrap()
    }

    fn detach(&mut self, child: Handle) {
        if let Some(p) = self.parent(child) {
            let list = self.ensure_children(p);
            list.retain(|&x| x != child);
        }
    }

    pub fn append_child(&mut self, parent: Handle, child: Handle) {
        self.detach(child);
        self.ensure_children(parent).push(child);
        self.parent_ov.insert(child, parent as i32);
        self.bump();
    }

    pub fn insert_before(&mut self, parent: Handle, child: Handle, reference: Option<Handle>) {
        self.detach(child);
        let list = self.ensure_children(parent);
        match reference.and_then(|r| list.iter().position(|&x| x == r)) {
            Some(idx) => list.insert(idx, child),
            None => list.push(child),
        }
        self.parent_ov.insert(child, parent as i32);
        self.bump();
    }

    pub fn remove_child(&mut self, parent: Handle, child: Handle) {
        self.ensure_children(parent).retain(|&x| x != child);
        self.parent_ov.insert(child, -1);
        self.bump();
    }

    pub fn set_text_content(&mut self, h: Handle, text: &str) {
        let nt = self.node_type(h);
        if nt == TEXT_NODE || nt == COMMENT_NODE {
            self.text_ov.insert(h, text.to_string());
        } else {
            // replace children with a single text node
            let t = self.create_text_node(text);
            self.children_ov.insert(h, vec![t]);
            self.parent_ov.insert(t, h as i32);
        }
        self.bump();
    }

    // ------------------------------------------------------------- creation
    fn push_new(&mut self, node_type: u8, name: String, ns: u8) -> Handle {
        let h = self.node_count();
        self.new_nodes.push(NewNode { node_type, name, ns });
        h
    }

    pub fn create_element(&mut self, tag: &str) -> Handle {
        let h = self.push_new(ELEMENT_NODE, tag.to_ascii_lowercase(), 0);
        self.children_ov.insert(h, Vec::new());
        self.attrs_ov.insert(h, Vec::new());
        self.bump();
        h
    }

    pub fn create_element_ns(&mut self, tag: &str, ns: u8) -> Handle {
        let h = self.push_new(ELEMENT_NODE, tag.to_string(), ns);
        self.children_ov.insert(h, Vec::new());
        self.attrs_ov.insert(h, Vec::new());
        self.bump();
        h
    }

    pub fn create_text_node(&mut self, data: &str) -> Handle {
        let h = self.push_new(TEXT_NODE, data.to_string(), 0);
        self.bump();
        h
    }

    pub fn create_comment(&mut self, data: &str) -> Handle {
        let h = self.push_new(COMMENT_NODE, data.to_string(), 0);
        self.bump();
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(html: &str) -> Tree {
        Tree::parse(html)
    }

    #[test]
    fn reads_structure_from_buffer() {
        let tree = t("<div id=a><span class=x>hi</span><p>yo</p></div>");
        // find the div
        let mut div = None;
        for h in 0..tree.node_count() {
            if tree.local_name(h) == Some("div") {
                div = Some(h);
            }
        }
        let div = div.unwrap();
        assert_eq!(tree.tag_name(div).as_deref(), Some("DIV"));
        assert_eq!(tree.get_attribute(div, "id"), Some("a"));
        let kids = tree.children(div);
        assert_eq!(kids.len(), 2);
        assert_eq!(tree.local_name(kids[0]), Some("span"));
        assert_eq!(tree.local_name(kids[1]), Some("p"));
        assert_eq!(tree.text_content(div), "hiyo");
    }

    #[test]
    fn set_attribute_is_cow_and_bumps_version() {
        let mut tree = t("<div id=a></div>");
        let div = (0..tree.node_count()).find(|&h| tree.local_name(h) == Some("div")).unwrap();
        let v0 = tree.version;
        tree.set_attribute(div, "class", "card");
        assert!(tree.version > v0);
        assert_eq!(tree.get_attribute(div, "class"), Some("card"));
        // original buffer attr still readable through overlay
        assert_eq!(tree.get_attribute(div, "id"), Some("a"));
    }

    #[test]
    fn append_and_remove_child() {
        let mut tree = t("<div></div>");
        let div = (0..tree.node_count()).find(|&h| tree.local_name(h) == Some("div")).unwrap();
        let span = tree.create_element("span");
        tree.append_child(div, span);
        assert_eq!(tree.children(div), vec![span]);
        assert_eq!(tree.parent(span), Some(div));
        assert_eq!(tree.tag_name(span).as_deref(), Some("SPAN"));
        tree.remove_child(div, span);
        assert!(tree.children(div).is_empty());
        assert_eq!(tree.parent(span), None);
    }

    #[test]
    fn create_text_and_set_text_content() {
        let mut tree = t("<p>old</p>");
        let p = (0..tree.node_count()).find(|&h| tree.local_name(h) == Some("p")).unwrap();
        tree.set_text_content(p, "new");
        assert_eq!(tree.text_content(p), "new");
    }

    #[test]
    fn siblings() {
        let tree = t("<ul><li>1</li><li>2</li><li>3</li></ul>");
        let lis: Vec<_> = (0..tree.node_count()).filter(|&h| tree.local_name(h) == Some("li")).collect();
        assert_eq!(tree.next_sibling(lis[0]), Some(lis[1]));
        assert_eq!(tree.previous_sibling(lis[2]), Some(lis[1]));
        assert_eq!(tree.next_sibling(lis[2]), None);
    }
}
