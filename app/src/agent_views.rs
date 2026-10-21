//! The data behind Composer's own agent editors (Scheduler, Advanced Lighting, …), shaped
//! for people: ids resolved to names, times and colours worded, and the choices an editor
//! offers (lights, rooms, screens, sources) listed.
//!
//! Composer shows these agents through .NET plugins rather than driver web pages; the
//! protocol they use is in `c4::agents`. Most of what is shown is the agent's stored data in
//! the project snapshot, the same data changes are predicted and verified against; live
//! reads add what only the agent knows (next runs, active scenes, media sources). This
//! module only reads: changes are ops (`c4::agent_ops`), proposed like any other change.

use c4::agents::{self, AgentKind};
use c4::director::Catalog;
use c4::model::{CodeItem, event_key};
use c4::{Director, Project};
use serde_json::{Value, json};

use crate::state::AppResult;

fn named(p: &Project, id: u32) -> Value {
    if p.item(id).is_some() {
        json!({ "id": id, "name": p.name_of(id), "room": p.room_of(id).map(|r| r.name.clone()) })
    } else {
        json!({ "id": id, "name": format!("#{id}"), "room": null })
    }
}

fn lines(p: &Project, code: &[CodeItem], depth: usize, out: &mut Vec<Value>) {
    for c in code {
        out.push(json!({ "depth": depth, "text": c.text(p), "enabled": c.enabled, "id": c.id, "target": c.device }));
        lines(p, &c.children, depth + 1, out);
    }
}

fn programming(p: &Project, agent: u32, event: u32) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(code) = p.programming.get(&event_key(agent, event)) {
        lines(p, code, 0, &mut out);
    }
    out
}

/// The view for one agent, or `view: null` when Composer shows it with the generic tabs only.
pub async fn view(d: &Director, p: &Project, _cat: &Catalog, id: u32) -> AppResult<Value> {
    let Some(it) = p.item(id) else { return Err(crate::state::AppError::Other(format!("no item #{id} in this project"))) };
    let Some(kind) = it.driver.as_deref().and_then(AgentKind::from_driver) else {
        return Ok(json!({ "id": id, "view": null }));
    };
    let agent = json!({ "id": id, "name": it.name });
    let data = match kind {
        AgentKind::Scheduler => scheduler(d, p, id).await?,
        AgentKind::AdvancedLighting => advanced_lighting(d, p, id).await?,
        AgentKind::Announcements => announcements(p, id),
        AgentKind::WakeSleep => wake_sleep(d, p, id).await?,
        AgentKind::PushNotification => push_notification(d, p, id).await?,
        AgentKind::EmailNotification => email_notification(p, id),
        AgentKind::ScreenSaver => screen_saver(p, id),
    };
    Ok(json!({ "id": id, "view": kind, "title": kind.title(), "agent": agent, "data": data }))
}

async fn scheduler(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let entries = agents::parse_schedule(&d.agent_read(id, "GET_ALL_ENTRIES", &[]).await?);
    // Today's sunrise and sunset put the astronomical entries in context; not essential.
    let today = chrono::Local::now().date_naive();
    let (day, month, year) = {
        use chrono::Datelike;
        (today.day().to_string(), today.month().to_string(), today.year().to_string())
    };
    let sun = d
        .agent_read(id, "GET_SUNRISE_SUNSET", &[("day", "INT", &day), ("month", "INT", &month), ("year", "INT", &year)])
        .await
        .ok()
        .and_then(|x| agents::parse_sun(&x));
    let rows: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id, "name": e.spec.name, "enabled": e.spec.enabled, "locked": e.locked, "hidden": e.hidden,
                "creator": (e.creator != 0).then(|| named(p, e.creator)), "category": e.category,
                "time": e.spec.time_text(), "repeat": e.spec.repeat_text(), "start": e.spec.start_text(),
                "end": e.spec.end_date.clone().filter(|_| e.spec.repeat != agents::Frequency::Once),
                "next": e.next,
                "spec": e.spec,
                "programming": programming(p, id, e.id),
            })
        })
        .collect();
    Ok(json!({ "sun": sun, "entries": rows }))
}

/// Items whose driver is one of `drivers` (a trailing `*` matches a prefix), as named refs,
/// room by room.
fn items_with(p: &Project, drivers: &[&str]) -> Vec<Value> {
    let mut v: Vec<&c4::model::Item> = p
        .items
        .values()
        .filter(|i| {
            let d = i.driver.as_deref().unwrap_or_default().to_ascii_lowercase();
            drivers.iter().any(|w| match w.strip_suffix('*') {
                Some(pre) => d.starts_with(&pre.to_ascii_lowercase()),
                None => d == w.to_ascii_lowercase(),
            })
        })
        .collect();
    v.sort_by_key(|i| (p.room_of(i.id).map(|r| r.name.clone()).unwrap_or_default(), p.name_of(i.id)));
    v.into_iter().map(|i| named(p, i.id)).collect()
}

