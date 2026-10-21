//! The project model, parsed from a `<currentstate>` document.
//!
//! That document is what Director's `Upload` returns and what a `.c4p` stores as
//! `project.xml`, so live systems, backups and predicted changes all share one shape
//! and can be diffed against each other.
//!
//! What a snapshot does *not* contain: driver definitions (connection names on the
//! provider side, property schemas, event names). Those come from the driver files or
//! from `GetBindingsByDevice`/`GetItems`, and are layered on via [`Names`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::xml::{child, child_text, child_u32, inner_xml};

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("project XML does not parse: {0}")]
    Xml(#[from] roxmltree::Error),
    #[error("not a project: expected <currentstate>, found <{0}>")]
    NotAProject(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Project,
    Site,
    Building,
    Floor,
    Room,
    Device,
    Proxy,
    Agent,
    Other(u32),
}

impl ItemKind {
    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::Project,
            2 => Self::Site,
            3 => Self::Building,
            4 => Self::Floor,
            8 => Self::Room,
            6 => Self::Device,
            7 => Self::Proxy,
            9 => Self::Agent,
            n => Self::Other(n),
        }
    }
    pub fn code(self) -> u32 {
        match self {
            Self::Project => 1,
            Self::Site => 2,
            Self::Building => 3,
            Self::Floor => 4,
            Self::Room => 8,
            Self::Device => 6,
            Self::Proxy => 7,
            Self::Agent => 9,
            Self::Other(n) => n,
        }
    }
    /// `label` for use in error messages that need a `&'static str`.
    pub fn label_static(self) -> &'static str {
        self.label()
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Site => "site",
            Self::Building => "building",
            Self::Floor => "floor",
            Self::Room => "room",
            Self::Device => "device",
            Self::Proxy => "proxy",
            Self::Agent => "agent",
            Self::Other(_) => "item",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: u32,
    pub name: String,
    pub kind: ItemKind,
    pub parent: Option<u32>,
    pub children: Vec<u32>,
    /// `config_data_file`: the .c4i/.c4z this item runs.
    pub driver: Option<String>,
    /// Driver properties persisted in `<state>` (DriverWorks `lua_gen_persisting`).
    pub properties: BTreeMap<String, String>,
}

/// One made connection. A snapshot stores these provider-first; only the consumer's
/// connection name is included.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Binding {
    pub consumer_device: u32,
    pub consumer_binding: u32,
    pub provider_device: u32,
    pub provider_binding: u32,
    pub consumer_name: String,
    pub classes: Vec<String>,
}

impl Binding {
    pub fn key(&self) -> (u32, u32, u32, u32) {
        (self.consumer_device, self.consumer_binding, self.provider_device, self.provider_binding)
    }
}

/// A device's network identity: how Director finds it (SDDP UUID, IP, Zigbee id).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkBinding {
    pub device: u32,
    pub binding: u32,
    /// 1 = IP/SDDP, 3 = Zigbee (others seen: 2).
    pub address_type: u32,
    pub address: String,
    pub uuid: String,
    pub search_type: String,
    /// Runtime status (`online`/`offline`). Not part of the configuration.
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variable {
    pub device: u32,
    pub id: u32,
    pub name: String,
    pub var_type: u32,
    pub readonly: bool,
    pub hidden: bool,
    pub description: String,
    pub value: String,
}

impl CodeItem {
    /// The device command this line sends and its static parameters (what `AddCode` takes),
    /// or `None` for a line that isn't a plain device command.
    pub fn command(&self) -> Option<(String, Vec<crate::ops::CodeParam>)> {
        let doc = roxmltree::Document::parse(&self.cmdcond).ok()?;
        let cmd = doc.descendants().find(|n| n.has_tag_name("devicecommand"))?;
        let name = child_text(cmd, "command")?.to_string();
        let params = cmd
            .descendants()
            .filter(|n| n.has_tag_name("param"))
            .map(|n| {
                let value = child(n, "value");
                crate::ops::CodeParam {
                    name: child_text(n, "name").unwrap_or_default().to_string(),
                    r#type: value.and_then(|v| v.attribute("type")).unwrap_or("STRING").to_string(),
                    value: value.and_then(|v| child_text(v, "static")).unwrap_or_default().to_string(),
                }
            })
            .collect();
        Some((name, params))
    }

    /// The line as Composer shows it: `NAME` replaced by the device it acts on, and Composer's
    /// `#!` templates (variable lines) expanded.
    pub fn text(&self, p: &Project) -> String {
        crate::program::render(&self.display, self.device, p)
    }
}

