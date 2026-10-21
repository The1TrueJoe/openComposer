//! The ops that change built-in agents other than the Scheduler: Advanced Lighting scenes,
//! Announcements, Wake/Sleep rooms, push and email notifications. Their variants live in
//! [`Op`]; this is how each predicts, validates, describes itself and what it sends.
//!
//! Every change is a `SendToDevice` to the agent with the agent's own command
//! (`NEW_SCENE`, `modify_announcement`, `MODIFY_TEMPLATE`, …), checked against the Virtual
//! Director. The agents keep their data in
//! the project (`Project::agent_data`), so a change is verified by reading the project back.
//!
//! Some calls need what the project holds now (how many steps a light has, the parts of an
//! announcement the spec doesn't cover). [`prepare`] fills those in from the snapshot the
//! change is predicted on; ops that weren't prepared fall back to what the op alone says.

use crate::Project;
use crate::agents::{self, AgentData, AgentKind, LightStep};
use crate::model::ItemKind;
use crate::ops::{Op, OpError};
use crate::soap::Call;

/// What a light has in a scene now, filled in by [`prepare`] for `SetSceneLight`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MemberNow {
    /// Not prepared: assume the light is in the scene with as many steps as asked for.
    #[default]
    Unknown,
    Absent,
    Steps(usize),
}

/// Steps a light can have in one scene; Composer has no limit, but more is a mistake.
const MAX_STEPS: usize = 20;

fn send(agent: u32, command: &str, params: &[(&str, &str, &str)]) -> Call {
    Call::new("SendToDevice").num("iddevice", agent).xml("data", agents::device_command(command, params))
}

fn bad(msg: impl Into<String>) -> OpError {
    OpError::BadAgentChange(msg.into())
}

/// The agent's data, or why `agent` isn't that kind of agent.
fn data_of<'a>(p: &'a mut Project, agent: u32, want: AgentKind) -> Result<&'a mut AgentData, OpError> {
    let it = p.item(agent).ok_or(OpError::NoSuchItem(agent))?;
    let kind = it.driver.as_deref().and_then(AgentKind::from_driver);
    if kind != Some(want) {
        return Err(OpError::WrongAgent { id: agent, name: it.name.clone(), want: want.title() });
    }
    Ok(p.agent_data.entry(agent).or_insert_with(|| AgentData::empty(want).expect("not the Scheduler")))
}

fn data_ref(p: &Project, agent: u32) -> Option<&AgentData> {
    p.agent_data.get(&agent)
}

fn unique(name: &str, taken: impl Iterator<Item = (u32, String)>, own: Option<u32>, what: &str) -> Result<(), OpError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(OpError::EmptyName);
    }
    if taken.into_iter().any(|(id, t)| Some(id) != own && t.trim().eq_ignore_ascii_case(n)) {
        return Err(bad(format!("there is already {what} named “{n}”")));
    }
    Ok(())
}

/// The lowest id no record uses: what the agents hand out.
fn free_id(used: impl Iterator<Item = u32>, from: u32) -> u32 {
    let used: std::collections::BTreeSet<u32> = used.collect();
    (from..).find(|i| !used.contains(i)).unwrap_or(from)
}

fn driver_of(p: &Project, id: u32) -> String {
    p.item(id).and_then(|i| i.driver.clone()).unwrap_or_default().to_ascii_lowercase()
}

/// The item, if it is a proxy whose driver is one of `drivers` (or starts with a `prefix*`).
fn expect_driver(p: &Project, id: u32, drivers: &[&str], what: &str) -> Result<(), OpError> {
    let it = p.item(id).ok_or(OpError::NoSuchItem(id))?;
    let d = driver_of(p, id);
    let ok = drivers.iter().any(|w| match w.strip_suffix('*') {
        Some(prefix) => d.starts_with(&prefix.to_ascii_lowercase()),
        None => d == w.to_ascii_lowercase(),
    });
    if ok {
        return Ok(());
    }
    let hint = match p.sole_proxy(id) {
        Some(px) => format!("; use its proxy #{} “{}”", px.id, px.name),
        None => String::new(),
    };
    Err(bad(format!("#{id} “{}” isn't {what}{hint}", it.name)))
}

fn drop_programming(p: &mut Project, agent: u32, events: &[u32]) {
    for e in events {
        p.programming.remove(&crate::model::event_key(agent, *e));
    }
}

/// Fill in what the op's calls need from the project it will be applied to.
pub fn prepare(op: &mut Op, p: &Project) {
    match op {
        Op::SetSceneLight { agent, scene, light, now, .. } => {
            *now = match data_ref(p, *agent) {
                Some(AgentData::Lighting { scenes }) => match scenes.iter().find(|s| s.id == *scene) {
                    Some(s) => match s.members.iter().find(|m| m.device == *light) {
                        Some(m) => MemberNow::Steps(m.steps.len()),
                        None => MemberNow::Absent,
                    },
                    None => MemberNow::Unknown,
                },
                _ => MemberNow::Unknown,
            };
        }
        Op::AddAnnouncement { announcement, xml, .. } => {
            *xml = announcement.to_xml(0, None, |id| room_id(p, id), |id| has_onscreen(p, id));
        }
        Op::ModifyAnnouncement { agent, id, announcement, xml } => {
            let current = match data_ref(p, *agent) {
                Some(AgentData::Announcements { announcements }) => announcements.iter().find(|a| a.id == *id),
                _ => None,
            };
            *xml = announcement.to_xml(*id, current, |id| room_id(p, id), |id| has_onscreen(p, id));
        }
        Op::ModifyWakeSleepRoom { agent, id, room, .. } => {
            if let Some(AgentData::WakeSleep { rooms }) = data_ref(p, *agent) {
                if let Some(w) = rooms.iter().find(|w| w.id == *id) {
                    *room = w.room;
                }
            }
        }
        _ => {}
    }
}

