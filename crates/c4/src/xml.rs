//! Small XML helpers shared by the protocol and the project model.

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// Text of the first child element named `tag`, trimmed.
pub fn child_text<'a>(node: roxmltree::Node<'a, '_>, tag: &str) -> Option<&'a str> {
    node.children().find(|c| c.has_tag_name(tag)).and_then(|c| c.text()).map(str::trim)
}

pub fn child_u32(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<u32> {
    child_text(node, tag).and_then(|t| t.parse().ok())
}

pub fn child<'a, 'i>(node: roxmltree::Node<'a, 'i>, tag: &str) -> Option<roxmltree::Node<'a, 'i>> {
    node.children().find(|c| c.has_tag_name(tag))
}

/// Convert an element to JSON for tool output: leaves become strings, repeated tags
/// become arrays, attributes are prefixed with `@`.
pub fn to_json(node: roxmltree::Node<'_, '_>) -> serde_json::Value {
    use serde_json::{Map, Value};
    let elems: Vec<_> = node.children().filter(|c| c.is_element()).collect();
    if elems.is_empty() && node.attributes().len() == 0 {
        return Value::String(node.text().unwrap_or_default().trim().to_string());
    }
    let mut map = Map::new();
    for a in node.attributes() {
        map.insert(format!("@{}", a.name()), Value::String(a.value().into()));
    }
    for c in elems {
        let key = c.tag_name().name().to_string();
        let v = to_json(c);
        match map.get_mut(&key) {
            Some(Value::Array(arr)) => arr.push(v),
            Some(existing) => {
                let prev = existing.take();
                *existing = Value::Array(vec![prev, v]);
            }
            None => {
                map.insert(key, v);
            }
        }
    }
    if let Some(t) = node.text().map(str::trim).filter(|t| !t.is_empty()) {
        map.insert("#text".into(), Value::String(t.into()));
    }
    Value::Object(map)
}

/// The source text of a node's children (its inner XML), exactly as received.
pub fn inner_xml<'a>(node: roxmltree::Node<'_, 'a>, src: &'a str) -> &'a str {
    let mut kids = node.children();
    match (kids.next(), node.last_child()) {
        (Some(first), Some(last)) => &src[first.range().start..last.range().end],
        _ => "",
    }
}
