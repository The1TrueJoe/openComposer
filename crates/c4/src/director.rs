//! A connected Director, with the reads and writes Composer performs.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::dialect::Dialect;
use crate::model::{ModelError, Names, Project, event_key};
use crate::ops::{Op, OpError};
use crate::soap::{Call, Connection, Identity, SoapError, TLS_PORT};
use crate::xml::{child, child_text, child_u32, inner_xml, to_json};

#[derive(Debug, thiserror::Error)]
pub enum DirectorError {
    #[error(transparent)]
    Soap(#[from] SoapError),
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error(transparent)]
    Op(#[from] OpError),
    #[error("{0}")]
    Other(String),
}

pub type Result<T, E = DirectorError> = std::result::Result<T, E>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DirectorInfo {
    pub host: String,
    pub name: String,
    pub uuid: String,
    /// The controller's own device id (30 on a typical EA-1); Zigbee queries go to it.
    pub device_id: u32,
    pub version: String,
    pub verified_version: bool,
    pub server_fingerprint: String,
}

/// A project as of one moment, with the XML it came from (kept for backups).
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub project: Project,
    pub xml: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConnectionDef {
    pub id: u32,
    pub name: String,
    pub consumer: bool,
    pub conn_type: u32,
    pub classes: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PropertyDef {
    pub name: String,
    pub prop_type: String,
    pub default: Option<String>,
    pub readonly: bool,
    pub items: Vec<String>,
    pub minimum: Option<String>,
    pub maximum: Option<String>,
}

/// A command programming can send to a device (Composer's "Device Specific Commands").
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CommandDef {
    pub name: String,
    /// Composer's line template; `NAME` stands for the device.
    pub description: String,
    pub params: Vec<PropertyDef>,
}

/// What a device's driver declares, from the `devicedata` in `GetItems`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: u32,
    pub manufacturer: String,
    pub model: String,
    pub driver_name: String,
    pub version: String,
    pub search_type: String,
    pub control_method: String,
    pub proxies: Vec<String>,
    pub connections: Vec<ConnectionDef>,
    pub events: BTreeMap<u32, String>,
    pub properties: Vec<PropertyDef>,
    pub actions: Vec<(String, String)>,
    pub commands: Vec<CommandDef>,
    /// `<small image_source="c4z">icons/device_sm.png</small>`: where the driver's own icon
    /// lives inside its package (`www/<path>`). `None` for drivers using Composer's images.
    pub icon: Option<String>,
    /// Web tabs the driver declares (`<tabs><tab name file/>`): pages in its www folder.
    pub tabs: Vec<DriverTab>,
    /// `<capabilities>` as declared, e.g. `supports_color` = `True`, `dimmer` = `True`.
    pub capabilities: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DriverTab {
    pub name: String,
    /// Path inside the package's www folder, e.g. `html/index.html`.
    pub file: String,
}

/// Driver definitions for every item, keyed by item id.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Catalog {
    pub devices: BTreeMap<u32, DeviceInfo>,
    /// A room's `<item>` data, reused when creating rooms (Director wants the room
    /// driver's full definition in `AddItem`).
    #[serde(skip)]
    pub room_template: Option<String>,
    /// The same for sites (2), buildings (3) and floors (4): their `<itemdata>` only.
    #[serde(skip)]
    pub location_templates: BTreeMap<u32, String>,
}

/// `template` with its `<itemdata><tag>` replaced by (or given) a new one, in the form
/// Composer uses: a v4 UUID with underscores, e.g. `18132870_8761_424b_9559_cb6bc5f2b305`.
fn with_fresh_tag(template: &str) -> String {
    use rand_core::{OsRng, RngCore};
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let tag = format!("<tag>{}_{}_{}_{}_{}</tag>", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]);
    match (template.find("<tag>"), template.find("</tag>")) {
        (Some(a), Some(z)) if a < z => format!("{}{tag}{}", &template[..a], &template[z + "</tag>".len()..]),
        _ => template.replacen("</itemdata>", &format!("{tag}</itemdata>"), 1).replacen("<itemdata />", &format!("<itemdata>{tag}</itemdata>"), 1),
    }
}

impl Catalog {
    /// The definition Director wants in `AddItem` for a new location, copied from one that exists.
    pub fn template_for(&self, op: &Op) -> Option<&str> {
        match op {
            Op::AddRoom { .. } => self.room_template.as_deref(),
            Op::AddLocation { kind, .. } => self.location_templates.get(&kind.item_kind().code()).map(String::as_str),
            _ => None,
        }
    }

    /// Agents declare no events; the Scheduler's are its entries (Composer's plugin reports
    /// them the same way), so programming can name and check them. They come from a
    /// snapshot, which has them current.
    pub fn set_schedule_events(&mut self, p: &Project) {
        for (agent, entries) in &p.schedules {
            let info = self.devices.entry(*agent).or_insert_with(|| DeviceInfo { id: *agent, ..Default::default() });
            info.events = entries.iter().map(|e| (e.id, e.spec.name.clone())).collect();
        }
    }

