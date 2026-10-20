//! What can be done to a Director, as typed async functions.
//!
//! Both the MCP server (`mcp.rs`) and the UI (`commands.rs`) call these, so a change
//! proposed from Claude Code, the in-app agent or a button in the app takes the same
//! path. Writes never touch the Director directly: they build [`Op`]s and hand them to
//! [`approvals::propose`].

use std::sync::Arc;
use std::time::Duration;

use c4::diff::{DiffOptions, diff};
use c4::director::ZigbeeQuery;
use c4::{Op, Project};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::approvals::{self, Approval, Status};
use crate::backups;
use crate::state::{App, AppError, AppResult};
use crate::views;

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DirectorArg {
    /// Director id, name or host. Omit for the active Director.
    #[serde(default)]
    pub director: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FindArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Text to match against item names, driver file names and room names.
    pub query: String,
    /// Restrict to one kind: site, building, floor, room, device, proxy, agent.
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ItemArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Item id (from the overview or find_items).
    pub id: u32,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ConnectionsArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Only this device (and its proxies).
    #[serde(default)]
    pub device: Option<u32>,
    /// Only connections of this class, e.g. HDMI, IR_OUT, STEREO, AUDIO_SELECTION.
    #[serde(default)]
    pub class: Option<String>,
    /// Only connections that are not connected to anything.
    #[serde(default)]
    pub unconnected_only: bool,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ProgrammingArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Only events of this device or agent.
    #[serde(default)]
    pub device: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct SddpArgs {
    /// How long to listen, 1–15 seconds (default 4).
    #[serde(default)]
    pub seconds: Option<u64>,
    /// SDDP type pattern to search for (default `*`, everything).
    #[serde(default)]
    pub pattern: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ZigbeeArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// server, mesh, nodes or zaps
    pub query: ZigbeeQuery,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DriverSearchArgs {
    /// Free text: manufacturer, model, driver name…
    #[serde(default)]
    pub text: String,
    /// Exact SDDP search type (from a discovered device) instead of text.
    #[serde(default)]
    pub search_type: Option<String>,
    /// Maximum results (default 20, max 100).
    #[serde(default)]
    pub rows: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CompareArgs {
    /// `live`, `live:<director>`, or `backup:<file name in the library>`.
    pub from: String,
    /// Same forms as `from`.
    pub to: String,
    /// Include runtime churn (variable values, online status, discovered IPs).
    #[serde(default)]
    pub runtime: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// A read-only c4soap method (must start with Get or Is), e.g. GetVariablesByDevice.
    pub method: String,
    /// Parameters by name; numbers are sent as number, booleans as bool, rest as string.
    #[serde(default)]
    pub params: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProposeArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// The changes, applied in order as one approval.
    pub ops: Vec<Op>,
    /// One sentence shown to the person approving: why these changes.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DriverArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Driver file name, e.g. roku.c4z
    pub filename: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InstallDriverArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// Driver file name to install, e.g. sony_strdn840.c4z
    pub filename: String,
    /// Where to take the file from: `path:<absolute path on this computer>`,
    /// `backup:<file in the library>`, or `director:<another Director>`.
    pub from: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LoadBackupArgs {
    #[serde(default)]
    pub director: Option<String>,
    /// File name in the backup library (see list_backups) or an absolute path.
    pub backup: String,
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn list_directors(app: &App, connected: &[String]) -> Value {
    let c = app.config();
    json!({
        "active": c.active_director,
        "directors": c.directors.iter().map(|d| json!({
            "id": d.id, "name": d.name, "host": d.host, "mode": d.mode,
            "connected": connected.contains(&d.id),
        })).collect::<Vec<_>>(),
    })
}

pub async fn director_info(app: &Arc<App>, a: DirectorArg) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let saved = app.resolve_director(Some(&s.id))?;
    Ok(json!({ "id": s.id, "mode": saved.mode, "info": s.director.info }))
}

pub async fn overview(app: &Arc<App>, a: DirectorArg) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    Ok(views::overview(&s.snapshot(false).await?.project))
}

pub async fn tree(app: &Arc<App>, a: DirectorArg) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let snap = s.snapshot(false).await?;
    Ok(json!({ "tree": views::tree(&snap.project), "project": snap.project.name }))
}

pub async fn find_items(app: &Arc<App>, a: FindArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    Ok(views::find(&s.snapshot(false).await?.project, &a.query, a.kind.as_deref()))
}

pub async fn get_item(app: &Arc<App>, a: ItemArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let (snap, cat) = (s.snapshot(false).await?, s.catalog(false).await?);
    views::item(&snap.project, &cat, a.id).ok_or_else(|| AppError::Other(format!("no item #{} in this project", a.id)))
}

pub async fn connections(app: &Arc<App>, a: ConnectionsArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let (snap, cat) = (s.snapshot(false).await?, s.catalog(false).await?);
    Ok(views::connections(&snap.project, &cat, a.device, a.class.as_deref(), a.unconnected_only))
}

pub async fn programming(app: &Arc<App>, a: ProgrammingArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let (snap, cat) = (s.snapshot(false).await?, s.catalog(false).await?);
    Ok(views::programming(&snap.project, &cat, a.device))
}

/// What Director knows about the network: identified devices and everything it has
/// discovered, with discovered-but-unidentified devices called out.
pub async fn network(app: &Arc<App>, a: DirectorArg) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let snap = s.snapshot(false).await?;
    let p = &snap.project;
    let found = s.director.physical_devices().await?;
    let identified: Vec<Value> = p
        .network_bindings
        .iter()
        .map(|n| json!({ "device": { "id": n.device, "name": p.name_of(n.device), "path": p.path(n.device) },
            "address_type": n.address_type, "address": n.address, "uuid": n.uuid,
            "search_type": n.search_type, "status": n.status }))
        .collect();
    let bound: std::collections::HashSet<&str> = p.network_bindings.iter().map(|n| n.uuid.as_str()).collect();
    let unidentified: Vec<_> = found.iter().filter(|d| !bound.contains(d.uuid.as_str())).collect();
    Ok(json!({ "identified": identified, "discovered": found, "discovered_not_in_project": unidentified }))
}

pub async fn discover_sddp(a: SddpArgs) -> AppResult<Value> {
    let secs = a.seconds.unwrap_or(4).clamp(1, 15);
    let found = c4::sddp::discover(a.pattern.as_deref().unwrap_or("*"), Duration::from_secs(secs))
        .await
        .map_err(|e| AppError::Other(format!("SDDP discovery failed: {e}")))?;
    Ok(json!({ "devices": found }))
}

pub async fn zigbee(app: &Arc<App>, a: ZigbeeArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    Ok(s.director.zigbee(a.query).await?)
}

pub async fn search_drivers(app: &Arc<App>, a: DriverSearchArgs) -> AppResult<Value> {
    let rows = a.rows.unwrap_or(20).clamp(1, 100);
    let r = c4::drivers::search(&app.http, &a.text, a.search_type.as_deref(), rows)
        .await
        .map_err(|e| AppError::Other(format!("driver database unreachable: {e}")))?;
    Ok(serde_json::to_value(r).unwrap_or_default())
}

pub fn list_backups(app: &App) -> Value {
    json!({ "backups": backups::list(app) })
}

/// Save the live project to the library, with the driver files it uses when the web
/// API is available. Only reads from the Director.
pub async fn backup_now(app: &Arc<App>, a: DirectorArg) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let saved = app.resolve_director(Some(&s.id))?;
    let snap = s.snapshot(true).await?;
    let mut drivers = std::collections::BTreeMap::new();
    let mut missing = Vec::new();
    let mut note = None;
    match app.broker(&s).await {
        Ok(b) => {
            for name in snap.project.drivers().into_iter().filter(|d| !c4::c4p::is_builtin_driver(d)) {
                match b.download_driver(&name).await {
                    Ok(Some(bytes)) => {
                        drivers.insert(name, bytes);
                    }
                    _ => missing.push(name),
                }
            }
        }
        Err(e) => note = Some(format!("project only, no driver files: {e}")),
    }
    let path = backups::save(app, &saved, &s.director.info.version, &snap, "backup", drivers)?;
    let mut v = serde_json::to_value(backups::info(&path)?).unwrap_or_default();
    v["drivers_missing"] = json!(missing);
    v["note"] = json!(note);
    Ok(v)
}

