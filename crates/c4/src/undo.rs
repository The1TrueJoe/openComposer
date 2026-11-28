//! Undo: the ops that take a project back from what an applied change left to what it was.
//!
//! Worked out from the change's own ops and the project before and after it, so new ids
//! (a device, a programming line, a scene) are the ones Director really gave. The result is
//! an ordinary list of [`Op`]s, proposed and approved like any other change; this module
//! sends nothing.
//!
//! Not everything can be undone with ops. A removed device or programming line can't be put
//! back as it was (Director gives new ids and re-adding loses its settings and programming);
//! commands, actions, Zigbee and driver installs act on the world, not the project. Those
//! are listed in [`Undo::not_undone`] and the caller points at the restore point instead.

use std::collections::BTreeSet;

use crate::Project;
use crate::agents::{AgentData, AgentState, AnnouncementSpec};
use crate::model::{CodeItem, event_key, is_sensitive_property};
use crate::ops::Op;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Undo {
    /// What to propose, in order.
    pub ops: Vec<Op>,
    /// What these ops won't put back, worded for a person.
    pub not_undone: Vec<String>,
}

/// The project and agents at one moment.
pub struct State<'a> {
    pub project: &'a Project,
    pub agents: &'a AgentState,
}

/// Plan the undo of `ops`, which took `before` to `after`.
pub fn plan(ops: &[Op], before: State<'_>, after: State<'_>) -> Undo {
    let mut u = Undo::default();
    // Items the undo removes take their connections, bindings and programming with them;
    // undoing those separately would fail on the missing item.
    let removed = removed_items(ops, &before, &after);
    // Code lines are found per event, once, however many ops added to it.
    let mut code_events = BTreeSet::new();
    // Scenes this undo adds back, so two of them aren't predicted the same id.
    let mut scenes = after.agents.clone();
    for op in ops.iter().rev() {
        inverse(op, &before, &after, &removed, &mut code_events, &mut scenes, &mut u);
    }
    for item in &removed {
        u.ops.push(Op::RemoveItem { id: *item });
    }
    u
}

