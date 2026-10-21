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

/// The ops `crate::agent_ops` handles, as one pattern.
macro_rules! agent_op {
    () => {
        Op::AddLightingScene { .. }
            | Op::RenameLightingScene { .. }
            | Op::RemoveLightingScene { .. }
            | Op::SetSceneLight { .. }
            | Op::RemoveSceneLight { .. }
            | Op::AddAnnouncement { .. }
            | Op::ModifyAnnouncement { .. }
            | Op::RemoveAnnouncement { .. }
            | Op::AddWakeSleepRoom { .. }
            | Op::ModifyWakeSleepRoom { .. }
            | Op::RemoveWakeSleepRoom { .. }
            | Op::AddPushNotification { .. }
            | Op::ModifyPushNotification { .. }
            | Op::RemovePushNotification { .. }
            | Op::AddEmailTemplate { .. }
            | Op::ModifyEmailTemplate { .. }
            | Op::RemoveEmailTemplate { .. }
    };
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Add a driver to a room. The driver file must already be on the controller.
    AddDevice { room: u32, name: String, driver: String },
    AddRoom { floor: u32, name: String },
    /// Add a site (under the project), building (under a site) or floor (under a building).
    AddLocation { parent: u32, kind: LocationKind, name: String },
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
    /// Remove a programming line (and anything nested under it; an If takes its Else along).
    RemoveCode { device: u32, event: u32, id: u32 },
    /// Add an If (or, with `loop`, a While) testing `condition`. Lines inside it are added
    /// with `parent` set to its id, once Director has given it one (a later change).
    /// `display` is filled in from the conditional when left empty.
    AddConditional {
        device: u32,
        event: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
        #[serde(default)]
        r#loop: bool,
        condition: crate::program::Condition,
        #[serde(default)]
        display: String,
    },
    /// Add an Else to an If: it goes right after the If (`parent` is the If's parent, `before`
    /// the line that follows the If, 0 = the end). Its lines are added inside it.
    AddElse {
        device: u32,
        event: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
    },
    /// Add a Delay, Stop, Break or comment line.
    AddControl {
        device: u32,
        event: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
        control: crate::program::Control,
    },
    /// Add a line that sets, toggles or does arithmetic on a variable.
    AddVariableCommand {
        device: u32,
        event: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
        variable: crate::program::VarRef,
        action: crate::program::VarAction,
        #[serde(default)]
        display: String,
        /// The variable's type, looked up when the change is proposed.
        #[serde(default, skip_serializing_if = "is_zero")]
        #[schemars(skip)]
        var_type: u32,
    },
    /// Move a line (with what's nested under it; an If takes its Else along) to `before`
    /// under `parent` (0 = top level / the end).
    MoveCode {
        device: u32,
        event: u32,
        id: u32,
        #[serde(default)]
        parent: u32,
        #[serde(default)]
        before: u32,
    },
    /// Enable or disable a line (Composer's Enable/Disable). A disabled If, While or Else
    /// skips everything inside it.
    SetCodeEnabled { device: u32, event: u32, id: u32, enabled: bool },
    /// Send a command to a device now (Composer's device control). Changes no project data.
    SendCommand {
        device: u32,
        command: String,
        #[serde(default)]
        params: Vec<CodeParam>,
    },
    /// Press one of a driver's Actions (Composer's Actions tab). Changes nothing in the
    /// project, but can do anything on the device, so it is approved like a write.
    RunAction { device: u32, command: String },
    /// Add an event to the Scheduler agent (Composer's Scheduler "Add"). Director picks its id,
    /// which is also its event id for programming.
    AddScheduleEntry { agent: u32, entry: crate::agents::ScheduleSpec },
    /// Replace a Scheduler event's settings (Composer's "Edit Entry"). `creator` and
    /// `category` must be the entry's current ones (`agent_view` lists them; usually 0 and "").
    ModifyScheduleEntry {
        agent: u32,
        id: u32,
        entry: crate::agents::ScheduleSpec,
        #[serde(default)]
        creator: u32,
        #[serde(default)]
        category: String,
    },
    /// Remove a Scheduler event, and the programming under it.
    RemoveScheduleEntry { agent: u32, id: u32 },
    // ---- other built-in agents (crate::agent_ops); `agent_view` lists their ids ----
    /// Add an Advanced Lighting scene (Composer's "New Scene"). The agent picks its id.
    AddLightingScene { agent: u32, name: String },
    RenameLightingScene { agent: u32, scene: u32, name: String },
    /// Remove an Advanced Lighting scene, and the programming under its events.
    RemoveLightingScene { agent: u32, scene: u32 },
    /// Put a light (its proxy) in an Advanced Lighting scene, or replace what it does there:
    /// its steps run in order, each after its delay (Composer's scene editor).
    SetSceneLight {
        agent: u32,
        scene: u32,
        light: u32,
        steps: Vec<crate::agents::LightStep>,
        #[serde(skip)]
        #[schemars(skip)]
        now: crate::agent_ops::MemberNow,
    },
    RemoveSceneLight { agent: u32, scene: u32, light: u32 },
    /// Add an announcement (Composer's Announcements "Add"). The agent picks its id.
    AddAnnouncement {
        agent: u32,
        announcement: crate::agents::AnnouncementSpec,
        #[serde(skip)]
        #[schemars(skip)]
        xml: String,
    },
    /// Replace an announcement's settings; what the spec doesn't cover is kept.
    ModifyAnnouncement {
        agent: u32,
        id: u32,
        announcement: crate::agents::AnnouncementSpec,
        #[serde(skip)]
        #[schemars(skip)]
        xml: String,
    },
    /// Remove an announcement, and the programming under its events.
    RemoveAnnouncement { agent: u32, id: u32 },
    /// Set up Wake/Sleep in a room, with Composer's defaults.
    AddWakeSleepRoom { agent: u32, room: u32 },
    /// Replace a room's Wake/Sleep defaults (`id` is the room setup's id from `agent_view`).
    ModifyWakeSleepRoom {
        agent: u32,
        id: u32,
        settings: crate::agents::WakeSleepSpec,
        #[serde(skip)]
        #[schemars(skip)]
        room: u32,
    },
    RemoveWakeSleepRoom { agent: u32, id: u32 },
    AddPushNotification { agent: u32, template: crate::agents::PushTemplateSpec },
    ModifyPushNotification { agent: u32, id: u32, template: crate::agents::PushTemplateSpec },
    RemovePushNotification { agent: u32, id: u32 },
    AddEmailTemplate { agent: u32, template: crate::agents::EmailTemplateSpec },
    ModifyEmailTemplate { agent: u32, id: u32, template: crate::agents::EmailTemplateSpec },
    RemoveEmailTemplate { agent: u32, id: u32 },
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LocationKind {
    Site,
    Building,
    Floor,
}

impl LocationKind {
    pub fn item_kind(self) -> ItemKind {
        match self {
            Self::Site => ItemKind::Site,
            Self::Building => ItemKind::Building,
            Self::Floor => ItemKind::Floor,
        }
    }
    /// Where this kind goes in the hierarchy.
    pub fn parent_kind(self) -> ItemKind {
        match self {
            Self::Site => ItemKind::Project,
            Self::Building => ItemKind::Site,
            Self::Floor => ItemKind::Building,
        }
    }
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
    #[error("#{0} is not a Scheduler agent")]
    NotScheduler(u32),
    #[error("the Scheduler has no event #{0}")]
    NoSuchScheduleEntry(u32),
    #[error("scheduled event “{0}” is locked; Composer doesn't allow changing it either")]
    ScheduleEntryLocked(String),
    #[error("{0}")]
    BadScheduleEntry(String),
    #[error("project to load does not parse: {0}")]
    BadProject(String),
    #[error("#{id} “{name}” is not the {want} agent")]
    WrongAgent { id: u32, name: String, want: &'static str },
    #[error("{0}")]
    BadAgentChange(String),
    /// Where a programming line can't go, or what it can't be (crate::program's rules).
    #[error("{0}")]
    Code(String),
}

impl Op {
    /// Whether the op mutates the controller at all (every op does today; kept so
    /// read-like ops can be added without touching the approval path).
    pub fn is_write(&self) -> bool {
        true
    }

    /// Fill in what the op's calls need from the project it is about to be predicted on and
    /// applied to (how many steps a light has in a scene, an announcement's hidden parts).
    /// Approvals call this for every op, in order, on the predicted project.
    pub fn prepare(&mut self, p: &Project) {
        crate::agent_ops::prepare(self, p);
    }

    /// One line for an approval card, in the project's own names.
    pub fn describe(&self, p: &Project) -> String {
        let n = |id: u32| format!("“{}”", p.name_of(id));
        match self {
            Op::AddDevice { room, name, driver } => format!("Add “{name}” ({driver}) to {}", n(*room)),
            Op::AddRoom { floor, name } => format!("Add room “{name}” to {}", n(*floor)),
            Op::AddLocation { parent, kind, name } => format!("Add {} “{name}” to {}", kind.item_kind().label(), n(*parent)),
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
            Op::SendCommand { device, command, params } => {
                let ps: Vec<String> = params.iter().map(|p| format!("{}={}", p.name, p.value)).collect();
                let ps = if ps.is_empty() { String::new() } else { format!(" ({})", ps.join(", ")) };
                format!("Send {command}{ps} to {}", n(*device))
            }
            Op::AddCode { device, target, display, .. } => {
                format!("Add to {} programming: “{}”", n(*device), display.replace("NAME", &p.name_of(*target)))
            }
            Op::RemoveCode { device, event, id } => format!("Remove “{}” from {} programming", code_text(p, *device, *event, *id), n(*device)),
            Op::AddConditional { device, r#loop, condition, display, .. } => {
                let shown = if display.is_empty() { condition.display(if *r#loop { "While" } else { "If" }, None) } else { display.clone() };
                format!("Add to {} programming: “{}”", n(*device), crate::program::render(&shown, condition.device(), p))
            }
            Op::AddElse { device, .. } => format!("Add an Else to {} programming", n(*device)),
            Op::AddControl { device, control, .. } => format!("Add to {} programming: “{}”", n(*device), control.parts().1),
            Op::AddVariableCommand { device, variable, action, display, var_type, .. } => {
                let shown = if display.is_empty() { action.display(variable, *var_type) } else { display.clone() };
                format!("Add to {} programming: “{}”", n(*device), crate::program::render(&shown, variable.device, p))
            }
            Op::MoveCode { device, event, id, .. } => format!("Move “{}” in {} programming", code_text(p, *device, *event, *id), n(*device)),
            Op::SetCodeEnabled { device, event, id, enabled } => format!(
                "{} “{}” in {} programming",
                if *enabled { "Enable" } else { "Disable" },
                code_text(p, *device, *event, *id),
                n(*device)
            ),
            Op::AddScheduleEntry { agent, entry } => {
                format!("Add scheduled event “{}” to {}: {} at {}", entry.name, n(*agent), entry.repeat_text(), entry.time_text())
            }
            Op::ModifyScheduleEntry { agent, id, entry, .. } => {
                let old = p.schedules.get(agent).and_then(|es| es.iter().find(|e| e.id == *id)).map(|e| e.spec.name.clone());
                format!("Change scheduled event “{}” in {}", old.unwrap_or_else(|| entry.name.clone()), n(*agent))
            }
            Op::RemoveScheduleEntry { agent, id } => {
                let old = p.schedules.get(agent).and_then(|es| es.iter().find(|e| e.id == *id)).map(|e| e.spec.name.clone());
                format!("Remove scheduled event “{}” from {}", old.unwrap_or_else(|| format!("#{id}")), n(*agent))
            }
            agent_op!() => crate::agent_ops::describe(self, p).unwrap_or_default(),
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
            Op::AddLocation { parent, kind, name } => {
                let (want, label) = (kind.parent_kind(), kind.parent_kind().label());
                expect_kind(p, *parent, &[want], kind.item_kind().label_static(), label)?;
                non_empty(name)?;
                let id = next_id(p);
                insert(p, Item {
                    id,
                    name: name.clone(),
                    kind: kind.item_kind(),
                    parent: Some(*parent),
                    children: vec![],
                    driver: None,
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
            Op::RunAction { device, .. } | Op::SendCommand { device, .. } => {
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
                place(code, *parent, *before, line)?;
            }
            Op::RemoveCode { device, event, id } => {
                let code = p.programming.get_mut(&crate::model::event_key(*device, *event)).ok_or(OpError::NoSuchCode { id: *id })?;
                // Director removes an If's Else with it.
                crate::program::detach(code, *id).ok_or(OpError::NoSuchCode { id: *id })?;
            }
            Op::AddConditional { device, event, parent, before, r#loop, condition, display } => {
                if let crate::program::Condition::Device { target, .. } = condition {
                    p.item(*target).ok_or(OpError::NoSuchItem(*target))?;
                }
                let word = if *r#loop { "While" } else { "If" };
                let display = if display.is_empty() { condition.display(word, None) } else { display.clone() };
                let kind = if *r#loop { crate::program::kind::LOOP } else { crate::program::kind::CONDITIONAL };
                add_line(p, *device, *event, *parent, *before, kind, condition.device(), display, condition.xml())?;
            }
            Op::AddElse { device, event, parent, before } => {
                add_line(p, *device, *event, *parent, *before, crate::program::kind::ELSE, crate::program::SYSTEM_DEVICE, "Else".into(), String::new())?;
            }
            Op::AddControl { device, event, parent, before, control } => {
                let (kind, display, xml) = control.parts();
                add_line(p, *device, *event, *parent, *before, kind, crate::program::SYSTEM_DEVICE, display, xml)?;
            }
            Op::AddVariableCommand { device, event, parent, before, variable, action, display, var_type } => {
                let display = if display.is_empty() { action.display(variable, *var_type) } else { display.clone() };
                let xml = action.xml(variable, *var_type);
                add_line(p, *device, *event, *parent, *before, crate::program::kind::COMMAND, variable.device, display, xml)?;
            }
            Op::MoveCode { device, event, id, parent, before } => {
                let code = p.programming.get_mut(&crate::model::event_key(*device, *event)).ok_or(OpError::NoSuchCode { id: *id })?;
                let it = crate::program::find(code, *id).ok_or(OpError::NoSuchCode { id: *id })?;
                if it.kind == crate::program::kind::ELSE {
                    return Err(OpError::Code("an Else moves with its If; move the If instead".into()));
                }
                let moving = crate::program::detach(code, *id).ok_or(OpError::NoSuchCode { id: *id })?;
                let mut inside = Vec::new();
                crate::program::ids(&moving, &mut inside);
                if inside.contains(parent) || (*before != 0 && inside.contains(before)) {
                    return Err(OpError::Code("a line can't be moved inside itself".into()));
                }
                let siblings = crate::program::siblings_mut(code, *parent).map_err(OpError::Code)?;
                let pos = crate::program::position(siblings, *before, moving[0].kind).map_err(OpError::Code)?;
                for (k, m) in moving.into_iter().enumerate() {
                    siblings.insert(pos + k, m);
                }
            }
            Op::SetCodeEnabled { device, event, id, enabled } => {
                let code = p.programming.get_mut(&crate::model::event_key(*device, *event)).ok_or(OpError::NoSuchCode { id: *id })?;
                let it = crate::program::find_mut(code, *id).ok_or(OpError::NoSuchCode { id: *id })?;
                if it.kind == crate::program::kind::COMMENT {
                    return Err(OpError::Code("comments can't be disabled (Composer doesn't offer it either)".into()));
                }
                it.enabled = *enabled;
            }
            Op::AddScheduleEntry { agent, entry } => {
                let entries = schedule_of(p, *agent)?;
                check_entry(entries, entry, None)?;
                // Director numbers entries from a counter that never goes back; any unused
                // id is as good for a preview (the diff matches added entries by name).
                let id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
                entries.push(crate::agents::ScheduleEntry {
                    id,
                    spec: entry.clone(),
                    locked: false,
                    hidden: false,
                    creator: 0,
                    category: String::new(),
                    next: None,
                });
            }
            Op::ModifyScheduleEntry { agent, id, entry, creator, category } => {
                let entries = schedule_of(p, *agent)?;
                check_entry(entries, entry, Some(*id))?;
                let e = entries.iter_mut().find(|e| e.id == *id).ok_or(OpError::NoSuchScheduleEntry(*id))?;
                if e.locked {
                    return Err(OpError::ScheduleEntryLocked(e.spec.name.clone()));
                }
                // Another agent's entry (Update Manager's nightly check…) is found by its
                // creator; writing it back without one would orphan it.
                if (e.creator, e.category.as_str()) != (*creator, category.as_str()) {
                    return Err(OpError::BadScheduleEntry(format!(
                        "“{}” has creator {} and category “{}”; pass those unchanged",
                        e.spec.name, e.creator, e.category
                    )));
                }
                e.spec = entry.clone();
            }
            Op::RemoveScheduleEntry { agent, id } => {
                let entries = schedule_of(p, *agent)?;
                let pos = entries.iter().position(|e| e.id == *id).ok_or(OpError::NoSuchScheduleEntry(*id))?;
                if entries[pos].locked {
                    return Err(OpError::ScheduleEntryLocked(entries[pos].spec.name.clone()));
                }
                entries.remove(pos);
                p.programming.remove(&crate::model::event_key(*agent, *id));
            }
            agent_op!() => crate::agent_ops::predict(self, p).unwrap_or(Ok(()))?,
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
            Op::AddLocation { parent, kind, name } => vec![
                Call::new("AddItem")
                    .num("idparent", *parent)
                    .str("name", name)
                    .num("type", kind.item_kind().code())
                    .xml("data", room_template.unwrap_or("<item><itemdata /></item>")),
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
            Op::SendCommand { device, command, params } => {
                let e = crate::xml::escape;
                let ps: String = params
                    .iter()
                    .map(|p| format!(r#"<param><name>{}</name><value type="{}"><static>{}</static></value></param>"#, e(&p.name), e(&p.r#type), e(&p.value)))
                    .collect();
                let cmd = format!(r#"<devicecommand owneridtype="" owneriditem="-1"><command>{}</command><params>{ps}</params></devicecommand>"#, e(command));
                vec![Call::new("SendToDevice").num("iddevice", *device).xml("data", cmd)]
            }
            Op::RemoveCode { device, event, id } => vec![
                Call::new("RemoveCodeItem").num("iddevice", *device).num("idevent", *event).num("idcodeitem", *id),
            ],
            Op::AddConditional { device, event, parent, before, r#loop, condition, display } => {
                let kind = if *r#loop { crate::program::kind::LOOP } else { crate::program::kind::CONDITIONAL };
                let display = if display.is_empty() { condition.display(if *r#loop { "While" } else { "If" }, None) } else { display.clone() };
                vec![add_code_item(*device, *event, *parent, *before, kind, condition.device(), &display, &condition.xml())]
            }
            Op::AddElse { device, event, parent, before } => {
                vec![add_code_item(*device, *event, *parent, *before, crate::program::kind::ELSE, crate::program::SYSTEM_DEVICE, "Else", "")]
            }
            Op::AddControl { device, event, parent, before, control } => {
                let (kind, display, xml) = control.parts();
                vec![add_code_item(*device, *event, *parent, *before, kind, crate::program::SYSTEM_DEVICE, &display, &xml)]
            }
            Op::AddVariableCommand { device, event, parent, before, variable, action, display, var_type } => {
                let display = if display.is_empty() { action.display(variable, *var_type) } else { display.clone() };
                let xml = action.xml(variable, *var_type);
                vec![add_code_item(*device, *event, *parent, *before, crate::program::kind::COMMAND, variable.device, &display, &xml)]
            }
            // Parameter names from Director's own string table; checked on the 3.3.3 Virtual
            // Director (an unknown name is ignored, not refused: `enabled` silently disables).
            Op::MoveCode { device, event, id, parent, before } => vec![
                Call::new("MoveCodeItem")
                    .num("iddevice", *device)
                    .num("idevent", *event)
                    .num("idcodeitem", *id)
                    .num("idnewparentcodeitem", *parent)
                    .num("idbeforecodeitem", *before),
            ],
            Op::SetCodeEnabled { device, event, id, enabled } => vec![
                Call::new("EnableCodeItem").num("iddevice", *device).num("idevent", *event).num("idcodeitem", *id).bool("enable", *enabled),
            ],
            Op::RunAction { device, command } => {
                let cmd = format!(
                    r#"<devicecommand owneridtype="" owneriditem="-1"><command>LUA_ACTION</command><params><param><name>ACTION</name><value type="STRING"><static>{}</static></value></param></params></devicecommand>"#,
                    crate::xml::escape(command)
                );
                vec![Call::new("SendToDevice").num("iddevice", *device).xml("data", cmd)]
            }
            Op::AddScheduleEntry { agent, entry } => {
                let cmd = crate::agents::device_command("ADD_ENTRY", &[("ENTRY_XML", "XML", &entry.to_xml(0, 0, "", false))]);
                vec![Call::new("SendToDevice").num("iddevice", *agent).xml("data", cmd)]
            }
            Op::ModifyScheduleEntry { agent, id, entry, creator, category } => {
                let cmd = crate::agents::device_command("MODIFY_ENTRY", &[("ENTRY_XML", "XML", &entry.to_xml(*id, *creator, category, false))]);
                vec![Call::new("SendToDevice").num("iddevice", *agent).xml("data", cmd)]
            }
            Op::RemoveScheduleEntry { agent, id } => {
                let cmd = crate::agents::device_command("DELETE_ENTRY", &[("EVENT_ID", "INT", &id.to_string())]);
                vec![Call::new("SendToDevice").num("iddevice", *agent).xml("data", cmd)]
            }
            agent_op!() => crate::agent_ops::calls(self).unwrap_or_default(),
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

/// The entries of a Scheduler agent, or why `agent` isn't one.
fn schedule_of(p: &mut Project, agent: u32) -> Result<&mut Vec<crate::agents::ScheduleEntry>, OpError> {
    let it = p.item(agent).ok_or(OpError::NoSuchItem(agent))?;
    let is_scheduler = it.driver.as_deref().and_then(crate::agents::AgentKind::from_driver) == Some(crate::agents::AgentKind::Scheduler);
    if !is_scheduler {
        return Err(OpError::NotScheduler(agent));
    }
    Ok(p.schedules.entry(agent).or_default())
}

/// Composer's "Edit Entry" checks, plus its rule that names are unique.
fn check_entry(entries: &[crate::agents::ScheduleEntry], e: &crate::agents::ScheduleSpec, own: Option<u32>) -> Result<(), OpError> {
    e.validate().map_err(OpError::BadScheduleEntry)?;
    let taken = entries.iter().any(|x| Some(x.id) != own && x.spec.name.trim().eq_ignore_ascii_case(e.name.trim()));
    if taken {
        return Err(OpError::BadScheduleEntry(format!("the Scheduler already has an event named “{}”", e.name.trim())));
    }
    Ok(())
}

fn max_code_id(code: &[crate::model::CodeItem]) -> u32 {
    code.iter().map(|c| c.id.max(max_code_id(&c.children))).max().unwrap_or(0)
}

/// Put a new line into a script where `parent`/`before` say, by Director's rules (inside an
/// If, While or Else only; nothing between an If and its Else).
fn place(code: &mut Vec<crate::model::CodeItem>, parent: u32, before: u32, line: crate::model::CodeItem) -> Result<(), OpError> {
    let siblings = crate::program::siblings_mut(code, parent).map_err(OpError::Code)?;
    let pos = crate::program::position(siblings, before, line.kind).map_err(OpError::Code)?;
    siblings.insert(pos, line);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_line(p: &mut Project, device: u32, event: u32, parent: u32, before: u32, kind: u32, target: u32, display: String, cmdcond: String) -> Result<(), OpError> {
    p.item(device).ok_or(OpError::NoSuchItem(device))?;
    let code = p.programming.entry(crate::model::event_key(device, event)).or_default();
    let line = crate::model::CodeItem { id: max_code_id(code) + 1, kind, device: target, display, enabled: true, cmdcond, children: vec![] };
    place(code, parent, before, line)
}

/// `AddCodeItem` as Composer sends it.
#[allow(clippy::too_many_arguments)]
fn add_code_item(device: u32, event: u32, parent: u32, before: u32, kind: u32, target: u32, display: &str, cmdcond: &str) -> Call {
    Call::new("AddCodeItem")
        .num("iddevice", device)
        .num("idevent", event)
        .num("idparentcodeitem", parent)
        .num("idbeforecodeitem", before)
        .num("idcreator", 0)
        .num("type", kind)
        .num("idcmdconddevice", target)
        .str("displayname", display)
        .xml("cmdcond", cmdcond)
}

/// A line's text for an approval card, or its number when it can't be found.
fn code_text(p: &Project, device: u32, event: u32, id: u32) -> String {
    p.programming
        .get(&crate::model::event_key(device, event))
        .and_then(|code| crate::program::find(code, id))
        .map(|c| c.text(p))
        .unwrap_or_else(|| format!("line #{id}"))
}

fn is_zero(n: &u32) -> bool {
    *n == 0
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
            device: 20, event: 1, parent: 0, before: 1, target: 21, command: "INPUT".into(),
            params: vec![], display: "Select HDMI 2 on NAME".into(),
        }
        .predict(&mut after)
        .unwrap();
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let [Change::ProgrammingChanged { lines, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        let added: Vec<_> = lines.iter().filter(|l| l.op == crate::diff::LineOp::Added).map(|l| (l.depth, l.text.as_str())).collect();
        assert_eq!(added, [(0, "Select HDMI 2 on Receiver")]);
        // Only an If, While or Else takes lines inside it (line 1 is a command).
        let under_command = Op::AddCode {
            device: 20, event: 1, parent: 1, before: 0, target: 21, command: "INPUT".into(), params: vec![], display: "x".into(),
        };
        assert!(matches!(under_command.predict(&mut after.clone()), Err(OpError::Code(_))));
        Op::RemoveCode { device: 20, event: 1, id: 1 }.predict(&mut after).unwrap();
        assert_eq!(after.programming["20:1"].len(), 1, "the TV line went with the line nested under it");
        assert!(matches!(Op::RemoveCode { device: 20, event: 1, id: 99 }.predict(&mut after), Err(OpError::NoSuchCode { .. })));
    }

    /// An If with a line inside, its Else, a While, a disabled line and a move — the
    /// sequence checked live on the Virtual Director (see `crate::program`).
    #[test]
    fn conditionals_else_loops_and_moves() {
        use crate::program::{Condition, Control, kind};
        let mut p = sample();
        p.programming.insert("20:2".into(), vec![]);
        let lamp_on = Condition::Device { target: 21, name: "LOAD_ON".into(), logic: None, params: vec![] };
        let add_if = Op::AddConditional { device: 20, event: 2, parent: 0, before: 0, r#loop: false, condition: lamp_on.clone(), display: "If NAME is on".into() };
        add_if.predict(&mut p).unwrap();
        let calls = add_if.calls(None)[0].encode(false);
        assert!(calls.contains(r#"<param name="type" type="number">2</param>"#) && calls.contains("<name>LOAD_ON</name>"), "{calls}");
        Op::AddControl { device: 20, event: 2, parent: 1, before: 0, control: Control::Delay { ms: 5000 } }.predict(&mut p).unwrap();
        // An Else only right after an If.
        assert!(Op::AddElse { device: 20, event: 2, parent: 1, before: 0 }.predict(&mut p.clone()).is_err());
        Op::AddElse { device: 20, event: 2, parent: 0, before: 0 }.predict(&mut p).unwrap();
        assert!(Op::AddElse { device: 20, event: 2, parent: 0, before: 0 }.predict(&mut p.clone()).is_err(), "not after another Else");
        Op::AddConditional { device: 20, event: 2, parent: 0, before: 0, r#loop: true, condition: lamp_on, display: "While NAME is on".into() }
            .predict(&mut p)
            .unwrap();
        // Nothing between an If and its Else.
        let between = Op::AddControl { device: 20, event: 2, parent: 0, before: 3, control: Control::Stop };
        assert!(matches!(between.predict(&mut p.clone()), Err(OpError::Code(_))));
        Op::SetCodeEnabled { device: 20, event: 2, id: 2, enabled: false }.predict(&mut p).unwrap();
        let code = &p.programming["20:2"];
        let shape: Vec<(u32, usize, bool)> = code.iter().map(|c| (c.kind, c.children.len(), c.enabled)).collect();
        assert_eq!(shape, [(kind::CONDITIONAL, 1, true), (kind::ELSE, 0, true), (kind::LOOP, 0, true)]);
        assert!(!code[0].children[0].enabled);
        assert_eq!(code[0].text(&p), "If Receiver is on");

        // Moving the If to the end takes its Else along; an Else can't move on its own.
        Op::MoveCode { device: 20, event: 2, id: 1, parent: 0, before: 0 }.predict(&mut p).unwrap();
        let order: Vec<u32> = p.programming["20:2"].iter().map(|c| c.id).collect();
        assert_eq!(order, [4, 1, 3]);
        assert!(Op::MoveCode { device: 20, event: 2, id: 3, parent: 0, before: 4 }.predict(&mut p.clone()).is_err());
        assert!(Op::MoveCode { device: 20, event: 2, id: 1, parent: 1, before: 0 }.predict(&mut p.clone()).is_err(), "not into itself");
        // Into the While, as its first line.
        Op::MoveCode { device: 20, event: 2, id: 2, parent: 4, before: 0 }.predict(&mut p).unwrap();
        assert_eq!(p.programming["20:2"][0].children.len(), 1);
        // Removing the If removes its Else.
        Op::RemoveCode { device: 20, event: 2, id: 1 }.predict(&mut p).unwrap();
        assert_eq!(p.programming["20:2"].len(), 1);

        let en = Op::SetCodeEnabled { device: 20, event: 2, id: 2, enabled: true }.calls(None)[0].encode(false);
        assert!(en.contains(r#"<param name="enable" type="bool">1</param>"#), "{en}");
        let mv = Op::MoveCode { device: 20, event: 2, id: 2, parent: 4, before: 0 }.calls(None)[0].encode(false);
        assert!(mv.contains(r#"name="idnewparentcodeitem""#), "{mv}");
    }

    #[test]
    fn variable_lines_are_completed_from_the_project() {
        use crate::program::{VarAction, VarRef};
        let mut p = sample();
        p.variables.push(crate::model::Variable {
            device: 100001, id: 1125, name: "Garage Timer".into(), var_type: 4, readonly: false, hidden: false,
            description: String::new(), value: "0".into(),
        });
        let cat = crate::director::Catalog::default();
        let mut op = Op::AddVariableCommand {
            device: 20, event: 1, parent: 0, before: 0, variable: VarRef { device: 100001, id: 1125 },
            action: VarAction::Set { value: "true".into() }, display: String::new(), var_type: 0,
        };
        crate::program::complete(&mut op, &p, &cat).unwrap();
        let Op::AddVariableCommand { display, var_type, action, .. } = &op else { unreachable!() };
        assert_eq!((display.as_str(), *var_type), (r#"#!"{VNAME} = True";VNAME="VNAME:100001,1125""#, 4));
        assert_eq!(action, &VarAction::Set { value: "1".into() });
        op.predict(&mut p).unwrap();
        assert_eq!(p.programming["20:1"].last().unwrap().text(&p), "Garage Timer = True");
        let mut bad = Op::AddVariableCommand {
            device: 20, event: 1, parent: 0, before: 0, variable: VarRef { device: 100001, id: 1125 },
            action: VarAction::Add { value: "1".into() }, display: String::new(), var_type: 0,
        };
        assert!(crate::program::complete(&mut bad, &p, &cat).unwrap_err().contains("arithmetic"));
    }

    #[test]
    fn add_device_names_the_driver_parameter_by_file_type() {
        let c4i = Op::AddDevice { room: 1, name: "TV".into(), driver: "tv_Vizio_SV421XVT.c4i".into() }.calls(None);
        assert!(c4i[0].encode(false).contains(r#"<param name="c4i_name" type="string">tv_Vizio_SV421XVT.c4i</param>"#));
        let c4z = Op::AddDevice { room: 1, name: "AVR".into(), driver: "sony_strdn840.c4z".into() }.calls(None);
        assert!(c4z[0].encode(false).contains(r#"<param name="c4z_name" type="string">sony_strdn840.c4z</param>"#));
    }

    #[test]
    fn scheduler_entries_add_change_and_remove() {
        let mut before = sample();
        before.items.insert(100100, Item {
            id: 100100,
            name: "Scheduler".into(),
            kind: ItemKind::Agent,
            parent: before.root,
            children: vec![],
            driver: Some("control4_agent_scheduler.c4i".into()),
            properties: Default::default(),
        });
        let spec = |name: &str| crate::agents::ScheduleSpec {
            name: name.into(),
            enabled: true,
            time_base: crate::agents::TimeBase::Sunset,
            minutes: 0,
            randomize_minutes: 0,
            start_date: "2026-10-21".into(),
            start_on: None,
            repeat: crate::agents::Frequency::Daily,
            every: 1,
            days: vec![],
            end_date: None,
        };
        let mut after = before.clone();
        Op::AddScheduleEntry { agent: 100100, entry: spec("Porch") }.predict(&mut after).unwrap();
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let [Change::ScheduleAdded { name, when, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        assert_eq!((name.as_str(), when.as_str()), ("Porch", "Every day at Sunset, from 2026-10-21"));
        // Names are unique, as in Composer.
        assert!(Op::AddScheduleEntry { agent: 100100, entry: spec("porch") }.predict(&mut after.clone()).is_err());
        // Only Scheduler agents take entries.
        assert!(matches!(Op::AddScheduleEntry { agent: 20, entry: spec("x") }.predict(&mut after.clone()), Err(OpError::NotScheduler(20))));

        let before = after.clone();
        let mut later = spec("Porch");
        later.time_base = crate::agents::TimeBase::Clock;
        later.minutes = 1110;
        Op::ModifyScheduleEntry { agent: 100100, id: 1, entry: later, creator: 0, category: String::new() }.predict(&mut after).unwrap();
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let [Change::ScheduleChanged { field, from, to, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        assert_eq!((field.as_str(), from.as_str(), to.as_str()), ("time", "Sunset", "6:30 PM"));

        after.programming.insert(crate::model::event_key(100100, 1), sample().programming["20:1"].clone());
        Op::RemoveScheduleEntry { agent: 100100, id: 1 }.predict(&mut after).unwrap();
        assert!(after.schedules[&100100].is_empty() && !after.programming.contains_key("100100:1"), "its programming goes too");
        let call = Op::RemoveScheduleEntry { agent: 100100, id: 7 }.calls(None)[0].encode(false);
        assert!(call.contains("&lt;command&gt;DELETE_ENTRY") || call.contains("<command>DELETE_ENTRY"), "{call}");
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
