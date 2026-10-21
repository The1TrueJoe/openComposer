//! The data behind Composer's own agent editors (Scheduler, Advanced Lighting, …), read
//! live from the agent and shaped for people: ids resolved to names, times worded.
//!
//! Composer shows these agents through .NET plugins rather than driver web pages; the
//! protocol they use is in `c4::agents`. This module only reads. Changes (scheduled events
//! so far) are ops, proposed like any other change.

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
        AgentKind::Announcements => announcements(d, p, id).await?,
        AgentKind::WakeSleep => wake_sleep(d, p, id).await?,
        AgentKind::PushNotification => push_notification(d, p, id).await?,
        AgentKind::EmailNotification => email_notification(d, id).await?,
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

async fn advanced_lighting(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let list = agents::parse_scene_list(&d.agent_read(id, "GET_SCENE_LIST", &[]).await?);
    let mut scenes = Vec::new();
    for s in &list {
        let detail = d
            .agent_read(id, "GET_SCENE", &[("SCENE_ID", "INTEGER", &s.id.to_string())])
            .await
            .ok()
            .and_then(|x| agents::parse_scene(&x));
        let members: Vec<Value> = detail
            .iter()
            .flat_map(|x| &x.members)
            .map(|m| {
                let steps: Vec<Value> = m
                    .steps
                    .iter()
                    .map(|st| json!({ "delay_ms": st.delay_ms, "level": st.level, "rate_ms": st.rate_ms,
                        "color_temperature": st.color_temperature, "color_hs": st.color_hs }))
                    .collect();
                json!({ "device": named(p, m.device), "steps": steps })
            })
            .collect();
        scenes.push(json!({ "id": s.id, "name": s.name, "active": s.active, "ramp_capable": s.ramp_capable, "members": members }));
    }
    Ok(json!({ "scenes": scenes }))
}

async fn announcements(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let list = agents::parse_announcements(&d.agent_read(id, "get_announcements", &[]).await?);
    let target = |t: &agents::AnnouncementTarget| {
        json!({ "device": named(p, t.id), "room": t.room.map(|r| named(p, r)), "volume": t.volume.filter(|v| *v >= 0), "onscreen": t.onscreen })
    };
    let rows: Vec<Value> = list
        .iter()
        .map(|a| {
            json!({ "id": a.id, "name": a.name, "audio": a.audio, "text": a.text, "image": a.image,
                "rooms": a.rooms.iter().map(|r| json!({ "room": named(p, r.id), "volume": r.volume.filter(|v| *v >= 0) })).collect::<Vec<_>>(),
                // A touchscreen is listed both as a navigator and as a touchscreen; show it once.
                "screens": a.navigators.iter().chain(&a.touchscreens)
                    .filter({ let mut seen = std::collections::HashSet::new(); move |t| seen.insert(t.id) })
                    .map(target).collect::<Vec<_>>() })
        })
        .collect();
    Ok(json!({ "announcements": rows }))
}

async fn wake_sleep(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let scenes = agents::parse_wake_sleep(&d.agent_read(id, "GET_WAKEUPGOODNIGHTSCENE_LIST", &[]).await?);
    let part = |x: &Option<agents::WakeSleepPart>| {
        x.as_ref().map(|x| json!({ "enabled": x.enabled, "device": x.device.map(|d| named(p, d)), "detail": x.detail }))
    };
    let rows: Vec<Value> = scenes
        .iter()
        .map(|s| {
            json!({ "id": s.id, "room": named(p, s.room), "wake_time": s.wake_time, "wake_days": s.wake_days,
                "sleep_minutes": s.sleep_minutes, "lights": part(&s.lights), "media": part(&s.media),
                "blinds": part(&s.blinds), "temperature": part(&s.temperature) })
        })
        .collect();
    Ok(json!({ "rooms": rows }))
}

async fn push_notification(d: &Director, p: &Project, id: u32) -> AppResult<Value> {
    let templates = agents::parse_templates(&d.agent_read(id, "GET_TEMPLATE_LIST", &[]).await?);
    let categories = d.agent_read(id, "GET_CATEGORY_LIST", &[]).await.map(|x| agents::parse_named_list(&x, "category")).unwrap_or_default();
    let severities = d.agent_read(id, "GET_SEVERITY_LIST", &[]).await.map(|x| agents::parse_named_list(&x, "severity")).unwrap_or_default();
    let name = |l: &[(u32, String)], v: Option<u32>| v.and_then(|v| l.iter().find(|(i, _)| *i == v).map(|(_, n)| n.clone()));
    let rows: Vec<Value> = templates
        .iter()
        .map(|t| {
            json!({ "id": t.id, "name": t.name, "subject": t.subject, "message": t.message, "timestamp": t.timestamp,
                "category": name(&categories, t.category), "severity": name(&severities, t.severity),
                "attachments": t.attachments.iter().map(|(owner, _)| named(p, *owner)).collect::<Vec<_>>() })
        })
        .collect();
    Ok(json!({ "templates": rows }))
}

async fn email_notification(d: &Director, id: u32) -> AppResult<Value> {
    let templates = agents::parse_templates(&d.agent_read(id, "GET_TEMPLATE_LIST", &[]).await?);
    let rows: Vec<Value> = templates.iter().map(|t| json!({ "id": t.id, "name": t.name })).collect();
    Ok(json!({ "templates": rows }))
}