/// A line of programming: a command, conditional, loop… with nested children.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeItem {
    pub id: u32,
    pub kind: u32,
    pub device: u32,
    /// Composer's rendering of the line, e.g. "Set  Relay 1  Toggle on NAME".
    pub display: String,
    pub enabled: bool,
    /// Raw XML of the command or condition, kept verbatim so it can be sent back.
    pub cmdcond: String,
    pub children: Vec<CodeItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub root: Option<u32>,
    pub items: BTreeMap<u32, Item>,
    pub bindings: Vec<Binding>,
    pub network_bindings: Vec<NetworkBinding>,
    pub variables: Vec<Variable>,
    /// (device, event id) → the code under that event.
    pub programming: BTreeMap<String, Vec<CodeItem>>,
    /// Director's next-id counter (`iditemcurrent`).
    pub next_item_id: u32,
    /// Scheduler agent id → its scheduled events, from the agent's stored state. Each entry
    /// id is also an event id of the agent in `programming`.
    #[serde(default)]
    pub schedules: BTreeMap<u32, Vec<crate::agents::ScheduleEntry>>,
    /// Advanced Lighting, Announcements, Wake/Sleep and notification agents' stored data,
    /// by agent id.
    #[serde(default)]
    pub agent_data: BTreeMap<u32, crate::agents::AgentData>,
}

/// Programming is keyed `"device:event"` so the map serialises as a JSON object.
pub fn event_key(device: u32, event: u32) -> String {
    format!("{device}:{event}")
}