fn inverse(
    op: &Op,
    b: &State<'_>,
    a: &State<'_>,
    removed: &[u32],
    code_events: &mut BTreeSet<(u32, u32)>,
    scenes: &mut AgentState,
    u: &mut Undo,
) {
    let bp = b.project;
    let gone = |id: u32| removed.iter().any(|r| *r == id || a.project.subtree(*r).contains(&id));
    let name = |id: u32| bp.name_of(id);
    let mut skip = |why: String| u.not_undone.push(why);
    match op {
        Op::AddDevice { .. } | Op::AddRoom { .. } | Op::AddLocation { .. } => {} // in `removed`
        Op::RemoveItem { id } => skip(format!("“{}” was removed; Director can't put it back as it was", name(*id))),
        Op::RenameItem { id, .. } => {
            if let Some(it) = bp.item(*id) {
                u.ops.push(Op::RenameItem { id: *id, name: it.name.clone() });
            }
        }
        Op::MoveItem { id, .. } => match bp.item(*id).and_then(|i| i.parent) {
            Some(parent) => {
                let siblings = &bp.item(parent).map(|p| p.children.clone()).unwrap_or_default();
                let before = siblings.iter().position(|c| c == id).and_then(|i| siblings.get(i + 1)).copied();
                u.ops.push(Op::MoveItem { id: *id, parent, before });
            }
            None => skip(format!("“{}” had no place to move back to", name(*id))),
        },
        Op::AddConnection { consumer_device, consumer_binding, provider_device, class, .. } => {
            if !gone(*consumer_device) && !gone(*provider_device) {
                u.ops.push(Op::RemoveConnection { consumer_device: *consumer_device, consumer_binding: *consumer_binding, class: class.clone() });
            }
        }
        Op::RemoveConnection { consumer_device, consumer_binding, class } => {
            let was = bp
                .bindings
                .iter()
                .find(|x| x.consumer_device == *consumer_device && x.consumer_binding == *consumer_binding && x.classes.iter().any(|c| c == class));
            match was {
                Some(x) => u.ops.push(Op::AddConnection {
                    consumer_device: x.consumer_device,
                    consumer_binding: x.consumer_binding,
                    provider_device: x.provider_device,
                    provider_binding: x.provider_binding,
                    class: class.clone(),
                    consumer_name: x.consumer_name.clone(),
                }),
                None => skip(format!("a {class} connection on “{}” that wasn't in the project before", name(*consumer_device))),
            }
        }
        Op::AddNetworkBinding { device, binding, .. } => {
            // device 0 is the device added in the same change, which the undo removes anyway.
            if *device != 0 && !gone(*device) {
                u.ops.push(Op::RemoveNetworkBinding { device: *device, binding: *binding });
            }
        }
        Op::RemoveNetworkBinding { device, binding } => {
            match bp.network_bindings.iter().find(|n| n.device == *device && n.binding == *binding) {
                // SDDP identities are stored by USN, which is what AddNetworkBinding takes.
                Some(n) => u.ops.push(Op::AddNetworkBinding {
                    device: *device,
                    binding: *binding,
                    address_type: n.address_type,
                    address: if n.uuid.is_empty() { n.address.clone() } else { n.uuid.clone() },
                    search_type: n.search_type.clone(),
                }),
                None => skip(format!("the network identity of “{}”", name(*device))),
            }
        }
        Op::SetProperty { device, name: prop, .. } => {
            if gone(*device) {
                return;
            }
            match bp.item(*device).and_then(|i| i.properties.get(prop)) {
                // Director keeps these encrypted; what the project holds isn't what was typed.
                Some(_) if is_sensitive_property(prop) => skip(format!("“{prop}” on “{}” (a password; set it again by hand)", name(*device))),
                Some(v) => u.ops.push(Op::SetProperty { device: *device, name: prop.clone(), value: v.clone() }),
                None => skip(format!("“{prop}” on “{}” had no value before", name(*device))),
            }
        }
        Op::AddCode { device, event, .. }
        | Op::AddConditional { device, event, .. }
        | Op::AddElse { device, event, .. }
        | Op::AddControl { device, event, .. }
        | Op::AddVariableCommand { device, event, .. } => {
            if gone(*device) || !code_events.insert((*device, *event)) {
                return;
            }
            let key = event_key(*device, *event);
            let old: BTreeSet<u32> = bp.programming.get(&key).map(|c| all_ids(c)).unwrap_or_default();
            let mut new = Vec::new();
            if let Some(code) = a.project.programming.get(&key) {
                new_tops(code, &old, &mut new);
            }
            for id in new.into_iter().rev() {
                u.ops.push(Op::RemoveCode { device: *device, event: *event, id });
            }
        }
        Op::RemoveCode { device, .. } => skip(format!("a programming line removed from “{}”", name(*device))),
        Op::MoveCode { device, event, id, .. } => match bp.programming.get(&event_key(*device, *event)).and_then(|c| place(c, 0, *id)) {
            Some((parent, before)) => u.ops.push(Op::MoveCode { device: *device, event: *event, id: *id, parent, before }),
            None => skip(format!("where a line in “{}” programming was", name(*device))),
        },
        Op::SetCodeEnabled { device, event, id, .. } => {
            match bp.programming.get(&event_key(*device, *event)).and_then(|c| crate::program::find(c, *id)) {
                Some(line) => u.ops.push(Op::SetCodeEnabled { device: *device, event: *event, id: *id, enabled: line.enabled }),
                None => skip(format!("a line in “{}” programming", name(*device))),
            }
        }
        Op::SendCommand { device, command, .. } | Op::RunAction { device, command } => {
            skip(format!("“{command}” sent to “{}” (it acted on the device)", name(*device)))
        }
        Op::AddScheduleEntry { agent, entry } => match new_schedule(b, a, *agent, &entry.name) {
            Some(id) => u.ops.push(Op::RemoveScheduleEntry { agent: *agent, id }),
            None => skip(format!("the scheduled event “{}”", entry.name)),
        },
        Op::ModifyScheduleEntry { agent, id, .. } => match b.agents.schedules.get(agent).and_then(|s| s.iter().find(|e| e.id == *id)) {
            Some(e) => u.ops.push(Op::ModifyScheduleEntry {
                agent: *agent,
                id: *id,
                entry: e.spec.clone(),
                creator: e.creator,
                category: e.category.clone(),
            }),
            None => skip(format!("scheduled event #{id}")),
        },
        Op::RemoveScheduleEntry { agent, id } => match b.agents.schedules.get(agent).and_then(|s| s.iter().find(|e| e.id == *id)) {
            Some(e) => {
                u.ops.push(Op::AddScheduleEntry { agent: *agent, entry: e.spec.clone() });
                if has_code(bp, *agent, &[*id]) {
                    skip(format!("the programming of the scheduled event “{}”", e.spec.name));
                }
            }
            None => skip(format!("scheduled event #{id}")),
        },
        Op::AddLightingScene { agent, name: scene } => match new_record(b, a, *agent, scene) {
            Some(id) => u.ops.push(Op::RemoveLightingScene { agent: *agent, scene: id }),
            None => skip(format!("the lighting scene “{scene}”")),
        },
        Op::RenameLightingScene { agent, scene, .. } => match scene_of(b.agents, *agent, *scene) {
            Some(s) => u.ops.push(Op::RenameLightingScene { agent: *agent, scene: *scene, name: s.name.clone() }),
            None => skip(format!("lighting scene #{scene}")),
        },
        Op::RemoveLightingScene { agent, scene } => match scene_of(b.agents, *agent, *scene) {
            Some(s) => {
                // The agent numbers the scene again; `approvals` maps this id to the real one.
                let id = free_scene_id(scenes, *agent);
                if let Some(AgentData::Lighting { scenes }) = scenes.agent_data.get_mut(agent) {
                    scenes.push(crate::agents::LightingScene { id, members: vec![], ..s.clone() });
                }
                u.ops.push(Op::AddLightingScene { agent: *agent, name: s.name.clone() });
                for m in &s.members {
                    u.ops.push(set_light(*agent, id, m.device, m.steps.clone()));
                }
                if has_code(bp, *agent, &[scene * 5, scene * 5 + 1, scene * 5 + 4]) {
                    skip(format!("the programming of the lighting scene “{}”", s.name));
                }
            }
            None => skip(format!("lighting scene #{scene}")),
        },
        Op::SetSceneLight { agent, scene, light, .. } => {
            match scene_of(b.agents, *agent, *scene).map(|s| s.members.iter().find(|m| m.device == *light)) {
                Some(Some(m)) => u.ops.push(set_light(*agent, *scene, *light, m.steps.clone())),
                // In the scene before? No: it was added, so take it out. A new scene goes as a whole.
                Some(None) => u.ops.push(Op::RemoveSceneLight { agent: *agent, scene: *scene, light: *light }),
                None => {}
            }
        }
        Op::RemoveSceneLight { agent, scene, light } => {
            match scene_of(b.agents, *agent, *scene).and_then(|s| s.members.iter().find(|m| m.device == *light)) {
                Some(m) => u.ops.push(set_light(*agent, *scene, *light, m.steps.clone())),
                None => skip(format!("“{}” in lighting scene #{scene}", name(*light))),
            }
        }
        Op::AddAnnouncement { agent, announcement, .. } => match new_record(b, a, *agent, &announcement.name) {
            Some(id) => u.ops.push(Op::RemoveAnnouncement { agent: *agent, id }),
            None => skip(format!("the announcement “{}”", announcement.name)),
        },
        Op::ModifyAnnouncement { agent, id, .. } | Op::RemoveAnnouncement { agent, id } => {
            let was = match b.agents.agent_data.get(agent) {
                Some(AgentData::Announcements { announcements }) => announcements.iter().find(|x| x.id == *id),
                _ => None,
            };
            match (was, op) {
                (Some(x), Op::ModifyAnnouncement { .. }) => {
                    u.ops.push(Op::ModifyAnnouncement { agent: *agent, id: *id, announcement: AnnouncementSpec::of(x), xml: String::new() })
                }
                (Some(x), _) => {
                    u.ops.push(Op::AddAnnouncement { agent: *agent, announcement: AnnouncementSpec::of(x), xml: String::new() });
                    if has_code(bp, *agent, &[*id, *id + crate::agents::ANNOUNCEMENT_COMPLETE]) {
                        skip(format!("the programming of the announcement “{}”", x.name));
                    }
                }
                (None, _) => skip(format!("announcement #{id}")),
            }
        }
        Op::AddWakeSleepRoom { agent, room } => {
            let old = wake_rooms(b.agents, *agent);
            match wake_rooms(a.agents, *agent).into_iter().find(|(id, r)| *r == *room && !old.iter().any(|(o, _)| o == id)) {
                Some((id, _)) => u.ops.push(Op::RemoveWakeSleepRoom { agent: *agent, id }),
                None => skip(format!("Wake/Sleep in “{}”", name(*room))),
            }
        }
        Op::ModifyWakeSleepRoom { agent, id, .. } => match b.agents.agent_data.get(agent) {
            Some(AgentData::WakeSleep { rooms }) if rooms.iter().any(|w| w.id == *id) => {
                let w = rooms.iter().find(|w| w.id == *id).unwrap();
                u.ops.push(Op::ModifyWakeSleepRoom { agent: *agent, id: *id, settings: w.settings.clone(), room: w.room });
            }
            _ => skip(format!("Wake/Sleep room #{id}")),
        },
        Op::RemoveWakeSleepRoom { .. } => skip("a Wake/Sleep room that was removed (add it again; its settings were lost)".into()),
        Op::AddPushNotification { agent, template } => match new_record(b, a, *agent, &template.name) {
            Some(id) => u.ops.push(Op::RemovePushNotification { agent: *agent, id }),
            None => skip(format!("the push notification “{}”", template.name)),
        },
        Op::ModifyPushNotification { agent, id, .. } | Op::RemovePushNotification { agent, id } => {
            let was = match b.agents.agent_data.get(agent) {
                Some(AgentData::Push { templates, .. }) => templates.iter().find(|t| t.id == *id),
                _ => None,
            };
            match (was, op) {
                (Some(t), Op::ModifyPushNotification { .. }) => u.ops.push(Op::ModifyPushNotification { agent: *agent, id: *id, template: t.spec.clone() }),
                (Some(t), _) => u.ops.push(Op::AddPushNotification { agent: *agent, template: t.spec.clone() }),
                (None, _) => skip(format!("push notification #{id}")),
            }
        }
        Op::AddEmailTemplate { agent, template } => match new_record(b, a, *agent, &template.name) {
            Some(id) => u.ops.push(Op::RemoveEmailTemplate { agent: *agent, id }),
            None => skip(format!("the email notification “{}”", template.name)),
        },
        Op::ModifyEmailTemplate { agent, id, .. } | Op::RemoveEmailTemplate { agent, id } => {
            let was = match b.agents.agent_data.get(agent) {
                Some(AgentData::Email { templates }) => templates.iter().find(|t| t.id == *id),
                _ => None,
            };
            match (was, op) {
                (Some(t), Op::ModifyEmailTemplate { .. }) => u.ops.push(Op::ModifyEmailTemplate { agent: *agent, id: *id, template: t.spec.clone() }),
                (Some(t), _) => u.ops.push(Op::AddEmailTemplate { agent: *agent, template: t.spec.clone() }),
                (None, _) => skip(format!("email notification #{id}")),
            }
        }
        Op::InstallDriver { filename, .. } => skip(format!("the driver file {filename} stays on the controller")),
        Op::ZigbeeControl { .. } => skip("a Zigbee mesh action".into()),
        Op::LoadProject { label, .. } => skip(format!("loading {label} (load the restore point instead)")),
    }
}

