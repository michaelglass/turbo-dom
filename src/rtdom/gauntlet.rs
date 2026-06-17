//! Phase-4 end-to-end gauntlet for the Rust-native runtime. Exercises the whole
//! stack in one in-process flow (no JS boundary): parse → query → getComputedStyle
//! cascade → event dispatch whose handler MUTATES the tree → cache-invalidated
//! re-query → serialize. This is the Rust-consumer analogue of the RTL gauntlet;
//! it proves the native API composes correctly across modules.
#![cfg(test)]

use super::cascade;
use super::events::{Dom, Event};
use super::serialize;

const PAGE: &str = "<!doctype html><html><head><style>\
.card{color:blue;padding:0}\
#hero{color:green}\
.card .title{font-weight:bold}\
</style></head><body><main class=grid>\
<div class='card' id=hero data-testid=c0><h2 class=title>A</h2><button type=button>add</button></div>\
<div class='card' data-testid=c1><h2 class=title>B</h2></div>\
<div class='card' data-testid=c2><h2 class=title>C</h2></div>\
</main></body></html>";

#[test]
fn full_stack_parse_query_cascade_event_mutate_serialize() {
    let mut dom = Dom::parse(PAGE);

    // --- query ---
    let cards = dom.tree.query_selector_all("div.card");
    assert_eq!(cards.len(), 3);
    let titles = dom.tree.query_selector_all(".card .title");
    assert_eq!(titles.len(), 3);
    assert_eq!(dom.tree.text_content(cards[0]), "Aadd"); // h2 "A" + button "add"

    // --- attributes ---
    assert_eq!(dom.tree.get_attribute(cards[1], "data-testid"), Some("c1"));
    assert_eq!(dom.tree.tag_name(cards[0]).as_deref(), Some("DIV"));

    // --- getComputedStyle cascade ---
    // .card sets color:blue; #hero (id) sets color:green and wins on specificity.
    let hero_cs = cascade::computed_style(&dom.tree, cards[0]);
    assert_eq!(cascade::get_property_value(&hero_cs, "color"), "rgb(0, 128, 0)"); // green
    let plain_cs = cascade::computed_style(&dom.tree, cards[1]);
    assert_eq!(cascade::get_property_value(&plain_cs, "color"), "rgb(0, 0, 255)"); // blue
    // honest absence
    assert_eq!(cascade::get_property_value(&plain_cs, "margin-top"), "");

    // --- event dispatch whose handler mutates the tree ---
    let main = dom.tree.query_selector("main.grid").unwrap();
    dom.add_event_listener(
        main,
        "addcard",
        false,
        false,
        Box::new(|tree, _ev| {
            let m = tree.query_selector("main.grid").unwrap();
            let card = tree.create_element("div");
            tree.set_attribute(card, "class", "card");
            tree.append_child(m, card);
        }),
    );
    let button = dom.tree.query_selector("button").unwrap();
    let mut ev = Event::new("addcard", true, false);
    dom.dispatch_event(button, &mut ev); // bubbles button → div → main

    // --- cache-invalidated re-query reflects the mutation ---
    assert_eq!(dom.tree.query_selector_all("div.card").len(), 4);

    // --- serialize ---
    let inner = serialize::serialize_inner(&dom.tree, main);
    assert_eq!(inner.matches("class=\"card\"").count() + inner.matches("class='card'").count() >= 1, true);
    let outer = serialize::serialize_outer(&dom.tree, cards[2]);
    assert!(outer.starts_with("<div"));
    assert!(outer.contains("data-testid=\"c2\""));
}

#[test]
fn innerhtml_then_query_and_serialize() {
    let mut dom = Dom::parse("<div id=root></div>");
    let root = dom.tree.query_selector("#root").unwrap();
    dom.tree.set_inner_html(root, "<ul><li class=x>1</li><li class=x>2</li></ul>");
    assert_eq!(dom.tree.query_selector_all("li.x").len(), 2);
    assert_eq!(dom.tree.text_content(root), "12");
    let html = serialize::serialize_inner(&dom.tree, root);
    assert!(html.starts_with("<ul>"));
}
