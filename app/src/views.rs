//! Compact JSON views of a project for assistants and the UI.
//!
//! A snapshot is large (1.5 MB of XML for a typical house), so these shape it into
//! what a question needs: the room tree, one item in depth, the connection list.
//! Credential-like property values are masked here, at the boundary.

use c4::director::{Catalog, DeviceInfo};
use c4::model::{CodeItem, ItemKind, REDACTED, is_sensitive_property, event_key};
use c4::Project;
use serde_json::{Value, json};

fn masked(name: &str, value: &str) -> String {
    if is_sensitive_property(name) && !value.is_empty() { REDACTED.into() } else { value.into() }
}

fn short_item(p: &Project, id: u32) -> Value {
    match p.item(id) {
        Some(i) => json!({ "id": id, "name": i.name, "kind": i.kind.label(), "driver": i.driver }),
        None => json!({ "id": id, "name": format!("#{id}") }),
    }
}

/// Rooms with their devices (proxies folded away), plus agents and counts.
pub fn overview(p: &Project) -> Value {
    let mut rooms = Vec::new();
    for room in p.items.values().filter(|i| i.kind == ItemKind::Room) {
        let devices: Vec<Value> = room
            .children
            .iter()
            .filter_map(|c| p.item(*c))
            .filter(|d| d.kind == ItemKind::Device)
            .map(|d| json!({ "id": d.id, "name": d.name, "driver": d.driver }))
            .collect();
        let location: Vec<String> = p.ancestors(room.id).iter().map(|a| a.name.clone()).collect();
        rooms.push(json!({ "id": room.id, "name": room.name, "location": location.join(" › "), "devices": devices }));
    }
    let agents: Vec<Value> = p
        .items
        .values()
        .filter(|i| i.kind == ItemKind::Agent)
        .map(|a| json!({ "id": a.id, "name": a.name, "driver": a.driver }))
        .collect();
    let count = |k: ItemKind| p.items.values().filter(|i| i.kind == k).count();
    json!({
        "project": p.name,
        "counts": {
            "rooms": count(ItemKind::Room), "devices": count(ItemKind::Device), "agents": count(ItemKind::Agent),
            "connections": p.bindings.len(), "network_bindings": p.network_bindings.len(),
            "events_with_programming": p.programming.len(),
        },
        "rooms": rooms,
        "agents": agents,
    })
}

/// The site/building/floor/room/device tree, for the UI's project pane.
pub fn tree(p: &Project) -> Value {
    fn node(p: &Project, id: u32) -> Value {
        let it = &p.items[&id];
        let children: Vec<Value> = it.children.iter().filter(|c| p.items.contains_key(c)).map(|c| node(p, *c)).collect();
        json!({ "id": id, "name": it.name, "kind": it.kind.label(), "driver": it.driver, "children": children })
    }
    match p.root {
        Some(r) => node(p, r),
        None => json!(null),
    }
}

/// Search items by name, driver file or room.
pub fn find(p: &Project, query: &str, kind: Option<&str>) -> Value {
    let q = query.to_lowercase();
    let hits: Vec<Value> = p
        .items
        .values()
        .filter(|i| kind.is_none_or(|k| i.kind.label() == k))
        .filter(|i| {
            q.is_empty()
                || i.name.to_lowercase().contains(&q)
                || i.driver.as_deref().is_some_and(|d| d.to_lowercase().contains(&q))
                || p.room_of(i.id).is_some_and(|r| r.name.to_lowercase().contains(&q))
        })
        .take(100)
        .map(|i| json!({ "id": i.id, "name": i.name, "kind": i.kind.label(), "driver": i.driver, "path": p.path(i.id) }))
        .collect();
    json!({ "matches": hits })
}

fn device_info(d: &DeviceInfo) -> Value {
    json!({
        "manufacturer": d.manufacturer, "model": d.model, "driver_name": d.driver_name,
        "version": d.version, "control_method": d.control_method, "search_type": d.search_type,
        "proxies": d.proxies,
    })
}

/// Connection definitions of one item, with what each is connected to.
fn connections_of(p: &Project, cat: &Catalog, id: u32) -> Vec<Value> {
    let Some(info) = cat.devices.get(&id) else { return vec![] };
    let names = cat.names();
    // A combo driver and its proxies declare the same connection ids; the binding
    // belongs to the proxy, so list each connection only under its owner.
    let proxy_owned: std::collections::HashSet<u32> = p
        .item(id)
        .map(|it| it.children.iter().filter_map(|c| cat.devices.get(c)).flat_map(|d| d.connections.iter().map(|c| c.id)).collect())
        .unwrap_or_default();
    info.connections
        .iter()
        .filter(|c| !proxy_owned.contains(&c.id))
        // Type 4 (ids 6000-6999) is how the device is reached on the network — what
        // `add_network_binding` identifies, not something to wire. See `network_connections`.
        .filter(|c| c.conn_type != 4)
        .map(|c| {
            let peers: Vec<Value> = p
                .bindings
                .iter()
                .filter_map(|b| {
                    if b.consumer_device == id && b.consumer_binding == c.id {
                        Some(json!({ "device": short_item(p, b.provider_device), "binding": b.provider_binding,
                            "connection": names.connection(b.provider_device, b.provider_binding), "classes": b.classes }))
                    } else if b.provider_device == id && b.provider_binding == c.id {
                        Some(json!({ "device": short_item(p, b.consumer_device), "binding": b.consumer_binding,
                            "connection": b.consumer_name, "classes": b.classes }))
                    } else {
                        None
                    }
                })
                .collect();
            json!({ "id": c.id, "name": c.name, "role": if c.consumer { "input" } else { "output" },
                "classes": c.classes, "connected_to": peers })
        })
        .collect()
}