/// A touchscreen's navigator: the `uidevice.c4i` proxy of a touchscreen (not the one under
/// a controller, which is the controller's own on-screen UI).
pub fn is_touchscreen(p: &Project, id: u32) -> bool {
    let parent = p.item(id).and_then(|i| i.parent);
    driver_of(p, id) == "uidevice.c4i" && parent.is_some_and(|x| driver_of(p, x).starts_with("uidevice_"))
}

/// What can show an announcement, as Composer stores it: a controller (its `controller.c4i`
/// proxy, shown on its video output) or a touchscreen.
pub fn is_navigator(p: &Project, id: u32) -> bool {
    driver_of(p, id) == "controller.c4i" || is_touchscreen(p, id)
}

fn room_id(p: &Project, id: u32) -> u32 {
    p.room_of(id).map(|r| r.id).unwrap_or(0)
}

/// Controllers show announcements on their video outputs; touchscreens don't have one.
fn has_onscreen(p: &Project, id: u32) -> bool {
    !driver_of(p, id).starts_with("uidevice")
}

/// One line for an approval card, or `None` for ops that aren't agent ops.
pub fn describe(op: &Op, p: &Project) -> Option<String> {
    let n = |id: u32| format!("“{}”", p.name_of(id));
    let scene_name = |agent: u32, scene: u32| match data_ref(p, agent) {
        Some(AgentData::Lighting { scenes }) => scenes.iter().find(|s| s.id == scene).map(|s| format!("“{}”", s.name)),
        _ => None,
    }
    .unwrap_or_else(|| format!("#{scene}"));
    let ann_name = |agent: u32, id: u32| match data_ref(p, agent) {
        Some(AgentData::Announcements { announcements }) => announcements.iter().find(|a| a.id == id).map(|a| format!("“{}”", a.name)),
        _ => None,
    }
    .unwrap_or_else(|| format!("#{id}"));
    let ws_room = |agent: u32, id: u32| match data_ref(p, agent) {
        Some(AgentData::WakeSleep { rooms }) => rooms.iter().find(|w| w.id == id).map(|w| n(w.room)),
        _ => None,
    }
    .unwrap_or_else(|| format!("#{id}"));
    let push_name = |agent: u32, id: u32| match data_ref(p, agent) {
        Some(AgentData::Push { templates, .. }) => templates.iter().find(|t| t.id == id).map(|t| format!("“{}”", t.spec.name)),
        _ => None,
    }
    .unwrap_or_else(|| format!("#{id}"));
    let email_name = |agent: u32, id: u32| match data_ref(p, agent) {
        Some(AgentData::Email { templates }) => templates.iter().find(|t| t.id == id).map(|t| format!("“{}”", t.spec.name)),
        _ => None,
    }
    .unwrap_or_else(|| format!("#{id}"));
    Some(match op {
        Op::AddLightingScene { name, .. } => format!("Add Advanced Lighting scene “{name}”"),
        Op::RenameLightingScene { agent, scene, name } => format!("Rename lighting scene {} to “{name}”", scene_name(*agent, *scene)),
        Op::RemoveLightingScene { agent, scene } => format!("Remove lighting scene {}", scene_name(*agent, *scene)),
        Op::SetSceneLight { agent, scene, light, steps, .. } => {
            let what: Vec<String> = steps.iter().map(LightStep::text).collect();
            format!("Set {} in lighting scene {}: {}", n(*light), scene_name(*agent, *scene), what.join(" → "))
        }
        Op::RemoveSceneLight { agent, scene, light } => format!("Remove {} from lighting scene {}", n(*light), scene_name(*agent, *scene)),
        Op::AddAnnouncement { announcement, .. } => format!("Add announcement “{}”", announcement.name),
        Op::ModifyAnnouncement { agent, id, .. } => format!("Change announcement {}", ann_name(*agent, *id)),
        Op::RemoveAnnouncement { agent, id } => format!("Remove announcement {}", ann_name(*agent, *id)),
        Op::AddWakeSleepRoom { room, .. } => format!("Set up Wake/Sleep in {}", n(*room)),
        Op::ModifyWakeSleepRoom { agent, id, .. } => format!("Change the Wake/Sleep defaults of {}", ws_room(*agent, *id)),
        Op::RemoveWakeSleepRoom { agent, id } => format!("Remove Wake/Sleep from {}", ws_room(*agent, *id)),
        Op::AddPushNotification { template, .. } => format!("Add push notification “{}”", template.name),
        Op::ModifyPushNotification { agent, id, .. } => format!("Change push notification {}", push_name(*agent, *id)),
        Op::RemovePushNotification { agent, id } => format!("Remove push notification {}", push_name(*agent, *id)),
        Op::AddEmailTemplate { template, .. } => format!("Add email notification “{}”", template.name),
        Op::ModifyEmailTemplate { agent, id, .. } => format!("Change email notification {}", email_name(*agent, *id)),
        Op::RemoveEmailTemplate { agent, id } => format!("Remove email notification {}", email_name(*agent, *id)),
        _ => return None,
    })
}

