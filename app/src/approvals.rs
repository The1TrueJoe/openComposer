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
use c4::director::Applied;
use c4::model::{REDACTED, is_sensitive_property};
use c4::Op;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::backups;
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
}

#[derive(Default)]
pub struct Approvals {
    all: Mutex<Vec<Approval>>,
    waiters: Mutex<HashMap<String, oneshot::Sender<(bool, Option<String>)>>>,
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
pub async fn propose(
    app: &Arc<App>,
    director: Option<&str>,
    ops: Vec<Op>,
    reason: Option<String>,
    source: &str,
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
    check_connections(&ops, &catalog, &before.project)?;
    check_drivers(app, &session, &ops).await?;
    let names = catalog.names();
    let mut predicted = before.project.clone();
    let mut descriptions = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        descriptions.push(op.describe(&predicted));
        op.predict(&mut predicted)
            .map_err(|e| AppError::Other(format!("change {} of {} can't be applied: {e}", i + 1, ops.len())))?;
    }
    let predicted_diff = redact(diff(&before.project, &predicted, &names, DiffOptions { runtime: true }));

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
    };
    let (tx, rx) = oneshot::channel();
    app.approvals.waiters.lock().unwrap().insert(id.clone(), tx);
    app.approvals.all.lock().unwrap().push(approval.clone());
    app.emit("approval", &approval);
    app.emit("attention", serde_json::json!({ "kind": "approval", "id": id, "title": approval.descriptions.first() }));

    let decision = tokio::time::timeout(DECISION_TIMEOUT, rx).await;
    let (approved, note) = match decision {
        Ok(Ok(d)) => d,
        _ => {
            app.approvals.waiters.lock().unwrap().remove(&id);
            let a = app.approvals.update(app, &id, |a| {
                a.status = Status::Expired;
                a.decided = Some(Utc::now());
            });
            return Ok(a.unwrap_or(approval));
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

    let (applied, error) = apply_all(app, &session, &ops).await;
    if !applied.is_empty() || error.is_none() {
        session.invalidate().await;
    }
    let verification = match session.snapshot(true).await {
        Ok(after) => {
            let names = session.names().await.unwrap_or(names);
            let actual = redact(diff(&before.project, &after.project, &names, DiffOptions::default()));
            Some(verify(&predicted_diff, actual))
        }
        Err(e) => {
            tracing::warn!("could not re-read project after applying: {e}");
            None
        }
    };
    let ok = error.is_none();
    let a = app.approvals.update(app, &id, |a| {
        a.status = if ok { Status::Applied } else { Status::Failed };
        a.error = error;
        a.applied = applied;
        a.restore_point = restore_point.map(|p| p.display().to_string());
        a.verification = verification;
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

/// Director accepts `AddBinding` for connections that don't exist (and silently does
/// nothing), so check both ends against the drivers' declared connections first.
fn check_connections(ops: &[Op], cat: &c4::Catalog, p: &c4::Project) -> AppResult<()> {
    let declared = |dev: u32, binding: u32| cat.devices.get(&dev).and_then(|d| d.connections.iter().find(|c| c.id == binding));
    let proxy_owner = |dev: u32, binding: u32| {
        p.item(dev).and_then(|i| i.children.iter().copied().find(|k| declared(*k, binding).is_some()))
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

async fn apply_all(app: &Arc<App>, session: &Session, ops: &[Op]) -> (Vec<Applied>, Option<String>) {
    let template = if ops.iter().any(|o| matches!(o, Op::AddRoom { .. })) {
        session.catalog(false).await.ok().and_then(|c| c.room_template.clone())
    } else {
        None
    };
    let mut applied = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        let result = match op {
            Op::InstallDriver { filename, bytes, .. } => match app.broker(session).await {
                Ok(b) => b
                    .install_driver(filename, bytes.clone())
                    .await
                    .map(|_| Applied { created: vec![], notes: vec![format!("installed {filename}")] })
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            },
            _ => session.director.apply(op, template.as_deref()).await.map_err(|e| e.to_string()),
        };
        match result {
            Ok(a) => applied.push(a),
            Err(e) => {
                let msg = if ops.len() > 1 {
                    format!("change {} of {} failed, the rest were not attempted: {e}", i + 1, ops.len())
                } else {
                    e.to_string()
                };
                return (applied, Some(msg));
            }
        }
    }
    (applied, None)
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
    Verification {
        matched: want.intersection(&got).count(),
        missing: want.difference(&got).cloned().collect(),
        side_effects,
    }
}