fn rooms(p: &Project) -> Vec<Value> {
    let mut v: Vec<&c4::model::Item> = p.items.values().filter(|i| i.kind == c4::model::ItemKind::Room).collect();
    v.sort_by_key(|i| i.name.clone());
    v.into_iter().map(|i| json!({ "id": i.id, "name": i.name, "room": null })).collect()
}

fn agent_data(p: &Project, id: u32) -> Option<&agents::AgentData> {
    p.agent_data.get(&id)
}

fn step_json(st: &agents::LightStep) -> Value {
    json!({ "delay_ms": st.delay_ms, "level": st.level, "rate_ms": st.rate_ms, "color": st.color, "text": st.text() })
}

async fn advanced_lighting(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    // Which scenes are on right now is the agent's to say; the rest is stored in the project.
    let live = d.agent_read(id, "GET_SCENE_LIST", &[]).await.map(|x| agents::parse_scene_list(&x)).unwrap_or_default();
    let stored = match agent_data(p, id) {
        Some(agents::AgentData::Lighting { scenes }) => scenes.clone(),
        _ => vec![],
    };
    let mut scenes: Vec<Value> = stored
        .iter()
        .map(|s| {
            let members: Vec<Value> = s
                .members
                .iter()
                .map(|m| json!({ "device": named(p, m.device), "steps": m.steps.iter().map(step_json).collect::<Vec<_>>() }))
                .collect();
            let info = live.iter().find(|l| l.id == s.id);
            let programmed: usize = [s.id * 5, s.id * 5 + 1, s.id * 5 + 4].iter().map(|e| programming(p, id, *e).len()).sum();
            json!({ "id": s.id, "name": s.name, "active": info.is_some_and(|i| i.active), "ramp_capable": info.is_some_and(|i| i.ramp_capable),
                "toggle": s.toggle_id.and_then(|t| stored.iter().find(|x| x.id == t)).map(|t| json!({ "id": t.id, "name": t.name })),
                "programmed": programmed,
                "members": members })
        })
        .collect();
    scenes.sort_by_key(|s| s["name"].as_str().unwrap_or_default().to_lowercase());
    Ok(json!({ "scenes": scenes, "lights": items_with(p, &agents::SCENE_LIGHT_DRIVERS) }))
}

fn announcements(p: &Project, id: u32) -> Value {
    let list = match agent_data(p, id) {
        Some(agents::AgentData::Announcements { announcements }) => announcements.clone(),
        _ => vec![],
    };
    let vol = |v: Option<i64>| v.filter(|v| *v >= 0);
    let rows: Vec<Value> = list
        .iter()
        .map(|a| {
            json!({ "id": a.id, "name": a.name, "audio": a.audio, "text": a.text, "image": a.image,
                "display_seconds": a.display_ms / 1000, "ok_button": a.ok_button,
                "rooms": a.rooms.iter().map(|r| json!({ "room": named(p, r.id), "volume": vol(r.volume) })).collect::<Vec<_>>(),
                "screens": a.navigators.iter().map(|n| json!({ "device": named(p, n.id), "onscreen": n.onscreen })).collect::<Vec<_>>(),
                "touchscreen_audio": a.touchscreens.iter().map(|t| json!({ "device": named(p, t.id), "volume": vol(t.volume) })).collect::<Vec<_>>(),
                "programmed": programming(p, id, a.id).len() + programming(p, id, a.id + agents::ANNOUNCEMENT_COMPLETE).len(),
                // What an editor starts from; images and sounds keep their logins masked.
                "spec": agents::AnnouncementSpec::of(a) })
        })
        .collect();
    let mut sounds: Vec<String> = list.iter().filter_map(|a| a.audio.clone()).filter(|s| !s.contains("://")).collect();
    sounds.sort();
    sounds.dedup();
    let pick = |f: fn(&Project, u32) -> bool| {
        let mut v: Vec<u32> = p.items.keys().copied().filter(|i| f(p, *i)).collect();
        v.sort_by_key(|i| (p.room_of(*i).map(|r| r.name.clone()).unwrap_or_default(), p.name_of(*i)));
        v.into_iter().map(|i| named(p, i)).collect::<Vec<_>>()
    };
    json!({ "announcements": rows, "rooms": rooms(p), "screens": pick(c4::agent_ops::is_navigator),
        "touchscreens": pick(c4::agent_ops::is_touchscreen), "sounds": sounds, "display_seconds": agents::DISPLAY_SECONDS })
}