/// Items the change added, as the top-level new items under where it added them.
fn removed_items(ops: &[Op], b: &State<'_>, a: &State<'_>) -> Vec<u32> {
    let mut out = Vec::new();
    for op in ops {
        let parent = match op {
            Op::AddDevice { room, .. } => *room,
            Op::AddRoom { floor, .. } => *floor,
            Op::AddLocation { parent, .. } => *parent,
            _ => continue,
        };
        let Some(p) = a.project.item(parent) else { continue };
        for c in &p.children {
            if !b.project.items.contains_key(c) && !out.contains(c) {
                out.push(*c);
            }
        }
    }
    out
}

fn all_ids(code: &[CodeItem]) -> BTreeSet<u32> {
    let mut v = Vec::new();
    crate::program::ids(code, &mut v);
    v.into_iter().collect()
}

/// New lines whose parent isn't new too (removing those takes their insides along).
fn new_tops(code: &[CodeItem], old: &BTreeSet<u32>, out: &mut Vec<u32>) {
    for (i, c) in code.iter().enumerate() {
        if old.contains(&c.id) {
            new_tops(&c.children, old, out);
        } else if !(c.kind == crate::program::kind::ELSE && i > 0 && !old.contains(&code[i - 1].id)) {
            // (An Else right after a new If goes when the If does.)
            out.push(c.id);
        }
    }
}