    /// Whether [`Self::set_schedule_events`] would change nothing.
    pub fn has_schedule_events(&self, p: &Project) -> bool {
        p.schedules.iter().all(|(agent, entries)| {
            self.devices.get(agent).is_some_and(|d| {
                d.events.len() == entries.len() && entries.iter().all(|e| d.events.get(&e.id) == Some(&e.spec.name))
            })
        })
    }

    pub fn names(&self) -> Names {
        let mut n = Names::default();
        for (id, d) in &self.devices {
            for c in &d.connections {
                n.connections.insert(format!("{id}:{}", c.id), c.name.clone());
            }
            for (e, name) in &d.events {
                n.events.insert(event_key(*id, *e), name.clone());
            }
        }
        n
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhysicalDevice {
    pub uuid: String,
    pub address: String,
    pub address_type: u32,
    pub device_type: String,
}

/// What a write produced: ids Director assigned, and any text it returned.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Applied {
    pub created: Vec<u32>,
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ZigbeeQuery {
    Server,
    Mesh,
    Nodes,
    Zaps,
}

impl ZigbeeQuery {
    fn call_and_event(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Server => ("GetZigbeeZserverInfo", "OnZigbeeZserverChanged", "zserver"),
            Self::Mesh => ("GetZigbeeMeshInfo", "OnZigbeeMeshChanged", "mesh"),
            Self::Nodes => ("GetAllZigbeeNodes", "OnZigbeeNodesChanged", "znodes"),
            Self::Zaps => ("GetZigbeeZaps", "OnZigbeeZapsChanged", "zaps"),
        }
    }
}

#[derive(Clone)]
pub struct Director {
    pub conn: Connection,
    pub dialect: Dialect,
    pub info: DirectorInfo,
}

impl Director {
    pub async fn connect(host: &str, identity: &Identity, pin: Option<&str>) -> Result<Self> {
        let conn = Connection::connect(host, TLS_PORT, identity, pin).await?;
        let ver = conn.call(Call::new("GetVersionInfo")).await?;
        let dialect = Dialect::from_version_info(&ver.raw)
            .ok_or_else(|| DirectorError::Other("GetVersionInfo did not include a Director version".into()))?;
        let di = conn.call(Call::new("GetDirectorInfo")).await?;
        let doc = di.doc()?;
        let info_node = doc.descendants().find(|n| n.has_tag_name("directorinfo"));
        let get = |t: &str| info_node.and_then(|n| child_text(n, t)).unwrap_or_default().to_string();
        let info = DirectorInfo {
            host: host.to_string(),
            name: get("name"),
            uuid: get("uuid"),
            device_id: get("devId").parse().unwrap_or(0),
            version: dialect.version.to_string(),
            verified_version: dialect.verified,
            server_fingerprint: conn.server_fingerprint.clone(),
        };
        conn.enable_events().await?;
        Ok(Self { conn, dialect, info })
    }

    /// The whole project, as a backup would capture it.
    pub async fn snapshot(&self) -> Result<Snapshot> {
        let r = self
            .conn
            .call(Call::new("Upload").num("flags", self.dialect.upload_flags).timeout(Duration::from_secs(180)))
            .await?;
        let xml = r.body().to_string();
        Ok(Snapshot { project: Project::parse(&xml)?, xml })
    }

