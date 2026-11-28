//! A connected Director, with the reads and writes Composer performs.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::dialect::Dialect;
use crate::model::{ModelError, Names, Project, event_key};
use crate::soap::{Call, Connection, Identity, SoapError, TLS_PORT};
use crate::xml::{child, child_text, child_u32, inner_xml, to_json};

#[derive(Debug, thiserror::Error)]
pub enum DirectorError {
    #[error(transparent)]
    Soap(#[from] SoapError),
    #[error(transparent)]
    Model(#[from] ModelError),
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
    /// Built-in agents' stored state, parsed from the same `xml`. Kept beside `project` so the
    /// model carries no agent types; predict/diff/approval take it alongside the project.
    pub agents: crate::agents::AgentState,
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

/// A test programming can make on a device (Composer's Conditionals and Loops tabs). DriverWorks
/// drivers declare a `type`; Control4's built-in proxies (light_v2's LOAD_ON) leave it out,
/// and some name theirs by number only. Shaped for use by [`crate::program::shape`].
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ConditionalDef {
    pub id: Option<u32>,
    pub name: String,
    /// SIMPLE, BOOL, NUMBER, STRING, LIST, ROOM, DEVICE (upper-cased); empty when undeclared.
    pub kind: String,
    /// Composer's line template: `NAME` for the device, `LOGIC` for the comparison.
    pub description: String,
    pub statement: String,
    pub true_text: Option<String>,
    pub false_text: Option<String>,
    pub items: Vec<String>,
    pub minimum: Option<String>,
    pub maximum: Option<String>,
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
    /// `<conditionals>`: what an If or While can test on it.
    #[serde(default)]
    pub conditionals: Vec<ConditionalDef>,
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

impl Catalog {
    /// Agents declare no events; the Scheduler's are its entries, Advanced Lighting's and
    /// Announcements' come from their scenes and announcements, so programming
    /// can name and check them. They come from a
    /// snapshot, which has them current.
    pub fn set_schedule_events(&mut self, agents: &crate::agents::AgentState) {
        for (agent, events) in agent_events(agents) {
            let info = self.devices.entry(agent).or_insert_with(|| DeviceInfo { id: agent, ..Default::default() });
            info.events = events.into_iter().collect();
        }
    }

    /// Whether [`Self::set_schedule_events`] would change nothing.
    pub fn has_schedule_events(&self, agents: &crate::agents::AgentState) -> bool {
        agent_events(agents).into_iter().all(|(agent, events)| {
            self.devices.get(&agent).is_some_and(|d| d.events.len() == events.len() && events.iter().all(|(id, n)| d.events.get(id) == Some(n)))
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

fn conditional_def(c: roxmltree::Node<'_, '_>) -> ConditionalDef {
    let t = |n: &str| child_text(c, n).map(String::from);
    let mut items: Vec<String> = child(c, "items")
        .map(|i| i.children().filter_map(|x| x.text()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    // Dynamic conditionals (GetConditionals) give their list as one comma-separated string.
    if let Some(list) = child_text(c, "list_items") {
        items.extend(list.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    }
    ConditionalDef {
        id: child_u32(c, "id"),
        name: t("name").unwrap_or_default(),
        kind: t("type").unwrap_or_default().to_uppercase(),
        description: t("description").unwrap_or_default(),
        statement: t("condition_statement").unwrap_or_default(),
        true_text: t("true_text"),
        false_text: t("false_text"),
        items,
        minimum: t("minimum"),
        maximum: t("maximum"),
    }
}

/// Built-in agents' events as the project has them now: (agent, [(event id, name)]).
fn agent_events(agents: &crate::agents::AgentState) -> Vec<(u32, Vec<(u32, String)>)> {
    let mut out: Vec<(u32, Vec<(u32, String)>)> =
        agents.schedules.iter().map(|(agent, entries)| (*agent, entries.iter().map(|e| (e.id, e.spec.name.clone())).collect())).collect();
    out.extend(agents.agent_data.iter().map(|(agent, d)| (*agent, d.events())).filter(|(_, e)| !e.is_empty()));
    out
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
    /// Drivers' `LUA_OUTPUT` lines, filled from the event stream for as long as this connection lives.
    pub lua: crate::lua_output::LuaLog,
}

impl Director {
    pub async fn connect(host: &str, identity: &Identity, pin: Option<&str>) -> Result<Self> {
        let (name, port) = crate::soap::split_addr(host, TLS_PORT);
        let conn = Connection::connect(&name, port, identity, pin).await?;
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
        let lua = crate::lua_output::LuaLog::default();
        // Subscribe before EnableEvents so no line is missed; ends when the connection closes.
        let mut rx = conn.events();
        let sink = lua.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(e) if e.name == "OnDataToUI" => {
                        if let Some((device, time, text)) = crate::lua_output::parse_lua_output(&e.raw) {
                            sink.push(device, time, text);
                        }
                    }
                    Ok(e) if e.name == "Disconnected" => break,
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        conn.enable_events().await?;
        Ok(Self { conn, dialect, info, lua })
    }

    /// Lines a driver printed: what is buffered, then whatever arrives within `wait`.
    /// Returns `(line, arrived_during_wait)`.
    pub async fn lua_output(&self, device: u32, wait: Duration, contains: Option<&str>) -> Vec<(crate::lua_output::LuaLine, bool)> {
        let mark = self.lua.mark();
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        self.lua.lines(device, contains).into_iter().map(|l| { let new = l.seq > mark; (l, new) }).collect()
    }

    /// The whole project, as a backup would capture it.
    pub async fn snapshot(&self) -> Result<Snapshot> {
        let r = self
            .conn
            .call(Call::new("Upload").num("flags", self.dialect.upload_flags).timeout(Duration::from_secs(180)))
            .await?;
        let xml = r.body().to_string();
        let agents = crate::agents::AgentState::parse(&xml);
        Ok(Snapshot { project: Project::parse(&xml)?, agents, xml })
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
            if let Some(cs) = child(dd, "conditionals") {
                info.conditionals = cs.children().filter(|c| c.has_tag_name("conditional")).map(conditional_def).collect();
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

    /// Read a device/room/proxy with a `GET_*`/`IS_*` device command and return the reply as
    /// JSON — what Composer does to browse a room's audio media (`GET_AUDIO_MEDIA`) or read a
    /// device's current settings. Only reads are sent (same gate as [`Self::agent_read`]); a
    /// command that changes something is a write and goes through an [`Op`]/approval instead.
    pub async fn device_read(&self, device: u32, command: &str, params: &[(&str, &str, &str)]) -> Result<serde_json::Value> {
        let body = self.agent_read(device, command, params).await?;
        Ok(match roxmltree::Document::parse(&body) {
            Ok(d) => to_json(d.root_element()),
            Err(_) => serde_json::Value::String(body),
        })
    }

    /// Send a prepared sequence of calls and collect what Director created. Generic: turning an
    /// [`Op`](crate::ops::Op) into calls, and any op-specific checks, live with `Op` (see
    /// `Op::apply`); this is the raw send + reply interpretation. Callers are responsible for
    /// approval; this only executes.
    pub async fn send_calls(&self, calls: Vec<Call>) -> Result<Applied> {
        let mut applied = Applied::default();
        for call in calls {
            let r = self.conn.call(call).await?;
            // Agents answer a change they refuse with `<failure>why</failure>` rather than an error.
            if r.method == "SendToDevice" {
                if let Some(why) = crate::agents::reply_failure(r.body()) {
                    return Err(DirectorError::Other(format!("the agent refused it: {why}")));
                }
            }
            let doc = r.doc()?;
            for n in doc.descendants() {
                if n.has_tag_name("protocol") || n.has_tag_name("proxy") {
                    if let Some(id) = n.text().and_then(|t| t.trim().parse().ok()) {
                        applied.created.push(id);
                    }
                }
            }
            // Director answers an AddCodeItem it won't take (an Else that follows no If, say)
            // with success and no id, and stores nothing.
            if r.method == "AddCodeItem" && r.body().trim().parse::<u32>().is_err() {
                return Err(DirectorError::Other(
                    "Director didn't add the programming line (it gave no id back); check where it was meant to go".into(),
                ));
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