/// Where line `id` sits: its parent (0 = top level) and the line after it (0 = the end),
/// skipping the Else that travels with an If.
fn place(code: &[CodeItem], parent: u32, id: u32) -> Option<(u32, u32)> {
    if let Some(i) = code.iter().position(|c| c.id == id) {
        let mut next = i + 1;
        if code.get(next).is_some_and(|c| c.kind == crate::program::kind::ELSE) {
            next += 1;
        }
        return Some((parent, code.get(next).map(|c| c.id).unwrap_or(0)));
    }
    code.iter().find_map(|c| place(&c.children, c.id, id))
}

fn has_code(p: &Project, agent: u32, events: &[u32]) -> bool {
    events.iter().any(|e| p.programming.get(&event_key(agent, *e)).is_some_and(|c| !c.is_empty()))
}

fn new_schedule(b: &State<'_>, a: &State<'_>, agent: u32, name: &str) -> Option<u32> {
    let old: BTreeSet<u32> = b.agents.schedules.get(&agent).into_iter().flatten().map(|e| e.id).collect();
    a.agents.schedules.get(&agent)?.iter().find(|e| !old.contains(&e.id) && e.spec.name.trim().eq_ignore_ascii_case(name.trim())).map(|e| e.id)
}

/// The id of a record of `agent` named `name` that wasn't there before.
fn new_record(b: &State<'_>, a: &State<'_>, agent: u32, name: &str) -> Option<u32> {
    let ids = |s: &AgentState| -> Vec<(u32, String)> {
        match s.agent_data.get(&agent) {
            Some(AgentData::Lighting { scenes }) => scenes.iter().map(|x| (x.id, x.name.clone())).collect(),
            Some(AgentData::Announcements { announcements }) => announcements.iter().map(|x| (x.id, x.name.clone())).collect(),
            Some(AgentData::Push { templates, .. }) => templates.iter().map(|x| (x.id, x.spec.name.clone())).collect(),
            Some(AgentData::Email { templates }) => templates.iter().map(|x| (x.id, x.spec.name.clone())).collect(),
            _ => vec![],
        }
    };
    let old: BTreeSet<u32> = ids(b.agents).into_iter().map(|(id, _)| id).collect();
    ids(a.agents).into_iter().find(|(id, n)| !old.contains(id) && n.trim().eq_ignore_ascii_case(name.trim())).map(|(id, _)| id)
}

