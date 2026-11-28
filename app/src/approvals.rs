//! Every change to a Director goes through here, whoever asks for it.
//!
//! 1. The ops are applied to a fresh snapshot in memory; anything that doesn't apply
//!    cleanly is refused before a person is asked.
//! 2. The predicted semantic diff becomes an approval card in the app.
//! 3. On approval the current project is saved as a restore point, the ops run, the
//!    project is read back, and the real diff is checked against the prediction.
//!
//! The caller (an MCP client, the in-app agent, or the UI) waits for the outcome.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use c4::diff::{Change, Diff, DiffOptions, diff};
use c4::director::{Applied, Snapshot};
use c4::model::{REDACTED, is_sensitive_property};
use c4::Op;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::backups;
use crate::config::AccessMode;
use crate::state::{App, AppError, AppResult, Session};

const DECISION_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Denied,
    Expired,
    Applying,
    Applied,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Verification {
    /// Predicted changes that happened.
    pub matched: usize,
    /// Predicted changes that did not happen.
    pub missing: Vec<String>,
    /// Changes nobody predicted: usually Director's own follow-ups (proxies, auto-made
    /// connections, driver variables), shown so nothing happens unseen.
    pub side_effects: Diff,
}

#[derive(Clone, Debug, Serialize)]
pub struct Approval {
    pub id: String,
    pub created: DateTime<Utc>,
    pub decided: Option<DateTime<Utc>>,
    pub director_id: String,
    pub director_name: String,
    pub project: String,
    pub source: String,
    pub reason: Option<String>,
    pub ops: Vec<Op>,
    pub descriptions: Vec<String>,
    pub diff: Diff,
    pub status: Status,
    pub note: Option<String>,
    pub error: Option<String>,
    pub applied: Vec<Applied>,
    pub restore_point: Option<String>,
    pub verification: Option<Verification>,
    /// Whether this applied change can be undone, and what an undo would leave as it is.
    pub undo: Option<UndoInfo>,
    /// The change this one undid.
    pub undo_of: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UndoInfo {
    /// Changes an undo would propose (0: nothing can be undone with changes; use the restore point).
    pub changes: usize,
    pub not_undone: Vec<String>,
    /// The approval that undid it, once one was applied.
    pub undone_by: Option<String>,
}

/// The project before and after an applied change, kept so it can be undone.
struct Basis {
    id: String,
    before: Arc<Snapshot>,
    after: Arc<Snapshot>,
}

/// Changes that can still be undone. Snapshots hold the whole project, so keep a few.
const UNDO_DEPTH: usize = 10;

#[derive(Default)]
pub struct Approvals {
    all: Mutex<Vec<Approval>>,
    waiters: Mutex<HashMap<String, oneshot::Sender<(bool, Option<String>)>>>,
    bases: Mutex<Vec<Basis>>,
}

impl Approvals {
    pub fn list(&self) -> Vec<Approval> {
        self.all.lock().unwrap().iter().rev().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Approval> {
        self.all.lock().unwrap().iter().find(|a| a.id == id).cloned()
    }

    /// Record the user's decision. Returns false if nothing was waiting.
    pub fn decide(&self, id: &str, approve: bool, note: Option<String>) -> bool {
        match self.waiters.lock().unwrap().remove(id) {
            Some(tx) => tx.send((approve, note)).is_ok(),
            None => false,
        }
    }

    /// Keep what undoing an applied change needs, and say what an undo would do.
    fn keep_for_undo(&self, id: &str, ops: &[Op], before: Arc<Snapshot>, after: Arc<Snapshot>) -> UndoInfo {
        let plan = c4::undo::plan(
            ops,
            c4::undo::State { project: &before.project, agents: &before.agents },
            c4::undo::State { project: &after.project, agents: &after.agents },
        );
        let mut bases = self.bases.lock().unwrap();
        bases.push(Basis { id: id.into(), before, after });
        if bases.len() > UNDO_DEPTH {
            bases.remove(0);
        }
        UndoInfo { changes: plan.ops.len(), not_undone: plan.not_undone, undone_by: None }
    }

    fn update(&self, app: &App, id: &str, f: impl FnOnce(&mut Approval)) -> Option<Approval> {
        let mut all = self.all.lock().unwrap();
        let a = all.iter_mut().find(|a| a.id == id)?;
        f(a);
        let out = a.clone();
        drop(all);
        app.emit("approval", &out);
        Some(out)
    }
}

/// Mask credential-like property values before a diff is shown or returned.
pub fn redact(mut d: Diff) -> Diff {
    for c in &mut d.changes {
        if let Change::PropertyChanged { property, from, to, .. } = c {
            if is_sensitive_property(property) {
                for v in [from, to] {
                    if v.as_deref().is_some_and(|s| !s.is_empty()) {
                        *v = Some(REDACTED.into());
                    }
                }
            }
        }
    }
    d
}

/// Propose ops on a Director, wait for a decision, apply, verify.
pub async fn propose(app: &Arc<App>, director: Option<&str>, ops: Vec<Op>, reason: Option<String>, source: &str) -> AppResult<Approval> {
    propose_with(app, director, ops, reason, source, None).await
}

/// Propose the undo of an applied change: the ops that take the project back, approved like
/// any change. What ops can't put back is listed; the restore point covers the rest.
pub async fn undo(app: &Arc<App>, id: &str, reason: Option<String>, source: &str) -> AppResult<Approval> {
    let a = app.approvals.get(id).ok_or_else(|| AppError::Other(format!("no change {id} in this session")))?;
    if a.status != Status::Applied {
        return Err(AppError::Other("only an applied change can be undone".into()));
    }
    if let Some(by) = a.undo.as_ref().and_then(|u| u.undone_by.clone()) {
        return Err(AppError::Other(format!("this change was already undone (by {by})")));
    }
    let basis = {
        let bases = app.approvals.bases.lock().unwrap();
        bases.iter().find(|b| b.id == id).map(|b| (b.before.clone(), b.after.clone()))
    };
    let restore = a.restore_point.as_deref().map(|r| format!(" Load its restore point instead: {r}")).unwrap_or_default();
    let Some((before, after)) = basis else {
        return Err(AppError::Other(format!("only the last {UNDO_DEPTH} changes made in this session can be undone.{restore}")));
    };
    let plan = c4::undo::plan(
        &a.ops,
        c4::undo::State { project: &before.project, agents: &before.agents },
        c4::undo::State { project: &after.project, agents: &after.agents },
    );
    if plan.ops.is_empty() {
        return Err(AppError::Other(format!("nothing in this change can be undone with changes ({}).{restore}", plan.not_undone.join("; "))));
    }
    let title = a.descriptions.first().cloned().unwrap_or_else(|| "a change".into());
    let mut why = format!("Undo “{title}”");
    if !plan.not_undone.is_empty() {
        why.push_str(&format!(". Not put back: {}", plan.not_undone.join("; ")));
    }
    if let Some(r) = reason {
        why = format!("{why}. {r}");
    }
    let r = propose_with(app, Some(&a.director_id), plan.ops, Some(why), source, Some(id.to_string())).await?;
    if r.status == Status::Applied {
        app.approvals.update(app, id, |a| {
            if let Some(u) = a.undo.as_mut() {
                u.undone_by = Some(r.id.clone());
            }
        });
    }
    Ok(r)
}

async fn propose_with(
    app: &Arc<App>,
    director: Option<&str>,
    mut ops: Vec<Op>,
    reason: Option<String>,
    source: &str,
    undo_of: Option<String>,
) -> AppResult<Approval> {
    if ops.is_empty() {
        return Err(AppError::Other("no changes were given".into()));
    }
    let saved = app.resolve_director(director)?;
    app.ensure_writable(&saved)?;
    let session = app.session(Some(&saved.id)).await?;
    let _turn = session.write_lock.lock().await;

    let before = session.snapshot(true).await?;
    let catalog = session.catalog(false).await?;
    // Programming lines get their text and variable types from the project and drivers.
    let n = ops.len();
    for (i, op) in ops.iter_mut().enumerate() {
        c4::program::complete(op, &before.project, &catalog)
            .map_err(|e| AppError::Other(if n > 1 { format!("change {} of {n}: {e}", i + 1) } else { e }))?;
    }
    check_connections(&ops, &catalog, &before.project)?;
    check_properties(&ops, &catalog, &before.project)?;
    check_actions(&ops, &catalog, &before.project)?;
    check_code(&ops, &catalog, &before.project)?;
    check_drivers(app, &session, &ops).await?;
    let names = catalog.names();
    let mut predicted = before.project.clone();
    let mut predicted_agents = before.agents.clone();
    let mut descriptions = Vec::new();
    // The id each new lighting scene is predicted to get, so later changes to it in the same
    // batch can be pointed at the id the agent really gives it.
    let mut new_scenes: Vec<Option<u32>> = Vec::new();
    for (i, op) in ops.iter_mut().enumerate() {
        // Against the project as the earlier changes leave it, as they will be applied.
        op.prepare(&predicted, &predicted_agents);
        descriptions.push(op.describe(&predicted, &predicted_agents));
        let free = match op {
            Op::AddLightingScene { agent, .. } => Some(c4::undo::free_scene_id(&predicted_agents, *agent)),
            _ => None,
        };
        new_scenes.push(free);
        op.predict(&mut predicted, &mut predicted_agents).map_err(|e| AppError::Other(format!("change {} of {n} can't be applied: {e}", i + 1)))?;
    }
    let predicted_diff = redact(diff(&before.project, &predicted, &before.agents, &predicted_agents, &names, DiffOptions { runtime: true }));

    let id = uuid::Uuid::new_v4().to_string();
    let approval = Approval {
        id: id.clone(),
        created: Utc::now(),
        decided: None,
        director_id: saved.id.clone(),
        director_name: saved.name.clone(),
        project: before.project.name.clone(),
        source: source.into(),
        reason,
        ops: ops.clone(),
        descriptions,
        diff: predicted_diff.clone(),
        status: Status::Pending,
        note: None,
        error: None,
        applied: vec![],
        restore_point: None,
        verification: None,
        undo: None,
        undo_of,
    };
    app.approvals.all.lock().unwrap().push(approval.clone());

    // A trusted ("auto") Director applies without a card; others pause for an approval.
    let (approved, note) = if saved.mode == AccessMode::Auto {
        (true, None)
    } else {
        let (tx, rx) = oneshot::channel();
        app.approvals.waiters.lock().unwrap().insert(id.clone(), tx);
        app.emit("approval", &approval);
        app.emit("attention", serde_json::json!({ "kind": "approval", "id": id, "title": approval.descriptions.first() }));
        match tokio::time::timeout(DECISION_TIMEOUT, rx).await {
            Ok(Ok(d)) => d,
            _ => {
                app.approvals.waiters.lock().unwrap().remove(&id);
                let a = app.approvals.update(app, &id, |a| {
                    a.status = Status::Expired;
                    a.decided = Some(Utc::now());
                });
                return Ok(a.unwrap_or(approval));
            }
        }
    };
    if !approved {
        let a = app.approvals.update(app, &id, |a| {
            a.status = Status::Denied;
            a.decided = Some(Utc::now());
            a.note = note;
        });
        return Ok(a.unwrap_or(approval));
    }
    app.approvals.update(app, &id, |a| {
        a.status = Status::Applying;
        a.decided = Some(Utc::now());
        a.note = note.clone();
    });

    let restore_point = backups::save_snapshot(app, &saved, &session.director.info.version, &before, "before change")
        .map_err(|e| tracing::warn!("restore point not saved: {e}"))
        .ok();

    let (applied, error, ops) = apply_all(app, &session, ops, &new_scenes).await;
    if !applied.is_empty() || error.is_none() {
        session.invalidate().await;
    }
    let ok = error.is_none();
    let mut undo = None;
    let verification = match session.snapshot(true).await {
        Ok(after) => {
            let names = session.names().await.unwrap_or(names);
            let actual = redact(diff(&before.project, &after.project, &before.agents, &after.agents, &names, DiffOptions::default()));
            if ok {
                undo = Some(app.approvals.keep_for_undo(&id, &ops, before.clone(), after));
            }
            Some(verify(&predicted_diff, actual))
        }
        Err(e) => {
            tracing::warn!("could not re-read project after applying: {e}");
            None
        }
    };
    let a = app.approvals.update(app, &id, |a| {
        a.status = if ok { Status::Applied } else { Status::Failed };
        a.error = error;
        a.applied = applied;
        a.restore_point = restore_point.map(|p| p.display().to_string());
        a.verification = verification;
        a.undo = undo;
        a.ops = ops;
    });
    app.emit("project-changed", serde_json::json!({ "director": saved.id }));
    Ok(a.unwrap_or(approval))
}

/// `AddDevice` with a driver the controller doesn't have fails with a bare "Unable to
/// add device", so look first (when the web API is reachable) and say what to do.
async fn check_drivers(app: &Arc<App>, session: &Session, ops: &[Op]) -> AppResult<()> {
    let installing: Vec<&str> = ops
        .iter()
        .filter_map(|o| match o {
            Op::InstallDriver { filename, .. } => Some(filename.as_str()),
            _ => None,
        })
        .collect();
    let wanted: Vec<&str> = ops
        .iter()
        .filter_map(|o| match o {
            Op::AddDevice { driver, .. } if !installing.contains(&driver.as_str()) => Some(driver.as_str()),
            _ => None,
        })
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let Ok(broker) = app.broker(session).await else { return Ok(()) };
    for d in wanted {
        if let Ok(None) = broker.driver_info(d).await {
            return Err(AppError::Other(format!(
                "{d} isn't on this controller yet; install it first with install_driver \
                 (from a file on this computer, a backup that contains it, or another Director)"
            )));
        }
    }
    Ok(())
}

/// Property values are checked against the driver's declared schema, as Composer's
/// property grid would restrict them.
fn check_properties(ops: &[Op], cat: &c4::Catalog, p: &c4::Project) -> AppResult<()> {
    for op in ops {
        let Op::SetProperty { device, name, value } = op else { continue };
        let who = p.name_of(*device);
        let Some(def) = cat.devices.get(device).and_then(|d| d.properties.iter().find(|x| x.name == *name)) else {
            return Err(AppError::Other(format!("“{who}” has no property “{name}” (get_item lists its properties)")));
        };
        if def.readonly {
            return Err(AppError::Other(format!("“{who}” property “{name}” is read-only; the driver sets it")));
        }
        // A LIST property's `items` are only what driver.xml declared; the driver can replace the
        // choices at runtime (`C4:UpdatePropertyList`), so a value outside that static list may be
        // perfectly valid. Director is the authority when the change is applied, so don't refuse a
        // LIST value here — only enforce a genuinely fixed list for other item-bearing types.
        if !def.prop_type.contains("LIST") && !def.items.is_empty() && !def.items.iter().any(|i| i == value) {
            return Err(AppError::Other(format!("“{name}” must be one of: {}", def.items.join(", "))));
        }
        if def.prop_type.contains("INTEGER") || def.prop_type.contains("FLOAT") {
            let v: f64 = value.parse().map_err(|_| AppError::Other(format!("“{name}” needs a number")))?;
            let bound = |b: &Option<String>| b.as_deref().and_then(|x| x.parse::<f64>().ok());
            if bound(&def.minimum).is_some_and(|m| v < m) || bound(&def.maximum).is_some_and(|m| v > m) {
                return Err(AppError::Other(format!(
                    "“{name}” must be between {} and {}",
                    def.minimum.clone().unwrap_or_default(),
                    def.maximum.clone().unwrap_or_default()
                )));
            }
        }
    }
    Ok(())
}

/// Programming lines must hang off an event the device declares and send a command the
/// target declares (when it declares any — proxies' built-in commands aren't listed).
fn check_code(ops: &[Op], cat: &c4::Catalog, p: &c4::Project) -> AppResult<()> {
    for op in ops {
        let (device, event) = match op {
            Op::AddCode { device, event, .. }
            | Op::AddConditional { device, event, .. }
            | Op::AddElse { device, event, .. }
            | Op::AddControl { device, event, .. }
            | Op::AddVariableCommand { device, event, .. } => (device, event),
            _ => continue,
        };
        if let Some(d) = cat.devices.get(device) {
            if !d.events.is_empty() && !d.events.contains_key(event) {
                let have: Vec<String> = d.events.iter().map(|(id, n)| format!("{id} {n}")).collect();
                return Err(AppError::Other(format!(
                    "“{}” has no event {event}; its events are: {}",
                    p.name_of(*device),
                    have.join(", ")
                )));
            }
        }
        let Op::AddCode { target, command, .. } = op else { continue };
        if let Some(t) = cat.devices.get(target) {
            if !t.commands.is_empty() && !t.commands.iter().any(|c| c.name == *command) {
                let have: Vec<&str> = t.commands.iter().map(|c| c.name.as_str()).collect();
                return Err(AppError::Other(format!(
                    "“{}” has no command “{command}”; its commands are: {}",
                    p.name_of(*target),
                    have.join(", ")
                )));
            }
        }
    }
    Ok(())
}

fn check_actions(ops: &[Op], cat: &c4::Catalog, p: &c4::Project) -> AppResult<()> {
    for op in ops {
        let Op::RunAction { device, command } = op else { continue };
        let actions = cat.devices.get(device).map(|d| &d.actions);
        if !actions.is_some_and(|a| a.iter().any(|(_, c)| c == command)) {
            let have: Vec<String> = actions.into_iter().flatten().map(|(n, c)| format!("{n} ({c})")).collect();
            return Err(AppError::Other(format!(
                "“{}” has no action “{command}”{}",
                p.name_of(*device),
                if have.is_empty() { String::new() } else { format!("; its actions are: {}", have.join(", ")) }
            )));
        }
    }
    Ok(())
}

/// Director accepts `AddBinding` for connections that don't exist (and silently does
/// nothing), so check both ends against the drivers' declared connections first.
fn check_connections(ops: &[Op], cat: &c4::Catalog, p: &c4::Project) -> AppResult<()> {
    let declared = |dev: u32, binding: u32| cat.devices.get(&dev).and_then(|d| d.connections.iter().find(|c| c.id == binding));
    let proxy_owner = |dev: u32, binding: u32| {
        // A room's children are the devices in it, not proxies.
        p.item(dev)
            .filter(|i| i.kind != c4::model::ItemKind::Room)
            .and_then(|i| i.children.iter().copied().find(|k| declared(*k, binding).is_some()))
    };
    // A combo driver repeats its proxies' connection ids; only the proxy can be bound.
    let find = |dev: u32, binding: u32| declared(dev, binding).filter(|_| proxy_owner(dev, binding).is_none());
    let owner_hint = |dev: u32, binding: u32| -> String {
        match proxy_owner(dev, binding) {
            Some(k) => format!(" — it belongs to its proxy #{k} “{}”", p.name_of(k)),
            None => String::new(),
        }
    };
    for op in ops {
        let Op::AddConnection { consumer_device, consumer_binding, provider_device, provider_binding, class, .. } = op else {
            continue;
        };
        for (dev, binding, want_consumer, role) in [
            (*consumer_device, *consumer_binding, true, "input"),
            (*provider_device, *provider_binding, false, "output"),
        ] {
            let Some(c) = find(dev, binding) else {
                return Err(AppError::Other(format!(
                    "“{}” (#{dev}) has no connection #{binding}{}",
                    p.name_of(dev),
                    owner_hint(dev, binding)
                )));
            };
            if c.consumer != want_consumer {
                return Err(AppError::Other(format!("“{}” connection “{}” is not an {role}", p.name_of(dev), c.name)));
            }
            if !c.classes.iter().any(|k| k.eq_ignore_ascii_case(class)) {
                return Err(AppError::Other(format!(
                    "“{}” connection “{}” doesn't carry {class} (it carries {})",
                    p.name_of(dev),
                    c.name,
                    c.classes.join(", ")
                )));
            }
        }
    }
    Ok(())
}

/// Apply the ops in order. Returns the ops as sent (a new scene's id corrected to the agent's).
async fn apply_all(app: &Arc<App>, session: &Session, mut ops: Vec<Op>, new_scenes: &[Option<u32>]) -> (Vec<Applied>, Option<String>, Vec<Op>) {
    let catalog = if ops.iter().any(|o| matches!(o, Op::AddRoom { .. } | Op::AddLocation { .. })) {
        session.catalog(false).await.ok()
    } else {
        None
    };
    let mut applied = Vec::new();
    let mut last_device: Option<u32> = None;
    let total = ops.len();
    // Ops already pointed at a real scene id, so a later new scene's prediction can't catch them.
    let mut retargeted = vec![false; total];
    for i in 0..total {
        // Resolve "the device added earlier in this batch" now that Director has its id.
        if let Op::AddNetworkBinding { device, .. } = &mut ops[i] {
            if *device == 0 {
                match last_device {
                    Some(d) => *device = d,
                    None => return (applied, Some("identify refers to a new device, but none was added before it".into()), ops),
                }
            }
        }
        let op = &ops[i];
        let result = match op {
            Op::InstallDriver { filename, bytes, .. } => match app.broker(session).await {
                Ok(b) => b
                    .install_driver(filename, bytes.clone())
                    .await
                    .map(|_| Applied { created: vec![], notes: vec![format!("installed {filename}")] })
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            },
            Op::UpdateDriver { filename, bytes, agent, restart, .. } => match app.broker(session).await {
                Ok(b) => match b.install_driver(filename, bytes.clone()).await {
                    Ok(()) => session
                        .director
                        .update_driver(*agent, filename, *restart)
                        .await
                        .map(|_| Applied { created: vec![], notes: vec![format!("uploaded {filename} and asked the Driver Update agent to apply it")] })
                        // Half done: say which half, so nobody assumes the devices moved over.
                        .map_err(|e| {
                            format!("{filename} was uploaded, but the Driver Update agent didn't take the update ({e}); devices still run the old version")
                        }),
                    Err(e) => Err(format!("{filename} couldn't be uploaded, nothing changed: {e}")),
                },
                Err(e) => Err(e.to_string()),
            },
            _ => op.apply(&session.director, catalog.as_ref().and_then(|c| c4::ops::template_for(c, op))).await.map_err(|e| e.to_string()),
        };
        match result {
            Ok(a) => {
                if matches!(op, Op::AddDevice { .. }) {
                    last_device = a.created.first().copied();
                }
                if let (Op::AddLightingScene { agent, name }, Some(Some(predicted))) = (op, new_scenes.get(i)) {
                    let (agent, predicted) = (*agent, *predicted);
                    match real_scene_id(session, agent, name).await {
                        Some(real) if real != predicted => retarget_scene(&mut ops, &mut retargeted, i + 1, agent, predicted, real),
                        Some(_) => {}
                        None if ops[i + 1..].iter().any(|o| scene_of(o, agent) == Some(predicted)) => {
                            applied.push(a);
                            let msg = format!("change {} of {total} added a lighting scene, but the agent didn't list it, so the rest were not attempted", i + 1);
                            return (applied, Some(msg), ops);
                        }
                        None => {}
                    }
                }
                applied.push(a)
            }
            Err(e) => {
                let msg = if total > 1 { format!("change {} of {total} failed, the rest were not attempted: {e}", i + 1) } else { e };
                return (applied, Some(msg), ops);
            }
        }
    }
    (applied, None, ops)
}

/// The id the Advanced Lighting agent gave the scene named `name`.
async fn real_scene_id(session: &Session, agent: u32, name: &str) -> Option<u32> {
    let list = session.director.agent_read(agent, "GET_SCENE_LIST", &[]).await.ok()?;
    let want = name.trim().to_lowercase();
    c4::agents::parse_scene_list(&list).into_iter().find(|s| s.name.trim().to_lowercase() == want).map(|s| s.id)
}

fn scene_of(op: &Op, on: u32) -> Option<u32> {
    match op {
        Op::SetSceneLight { agent, scene, .. }
        | Op::RemoveSceneLight { agent, scene, .. }
        | Op::RenameLightingScene { agent, scene, .. }
        | Op::RemoveLightingScene { agent, scene } if *agent == on => Some(*scene),
        _ => None,
    }
}

/// Point the later changes to a new scene at the id the agent gave it.
fn retarget_scene(ops: &mut [Op], done: &mut [bool], start: usize, on: u32, from: u32, to: u32) {
    for (op, done) in ops.iter_mut().zip(done.iter_mut()).skip(start) {
        if *done {
            continue;
        }
        if let Op::SetSceneLight { agent, scene, .. }
        | Op::RemoveSceneLight { agent, scene, .. }
        | Op::RenameLightingScene { agent, scene, .. }
        | Op::RemoveLightingScene { agent, scene } = op
        {
            if *agent == on && *scene == from {
                *scene = to;
                *done = true;
            }
        }
    }
}

fn verify(predicted: &Diff, actual: Diff) -> Verification {
    let want: BTreeSet<String> = predicted.changes.iter().map(Change::key).collect();
    let got: BTreeSet<String> = actual.changes.iter().map(Change::key).collect();
    let mut side_effects = actual.clone();
    // Drivers re-encrypt stored credentials on every save; that churn can't be shown and isn't news.
    side_effects.changes.retain(|c| {
        !want.contains(&c.key()) && !matches!(c, Change::PropertyChanged { property, .. } if is_sensitive_property(property))
    });
    side_effects.summary = Default::default();
    let mut missing: Vec<String> = want.difference(&got).cloned().collect();
    // An event's programming is checked line by line: Director can answer a call and store
    // something else, or nothing (an Else it won't take still says result="1").
    let result = |lines: &[c4::diff::CodeLine]| -> Vec<(usize, String, bool)> {
        lines.iter().filter(|l| l.op != c4::diff::LineOp::Removed).map(|l| (l.depth, l.text.clone(), l.enabled)).collect()
    };
    for p in &predicted.changes {
        let Change::ProgrammingChanged { lines, .. } = p else { continue };
        let got = actual.changes.iter().find(|a| a.key() == p.key());
        if let Some(Change::ProgrammingChanged { lines: actual_lines, .. }) = got {
            if result(lines) != result(actual_lines) {
                missing.push(format!("{} (its lines came out differently than predicted)", p.key()));
            }
        }
    }
    Verification { matched: want.len() - missing.len(), missing, side_effects }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn light(scene: u32) -> Op {
        Op::SetSceneLight { agent: 3, scene, light: 900, steps: vec![], now: Default::default() }
    }

    #[test]
    fn new_scene_ids_follow_the_agent() {
        // Two new scenes predicted as 1 and 2; the agent gives them 2 and 5.
        let mut ops = vec![light(1), light(2), light(7)];
        let mut done = vec![false; 3];
        retarget_scene(&mut ops, &mut done, 0, 3, 1, 2);
        retarget_scene(&mut ops, &mut done, 0, 3, 2, 5);
        let scenes: Vec<u32> = ops.iter().filter_map(|o| scene_of(o, 3)).collect();
        assert_eq!(scenes, [2, 5, 7], "the first scene's lights aren't moved to the second");
    }
}
