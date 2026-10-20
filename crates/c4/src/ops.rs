//! Changes to a project, as values.
//!
//! An [`Op`] can be applied to an in-memory [`Project`] to predict its effect (that is
//! what the approval card diffs), and turned into the c4soap calls Composer would send.
//! Prediction also validates: an op that can't apply cleanly to the current snapshot
//! is refused before anyone is asked to approve it.
//!
//! Call formats come from Composer Pro 3.3's own debug logs.

use serde::{Deserialize, Serialize};

use crate::model::{Binding, Item, ItemKind, NetworkBinding, Project};
use crate::soap::Call;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Add a driver to a room. The driver file must already be on the controller.
    AddDevice { room: u32, name: String, driver: String },
    AddRoom { floor: u32, name: String },
    RemoveItem { id: u32 },
    RenameItem { id: u32, name: String },
    MoveItem { id: u32, parent: u32, before: Option<u32> },
    AddConnection {
        consumer_device: u32,
        consumer_binding: u32,
        provider_device: u32,
        provider_binding: u32,
        class: String,
        /// Shown in previews; Director fills in the real name.
        #[serde(default)]
        consumer_name: String,
    },
    RemoveConnection { consumer_device: u32, consumer_binding: u32, class: String },
    /// Identify a device on the network (what Composer's "Identify" does for SDDP).
    /// `device: 0` means the device added earlier in the same batch.
    AddNetworkBinding { device: u32, binding: u32, address_type: u32, address: String, search_type: String },
    RemoveNetworkBinding { device: u32, binding: u32 },
    /// Set a driver property (what typing into Composer's property grid does).
    SetProperty { device: u32, name: String, value: String },
    /// Add a programming line that sends `command` to `target` when `device`'s `event`
    /// fires. `parent` 0 = top level; `before` 0 = at the end.
    AddCode {
        device: u32,
        event: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
        target: u32,
        command: String,
        #[serde(default)]
        params: Vec<CodeParam>,
        /// The line as Composer shows it; `NAME` stands for the target.
        display: String,
    },
    /// Remove a programming line (and anything nested under it).
    RemoveCode { device: u32, event: u32, id: u32 },
    /// Press one of a driver's Actions (Composer's Actions tab). Changes nothing in the
    /// project, but can do anything on the device, so it is approved like a write.
    RunAction { device: u32, command: String },
    /// Put a driver file on the controller (via its web API, not c4soap). The project is
    /// unchanged until a device uses it.
    InstallDriver {
        filename: String,
        /// Where the file came from, for the approval card.
        source: String,
        #[serde(skip, default)]
        #[schemars(skip)]
        bytes: Vec<u8>,
    },
    /// Replace the whole project (Composer's "Load Project"). `xml` is a `<currentstate>`.
    LoadProject {
        label: String,
        #[serde(skip_serializing, default)]
        #[schemars(skip)]
        xml: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct CodeParam {
    pub name: String,
    /// STRING, INTEGER, … as the driver declares it.
    #[serde(default = "string_type")]
    pub r#type: String,
    pub value: String,
}

fn string_type() -> String {
    "STRING".into()
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OpError {
    #[error("no item #{0} in this project")]
    NoSuchItem(u32),
    #[error("{what} must go in a {expected}, but #{id} “{name}” is {actual}")]
    WrongParent { what: &'static str, expected: &'static str, id: u32, name: String, actual: String },
    #[error("“{0}” can't be removed: it is the top of the project")]
    CantRemoveRoot(String),
    #[error("a name can't be empty")]
    EmptyName,
    #[error("can't move “{0}” inside itself")]
    MoveIntoSelf(String),
    #[error("{device} connection #{binding} is already connected to {other}; remove that connection first")]
    AlreadyConnected { device: String, binding: u32, other: String },
    #[error("{device} connection #{binding} has no {class} connection to remove")]
    NotConnected { device: String, binding: u32, class: String },
    #[error("{device} has no network binding #{binding}")]
    NoNetworkBinding { device: String, binding: u32 },
    #[error("no programming line #{id} under that event")]
    NoSuchCode { id: u32 },
    #[error("project to load does not parse: {0}")]
    BadProject(String),
}

impl Op {
    /// Whether the op mutates the controller at all (every op does today; kept so
    /// read-like ops can be added without touching the approval path).
    pub fn is_write(&self) -> bool {
        true
    }

    /// One line for an approval card, in the project's own names.
    pub fn describe(&self, p: &Project) -> String {
        let n = |id: u32| format!("“{}”", p.name_of(id));
        match self {
            Op::AddDevice { room, name, driver } => format!("Add “{name}” ({driver}) to {}", n(*room)),
            Op::AddRoom { floor, name } => format!("Add room “{name}” to {}", n(*floor)),
            Op::RemoveItem { id } => {
                let k = p.item(*id).map(|i| i.kind.label()).unwrap_or("item");
                format!("Remove {k} {}", n(*id))
            }
            Op::RenameItem { id, name } => format!("Rename {} to “{name}”", n(*id)),
            Op::MoveItem { id, parent, .. } => format!("Move {} to {}", n(*id), n(*parent)),
            Op::AddConnection { consumer_device, consumer_binding, provider_device, provider_binding, class, .. } => format!(
                "Connect {} #{provider_binding} → {} #{consumer_binding} ({class})",
                n(*provider_device),
                n(*consumer_device)
            ),
            Op::RemoveConnection { consumer_device, consumer_binding, class } => {
                format!("Disconnect {} #{consumer_binding} ({class})", n(*consumer_device))
            }
            Op::AddNetworkBinding { device, address, search_type, .. } => {
                let who = if *device == 0 { "the new device".to_string() } else { n(*device) };
                format!("Identify {who} as {search_type} at {address}")
            }
            Op::RemoveNetworkBinding { device, .. } => format!("Remove network identity of {}", n(*device)),
            Op::SetProperty { device, name, value } => {
                let shown = if crate::model::is_sensitive_property(name) { crate::model::REDACTED } else { value.as_str() };
                format!("Set {} property “{name}” to “{shown}”", n(*device))
            }
            Op::RunAction { device, command } => format!("Run action “{command}” on {}", n(*device)),
            Op::AddCode { device, target, display, .. } => {
                format!("Add to {} programming: “{}”", n(*device), display.replace("NAME", &p.name_of(*target)))
            }
            Op::RemoveCode { device, id, .. } => format!("Remove programming line #{id} from {}", n(*device)),
            Op::InstallDriver { filename, source, bytes } => {
                format!("Install driver file {filename} ({} KB) from {source}", bytes.len().div_ceil(1024))
            }
            Op::LoadProject { label, .. } => format!("Replace the whole project with {label}"),
        }
    }

    /// Apply to a copy of the project. Ids for new items are guesses (Director assigns
    /// them), which is fine for a preview.
    pub fn predict(&self, p: &mut Project) -> Result<(), OpError> {
        match self {
            Op::AddDevice { room, name, driver } => {
                expect_kind(p, *room, &[ItemKind::Room], "a device", "room")?;
                non_empty(name)?;
                let id = next_id(p);
                insert(p, Item {
                    id,
                    name: name.clone(),
                    kind: ItemKind::Device,
                    parent: Some(*room),
                    children: vec![],
                    driver: Some(driver.clone()),
                    properties: Default::default(),
                });
            }
            Op::AddRoom { floor, name } => {
                expect_kind(p, *floor, &[ItemKind::Floor], "a room", "floor")?;
                non_empty(name)?;
                let id = next_id(p);
                insert(p, Item {
                    id,
                    name: name.clone(),
                    kind: ItemKind::Room,
                    parent: Some(*floor),
                    children: vec![],
                    driver: Some("roomdevice.c4i".into()),
                    properties: Default::default(),
                });
            }
            Op::RemoveItem { id } => {
                let it = p.item(*id).ok_or(OpError::NoSuchItem(*id))?;
                if it.parent.is_none() || it.kind == ItemKind::Project {
                    return Err(OpError::CantRemoveRoot(it.name.clone()));
                }
                let parent = it.parent;
                let gone = p.subtree(*id);
                for g in &gone {
                    p.items.remove(g);
                }
                if let Some(pp) = parent.and_then(|x| p.items.get_mut(&x)) {
                    pp.children.retain(|c| c != id);
                }
                p.bindings.retain(|b| !gone.contains(&b.consumer_device) && !gone.contains(&b.provider_device));
                p.network_bindings.retain(|n| !gone.contains(&n.device));
                p.variables.retain(|v| !gone.contains(&v.device));
                p.programming.retain(|k, _| {
                    let dev: u32 = k.split(':').next().and_then(|d| d.parse().ok()).unwrap_or(0);
                    !gone.contains(&dev)
                });
                for code in p.programming.values_mut() {
                    prune_code(code, &gone);
                }
            }
            Op::RenameItem { id, name } => {
                non_empty(name)?;
                p.items.get_mut(id).ok_or(OpError::NoSuchItem(*id))?.name = name.clone();
            }
            Op::MoveItem { id, parent, before } => {
                let it = p.item(*id).ok_or(OpError::NoSuchItem(*id))?.clone();
                let target = p.item(*parent).ok_or(OpError::NoSuchItem(*parent))?;
                let allowed: &[ItemKind] = match it.kind {
                    ItemKind::Device => &[ItemKind::Room],
                    ItemKind::Room => &[ItemKind::Floor],
                    ItemKind::Floor => &[ItemKind::Building],
                    ItemKind::Building => &[ItemKind::Site],
                    _ => &[],
                };
                if !allowed.contains(&target.kind) {
                    return Err(OpError::WrongParent {
                        what: "this item",
                        expected: allowed.first().map(|k| k.label()).unwrap_or("different place"),
                        id: target.id,
                        name: target.name.clone(),
                        actual: with_article(target.kind.label()),
                    });
                }
                if p.subtree(*id).contains(parent) {
                    return Err(OpError::MoveIntoSelf(it.name));
                }
                if let Some(old) = it.parent.and_then(|x| p.items.get_mut(&x)) {
                    old.children.retain(|c| c != id);
                }
                let np = p.items.get_mut(parent).unwrap();
                let pos = before.and_then(|b| np.children.iter().position(|c| *c == b)).unwrap_or(np.children.len());
                np.children.insert(pos, *id);
                p.items.get_mut(id).unwrap().parent = Some(*parent);
            }
            Op::AddConnection { consumer_device, consumer_binding, provider_device, provider_binding, class, consumer_name } => {
                p.item(*consumer_device).ok_or(OpError::NoSuchItem(*consumer_device))?;
                p.item(*provider_device).ok_or(OpError::NoSuchItem(*provider_device))?;
                if let Some(b) = p
                    .bindings
                    .iter()
                    .find(|b| b.consumer_device == *consumer_device && b.consumer_binding == *consumer_binding && b.classes.contains(class))
                {
                    return Err(OpError::AlreadyConnected {
                        device: p.name_of(*consumer_device),
                        binding: *consumer_binding,
                        other: p.name_of(b.provider_device),
                    });
                }
                p.bindings.push(Binding {
                    consumer_device: *consumer_device,
                    consumer_binding: *consumer_binding,
                    provider_device: *provider_device,
                    provider_binding: *provider_binding,
                    consumer_name: consumer_name.clone(),
                    classes: vec![class.clone()],
                });
                p.bindings.sort();
            }
            Op::RemoveConnection { consumer_device, consumer_binding, class } => {
                let before = p.bindings.len();
                p.bindings.retain(|b| {
                    !(b.consumer_device == *consumer_device && b.consumer_binding == *consumer_binding && b.classes.contains(class))
                });
                if p.bindings.len() == before {
                    return Err(OpError::NotConnected {
                        device: p.name_of(*consumer_device),
                        binding: *consumer_binding,
                        class: class.clone(),
                    });
                }
            }
            Op::AddNetworkBinding { device, binding, address_type, address, search_type } => {
                // 0 = the device an earlier op in this batch added (it took the last id).
                let device = &if *device == 0 { p.next_item_id } else { *device };
                p.item(*device).ok_or(OpError::NoSuchItem(*device))?;
                p.network_bindings.retain(|n| !(n.device == *device && n.binding == *binding));
                p.network_bindings.push(NetworkBinding {
                    device: *device,
                    binding: *binding,
                    address_type: *address_type,
                    address: address.clone(),
                    uuid: address.clone(),
                    search_type: search_type.clone(),
                    status: String::new(),
                });
            }
            Op::RemoveNetworkBinding { device, binding } => {
                let before = p.network_bindings.len();
                p.network_bindings.retain(|n| !(n.device == *device && n.binding == *binding));
                if p.network_bindings.len() == before {
                    return Err(OpError::NoNetworkBinding { device: p.name_of(*device), binding: *binding });
                }
            }
            Op::SetProperty { device, name, value } => {
                p.items.get_mut(device).ok_or(OpError::NoSuchItem(*device))?.properties.insert(name.clone(), value.clone());
            }
            Op::RunAction { device, .. } => {
                p.item(*device).ok_or(OpError::NoSuchItem(*device))?;
            }
            Op::AddCode { device, event, parent, before, target, display, .. } => {
                p.item(*device).ok_or(OpError::NoSuchItem(*device))?;
                p.item(*target).ok_or(OpError::NoSuchItem(*target))?;
                let code = p.programming.entry(crate::model::event_key(*device, *event)).or_default();
                let id = max_code_id(code) + 1;
                let line = crate::model::CodeItem {
                    id,
                    kind: 1,
                    device: *target,
                    // Director stores Composer's template with NAME in it; views fill it in.
                    display: display.clone(),
                    enabled: true,
                    cmdcond: String::new(),
                    children: vec![],
                };
                let siblings = if *parent == 0 { code } else { &mut find_code(code, *parent).ok_or(OpError::NoSuchCode { id: *parent })?.children };
                let pos = if *before == 0 { siblings.len() } else { siblings.iter().position(|c| c.id == *before).ok_or(OpError::NoSuchCode { id: *before })? };
                siblings.insert(pos, line);
            }
            Op::RemoveCode { device, event, id } => {
                let code = p.programming.get_mut(&crate::model::event_key(*device, *event)).ok_or(OpError::NoSuchCode { id: *id })?;
                if !remove_code(code, *id) {
                    return Err(OpError::NoSuchCode { id: *id });
                }
            }
            Op::InstallDriver { .. } => {}
            Op::LoadProject { xml, .. } => {
                *p = Project::parse(xml).map_err(|e| OpError::BadProject(e.to_string()))?;
            }
        }
        Ok(())
    }

    /// The calls Composer sends for this op. `AddRoom` needs a room definition copied
    /// from an existing room, which [`crate::Director::apply`] supplies.
    pub fn calls(&self, room_template: Option<&str>) -> Vec<Call> {
        match self {
            Op::AddDevice { room, name, driver } => {
                // Composer names the parameter after the file type; Director treats a
                // c4z_name as a .c4z whatever its extension says.
                let param = if driver.to_ascii_lowercase().ends_with(".c4i") { "c4i_name" } else { "c4z_name" };
                vec![Call::new("AddDevice").num("idparent", *room).str("name", name).str(param, driver)]
            }
            Op::AddRoom { floor, name } => vec![
                Call::new("AddItem")
                    .num("idparent", *floor)
                    .str("name", name)
                    .num("type", ItemKind::Room.code())
                    .xml("data", room_template.unwrap_or_default()),
            ],
            Op::RemoveItem { id } => vec![Call::new("RemoveItem").num("iditem", *id)],
            Op::RenameItem { id, name } => vec![Call::new("EditItemName").num("iditem", *id).str("name", name)],
            Op::MoveItem { id, parent, before } => vec![
                Call::new("MoveItem").num("idItem", *id).num("idparent", *parent).num("idbeforeitem", before.unwrap_or(0)),
            ],
            Op::AddConnection { consumer_device, consumer_binding, provider_device, provider_binding, class, .. } => vec![
                Call::new("AddBinding")
                    .num("idproviderdevice", *provider_device)
                    .num("idproviderbinding", *provider_binding)
                    .num("idconsumerdevice", *consumer_device)
                    .num("idconsumerbinding", *consumer_binding)
                    .str("class", class),
            ],
            Op::RemoveConnection { consumer_device, consumer_binding, class } => vec![
                Call::new("RemoveBinding")
                    .num("idconsumerdevice", *consumer_device)
                    .num("idconsumerbinding", *consumer_binding)
                    .str("class", class),
            ],
            Op::AddNetworkBinding { device, binding, address_type, address, search_type } => vec![
                Call::new("AddNetworkBinding")
                    .num("idDevice", *device)
                    .num("networkbindingid", *binding)
                    .num("type", *address_type)
                    .str("address", address)
                    .str("searchtype", search_type),
            ],
            Op::RemoveNetworkBinding { device, binding } => vec![
                Call::new("RemoveNetworkBinding").num("iddevice", *device).num("networkbindingid", *binding),
            ],
            Op::SetProperty { device, name, value } => {
                let e = crate::xml::escape;
                let cmd = format!(
                    r#"<devicecommand owneridtype="" owneriditem="-1"><command>UPDATE_PROPERTY</command><params><param><name>Name</name><value type="STRING"><static>{}</static></value></param><param><name>Value</name><value type="STRING"><static>{}</static></value></param></params></devicecommand>"#,
                    e(name),
                    e(value)
                );
                vec![Call::new("SendToDevice").num("iddevice", *device).xml("data", cmd)]
            }
            Op::AddCode { device, event, parent, before, target, command, params, display } => {
                let e = crate::xml::escape;
                let ps: String = params
                    .iter()
                    .map(|p| format!(r#"<param><name>{}</name><value type="{}"><static>{}</static></value></param>"#, e(&p.name), e(&p.r#type), e(&p.value)))
                    .collect();
                let cmdcond = format!(r#"<devicecommand owneridtype="" owneriditem="-1"><command>{}</command><params>{ps}</params></devicecommand>"#, e(command));
                vec![
                    Call::new("AddCodeItem")
                        .num("iddevice", *device)
                        .num("idevent", *event)
                        .num("idparentcodeitem", *parent)
                        .num("idbeforecodeitem", *before)
                        .num("idcreator", 0)
                        .num("type", 1)
                        .num("idcmdconddevice", *target)
                        .str("displayname", display)
                        .xml("cmdcond", cmdcond),
                ]
            }
            Op::RemoveCode { device, event, id } => vec![
                Call::new("RemoveCodeItem").num("iddevice", *device).num("idevent", *event).num("idcodeitem", *id),
            ],
            Op::RunAction { device, command } => {
                let cmd = format!(
                    r#"<devicecommand owneridtype="" owneriditem="-1"><command>LUA_ACTION</command><params><param><name>ACTION</name><value type="STRING"><static>{}</static></value></param></params></devicecommand>"#,
                    crate::xml::escape(command)
                );
                vec![Call::new("SendToDevice").num("iddevice", *device).xml("data", cmd)]
            }
            Op::InstallDriver { .. } => vec![],
            Op::LoadProject { xml, .. } => {
                let body = xml.trim_start();
                let body = match body.strip_prefix("<?xml") {
                    Some(rest) => rest.split_once("?>").map(|(_, r)| r.trim_start()).unwrap_or(body),
                    None => body,
                };
                vec![
                    Call::new("Download").xml("project", body).timeout(std::time::Duration::from_secs(300)),
                    Call::new("ReloadDatabase").timeout(std::time::Duration::from_secs(120)),
                ]
            }
        }
    }
}

fn with_article(word: &str) -> String {
    let an = word.starts_with(['a', 'e', 'i', 'o', 'u']);
    format!("{} {word}", if an { "an" } else { "a" })
}

fn next_id(p: &mut Project) -> u32 {
    let max = p.items.keys().copied().filter(|k| *k < 100_000).max().unwrap_or(0);
    p.next_item_id = p.next_item_id.max(max) + 1;
    p.next_item_id
}

fn insert(p: &mut Project, item: Item) {
    if let Some(parent) = item.parent.and_then(|x| p.items.get_mut(&x)) {
        parent.children.push(item.id);
    }
    p.items.insert(item.id, item);
}

fn non_empty(name: &str) -> Result<(), OpError> {
    if name.trim().is_empty() { Err(OpError::EmptyName) } else { Ok(()) }
}

fn expect_kind(p: &Project, id: u32, kinds: &[ItemKind], what: &'static str, expected: &'static str) -> Result<(), OpError> {
    let it = p.item(id).ok_or(OpError::NoSuchItem(id))?;
    if kinds.contains(&it.kind) {
        Ok(())
    } else {
        Err(OpError::WrongParent { what, expected, id, name: it.name.clone(), actual: with_article(it.kind.label()) })
    }
}

fn max_code_id(code: &[crate::model::CodeItem]) -> u32 {
    code.iter().map(|c| c.id.max(max_code_id(&c.children))).max().unwrap_or(0)
}

fn find_code(code: &mut [crate::model::CodeItem], id: u32) -> Option<&mut crate::model::CodeItem> {
    for c in code.iter_mut() {
        if c.id == id {
            return Some(c);
        }
        if let Some(f) = find_code(&mut c.children, id) {
            return Some(f);
        }
    }
    None
}

fn remove_code(code: &mut Vec<crate::model::CodeItem>, id: u32) -> bool {
    if let Some(pos) = code.iter().position(|c| c.id == id) {
        code.remove(pos);
        return true;
    }
    code.iter_mut().any(|c| remove_code(&mut c.children, id))
}

fn prune_code(code: &mut Vec<crate::model::CodeItem>, gone: &[u32]) {
    code.retain(|c| !gone.contains(&c.device));
    for c in code.iter_mut() {
        prune_code(&mut c.children, gone);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{Change, DiffOptions, diff};
    use crate::model::Names;

    fn sample() -> Project {
        Project::parse(include_str!("../tests/fixtures/sample-project.xml")).unwrap()
    }

    #[test]
    fn devices_only_go_in_rooms() {
        let mut p = sample();
        let err = Op::AddDevice { room: 4, name: "Apple TV".into(), driver: "apple_tv.c4z".into() }.predict(&mut p);
        assert!(matches!(err, Err(OpError::WrongParent { .. })), "{err:?}");
    }

    #[test]
    fn add_device_predicts_an_added_item_in_the_room() {
        let before = sample();
        let mut after = before.clone();
        Op::AddDevice { room: 11, name: "Apple TV".into(), driver: "apple_tv.c4z".into() }.predict(&mut after).unwrap();
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let [Change::ItemAdded { item, driver, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        assert_eq!(item.location.last().map(String::as_str), Some("Kitchen"));
        assert_eq!(driver.as_deref(), Some("apple_tv.c4z"));
    }

    #[test]
    fn connecting_an_already_connected_input_is_refused() {
        let mut p = sample();
        let op = Op::AddConnection {
            consumer_device: 20,
            consumer_binding: 1000,
            provider_device: 21,
            provider_binding: 2001,
            class: "HDMI".into(),
            consumer_name: String::new(),
        };
        assert!(matches!(op.predict(&mut p), Err(OpError::AlreadyConnected { .. })));
    }

    #[test]
    fn removing_a_device_drops_its_programming_lines() {
        let mut p = sample();
        Op::RemoveItem { id: 21 }.predict(&mut p).unwrap();
        let code = &p.programming["20:1"];
        assert!(code[0].children.is_empty(), "the receiver line under the TV event is gone");
    }

    #[test]
    fn programming_lines_insert_and_remove() {
        let before = sample();
        let mut after = before.clone();
        Op::AddCode {
            device: 20, event: 1, parent: 1, before: 0, target: 21, command: "INPUT".into(),
            params: vec![], display: "Select HDMI 2 on NAME".into(),
        }
        .predict(&mut after)
        .unwrap();
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let [Change::ProgrammingChanged { lines, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        let added: Vec<_> = lines.iter().filter(|l| l.op == crate::diff::LineOp::Added).map(|l| (l.depth, l.text.as_str())).collect();
        assert_eq!(added, [(1, "Select HDMI 2 on Receiver")]);
        Op::RemoveCode { device: 20, event: 1, id: 2 }.predict(&mut after).unwrap();
        assert_eq!(after.programming["20:1"][0].children.len(), 1, "only the new line remains under the TV line");
        assert!(matches!(Op::RemoveCode { device: 20, event: 1, id: 99 }.predict(&mut after), Err(OpError::NoSuchCode { .. })));
    }

    #[test]
    fn add_device_names_the_driver_parameter_by_file_type() {
        let c4i = Op::AddDevice { room: 1, name: "TV".into(), driver: "tv_Vizio_SV421XVT.c4i".into() }.calls(None);
        assert!(c4i[0].encode(false).contains(r#"<param name="c4i_name" type="string">tv_Vizio_SV421XVT.c4i</param>"#));
        let c4z = Op::AddDevice { room: 1, name: "AVR".into(), driver: "sony_strdn840.c4z".into() }.calls(None);
        assert!(c4z[0].encode(false).contains(r#"<param name="c4z_name" type="string">sony_strdn840.c4z</param>"#));
    }

    #[test]
    fn calls_match_composer() {
        let c = Op::RemoveConnection { consumer_device: 373, consumer_binding: 2, class: "AUDIO_SELECTION".into() }.calls(None);
        assert_eq!(
            c[0].encode(false),
            r#"<c4soap name="RemoveBinding" session="0" operation="RWX" category="composer" async="False"><param name="idconsumerdevice" type="number">373</param><param name="idconsumerbinding" type="number">2</param><param name="class" type="string">AUDIO_SELECTION</param></c4soap>"#
        );
    }
}