    /// Driver definitions for every item (connection names, events, property schemas).
    pub async fn catalog(&self) -> Result<Catalog> {
        let r = self.conn.call(Call::new("GetItems").timeout(Duration::from_secs(180))).await?;
        let doc = r.doc()?;
        let mut cat = Catalog::default();
        for item in doc.descendants().filter(|n| n.has_tag_name("item")) {
            if let Some(kind @ (2 | 3 | 4)) = child_u32(item, "type") {
                if !cat.location_templates.contains_key(&kind) {
                    // A fresh tag: Composer gives every location its own.
                    let itemdata: String = child(item, "itemdata")
                        .map(|n| {
                            n.children()
                                .filter(|c| c.is_element() && !c.has_tag_name("tag"))
                                .map(|c| r.raw[c.range()].to_string())
                                .collect()
                        })
                        .unwrap_or_default();
                    cat.location_templates.insert(kind, format!("<item><itemdata>{itemdata}</itemdata></item>"));
                }
            }
            let (Some(id), Some(dd)) = (child_u32(item, "id"), child(item, "devicedata")) else { continue };
            let t = |n: &str| child_text(dd, n).unwrap_or_default().to_string();
            let mut info = DeviceInfo {
                id,
                manufacturer: t("manufacturer"),
                model: t("model"),
                driver_name: t("name"),
                version: t("version"),
                search_type: t("search_type"),
                control_method: t("controlmethod"),
                ..Default::default()
            };
            if let Some(px) = child(dd, "proxies") {
                info.proxies = px.children().filter_map(|c| c.text()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            }
            if let Some(cs) = child(dd, "connections") {
                for c in cs.children().filter(|c| c.has_tag_name("connection")) {
                    info.connections.push(ConnectionDef {
                        id: child_u32(c, "id").unwrap_or(0),
                        name: child_text(c, "connectionname").unwrap_or_default().into(),
                        consumer: child_text(c, "consumer").is_some_and(|v| v.eq_ignore_ascii_case("true")),
                        conn_type: child_u32(c, "type").unwrap_or(0),
                        classes: c
                            .descendants()
                            .filter(|n| n.has_tag_name("classname"))
                            .filter_map(|n| n.text())
                            .map(|s| s.trim().to_string())
                            .collect(),
                    });
                }
            }
            if let Some(evs) = child(dd, "events") {
                for e in evs.children().filter(|c| c.has_tag_name("event")) {
                    if let Some(eid) = child_u32(e, "id") {
                        info.events.insert(eid, child_text(e, "name").unwrap_or_default().into());
                    }
                }
            }
            if let Some(props) = child(dd, "config").and_then(|c| child(c, "properties")) {
                for pr in props.children().filter(|c| c.has_tag_name("property")) {
                    info.properties.push(PropertyDef {
                        name: child_text(pr, "name").unwrap_or_default().into(),
                        prop_type: child_text(pr, "type").unwrap_or_default().into(),
                        default: child_text(pr, "default").map(String::from),
                        readonly: child_text(pr, "readonly").is_some_and(|v| v.eq_ignore_ascii_case("true")),
                        items: child(pr, "items")
                            .map(|i| i.children().filter_map(|c| c.text()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                            .unwrap_or_default(),
                        minimum: child_text(pr, "minimum").map(String::from),
                        maximum: child_text(pr, "maximum").map(String::from),
                    });
                }
            }
            if let Some(acts) = child(dd, "config").and_then(|c| child(c, "actions")) {
                for a in acts.children().filter(|c| c.has_tag_name("action")) {
                    info.actions.push((
                        child_text(a, "name").unwrap_or_default().into(),
                        child_text(a, "command").unwrap_or_default().into(),
                    ));
                }
            }
            info.icon = child(dd, "small")
                .filter(|n| n.attribute("image_source") == Some("c4z"))
                .and_then(|n| n.text())
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            if let Some(caps) = child(dd, "capabilities") {
                info.capabilities = caps
                    .children()
                    .filter(|c| c.is_element())
                    .map(|c| (c.tag_name().name().to_string(), c.text().unwrap_or_default().trim().to_string()))
                    .collect();
            }
            info.tabs = dd
                .descendants()
                .filter(|n| n.has_tag_name("tab"))
                .filter_map(|t| Some(DriverTab { name: t.attribute("name")?.to_string(), file: t.attribute("file")?.to_string() }))
                .collect();
            if let Some(cmds) = child(dd, "commands") {
                for c in cmds.children().filter(|c| c.has_tag_name("command")) {
                    info.commands.push(CommandDef {
                        name: child_text(c, "name").unwrap_or_default().into(),
                        description: child_text(c, "description").unwrap_or_default().into(),
                        params: child(c, "params")
                            .map(|ps| {
                                ps.children()
                                    .filter(|p| p.has_tag_name("param"))
                                    .map(|p| PropertyDef {
                                        name: child_text(p, "name").unwrap_or_default().into(),
                                        prop_type: child_text(p, "type").unwrap_or_default().into(),
                                        items: child(p, "items")
                                            .map(|i| i.children().filter_map(|c| c.text()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                                            .unwrap_or_default(),
                                        minimum: child_text(p, "minimum").map(String::from),
                                        maximum: child_text(p, "maximum").map(String::from),
                                        ..Default::default()
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    });
                }
            }
            if cat.room_template.is_none() && child_u32(item, "type") == Some(8) {
                let itemdata = child(item, "itemdata").map(|n| inner_xml(n, &r.raw)).unwrap_or_default();
                cat.room_template = Some(format!(
                    "<item><itemdata>{itemdata}</itemdata><devicedata>{}</devicedata></item>",
                    inner_xml(dd, &r.raw)
                ));
            }
            cat.devices.insert(id, info);
        }
        Ok(cat)
    }

    /// Devices Director has discovered on the network (SDDP and friends), bound or not.
    pub async fn physical_devices(&self) -> Result<Vec<PhysicalDevice>> {
        let r = self.conn.call(Call::new("GetPhysicalDevices")).await?;
        let doc = r.doc()?;
        Ok(doc
            .descendants()
            .filter(|n| n.has_tag_name("physicaldevice"))
            .map(|n| PhysicalDevice {
                uuid: n.attribute("uuid").unwrap_or_default().into(),
                address: n.attribute("address").unwrap_or_default().into(),
                address_type: n.attribute("addresstype").and_then(|a| a.parse().ok()).unwrap_or(0),
                device_type: n.attribute("devicetype").unwrap_or_default().into(),
            })
            .collect())
    }

    /// Zigbee data arrives as an event after an async request, as Composer does it.
    pub async fn zigbee(&self, q: ZigbeeQuery) -> Result<serde_json::Value> {
        let (method, event, param) = q.call_and_event();
        let call = Call::new(method).num("iddevice", self.info.device_id);
        let ev = self.conn.request_event(&call, event, Duration::from_secs(10)).await?;
        let inner = ev.param(param).unwrap_or_default();
        Ok(match roxmltree::Document::parse(&inner) {
            Ok(d) => to_json(d.root_element()),
            Err(_) => serde_json::Value::String(inner),
        })
    }

    /// Any read-only call, returned as JSON. The escape hatch for tools.
    pub async fn read(&self, method: &str, params: &[(String, serde_json::Value)]) -> Result<serde_json::Value> {
        const ALLOWED: &[&str] = &["Get", "Is"];
        if !ALLOWED.iter().any(|p| method.starts_with(p)) {
            return Err(DirectorError::Other(format!("{method} is not a read (only Get*/Is* calls are allowed here)")));
        }
        let mut call = Call::new(method);
        for (k, v) in params {
            call = match v {
                serde_json::Value::Number(n) => call.num(k, n.as_i64().unwrap_or(0)),
                serde_json::Value::Bool(b) => call.bool(k, *b),
                other => call.str(k, other.as_str().map(String::from).unwrap_or_else(|| other.to_string())),
            };
        }
        let r = self.conn.call(call).await?;
        let doc = r.doc()?;
        Ok(to_json(doc.root_element()))
    }

    /// Ask an agent for its data the way Composer's agent editors do (`SendToDevice` with a
    /// `GET_…` devicecommand, answered synchronously); returns the reply's XML. Only reads
    /// are sent: anything else is a change and goes through an [`Op`].
    pub async fn agent_read(&self, agent: u32, command: &str, params: &[(&str, &str, &str)]) -> Result<String> {
        if !crate::agents::is_read_command(command) {
            return Err(DirectorError::Other(format!("{command} is not a read (only GET_*/IS_* agent commands are sent here)")));
        }
        let data = crate::agents::device_command(command, params);
        let r = self.conn.call(Call::new("SendToDevice").num("iddevice", agent).xml("data", data)).await?;
        Ok(r.body().to_string())
    }

    /// Perform one op. Callers are responsible for approval; this only executes.
    /// `template` is `Catalog::template_for(op)`: the item definition a new location copies.
    pub async fn apply(&self, op: &Op, room_template: Option<&str>) -> Result<Applied> {
        if matches!(op, Op::AddRoom { .. }) && room_template.is_none() {
            return Err(DirectorError::Other(
                "adding a room needs an existing room to copy its definition from".into(),
            ));
        }
        if let (Op::AddLocation { kind, .. }, None) = (op, room_template) {
            return Err(DirectorError::Other(format!(
                "adding a {} needs an existing one in the project to copy its definition from",
                kind.item_kind().label()
            )));
        }
        // Every location has its own tag; one copied from the template would be shared.
        let fresh = room_template.map(with_fresh_tag);
        let mut applied = Applied::default();
        for call in op.calls(fresh.as_deref()) {
            let r = self.conn.call(call).await?;
            let doc = r.doc()?;
            for n in doc.descendants() {
                if n.has_tag_name("protocol") || n.has_tag_name("proxy") {
                    if let Some(id) = n.text().and_then(|t| t.trim().parse().ok()) {
                        applied.created.push(id);
                    }
                }
            }
            // AddItem answers with the bare new id.
            if r.method == "AddItem" {
                if let Ok(id) = r.body().trim().parse() {
                    applied.created.push(id);
                }
            }
        }
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::with_fresh_tag;

    #[test]
    fn fresh_tags() {
        let room = "<item><itemdata><small_image>x</small_image><tag>old</tag></itemdata></item>";
        let a = with_fresh_tag(room);
        assert!(!a.contains("<tag>old</tag>") && a.contains("<small_image>x</small_image><tag>"));
        assert_ne!(a, with_fresh_tag(room));
        let b = with_fresh_tag("<item><itemdata><small_image>x</small_image></itemdata></item>");
        let tag = &b[b.find("<tag>").unwrap() + 5..b.find("</tag>").unwrap()];
        assert_eq!(tag.split('_').map(str::len).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
    }
}