pub async fn driver_status(app: &Arc<App>, a: DriverArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let b = app.broker(&s).await?;
    let info = b.driver_info(&a.filename).await.map_err(|e| AppError::Other(e.to_string()))?;
    Ok(json!({ "filename": a.filename, "installed": info.is_some(), "info": info }))
}

async fn driver_bytes(app: &Arc<App>, filename: &str, from: &str) -> AppResult<(Vec<u8>, String)> {
    if let Some(path) = from.strip_prefix("path:") {
        let p = std::path::PathBuf::from(path);
        if !p.is_absolute() {
            return Err(AppError::Other("path: needs an absolute path".into()));
        }
        let bytes = std::fs::read(&p).map_err(|e| AppError::Other(format!("can't read {path}: {e}")))?;
        return Ok((bytes, format!("file {path}")));
    }
    if let Some(file) = from.strip_prefix("backup:") {
        let path = backups::resolve(app, file)?;
        let mut b = c4::c4p::Backup::open(std::fs::File::open(&path).map_err(|e| AppError::Other(e.to_string()))?)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let bytes = b
            .read(&format!("drivers/{filename}"))
            .map_err(|_| AppError::Other(format!("backup {file} doesn't contain {filename}")))?;
        return Ok((bytes, format!("backup {file}")));
    }
    if let Some(other) = from.strip_prefix("director:") {
        let s = app.session(Some(other)).await?;
        let b = app.broker(&s).await?;
        let bytes = b
            .download_driver(filename)
            .await
            .map_err(|e| AppError::Other(e.to_string()))?
            .ok_or_else(|| AppError::Other(format!("{other} doesn't have {filename}")))?;
        return Ok((bytes, format!("Director {}", s.director.info.name)));
    }
    Err(AppError::Other("from must be path:<file>, backup:<file> or director:<name>".into()))
}