/// Apply to a copy of the project, refusing what Composer's editors refuse. `None` for ops
/// that aren't agent ops.
pub fn predict(op: &Op, p: &mut Project) -> Option<Result<(), OpError>> {
    Some(match op {
        Op::AddLightingScene { .. }
        | Op::RenameLightingScene { .. }
        | Op::RemoveLightingScene { .. }
        | Op::SetSceneLight { .. }
        | Op::RemoveSceneLight { .. } => lighting(op, p),
        Op::AddAnnouncement { .. } | Op::ModifyAnnouncement { .. } | Op::RemoveAnnouncement { .. } => announcements(op, p),
        Op::AddWakeSleepRoom { .. } | Op::ModifyWakeSleepRoom { .. } | Op::RemoveWakeSleepRoom { .. } => wake_sleep(op, p),
        Op::AddPushNotification { .. } | Op::ModifyPushNotification { .. } | Op::RemovePushNotification { .. } => push(op, p),
        Op::AddEmailTemplate { .. } | Op::ModifyEmailTemplate { .. } | Op::RemoveEmailTemplate { .. } => email(op, p),
        _ => return None,
    })
}

fn lighting(op: &Op, p: &mut Project) -> Result<(), OpError> {
    let agent = match op {
        Op::AddLightingScene { agent, .. }
        | Op::RenameLightingScene { agent, .. }
        | Op::RemoveLightingScene { agent, .. }
        | Op::SetSceneLight { agent, .. }
        | Op::RemoveSceneLight { agent, .. } => *agent,
        _ => unreachable!(),
    };
    // Lights are checked against the project before its agent data is borrowed.
    if let Op::SetSceneLight { light, steps, .. } = op {
        expect_driver(p, *light, &agents::SCENE_LIGHT_DRIVERS, "a light, fan or blind that Advanced Lighting can use")?;
        if steps.is_empty() || steps.len() > MAX_STEPS {
            return Err(bad(format!("a light needs 1–{MAX_STEPS} steps in a scene (got {})", steps.len())));
        }
        for (i, s) in steps.iter().enumerate() {
            s.validate().map_err(|e| bad(format!("step {}: {e}", i + 1)))?;
        }
    }
    let AgentData::Lighting { scenes } = data_of(p, agent, AgentKind::AdvancedLighting)? else { unreachable!() };
    let names = |scenes: &Vec<agents::LightingScene>| scenes.iter().map(|s| (s.id, s.name.clone())).collect::<Vec<_>>();
    let no_scene = |id: u32| bad(format!("Advanced Lighting has no scene #{id}"));
    let mut gone_events = vec![];
    match op {
        Op::AddLightingScene { name, .. } => {
            unique(name, names(scenes).into_iter(), None, "a lighting scene")?;
            let id = free_id(scenes.iter().map(|s| s.id), 0);
            scenes.push(agents::LightingScene { id, name: name.trim().into(), toggle_id: None, active: false, members: vec![] });
        }
        Op::RenameLightingScene { scene, name, .. } => {
            unique(name, names(scenes).into_iter(), Some(*scene), "a lighting scene")?;
            scenes.iter_mut().find(|s| s.id == *scene).ok_or_else(|| no_scene(*scene))?.name = name.trim().into();
        }
        Op::RemoveLightingScene { scene, .. } => {
            let pos = scenes.iter().position(|s| s.id == *scene).ok_or_else(|| no_scene(*scene))?;
            scenes.remove(pos);
            // A toggle companion pointing at it no longer has one.
            for s in scenes.iter_mut().filter(|s| s.toggle_id == Some(*scene)) {
                s.toggle_id = None;
            }
            gone_events = vec![scene * 5, scene * 5 + 1, scene * 5 + 4];
        }
        Op::SetSceneLight { scene, light, steps, .. } => {
            let s = scenes.iter_mut().find(|s| s.id == *scene).ok_or_else(|| no_scene(*scene))?;
            match s.members.iter_mut().find(|m| m.device == *light) {
                Some(m) => m.steps = steps.clone(),
                None => s.members.push(agents::LightingMember { device: *light, steps: steps.clone() }),
            }
        }
        Op::RemoveSceneLight { scene, light, .. } => {
            let s = scenes.iter_mut().find(|s| s.id == *scene).ok_or_else(|| no_scene(*scene))?;
            let pos = s.members.iter().position(|m| m.device == *light).ok_or_else(|| bad(format!("#{light} isn't in scene “{}”", s.name)))?;
            s.members.remove(pos);
        }
        _ => unreachable!(),
    }
    drop_programming(p, agent, &gone_events);
    Ok(())
}