async fn wake_sleep(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let list = match agent_data(p, id) {
        Some(agents::AgentData::WakeSleep { rooms }) => rooms.clone(),
        _ => vec![],
    };
    let hospitality = d.agent_read(id, "GET_AGENT_STATUS", &[]).await.is_ok_and(|x| agents::parse_hospitality(&x));
    let mut rows = Vec::new();
    for w in &list {
        let s = &w.settings;
        let room = w.room.to_string();
        // The sources and their items only the agent can list; names otherwise come from the project.
        let sources = d
            .agent_read(id, "GET_MEDIA_SOURCES", &[("TYPE", "STRING", "ALL"), ("ROOMID", "INTEGER", &room)])
            .await
            .map(|x| agents::parse_media_choices(&x, "source"))
            .unwrap_or_default();
        let items = if s.media.source != 0 && !s.media.kind.is_empty() {
            d.agent_read(id, "GET_MEDIA_ITEMS_FOR_SOURCE", &[("TYPE", "STRING", &s.media.kind), ("ROOMID", "INTEGER", &room), ("ID", "INTEGER", &s.media.source.to_string())])
                .await
                .map(|x| agents::parse_media_choices(&x, "item"))
                .unwrap_or_default()
        } else {
            vec![]
        };
        let modes = d
            .agent_read(id, "GET_TEMPERATURE_MODES", &[("TYPE", "STRING", "ALL"), ("ROOMID", "INTEGER", &room)])
            .await
            .map(|x| agents::parse_temperature_modes(&x))
            .unwrap_or_default();
        let source_name = if s.media.source == 0 {
            if s.media.tv_only || s.media.kind == "watch" { Some("TV".to_string()) } else { None }
        } else {
            sources.iter().find(|x| x.id == s.media.source).map(|x| x.name.clone()).or_else(|| p.item(s.media.source).map(|_| p.name_of(s.media.source)))
        };
        let item_name = (s.media.item != 0).then(|| {
            items.iter().find(|x| x.id == s.media.item).map(|x| x.name.clone()).unwrap_or_else(|| format!("item #{}", s.media.item))
        });
        rows.push(json!({ "id": w.id, "room": named(p, w.room), "settings": s,
            // The ids resolved: 0 means all of the room's lights or blinds, or its TV.
            "light": if s.lights.light == 0 { json!({ "id": 0, "name": "All lights in the room", "room": null }) } else { named(p, s.lights.light) },
            "blind": if s.blinds.blind == 0 { json!({ "id": 0, "name": "All blinds in the room", "room": null }) } else { named(p, s.blinds.blind) },
            "source": source_name, "item": item_name, "sources": sources, "items": items, "temperature_modes": modes }));
    }
    let set: Vec<u32> = list.iter().map(|w| w.room).collect();
    let free: Vec<Value> = rooms(p).into_iter().filter(|r| !set.contains(&(r["id"].as_u64().unwrap_or(0) as u32))).collect();
    Ok(json!({ "rooms": rows, "available_rooms": free, "hospitality": hospitality,
        "lights": items_with(p, &["light.c4i", "light_v2.c4i", "outlet_light.c4i"]), "blinds": items_with(p, &["blind.c4i", "blindV2.c4i"]) }))
}

async fn push_notification(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let (templates, categories, severities) = match agent_data(p, id) {
        Some(agents::AgentData::Push { templates, categories, severities }) => (templates.clone(), categories.clone(), severities.clone()),
        _ => (vec![], vec![], vec![]),
    };
    let name = |l: &[(u32, String)], v: u32| l.iter().find(|(i, _)| *i == v).map(|(_, n)| n.clone());
    let rows: Vec<Value> = templates
        .iter()
        .map(|t| {
            let s = &t.spec;
            json!({ "id": t.id, "name": s.name, "subject": s.subject, "message": s.message, "timestamp": s.timestamp,
                "category": name(&categories, s.category), "severity": name(&severities, s.severity),
                "attachments": s.attachments.iter().map(|a| named(p, a.owner)).collect::<Vec<_>>(),
                "spec": s })
        })
        .collect();
    // Cameras and the like that can attach a snapshot; only the agent knows.
    let providers: Vec<Value> = d
        .agent_read(id, "GET_ATTACHMENT_PROVIDER_LIST", &[])
        .await
        .map(|x| agents::parse_attachment_providers(&x))
        .unwrap_or_default()
        .into_iter()
        .map(|(owner, aid, label)| json!({ "owner": named(p, owner), "id": aid, "label": label }))
        .collect();
    let list = |l: &[(u32, String)]| l.iter().map(|(i, n)| json!({ "id": i, "name": n })).collect::<Vec<_>>();
    Ok(json!({ "templates": rows, "categories": list(&categories), "severities": list(&severities), "attachment_providers": providers }))
}

fn email_notification(p: &Project, id: u32) -> Value {
    let templates = match agent_data(p, id) {
        Some(agents::AgentData::Email { templates }) => templates.clone(),
        _ => vec![],
    };
    let rows: Vec<Value> = templates
        .iter()
        .map(|t| json!({ "id": t.id, "name": t.spec.name, "subject": t.spec.subject, "message": t.spec.body, "to": t.spec.to, "spec": t.spec }))
        .collect();
    json!({ "templates": rows })
}

fn screen_saver(p: &Project, id: u32) -> Value {
    let s = match agent_data(p, id) {
        Some(agents::AgentData::ScreenSaver(s)) => s.clone(),
        _ => agents::ScreenSaver::default(),
    };
    json!({ "device": (s.device != 0).then(|| named(p, s.device)), "picture_path": s.picture_path, "photo_seconds": s.photo_seconds })
}