fn scene_of(s: &AgentState, agent: u32, scene: u32) -> Option<&crate::agents::LightingScene> {
    match s.agent_data.get(&agent) {
        Some(AgentData::Lighting { scenes }) => scenes.iter().find(|x| x.id == scene),
        _ => None,
    }
}

/// The id a new scene is predicted to get (the lowest free one, as `agent_ops` predicts).
pub fn free_scene_id(s: &AgentState, agent: u32) -> u32 {
    let used: BTreeSet<u32> = match s.agent_data.get(&agent) {
        Some(AgentData::Lighting { scenes }) => scenes.iter().map(|x| x.id).collect(),
        _ => BTreeSet::new(),
    };
    (0..).find(|i| !used.contains(i)).unwrap_or(0)
}

fn wake_rooms(s: &AgentState, agent: u32) -> Vec<(u32, u32)> {
    match s.agent_data.get(&agent) {
        Some(AgentData::WakeSleep { rooms }) => rooms.iter().map(|w| (w.id, w.room)).collect(),
        _ => vec![],
    }
}

fn set_light(agent: u32, scene: u32, light: u32, steps: Vec<crate::agents::LightStep>) -> Op {
    Op::SetSceneLight { agent, scene, light, steps, now: Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{LightStep, LightingMember, LightingScene};
    use crate::model::{Item, ItemKind};
    use crate::ops::LocationKind;

    fn project() -> Project {
        let mut p = Project::parse(include_str!("../tests/fixtures/sample-project.xml")).unwrap();
        for (id, name, kind, parent, driver) in [
            (7u32, "Advanced Lighting", ItemKind::Agent, None, "control4_agent_adv_lighting.c4i"),
            (900, "Lamp", ItemKind::Proxy, Some(11u32), "light_v2.c4i"),
            (901, "Pendant", ItemKind::Proxy, Some(11), "light_v2.c4i"),
        ] {
            p.items.insert(id, Item { id, name: name.into(), kind, parent, children: vec![], driver: Some(driver.into()), properties: Default::default() });
            if let Some(pp) = parent.and_then(|x| p.items.get_mut(&x)) {
                pp.children.push(id);
            }
        }
        p
    }

    fn step(level: u32) -> LightStep {
        LightStep { delay_ms: 0, level: Some(level), rate_ms: 1000, color: None }
    }

    fn agents() -> AgentState {
        let mut a = AgentState::default();
        let scene = LightingScene {
            id: 0,
            name: "Evening".into(),
            toggle_id: None,
            active: false,
            members: vec![LightingMember { device: 900, steps: vec![step(40)] }, LightingMember { device: 901, steps: vec![step(10)] }],
        };
        a.agent_data.insert(7, AgentData::Lighting { scenes: vec![scene] });
        a
    }

    fn run(p: &mut Project, a: &mut AgentState, ops: &[Op]) {
        for op in ops {
            let mut op = op.clone();
            op.prepare(p, a);
            op.predict(p, a).unwrap_or_else(|e| panic!("{op:?}: {e}"));
        }
    }

    /// Apply `ops`, then their undo; the project and agents are back where they started.
    fn round_trip(ops: &[Op]) -> Undo {
        let (p0, a0) = (project(), agents());
        let (mut p, mut a) = (p0.clone(), a0.clone());
        run(&mut p, &mut a, ops);
        let u = plan(ops, State { project: &p0, agents: &a0 }, State { project: &p, agents: &a });
        run(&mut p, &mut a, &u.ops);
        assert_eq!(p.items, p0.items, "items");
        assert_eq!(p.bindings, p0.bindings, "connections");
        // The address and status are Director's to resolve from the USN.
        let net = |p: &Project| p.network_bindings.iter().map(|n| (n.device, n.binding, n.uuid.clone(), n.search_type.clone())).collect::<Vec<_>>();
        assert_eq!(net(&p), net(&p0), "network");
        assert_eq!(p.programming, p0.programming, "programming");
        let names = |a: &AgentState| match a.agent_data.get(&7) {
            Some(AgentData::Lighting { scenes }) => scenes.iter().map(|s| (s.name.clone(), s.members.clone())).collect::<Vec<_>>(),
            _ => vec![],
        };
        assert_eq!(names(&a), names(&a0), "scenes");
        u
    }

    #[test]
    fn edits_go_back() {
        let u = round_trip(&[
            Op::RenameItem { id: 20, name: "Family TV".into() },
            Op::SetProperty { device: 20, name: "Debug Mode".into(), value: "On".into() },
            Op::MoveItem { id: 21, parent: 11, before: None },
            Op::RemoveConnection { consumer_device: 20, consumer_binding: 1000, class: "HDMI".into() },
            Op::RemoveNetworkBinding { device: 20, binding: 6001 },
        ]);
        assert!(u.not_undone.is_empty(), "{:?}", u.not_undone);
    }

    #[test]
    fn added_things_are_removed() {
        let u = round_trip(&[
            Op::AddDevice { room: 11, name: "Apple TV".into(), driver: "apple_tv.c4z".into() },
            Op::AddRoom { floor: 4, name: "Den".into() },
            Op::AddLocation { parent: 3, kind: LocationKind::Floor, name: "Upstairs".into() },
        ]);
        assert_eq!(u.ops.iter().filter(|o| matches!(o, Op::RemoveItem { .. })).count(), 3);
    }

    #[test]
    fn scenes_go_back_even_when_removed() {
        round_trip(&[
            Op::AddLightingScene { agent: 7, name: "Morning".into() },
            Op::SetSceneLight { agent: 7, scene: 0, light: 900, steps: vec![step(100)], now: Default::default() },
            Op::RemoveSceneLight { agent: 7, scene: 0, light: 901 },
            Op::RenameLightingScene { agent: 7, scene: 0, name: "Late".into() },
        ]);
        round_trip(&[Op::RemoveLightingScene { agent: 7, scene: 0 }]);
    }

    #[test]
    fn programming_goes_back() {
        use crate::program::{Condition, Control};
        let on = Condition::Device { target: 21, name: "LOAD_ON".into(), logic: None, params: vec![] };
        round_trip(&[
            Op::AddConditional { device: 20, event: 1, parent: 0, before: 1, r#loop: false, condition: on, display: "If NAME is on".into() },
            Op::AddElse { device: 20, event: 1, parent: 0, before: 1 },
            Op::AddControl { device: 20, event: 1, parent: 0, before: 0, control: Control::Delay { ms: 1000 } },
            Op::SetCodeEnabled { device: 20, event: 1, id: 2, enabled: false },
            Op::MoveCode { device: 20, event: 1, id: 1, parent: 0, before: 0 },
        ]);
    }

    #[test]
    fn removals_and_commands_are_reported() {
        let (p0, a0) = (project(), agents());
        let ops = [Op::RemoveItem { id: 21 }, Op::SendCommand { device: 20, command: "ON".into(), params: vec![] }];
        let (mut p, mut a) = (p0.clone(), a0.clone());
        run(&mut p, &mut a, &ops);
        let u = plan(&ops, State { project: &p0, agents: &a0 }, State { project: &p, agents: &a });
        assert!(u.ops.is_empty());
        assert_eq!(u.not_undone.len(), 2, "{:?}", u.not_undone);
    }
}