fn code_lines(code: &[CodeItem], depth: usize, out: &mut Vec<Value>) {
    for c in code {
        out.push(json!({ "depth": depth, "text": c.display, "enabled": c.enabled, "id": c.id }));
        code_lines(&c.children, depth + 1, out);
    }
}

/// Everything about one item: driver, properties (with schema), connections, network
/// identity, variables, events with their programming, and child proxies.
pub fn item(p: &Project, cat: &Catalog, id: u32) -> Option<Value> {
    let it = p.item(id)?;
    let info = cat.devices.get(&id);
    let properties: Vec<Value> = match info {
        Some(d) if !d.properties.is_empty() => d
            .properties
            .iter()
            .map(|def| {
                let v = it.properties.get(&def.name).cloned().or_else(|| def.default.clone()).unwrap_or_default();
                json!({ "name": def.name, "value": masked(&def.name, &v), "type": def.prop_type,
                    "readonly": def.readonly, "options": def.items, "min": def.minimum, "max": def.maximum })
            })
            .collect(),
        _ => it.properties.iter().map(|(k, v)| json!({ "name": k, "value": masked(k, v) })).collect(),
    };
    let mut events = Vec::new();
    if let Some(d) = info {
        for (eid, name) in &d.events {
            let mut lines = Vec::new();
            if let Some(code) = p.programming.get(&event_key(id, *eid)) {
                code_lines(code, 0, &mut lines);
            }
            events.push(json!({ "id": eid, "name": name, "programming": lines }));
        }
    }
    let children: Vec<Value> = it
        .children
        .iter()
        .filter_map(|c| p.item(*c))
        .map(|c| json!({ "id": c.id, "name": c.name, "kind": c.kind.label(), "driver": c.driver,
            "connections": connections_of(p, cat, c.id) }))
        .collect();
    Some(json!({
        "id": id, "name": it.name, "kind": it.kind.label(), "path": p.path(id),
        "room": p.room_of(id).map(|r| r.name.clone()), "driver": it.driver,
        "device": info.map(device_info),
        "properties": properties,
        "actions": info.map(|d| d.actions.iter().map(|(n, c)| json!({ "name": n, "command": c })).collect::<Vec<_>>()),
        "connections": connections_of(p, cat, id),
        "network": p.network_bindings.iter().filter(|n| n.device == id).collect::<Vec<_>>(),
        "network_connections": info.map(|d| d.connections.iter().filter(|c| c.conn_type == 4)
            .map(|c| json!({ "id": c.id, "name": c.name, "classes": c.classes })).collect::<Vec<_>>()).unwrap_or_default(),
        "variables": p.variables.iter().filter(|v| v.device == id).collect::<Vec<_>>(),
        "events": events,
        "children": children,
    }))
}

/// Every connection definition in the project, optionally filtered.
pub fn connections(p: &Project, cat: &Catalog, device: Option<u32>, class: Option<&str>, unconnected_only: bool) -> Value {
    let class = class.map(str::to_uppercase);
    let mut rows = Vec::new();
    for (id, info) in &cat.devices {
        if device.is_some_and(|d| d != *id && p.item(*id).and_then(|i| i.parent) != Some(d)) {
            continue;
        }
        let Some(it) = p.item(*id) else { continue };
        for c in connections_of(p, cat, *id) {
            let connected = c["connected_to"].as_array().is_some_and(|a| !a.is_empty());
            if unconnected_only && connected {
                continue;
            }
            if let Some(cl) = &class {
                if !c["classes"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(cl))) {
                    continue;
                }
            }
            rows.push(json!({ "device": { "id": id, "name": it.name, "room": p.room_of(*id).map(|r| r.name.clone()) },
                "connection": c }));
        }
        let _ = info;
    }
    json!({ "connections": rows })
}

/// Programming per event, readable.
pub fn programming(p: &Project, cat: &Catalog, device: Option<u32>) -> Value {
    let names = cat.names();
    let events: Vec<Value> = p
        .programming
        .iter()
        .filter_map(|(k, code)| {
            let (d, e) = k.split_once(':')?;
            let (d, e): (u32, u32) = (d.parse().ok()?, e.parse().ok()?);
            if device.is_some_and(|x| x != d) {
                return None;
            }
            let mut lines = Vec::new();
            code_lines(code, 0, &mut lines);
            Some(json!({ "device": short_item(p, d), "event": e, "event_name": names.event(d, e), "lines": lines }))
        })
        .collect();
    json!({ "events": events })
}