pub async fn install_driver(app: &Arc<App>, a: InstallDriverArgs, source: &str) -> AppResult<Value> {
    let (bytes, from) = driver_bytes(app, &a.filename, &a.from).await?;
    let op = Op::InstallDriver { filename: a.filename, source: from, bytes };
    let r = approvals::propose(app, a.director.as_deref(), vec![op], a.reason, source).await?;
    Ok(outcome(&r))
}

async fn load_source(app: &Arc<App>, src: &str) -> AppResult<(String, Project, c4::Names)> {
    if let Some(file) = src.strip_prefix("backup:") {
        let path = backups::resolve(app, file)?;
        let (_, p) = backups::read_project(&path)?;
        return Ok((format!("backup {file}"), p, c4::Names::default()));
    }
    let which = src.strip_prefix("live").map(|r| r.trim_start_matches(':')).filter(|r| !r.is_empty());
    let s = app.session(which).await?;
    let snap = s.snapshot(false).await?;
    Ok((format!("live {}", s.director.info.name), snap.project.clone(), s.names().await?))
}

pub async fn compare(app: &Arc<App>, a: CompareArgs) -> AppResult<Value> {
    let (la, pa, na) = load_source(app, &a.from).await?;
    let (lb, pb, nb) = load_source(app, &a.to).await?;
    let mut names = na;
    names.connections.extend(nb.connections);
    names.events.extend(nb.events);
    let d = approvals::redact(diff(&pa, &pb, &names, DiffOptions { runtime: a.runtime }));
    Ok(json!({ "from": la, "to": lb, "diff": d }))
}

pub async fn director_read(app: &Arc<App>, a: ReadArgs) -> AppResult<Value> {
    let s = app.session(a.director.as_deref()).await?;
    let params: Vec<(String, Value)> = a.params.into_iter().collect();
    Ok(s.director.read(&a.method, &params).await?)
}

/// What a caller learns about its proposal.
pub fn outcome(a: &Approval) -> Value {
    let created: Vec<u32> = a.applied.iter().flat_map(|x| x.created.iter().copied()).collect();
    let verification = a.verification.as_ref().map(|v| json!({
        "predicted_changes_seen": v.matched,
        "predicted_but_missing": v.missing,
        "other_changes_director_made": v.side_effects.changes.len(),
    }));
    let message = match a.status {
        Status::Applied => "Approved and applied.".to_string(),
        Status::Denied => match &a.note {
            Some(n) => format!("The user declined this change: {n}"),
            None => "The user declined this change. Ask what they want instead.".into(),
        },
        Status::Expired => "No one approved this within 15 minutes; nothing was changed.".into(),
        Status::Failed => format!("Approved, but Director refused: {}", a.error.clone().unwrap_or_default()),
        Status::Pending | Status::Applying => "Still in progress.".into(),
    };
    json!({
        "status": a.status, "message": message, "approval_id": a.id, "changes": a.descriptions,
        "created_item_ids": created, "restore_point": a.restore_point, "verification": verification,
    })
}

pub async fn propose(app: &Arc<App>, a: ProposeArgs, source: &str) -> AppResult<Value> {
    if a.ops.iter().any(|o| matches!(o, Op::LoadProject { .. })) {
        return Err(AppError::Other("use load_backup to replace a whole project".into()));
    }
    if a.ops.iter().any(|o| matches!(o, Op::InstallDriver { .. })) {
        return Err(AppError::Other("use install_driver to put a driver file on a controller".into()));
    }
    let r = approvals::propose(app, a.director.as_deref(), a.ops, a.reason, source).await?;
    Ok(outcome(&r))
}

pub async fn load_backup(app: &Arc<App>, a: LoadBackupArgs, source: &str) -> AppResult<Value> {
    let path = backups::resolve(app, &a.backup)?;
    let (xml, _) = backups::read_project(&path)?;
    let label = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let r = approvals::propose(app, a.director.as_deref(), vec![Op::LoadProject { label, xml }], a.reason, source).await?;
    Ok(outcome(&r))
}