fn announcements(op: &Op, p: &mut Project) -> Result<(), OpError> {
    let (agent, spec) = match op {
        Op::AddAnnouncement { agent, announcement, .. } | Op::ModifyAnnouncement { agent, announcement, .. } => (*agent, Some(announcement)),
        Op::RemoveAnnouncement { agent, .. } => (*agent, None),
        _ => unreachable!(),
    };
    if let Some(s) = spec {
        if !agents::DISPLAY_SECONDS.contains(&s.display_seconds) {
            return Err(bad(format!("an announcement stays on screen for one of {:?} seconds (got {})", agents::DISPLAY_SECONDS, s.display_seconds)));
        }
        if s.audio.as_deref().is_some_and(|a| a.trim().is_empty()) || s.image.as_deref().is_some_and(|a| a.trim().is_empty()) {
            return Err(bad("leave the sound or image out rather than empty"));
        }
        for r in &s.rooms {
            let it = p.item(r.id).ok_or(OpError::NoSuchItem(r.id))?;
            if it.kind != ItemKind::Room {
                return Err(bad(format!("announcements play in rooms; #{} “{}” isn't one", r.id, it.name)));
            }
        }
        for v in s.rooms.iter().chain(&s.touchscreen_audio) {
            if v.volume.is_some_and(|v| v > 100) {
                return Err(bad("a volume is 0–100"));
            }
        }
        let name = |id: u32| p.item(id).map(|i| i.name.clone()).ok_or(OpError::NoSuchItem(id));
        for id in &s.screens {
            if !is_navigator(p, *id) {
                return Err(bad(format!("#{id} “{}” can't show announcements: give a controller's or touchscreen's proxy (agent_view lists them)", name(*id)?)));
            }
        }
        for t in &s.touchscreen_audio {
            if !is_touchscreen(p, t.id) {
                return Err(bad(format!("#{} “{}” isn't a touchscreen's proxy (agent_view lists them)", t.id, name(t.id)?)));
            }
        }
    }
    let AgentData::Announcements { announcements } = data_of(p, agent, AgentKind::Announcements)? else { unreachable!() };
    let names: Vec<(u32, String)> = announcements.iter().map(|a| (a.id, a.name.clone())).collect();
    let no_such = |id: u32| bad(format!("there is no announcement #{id}"));
    let mut gone = vec![];
    match op {
        Op::AddAnnouncement { announcement, xml, .. } => {
            unique(&announcement.name, names.into_iter(), None, "an announcement")?;
            if announcement.image.iter().chain(&announcement.audio).any(|v| v.contains(agents::MASK)) {
                return Err(bad(format!("a new announcement's image or sound can't contain “{}”; give the whole URL", agents::MASK)));
            }
            let id = free_id(announcements.iter().map(|a| a.id), 1);
            announcements.push(model_announcement(id, xml, announcement));
        }
        Op::ModifyAnnouncement { id, announcement, xml, .. } => {
            unique(&announcement.name, names.into_iter(), Some(*id), "an announcement")?;
            let a = announcements.iter_mut().find(|a| a.id == *id).ok_or_else(|| no_such(*id))?;
            *a = model_announcement(*id, xml, announcement);
        }
        Op::RemoveAnnouncement { id, .. } => {
            let pos = announcements.iter().position(|a| a.id == *id).ok_or_else(|| no_such(*id))?;
            announcements.remove(pos);
            gone = vec![*id, *id + agents::ANNOUNCEMENT_COMPLETE];
        }
        _ => unreachable!(),
    }
    drop_programming(p, agent, &gone);
    Ok(())
}

/// The announcement as the agent will store it: parsed back from the XML that is sent
/// (so masking and defaults match a re-read), or from the spec when unprepared.
fn model_announcement(id: u32, xml: &str, s: &agents::AnnouncementSpec) -> agents::Announcement {
    let sent = if xml.is_empty() { s.to_xml(id, None, |_| 0, |_| true) } else { xml.to_string() };
    let mut a = agents::parse_announcements(&format!("<announcements>{sent}</announcements>")).pop().expect("built announcement parses");
    a.id = id;
    a
}

