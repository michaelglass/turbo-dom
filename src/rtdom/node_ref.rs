//! Ergonomic read-only façade over the handle-based [`Tree`] (RUST_PORT_PLAN §7).
//!
//! Threading `(tree, handle)` pairs through call sites is noisy. [`NodeRef`] bundles
//! a `&Tree` with a [`Handle`] so a consumer can write chained navigation/queries:
//!
//! ```ignore
//! let id = tree.query("div.card")?.get_attribute("id");
//! ```
//!
//! `NodeRef` is `Copy` (a shared reference + a `u32`) — no ownership, no clones needed.
//! It is a thin, allocation-light wrapper that ONLY calls the existing public `Tree`
//! API; it never reaches into `Tree` internals and never mutates.
//!
//! Scoping note: [`Tree::query_selector`]/[`Tree::query_selector_all`] are
//! DOCUMENT-scoped. [`NodeRef::query_selector`]/[`NodeRef::query_selector_all`] are
//! DESCENDANT-scoped — they run the document query and keep only matches whose
//! ancestor chain passes through `self` (matching the DOM `Element.querySelector*`
//! contract, where the context node itself is excluded and only descendants count).

use crate::rtdom::tree::{Handle, Tree, ELEMENT_NODE};

/// A read-only cursor over one node of a [`Tree`].
///
/// Holds a borrowed `&Tree` plus the node's [`Handle`]; cheap to copy and pass by value.
#[derive(Clone, Copy)]
pub struct NodeRef<'a> {
    tree: &'a Tree,
    handle: Handle,
}

impl<'a> NodeRef<'a> {
    /// Bind a handle to its tree.
    #[inline]
    pub fn new(tree: &'a Tree, handle: Handle) -> NodeRef<'a> {
        NodeRef { tree, handle }
    }

    /// The underlying node handle.
    #[inline]
    pub fn handle(&self) -> Handle {
        self.handle
    }

    /// The tree this node belongs to.
    #[inline]
    pub fn tree(&self) -> &'a Tree {
        self.tree
    }

    // ------------------------------------------------------------------ reads

    /// `tagName` (uppercased for HTML-namespace elements). `None` for non-elements.
    pub fn tag_name(&self) -> Option<String> {
        self.tree.tag_name(self.handle)
    }

    /// `localName` (lowercase as parsed). `None` for non-elements.
    pub fn local_name(&self) -> Option<&'a str> {
        self.tree.local_name(self.handle)
    }

    /// `nodeType` (e.g. `ELEMENT_NODE`, `TEXT_NODE`).
    pub fn node_type(&self) -> u8 {
        self.tree.node_type(self.handle)
    }

    /// Attribute value by name, or `None` if absent.
    pub fn get_attribute(&self, name: &str) -> Option<&'a str> {
        self.tree.get_attribute(self.handle, name)
    }

    /// Whether the named attribute is present.
    pub fn has_attribute(&self, name: &str) -> bool {
        self.tree.has_attribute(self.handle, name)
    }

    /// All attributes as `(name, value)` pairs.
    pub fn attributes(&self) -> Vec<(String, String)> {
        self.tree.attributes(self.handle)
    }

    /// Concatenated descendant text.
    pub fn text_content(&self) -> String {
        self.tree.text_content(self.handle)
    }

    // ------------------------------------------------------------- navigation

    /// Parent node, if any.
    pub fn parent(&self) -> Option<NodeRef<'a>> {
        self.tree.parent(self.handle).map(|h| self.wrap(h))
    }

    /// All child nodes (every node type), in order.
    pub fn children(&self) -> Vec<NodeRef<'a>> {
        self.tree
            .children(self.handle)
            .into_iter()
            .map(|h| self.wrap(h))
            .collect()
    }

    /// First child node (any type), if any.
    pub fn first_child(&self) -> Option<NodeRef<'a>> {
        self.tree.first_child(self.handle).map(|h| self.wrap(h))
    }

    /// Last child node (any type), if any.
    pub fn last_child(&self) -> Option<NodeRef<'a>> {
        self.tree.last_child(self.handle).map(|h| self.wrap(h))
    }

    /// Next sibling node (any type), if any.
    pub fn next_sibling(&self) -> Option<NodeRef<'a>> {
        self.tree.next_sibling(self.handle).map(|h| self.wrap(h))
    }

    /// Previous sibling node (any type), if any.
    pub fn previous_sibling(&self) -> Option<NodeRef<'a>> {
        self.tree.previous_sibling(self.handle).map(|h| self.wrap(h))
    }

    /// First child that is an element.
    pub fn first_element_child(&self) -> Option<NodeRef<'a>> {
        for h in self.tree.children(self.handle) {
            if self.tree.node_type(h) == ELEMENT_NODE {
                return Some(self.wrap(h));
            }
        }
        None
    }

    /// Last child that is an element.
    pub fn last_element_child(&self) -> Option<NodeRef<'a>> {
        let kids = self.tree.children(self.handle);
        for h in kids.into_iter().rev() {
            if self.tree.node_type(h) == ELEMENT_NODE {
                return Some(self.wrap(h));
            }
        }
        None
    }

    /// Next sibling that is an element.
    pub fn next_element_sibling(&self) -> Option<NodeRef<'a>> {
        let mut cur = self.tree.next_sibling(self.handle);
        while let Some(h) = cur {
            if self.tree.node_type(h) == ELEMENT_NODE {
                return Some(self.wrap(h));
            }
            cur = self.tree.next_sibling(h);
        }
        None
    }

    /// Previous sibling that is an element.
    pub fn previous_element_sibling(&self) -> Option<NodeRef<'a>> {
        let mut cur = self.tree.previous_sibling(self.handle);
        while let Some(h) = cur {
            if self.tree.node_type(h) == ELEMENT_NODE {
                return Some(self.wrap(h));
            }
            cur = self.tree.previous_sibling(h);
        }
        None
    }

    // ---------------------------------------------------------------- queries

    /// Whether this node matches the selector.
    pub fn matches(&self, selector: &str) -> bool {
        self.tree.matches(self.handle, selector)
    }

    /// First DESCENDANT matching `selector` (the context node itself is excluded).
    pub fn query_selector(&self, selector: &str) -> Option<NodeRef<'a>> {
        self.tree
            .query_selector_all(selector)
            .into_iter()
            .find(|&h| self.is_descendant(h))
            .map(|h| self.wrap(h))
    }

    /// All DESCENDANTS matching `selector` (the context node itself is excluded).
    pub fn query_selector_all(&self, selector: &str) -> Vec<NodeRef<'a>> {
        self.tree
            .query_selector_all(selector)
            .into_iter()
            .filter(|&h| self.is_descendant(h))
            .map(|h| self.wrap(h))
            .collect()
    }

    // ----------------------------------------------------------------- internals

    #[inline]
    fn wrap(&self, h: Handle) -> NodeRef<'a> {
        NodeRef::new(self.tree, h)
    }

    /// Is `h` a strict descendant of `self.handle` (walking parents to the root)?
    fn is_descendant(&self, h: Handle) -> bool {
        if h == self.handle {
            return false;
        }
        let mut cur = self.tree.parent(h);
        while let Some(p) = cur {
            if p == self.handle {
                return true;
            }
            cur = self.tree.parent(p);
        }
        false
    }
}

