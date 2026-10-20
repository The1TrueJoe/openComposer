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
    AddNetworkBinding { device: u32, binding: u32, address_type: u32, address: String, search_type: String },
    RemoveNetworkBinding { device: u32, binding: u32 },
    /// Replace the whole project (Composer's "Load Project"). `xml` is a `<currentstate>`.
    LoadProject {
        label: String,
        #[serde(skip_serializing, default)]
        #[schemars(skip)]
        xml: String,
    },
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
                format!("Identify {} as {search_type} at {address}", n(*device))
            }
            Op::RemoveNetworkBinding { device, .. } => format!("Remove network identity of {}", n(*device)),
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
            Op::AddDevice { room, name, driver } => vec![
                Call::new("AddDevice").num("idparent", *room).str("name", name).str("c4z_name", driver),
            ],
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
    fn calls_match_composer() {
        let c = Op::RemoveConnection { consumer_device: 373, consumer_binding: 2, class: "AUDIO_SELECTION".into() }.calls(None);
        assert_eq!(
            c[0].encode(false),
            r#"<c4soap name="RemoveBinding" session="0" operation="RWX" category="composer" async="False"><param name="idconsumerdevice" type="number">373</param><param name="idconsumerbinding" type="number">2</param><param name="class" type="string">AUDIO_SELECTION</param></c4soap>"#
        );
    }
}