impl Project {
    pub fn parse(xml: &str) -> Result<Self, ModelError> {
        let doc = roxmltree::Document::parse_with_options(
            xml,
            roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
        )?;
        let root = doc.root_element();
        if !root.has_tag_name("currentstate") {
            return Err(ModelError::NotAProject(root.tag_name().name().into()));
        }
        let mut p = Project {
            next_item_id: child(root, "properties").and_then(|n| child_u32(n, "iditemcurrent")).unwrap_or(0),
            ..Default::default()
        };

        if let Some(items) = child(root, "systemitems") {
            for it in items.children().filter(|c| c.has_tag_name("item")) {
                p.add_item_tree(it, None);
            }
        }
        p.root = p.items.values().find(|i| i.parent.is_none()).map(|i| i.id);
        p.name = p.root.and_then(|r| p.items.get(&r)).map(|i| i.name.clone()).unwrap_or_default();

        if let Some(bs) = child(root, "bindings") {
            for bb in bs.children().filter(|c| c.has_tag_name("boundbinding")) {
                let (Some(pd), Some(pb)) = (child_u32(bb, "deviceid"), child_u32(bb, "bindingid")) else { continue };
                let Some(consumers) = child(bb, "boundconsumers") else { continue };
                for b in consumers.children().filter(|c| c.has_tag_name("bound")) {
                    let (Some(cd), Some(cb)) = (child_u32(b, "deviceid"), child_u32(b, "bindingid")) else { continue };
                    let classes = child(b, "boundclasses")
                        .map(|cl| cl.children().filter_map(|c| c.text()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
                        .unwrap_or_default();
                    p.bindings.push(Binding {
                        consumer_device: cd,
                        consumer_binding: cb,
                        provider_device: pd,
                        provider_binding: pb,
                        consumer_name: child_text(b, "name").unwrap_or_default().to_string(),
                        classes,
                    });
                }
            }
        }
        p.bindings.sort();

        if let Some(nbs) = child(root, "networkbindings") {
            for nb in nbs.children().filter(|c| c.has_tag_name("networkbinding")) {
                p.network_bindings.push(NetworkBinding {
                    device: child_u32(nb, "deviceid").unwrap_or(0),
                    binding: child_u32(nb, "networkbindingid").unwrap_or(0),
                    address_type: child_u32(nb, "addresstype").unwrap_or(0),
                    address: child_text(nb, "addr").unwrap_or_default().into(),
                    uuid: child_text(nb, "uuid").unwrap_or_default().into(),
                    search_type: child_text(nb, "ssdptype").unwrap_or_default().into(),
                    status: child_text(nb, "status").unwrap_or_default().into(),
                });
            }
        }

        if let Some(vs) = child(root, "variables") {
            for v in vs.children().filter(|c| c.has_tag_name("variable")) {
                let a = |n: &str| v.attribute(n).unwrap_or_default();
                p.variables.push(Variable {
                    device: a("deviceid").parse().unwrap_or(0),
                    id: a("variableid").parse().unwrap_or(0),
                    name: a("name").into(),
                    var_type: a("type").parse().unwrap_or(0),
                    readonly: a("readonly") == "1",
                    hidden: a("hidden") == "1",
                    description: a("description").into(),
                    value: v.text().unwrap_or_default().into(),
                });
            }
        }

        if let Some(em) = child(root, "event_mgr") {
            for ev in em.children().filter(|c| c.has_tag_name("event")) {
                let (Some(d), Some(e)) = (child_u32(ev, "deviceid"), child_u32(ev, "eventid")) else { continue };
                let mut code = Vec::new();
                for ci in ev.children().filter(|c| c.has_tag_name("codeitem")) {
                    let item = parse_code_item(ci, xml);
                    // Each event holds one root container (id 0); its children are the program.
                    if item.id == 0 {
                        code.extend(item.children);
                    } else {
                        code.push(item);
                    }
                }
                p.programming.insert(event_key(d, e), code);
            }
        }
        Ok(p)
    }

    fn add_item_tree(&mut self, node: roxmltree::Node<'_, '_>, parent: Option<u32>) {
        let Some(id) = child_u32(node, "id") else { return };
        let driver = child(node, "itemdata")
            .and_then(|d| child_text(d, "config_data_file"))
            .or_else(|| child_text(node, "c4i"))
            .filter(|s| !s.is_empty())
            .map(String::from);
        let item = Item {
            id,
            name: child_text(node, "name").unwrap_or_default().to_string(),
            kind: ItemKind::from_code(child_u32(node, "type").unwrap_or(0)),
            parent,
            children: Vec::new(),
            driver,
            properties: child_text(node, "state").map(parse_persisted_properties).unwrap_or_default(),
        };
        self.items.insert(id, item);
        if let Some(entries) = crate::agents::schedule_from_item(node) {
            self.schedules.insert(id, entries);
        }
        if let Some(data) = crate::agents::data_from_item(node) {
            self.agent_data.insert(id, data);
        }
        if let Some(p) = parent.and_then(|p| self.items.get_mut(&p)) {
            p.children.push(id);
        }
        if let Some(subs) = child(node, "subitems") {
            for s in subs.children().filter(|c| c.has_tag_name("item")) {
                self.add_item_tree(s, Some(id));
            }
        }
    }

    pub fn item(&self, id: u32) -> Option<&Item> {
        self.items.get(&id)
    }

    /// The name people know an item by. A device with a single proxy is named on its proxy:
    /// the device keeps the driver's own name ("Philips Hue Light (OS 3.3.0+)") and the proxy
    /// holds the one the dealer gave it ("Left Lamp"), which is what Composer shows.
    pub fn name_of(&self, id: u32) -> String {
        match self.items.get(&id) {
            Some(i) => self.sole_proxy(id).unwrap_or(i).name.clone(),
            None => format!("#{id}"),
        }
    }

    /// A device's only proxy, when it has exactly one. Renaming such a device means renaming
    /// this, and the tree folds it into the device.
    pub fn sole_proxy(&self, id: u32) -> Option<&Item> {
        let it = self.items.get(&id)?;
        if it.kind != ItemKind::Device {
            return None;
        }
        let mut proxies = it.children.iter().filter_map(|c| self.items.get(c)).filter(|c| c.kind == ItemKind::Proxy);
        match (proxies.next(), proxies.next()) {
            (Some(p), None) => Some(p),
            _ => None,
        }
    }

    /// Ancestors from the top (excluding the project root), e.g. `["Home", "House", "Main", "Living"]`.
    pub fn ancestors(&self, id: u32) -> Vec<&Item> {
        let mut out = Vec::new();
        let mut cur = self.items.get(&id).and_then(|i| i.parent);
        while let Some(pid) = cur {
            let Some(p) = self.items.get(&pid) else { break };
            if p.kind != ItemKind::Project {
                out.push(p);
            }
            cur = p.parent;
        }
        out.reverse();
        out
    }

    /// "House › Main › Living › Denon AVR-X2100W"
    pub fn path(&self, id: u32) -> String {
        let mut parts: Vec<String> = self.ancestors(id).iter().map(|i| i.name.clone()).collect();
        parts.push(self.name_of(id));
        parts.join(" › ")
    }

    /// The room an item lives in, if any.
    pub fn room_of(&self, id: u32) -> Option<&Item> {
        if self.items.get(&id)?.kind == ItemKind::Room {
            return self.items.get(&id);
        }
        self.ancestors(id).into_iter().rev().find(|i| i.kind == ItemKind::Room)
    }

    /// The item and everything under it.
    pub fn subtree(&self, id: u32) -> Vec<u32> {
        let mut out = vec![id];
        let mut i = 0;
        while i < out.len() {
            if let Some(it) = self.items.get(&out[i]) {
                out.extend(it.children.iter().copied());
            }
            i += 1;
        }
        out
    }

    pub fn bindings_of(&self, device: u32) -> impl Iterator<Item = &Binding> {
        self.bindings.iter().filter(move |b| b.consumer_device == device || b.provider_device == device)
    }

    pub fn drivers(&self) -> Vec<String> {
        let mut d: Vec<String> = self.items.values().filter_map(|i| i.driver.clone()).collect();
        d.sort();
        d.dedup();
        d
    }
}

fn parse_code_item(node: roxmltree::Node<'_, '_>, src: &str) -> CodeItem {
    CodeItem {
        id: child_u32(node, "id").unwrap_or(0),
        kind: child_u32(node, "type").unwrap_or(0),
        device: child_u32(node, "device").unwrap_or(0),
        display: child_text(node, "display").unwrap_or_default().to_string(),
        enabled: child_text(node, "enabled").map(|e| e != "0" && !e.eq_ignore_ascii_case("false")).unwrap_or(true),
        cmdcond: child(node, "cmdcond").map(|c| inner_xml(c, src).to_string()).unwrap_or_default(),
        children: child(node, "subitems")
            .map(|s| s.children().filter(|c| c.has_tag_name("codeitem")).map(|c| parse_code_item(c, src)).collect())
            .unwrap_or_default(),
    }
}

/// `<lua_gen_persisting><properties><property><name>…</name><value>…</value>…`
fn parse_persisted_properties(state: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(doc) = roxmltree::Document::parse(state) else { return out };
    for p in doc.descendants().filter(|n| n.has_tag_name("property")) {
        // Only direct <properties><property> entries; nested ones belong to other blobs.
        if !p.parent().is_some_and(|pp| pp.has_tag_name("properties")) {
            continue;
        }
        if let Some(name) = child_text(p, "name") {
            out.insert(name.to_string(), child_text(p, "value").unwrap_or_default().to_string());
        }
    }
    out
}

/// Properties whose values must never be shown or handed to a model: drivers store
/// credentials as ordinary properties (a WattBox keeps its password in "Password").
pub fn is_sensitive_property(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["password", "passcode", "passphrase", "secret", "token", "api key", "apikey", "pin code", "private key"]
        .iter()
        .any(|k| n.contains(k))
}

pub const REDACTED: &str = "••••••";

impl Project {
    /// A copy safe to show or send to an assistant: sensitive property values masked.
    pub fn redacted(&self) -> Project {
        let mut p = self.clone();
        for it in p.items.values_mut() {
            for (k, v) in it.properties.iter_mut() {
                if is_sensitive_property(k) && !v.is_empty() {
                    *v = REDACTED.to_string();
                }
            }
        }
        p
    }
}

/// Human names that a snapshot lacks, gathered from live `GetBindingsByDevice` calls or
/// driver files: provider-side connection names and event names.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Names {
    /// "device:binding" → connection name
    pub connections: BTreeMap<String, String>,
    /// "device:event" → event name
    pub events: BTreeMap<String, String>,
}

impl Names {
    pub fn connection(&self, device: u32, binding: u32) -> Option<&str> {
        self.connections.get(&format!("{device}:{binding}")).map(String::as_str)
    }
    pub fn event(&self, device: u32, event: u32) -> Option<&str> {
        self.events.get(&event_key(device, event)).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SAMPLE: &str = include_str!("../tests/fixtures/sample-project.xml");

    #[test]
    fn parses_hierarchy_bindings_and_programming() {
        let p = Project::parse(SAMPLE).unwrap();
        assert_eq!(p.name, "Sample House");
        let tv = p.items.values().find(|i| i.name == "Living TV").unwrap();
        assert_eq!(tv.kind, ItemKind::Device);
        // Named, like Composer does, by its only proxy.
        assert_eq!(p.sole_proxy(tv.id).map(|x| x.id), Some(22));
        assert_eq!(p.path(tv.id), "Home › House › Main › Living › TV");
        assert_eq!(p.room_of(tv.id).unwrap().name, "Living");
        assert_eq!(tv.properties.get("IP Address").map(String::as_str), Some("192.168.1.50"));
        assert!(p.bindings.iter().any(|b| b.consumer_device == tv.id && b.classes == ["HDMI"]));
        assert_eq!(p.network_bindings.len(), 1);
        let code = &p.programming[&event_key(20, 1)];
        assert_eq!(code[0].display, "Turn on Living TV");
        assert_eq!(code[0].command().map(|(c, _)| c), Some("ON".into()));
        assert_eq!(code[0].children.len(), 1);
    }
}