fn wake_sleep(op: &Op, p: &mut Project) -> Result<(), OpError> {
    let agent = match op {
        Op::AddWakeSleepRoom { agent, .. } | Op::ModifyWakeSleepRoom { agent, .. } | Op::RemoveWakeSleepRoom { agent, .. } => *agent,
        _ => unreachable!(),
    };
    match op {
        Op::AddWakeSleepRoom { room, .. } => {
            let it = p.item(*room).ok_or(OpError::NoSuchItem(*room))?;
            if it.kind != ItemKind::Room {
                return Err(bad(format!("Wake/Sleep is set up per room; #{room} “{}” isn't one", it.name)));
            }
        }
        Op::ModifyWakeSleepRoom { settings, .. } => {
            settings.validate().map_err(bad)?;
            if settings.lights.light != 0 {
                expect_driver(p, settings.lights.light, &["light.c4i", "light_v2.c4i", "outlet_light.c4i"], "a light")?;
            }
            if settings.blinds.blind != 0 {
                expect_driver(p, settings.blinds.blind, &["blind.c4i", "blindV2.c4i"], "a blind")?;
            }
            if settings.media.source != 0 {
                p.item(settings.media.source).ok_or(OpError::NoSuchItem(settings.media.source))?;
            }
        }
        _ => {}
    }
    let AgentData::WakeSleep { rooms } = data_of(p, agent, AgentKind::WakeSleep)? else { unreachable!() };
    let no_such = |id: u32| bad(format!("Wake/Sleep has no room setup #{id}"));
    match op {
        Op::AddWakeSleepRoom { room, .. } => {
            if rooms.iter().any(|w| w.room == *room) {
                return Err(bad("that room already has Wake/Sleep"));
            }
            let id = free_id(rooms.iter().map(|w| w.id), 1);
            rooms.push(agents::WakeSleepScene { id, room: *room, settings: agents::WakeSleepSpec::default() });
        }
        Op::ModifyWakeSleepRoom { id, settings, .. } => {
            rooms.iter_mut().find(|w| w.id == *id).ok_or_else(|| no_such(*id))?.settings = settings.clone();
        }
        Op::RemoveWakeSleepRoom { id, .. } => {
            let pos = rooms.iter().position(|w| w.id == *id).ok_or_else(|| no_such(*id))?;
            rooms.remove(pos);
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn push(op: &Op, p: &mut Project) -> Result<(), OpError> {
    let (agent, spec) = match op {
        Op::AddPushNotification { agent, template } | Op::ModifyPushNotification { agent, template, .. } => (*agent, Some(template)),
        Op::RemovePushNotification { agent, .. } => (*agent, None),
        _ => unreachable!(),
    };
    for a in spec.iter().flat_map(|s| &s.attachments) {
        p.item(a.owner).ok_or(OpError::NoSuchItem(a.owner))?;
    }
    let AgentData::Push { templates, categories, severities } = data_of(p, agent, AgentKind::PushNotification)? else { unreachable!() };
    if let Some(s) = spec {
        for (what, v, list) in [("category", s.category, &*categories), ("severity", s.severity, &*severities)] {
            if v != 0 && !list.is_empty() && !list.iter().any(|(i, _)| *i == v) {
                let have: Vec<String> = list.iter().map(|(i, n)| format!("{i} {n}")).collect();
                return Err(bad(format!("there is no {what} {v}; the agent has: {}", have.join(", "))));
            }
        }
    }
    let names: Vec<(u32, String)> = templates.iter().map(|t| (t.id, t.spec.name.clone())).collect();
    let no_such = |id: u32| bad(format!("there is no push notification #{id}"));
    match op {
        Op::AddPushNotification { template, .. } => {
            unique(&template.name, names.into_iter(), None, "a push notification")?;
            // The notification agents count up rather than reuse ids.
            let id = templates.iter().map(|t| t.id + 1).max().unwrap_or(1);
            templates.push(agents::NotificationTemplate { id, spec: trimmed_push(template) });
        }
        Op::ModifyPushNotification { id, template, .. } => {
            unique(&template.name, names.into_iter(), Some(*id), "a push notification")?;
            templates.iter_mut().find(|t| t.id == *id).ok_or_else(|| no_such(*id))?.spec = trimmed_push(template);
        }
        Op::RemovePushNotification { id, .. } => {
            let pos = templates.iter().position(|t| t.id == *id).ok_or_else(|| no_such(*id))?;
            templates.remove(pos);
        }
        _ => unreachable!(),
    }
    Ok(())
}

/// Stored text comes back trimmed; predict the same.
fn trimmed_push(s: &agents::PushTemplateSpec) -> agents::PushTemplateSpec {
    agents::PushTemplateSpec { name: s.name.trim().into(), subject: s.subject.trim().into(), message: s.message.trim().into(), ..s.clone() }
}

fn email(op: &Op, p: &mut Project) -> Result<(), OpError> {
    let (agent, spec) = match op {
        Op::AddEmailTemplate { agent, template } | Op::ModifyEmailTemplate { agent, template, .. } => (*agent, Some(template)),
        Op::RemoveEmailTemplate { agent, .. } => (*agent, None),
        _ => unreachable!(),
    };
    if let Some(s) = spec {
        if let Some(bad_addr) = s.to.split([',', ';']).map(str::trim).find(|a| !a.is_empty() && !a.contains('@')) {
            return Err(bad(format!("“{bad_addr}” isn't an email address")));
        }
    }
    let AgentData::Email { templates } = data_of(p, agent, AgentKind::EmailNotification)? else { unreachable!() };
    let names: Vec<(u32, String)> = templates.iter().map(|t| (t.id, t.spec.name.clone())).collect();
    let no_such = |id: u32| bad(format!("there is no email notification #{id}"));
    let trimmed = |s: &agents::EmailTemplateSpec| agents::EmailTemplateSpec {
        name: s.name.trim().into(),
        to: s.to.trim().into(),
        subject: s.subject.trim().into(),
        body: s.body.trim().into(),
        timestamp: s.timestamp,
    };
    match op {
        Op::AddEmailTemplate { template, .. } => {
            unique(&template.name, names.into_iter(), None, "an email notification")?;
            let id = templates.iter().map(|t| t.id + 1).max().unwrap_or(1);
            templates.push(agents::EmailTemplate { id, spec: trimmed(template) });
        }
        Op::ModifyEmailTemplate { id, template, .. } => {
            unique(&template.name, names.into_iter(), Some(*id), "an email notification")?;
            templates.iter_mut().find(|t| t.id == *id).ok_or_else(|| no_such(*id))?.spec = trimmed(template);
        }
        Op::RemoveEmailTemplate { id, .. } => {
            let pos = templates.iter().position(|t| t.id == *id).ok_or_else(|| no_such(*id))?;
            templates.remove(pos);
        }
        _ => unreachable!(),
    }
    Ok(())
}

/// What the agent is sent, or `None` for ops that aren't agent ops.
pub fn calls(op: &Op) -> Option<Vec<Call>> {
    let int = |v: u32| v.to_string();
    Some(match op {
        Op::AddLightingScene { agent, name } => vec![send(*agent, "NEW_SCENE", &[("name", "STRING", name.trim())])],
        Op::RenameLightingScene { agent, scene, name } => {
            vec![send(*agent, "EDIT_SCENE", &[("SCENE_ID", "INTEGER", &int(*scene)), ("RENAME", "STRING", name.trim())])]
        }
        Op::RemoveLightingScene { agent, scene } => vec![send(*agent, "DELETE_SCENE", &[("SCENE_ID", "INTEGER", &int(*scene))])],
        Op::SetSceneLight { agent, scene, light, steps, now } => scene_light_calls(*agent, *scene, *light, steps, *now),
        Op::RemoveSceneLight { agent, scene, light } => {
            vec![send(*agent, "DELETE_MEMBER", &[("SCENE_ID", "INTEGER", &int(*scene)), ("MEMBER_ID", "INTEGER", &int(*light))])]
        }
        Op::AddAnnouncement { agent, announcement, xml } => {
            let x = if xml.is_empty() { announcement.to_xml(0, None, |_| 0, |_| true) } else { xml.clone() };
            vec![send(*agent, "add_announcement", &[("announcement", "XML", &x)])]
        }
        Op::ModifyAnnouncement { agent, id, announcement, xml } => {
            let x = if xml.is_empty() { announcement.to_xml(*id, None, |_| 0, |_| true) } else { xml.clone() };
            vec![send(*agent, "modify_announcement", &[("announcement", "XML", &x)])]
        }
        Op::RemoveAnnouncement { agent, id } => vec![send(*agent, "remove_announcement", &[("id", "INTEGER", &int(*id))])],
        Op::AddWakeSleepRoom { agent, room } => {
            vec![send(*agent, "ADD_WAKEUPGOODNIGHTSCENE", &[("scene", "STRING", &agents::WakeSleepSpec::default().to_xml(0, *room, false))])]
        }
        Op::ModifyWakeSleepRoom { agent, id, settings, room } => {
            vec![send(*agent, "MODIFY_WAKEUPGOODNIGHTSCENE", &[("scene", "STRING", &settings.to_xml(*id, *room, true))])]
        }
        Op::RemoveWakeSleepRoom { agent, id } => vec![send(*agent, "DELETE_WAKEUPGOODNIGHTSCENE", &[("sceneid", "INTEGER", &int(*id))])],
        Op::AddPushNotification { agent, template } => {
            vec![send(*agent, "ADD_TEMPLATE", &[("TEMPLATE_XML", "XML", &trimmed_push(template).to_xml(0))])]
        }
        Op::ModifyPushNotification { agent, id, template } => {
            vec![send(*agent, "MODIFY_TEMPLATE", &[("TEMPLATE_XML", "XML", &trimmed_push(template).to_xml(*id))])]
        }
        Op::RemovePushNotification { agent, id } | Op::RemoveEmailTemplate { agent, id } => {
            vec![send(*agent, "DELETE_TEMPLATE", &[("TEMPLATE_ID", "INT", &int(*id))])]
        }
        Op::AddEmailTemplate { agent, template } => vec![send(*agent, "ADD_TEMPLATE", &[("TEMPLATE_XML", "XML", &template.to_xml(0))])],
        Op::ModifyEmailTemplate { agent, id, template } => vec![send(
            *agent,
            "MODIFY_TEMPLATE",
            &[("TEMPLATE_ID", "INT", &int(*id)), ("TEMPLATE_XML", "XML", &template.to_xml(*id))],
        )],
        _ => return None,
    })
}

/// Composer's scene editor, one property at a time: add the light if it isn't in the
/// scene (which gives it one step), add or delete steps to match, then set every step.
fn scene_light_calls(agent: u32, scene: u32, light: u32, steps: &[LightStep], now: MemberNow) -> Vec<Call> {
    let (sid, lid) = (scene.to_string(), light.to_string());
    let mut out = Vec::new();
    let have = match now {
        MemberNow::Unknown => steps.len(),
        MemberNow::Absent => {
            out.push(send(agent, "ADD_MEMBERS", &[("SCENE_ID", "INTEGER", &sid), ("members", "STRING", &format!("<MEMBER_ID>{light}</MEMBER_ID>"))]));
            1
        }
        MemberNow::Steps(n) => n,
    };
    for _ in have..steps.len() {
        out.push(send(agent, "ADD_ELEMENT", &[("SCENE_ID", "INTEGER", &sid), ("MEMBER_ID", "INTEGER", &lid)]));
    }
    for i in (steps.len()..have).rev() {
        out.push(send(agent, "DELETE_ELEMENT", &[("SCENE_ID", "INTEGER", &sid), ("MEMBER_ID", "INTEGER", &lid), ("ELEMENT_ID", "INTEGER", &i.to_string())]));
    }
    let tf = |b: bool| if b { "True" } else { "False" };
    for (i, s) in steps.iter().enumerate() {
        let eid = i.to_string();
        let edit = |props: &[(&str, &str)]| {
            let mut ps = vec![("SCENE_ID", "INTEGER", sid.as_str()), ("MEMBER_ID", "INTEGER", lid.as_str()), ("ELEMENT_ID", "INTEGER", eid.as_str())];
            ps.extend(props.iter().map(|(k, v)| (*k, "STRING", *v)));
            send(agent, "EDIT_ELEMENT", &ps)
        };
        out.push(edit(&[("delay", &s.delay_ms.to_string())]));
        out.push(edit(&[("level_enabled", tf(s.level.is_some()))]));
        if let Some(l) = s.level {
            out.push(edit(&[("level", &l.to_string())]));
        }
        // The agent sets the colour's rate along with the level's; the colour's own is set too
        // for a step that only changes colour.
        out.push(edit(&[("level_rate", &s.rate_ms.to_string())]));
        out.push(edit(&[("color_enabled", tf(s.color.is_some()))]));
        if let Some(c) = s.color {
            let (x, y, mode) = c.to_xy();
            out.push(edit(&[("color_mode", &mode.to_string())]));
            out.push(edit(&[("color_x", &agents::coord(x)), ("color_y", &agents::coord(y))]));
            out.push(edit(&[("color_rate", &s.rate_ms.to_string())]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{LightColor, LightStep};
    use crate::diff::{Change, DiffOptions, diff};
    use crate::model::{Item, Names};

    fn project() -> Project {
        let mut p = Project::parse(include_str!("../tests/fixtures/sample-project.xml")).unwrap();
        let mut add = |id: u32, name: &str, kind: ItemKind, parent: Option<u32>, driver: &str| {
            p.items.insert(id, Item { id, name: name.into(), kind, parent, children: vec![], driver: Some(driver.into()), properties: Default::default() });
            if let Some(pp) = parent.and_then(|x| p.items.get_mut(&x)) {
                pp.children.push(id);
            }
        };
        add(3, "Advanced Lighting", ItemKind::Agent, None, "control4_agent_adv_lighting.c4i");
        add(4, "Announcements", ItemKind::Agent, None, "control4_agent_announcements.c4i");
        add(5, "Wake/Sleep", ItemKind::Agent, None, "control4_agent_wakeup_goodnight.c4i");
        add(6, "Push Notification", ItemKind::Agent, None, "control4_agent_notification.c4i");
        add(7, "Email Notification", ItemKind::Agent, None, "control4_agent_emailnotification.c4i");
        add(900, "Lamp", ItemKind::Proxy, Some(11), "light_v2.c4i");
        add(902, "T3 Touch Screen", ItemKind::Device, Some(11), "uidevice_glassedge7.c4i");
        add(901, "Kitchen Touchscreen", ItemKind::Proxy, Some(902), "uidevice.c4i");
        p
    }

    fn apply(p: &mut Project, mut op: Op) -> Result<(), OpError> {
        prepare(&mut op, p);
        op.predict(p)
    }

    fn step(level: u32, kelvin: Option<u32>) -> LightStep {
        LightStep { delay_ms: 0, level: Some(level), rate_ms: 2000, color: kelvin.map(|kelvin| LightColor::Temperature { kelvin }) }
    }

    #[test]
    fn lighting_scenes_are_made_lit_and_removed() {
        let before = project();
        let mut p = before.clone();
        apply(&mut p, Op::AddLightingScene { agent: 3, name: "Evening".into() }).unwrap();
        assert!(apply(&mut p.clone(), Op::AddLightingScene { agent: 3, name: "evening".into() }).is_err(), "names are unique");
        let mut set = Op::SetSceneLight { agent: 3, scene: 0, light: 900, steps: vec![step(40, Some(2700))], now: MemberNow::Unknown };
        prepare(&mut set, &p);
        // Not in the scene yet: added (one step), then set.
        let calls: Vec<String> = set.calls(None).iter().map(|c| c.encode(false)).collect();
        assert!(calls[0].contains("ADD_MEMBERS") && calls.iter().any(|c| c.contains("level&lt;/name") || c.contains("<name>level</name>")), "{calls:?}");
        set.predict(&mut p).unwrap();
        let d = diff(&before, &p, &Names::default(), DiffOptions::default());
        let [Change::AgentRecordAdded { what, name, details, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        assert_eq!((what.as_str(), name.as_str()), ("lighting scene", "Evening"));
        assert_eq!(details[0], ("Lamp (Kitchen)".to_string(), "40%, 2700 K over 2 s".to_string()));

        // Two steps where it had one: one ADD_ELEMENT.
        let mut two = Op::SetSceneLight { agent: 3, scene: 0, light: 900, steps: vec![step(40, None), step(0, None)], now: MemberNow::Unknown };
        prepare(&mut two, &p);
        assert_eq!(two.calls(None).iter().filter(|c| c.encode(false).contains("ADD_ELEMENT")).count(), 1);
        // Only lights.
        assert!(apply(&mut p.clone(), Op::SetSceneLight { agent: 3, scene: 0, light: 901, steps: vec![step(1, None)], now: MemberNow::Unknown }).is_err());
        assert!(apply(&mut p.clone(), Op::SetSceneLight { agent: 3, scene: 0, light: 900, steps: vec![step(101, None)], now: MemberNow::Unknown }).is_err());

        let lit = p.clone();
        apply(&mut p, Op::RemoveSceneLight { agent: 3, scene: 0, light: 900 }).unwrap();
        let d = diff(&lit, &p, &Names::default(), DiffOptions::default());
        let [Change::AgentRecordChanged { field, to, .. }] = d.changes.as_slice() else { panic!("{:?}", d.changes) };
        assert_eq!((field.as_str(), to.as_str()), ("Lamp (Kitchen)", "none"));
        apply(&mut p, Op::RemoveLightingScene { agent: 3, scene: 0 }).unwrap();
        assert!(matches!(apply(&mut p, Op::RemoveLightingScene { agent: 4, scene: 0 }), Err(OpError::WrongAgent { .. })));
    }

    #[test]
    fn announcements_keep_hidden_logins() {
        let mut p = project();
        p.agent_data.insert(4, AgentData::Announcements {
            announcements: agents::parse_announcements(r#"<announcements><announcement id="1" name="Doorbell" dynamic="false" advanced="true"><audio isurl="false" file="bell.mp3" delay="700" delayStop="0"/><video file="http://cam/snap.cgi?password=secret" text="At the door" delay="0" timeout="30000" displayID="0" variableID="0" variableName="" OKButton="true"/><rooms/><navigators/><touchscreens/></announcement></announcements>"#),
        });
        let AgentData::Announcements { announcements } = &p.agent_data[&4] else { unreachable!() };
        let mut spec = agents::AnnouncementSpec::of(&announcements[0]);
        spec.text = "Someone's here".into();
        spec.screens = vec![901];
        let mut op = Op::ModifyAnnouncement { agent: 4, id: 1, announcement: spec, xml: String::new() };
        prepare(&mut op, &p);
        let call = op.calls(None)[0].encode(false);
        assert!(call.contains("password=secret") && call.contains("700"), "the login and the audio delay are kept: {call}");
        assert!(!serde_json::to_string(&op).unwrap().contains("secret"), "the login never leaves in the op");
        let before = p.clone();
        op.predict(&mut p).unwrap();
        let d = diff(&before, &p, &Names::default(), DiffOptions::default());
        let fields: Vec<&str> = d.changes.iter().map(|c| match c { Change::AgentRecordChanged { field, .. } => field.as_str(), _ => "?" }).collect();
        assert_eq!(fields, ["text", "shows on"]);
        let mut bad_room = agents::AnnouncementSpec::of(&announcements_of(&p)[0]);
        bad_room.rooms = vec![agents::AnnouncementVolume { id: 900, volume: None }];
        assert!(apply(&mut p.clone(), Op::ModifyAnnouncement { agent: 4, id: 1, announcement: bad_room, xml: String::new() }).is_err());
    }

    fn announcements_of(p: &Project) -> Vec<agents::Announcement> {
        match &p.agent_data[&4] {
            AgentData::Announcements { announcements } => announcements.clone(),
            _ => vec![],
        }
    }

    #[test]
    fn wake_sleep_and_notifications() {
        let mut p = project();
        apply(&mut p, Op::AddWakeSleepRoom { agent: 5, room: 11 }).unwrap();
        assert!(apply(&mut p.clone(), Op::AddWakeSleepRoom { agent: 5, room: 11 }).is_err(), "one per room");
        let mut s = agents::WakeSleepSpec::default();
        s.wake_time = "07:15".into();
        let mut op = Op::ModifyWakeSleepRoom { agent: 5, id: 1, settings: s, room: 0 };
        prepare(&mut op, &p);
        assert!(op.calls(None)[0].encode(false).contains("roomid=&quot;11&quot;"), "{}", op.calls(None)[0].encode(false));
        op.predict(&mut p).unwrap();

        let t = agents::PushTemplateSpec { name: "Gate".into(), category: 0, severity: 0, subject: "Gate open".into(), message: String::new(), timestamp: true, attachments: vec![] };
        apply(&mut p, Op::AddPushNotification { agent: 6, template: t.clone() }).unwrap();
        assert!(apply(&mut p.clone(), Op::AddPushNotification { agent: 6, template: t }).is_err());
        let e = agents::EmailTemplateSpec { name: "Leak".into(), to: "not-an-address".into(), subject: String::new(), body: String::new(), timestamp: true };
        assert!(apply(&mut p.clone(), Op::AddEmailTemplate { agent: 7, template: e }).is_err());
    }
}