/// Façade entry points on a [`Tree`] that hand back [`NodeRef`]s.
pub trait DocumentExt {
    /// The document root as a [`NodeRef`].
    fn document(&self) -> NodeRef<'_>;
    /// Wrap an arbitrary handle.
    fn node(&self, h: Handle) -> NodeRef<'_>;
    /// Document-scoped first match (delegates to [`Tree::query_selector`]).
    fn query(&self, sel: &str) -> Option<NodeRef<'_>>;
    /// Document-scoped all matches (delegates to [`Tree::query_selector_all`]).
    fn query_all(&self, sel: &str) -> Vec<NodeRef<'_>>;
}

impl DocumentExt for Tree {
    fn document(&self) -> NodeRef<'_> {
        NodeRef::new(self, self.root())
    }

    fn node(&self, h: Handle) -> NodeRef<'_> {
        NodeRef::new(self, h)
    }

    fn query(&self, sel: &str) -> Option<NodeRef<'_>> {
        self.query_selector(sel).map(|h| NodeRef::new(self, h))
    }

    fn query_all(&self, sel: &str) -> Vec<NodeRef<'_>> {
        self.query_selector_all(sel)
            .into_iter()
            .map(|h| NodeRef::new(self, h))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtdom::tree::Tree;

    const HTML: &str =
        "<main><div class=card id=c1><span>hi</span></div><div class=card>x</div></main>";

    #[test]
    fn document_scoped_query() {
        let tree = Tree::parse(HTML);
        let card = tree.query("div.card").expect("first card");
        assert_eq!(card.tag_name().as_deref(), Some("DIV"));
        assert_eq!(card.get_attribute("id"), Some("c1"));
        assert_eq!(card.text_content(), "hi");

        assert_eq!(tree.query_all("div.card").len(), 2);
    }

    #[test]
    fn descendant_scoped_query() {
        let tree = Tree::parse(HTML);
        let cards = tree.query_all("div.card");
        assert_eq!(cards.len(), 2);

        // First card has a <span>, second does not.
        assert_eq!(cards[0].query_selector_all("span").len(), 1);
        assert_eq!(cards[1].query_selector_all("span").len(), 0);

        // The context node itself is excluded from its own query results.
        assert!(cards[0].query_selector("div.card").is_none());
    }

    #[test]
    fn navigation() {
        let tree = Tree::parse(HTML);
        let card = tree.query("#c1").expect("card by id");
        let span = card.first_element_child().expect("span child");
        assert_eq!(span.tag_name().as_deref(), Some("SPAN"));
        assert_eq!(span.text_content(), "hi");

        // parent() walks back up.
        let back = span.parent().expect("parent of span");
        assert_eq!(back.get_attribute("id"), Some("c1"));

        // children() of the <main>: two card divs.
        let main = card.parent().expect("main");
        assert_eq!(main.tag_name().as_deref(), Some("MAIN"));
        let kids = main.children();
        assert_eq!(kids.len(), 2);
        assert!(kids.iter().all(|k| k.tag_name().as_deref() == Some("DIV")));

        // element-sibling navigation between the two cards.
        let sib = card.next_element_sibling().expect("second card");
        assert!(sib.matches("div.card"));
        assert_eq!(sib.text_content(), "x");
        assert_eq!(
            sib.previous_element_sibling().map(|n| n.handle()),
            Some(card.handle())
        );
    }
}
