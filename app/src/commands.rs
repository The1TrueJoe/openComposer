//! Commands the UI invokes. Project reads and changes go through [`actions`] — the
//! same code the MCP tools use — with the UI as the source.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;

use crate::actions;
use crate::agent::{self, ConversationInfo, ProviderStatus};
use crate::approvals::Approval;
use crate::certs;
use crate::config::{AccessMode, Config, Provider, SavedDirector};
use crate::mcp;
use crate::state::{Activity, App, AppError};

type S<'a> = State<'a, Arc<App>>;
type R<T> = Result<T, String>;

pub const UI_SOURCE: &str = "You (openComposer)";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct IdentityStatus {
    loaded: bool,
    /// False while the stored certificate is still being unlocked (macOS may be asking).
    unlocked: bool,
    label: Option<String>,
    fingerprint: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct AppStatus {
    version: &'static str,
    config: Config,
    identity: IdentityStatus,
    mcp: mcp::McpStatus,
    connected: Vec<String>,
    stdio_command: String,
}

#[tauri::command]
pub async fn app_status(app: S<'_>) -> R<AppStatus> {
    let id = app.identity.read().unwrap().clone();
    let identity = IdentityStatus {
        loaded: id.is_some(),
        unlocked: app.identity_unlocked(),
        label: id.as_ref().map(|i| i.label.clone()),
        fingerprint: id.as_ref().and_then(|i| i.identity().ok()).map(|i| i.fingerprint()),
        error: app.identity_error.read().unwrap().clone(),
    };
    Ok(AppStatus {
        version: env!("CARGO_PKG_VERSION"),
        config: app.config(),
        identity,
        mcp: mcp::status(),
        connected: app.connected().await,
        stdio_command: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn import_identity_pem(app: S<'_>, cert: String, key: Option<String>) -> R<()> {
    let key = key.unwrap_or_else(|| cert.clone());
    let id = certs::from_pem_files(&PathBuf::from(&cert), &PathBuf::from(&key)).map_err(err)?;
    app.set_identity(id).map_err(err)
}

/// Any picked or dropped certificate files (see `certs::from_files`). A .p12 without a
/// password fails with a message starting `NEEDS_PASSWORD:` so the UI can ask for it.
#[tauri::command]
pub async fn import_identity_files(app: S<'_>, paths: Vec<String>, password: Option<String>) -> R<()> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let id = certs::from_files(&paths, password.as_deref()).map_err(err)?;
    app.set_identity(id).map_err(err)
}

#[tauri::command]
pub async fn import_identity_p12(app: S<'_>, path: String, password: String) -> R<()> {
    let id = certs::from_p12(&PathBuf::from(path), &password).map_err(err)?;
    app.set_identity(id).map_err(err)
}

#[tauri::command]
pub async fn add_director(app: S<'_>, name: String, host: String, mode: Option<AccessMode>) -> R<SavedDirector> {
    let d = SavedDirector {
        id: uuid::Uuid::new_v4().to_string(),
        name: if name.trim().is_empty() { host.clone() } else { name.trim().into() },
        host: host.trim().into(),
        fingerprint: None,
        mode: mode.unwrap_or(AccessMode::Approve),
        web_api: true,
        web_api_addr: None,
        web_api_fingerprint: None,
    };
    let out = d.clone();
    app.update_config(|c| {
        if c.active_director.is_none() {
            c.active_director = Some(d.id.clone());
        }
        c.directors.push(d);
    })
    .map_err(err)?;
    Ok(out)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_director(
    app: S<'_>,
    id: String,
    name: Option<String>,
    host: Option<String>,
    mode: Option<AccessMode>,
    web_api: Option<bool>,
    web_api_addr: Option<String>,
) -> R<()> {
    let host_changed = host.is_some();
    app.update_config(|c| {
        if let Some(d) = c.directors.iter_mut().find(|d| d.id == id) {
            if let Some(n) = name {
                d.name = n;
            }
            if let Some(h) = host {
                d.host = h;
                d.fingerprint = None;
            }
            if let Some(m) = mode {
                d.mode = m;
            }
            if let Some(w) = web_api {
                d.web_api = w;
            }
            if let Some(a) = web_api_addr {
                d.web_api_addr = Some(a).filter(|s| !s.trim().is_empty());
                d.web_api_fingerprint = None;
            }
        }
    })
    .map_err(err)?;
    if host_changed {
        app.disconnect(&id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_director(app: S<'_>, id: String) -> R<()> {
    app.disconnect(&id).await;
    app.update_config(|c| {
        c.directors.retain(|d| d.id != id);
        if c.active_director.as_deref() == Some(&id) {
            c.active_director = c.directors.first().map(|d| d.id.clone());
        }
    })
    .map(|_| ())
    .map_err(err)
}

#[tauri::command]
pub async fn set_active_director(app: S<'_>, id: String) -> R<()> {
    app.update_config(|c| c.active_director = Some(id)).map(|_| ()).map_err(err)
}

/// Forget the pinned controller certificate (after a controller is replaced or reset).
#[tauri::command]
pub async fn forget_fingerprint(app: S<'_>, id: String) -> R<()> {
    app.disconnect(&id).await;
    app.update_config(|c| {
        if let Some(d) = c.directors.iter_mut().find(|d| d.id == id) {
            d.fingerprint = None;
        }
    })
    .map(|_| ())
    .map_err(err)
}

#[tauri::command]
pub async fn connect_director(app: S<'_>, id: String) -> R<Value> {
    actions::director_info(&app, actions::DirectorArg { director: Some(id) }).await.map_err(err)
}

#[tauri::command]
pub async fn disconnect_director(app: S<'_>, id: String) -> R<()> {
    app.disconnect(&id).await;
    Ok(())
}

/// Find controllers on the LAN by SDDP. Controllers answer `*` or their exact type, not a
/// prefix wildcard, so search for everything and keep the controllers.
#[tauri::command]
pub async fn discover_controllers() -> R<Value> {
    let found: Vec<_> = c4::sddp::discover("*", std::time::Duration::from_secs(3))
        .await
        .map_err(err)?
        .into_iter()
        .filter(|a| a.is_controller())
        .collect();
    // Every controller answers SDDP, but only the primary runs a Director; secondaries
    // report "disabled" on the unauthenticated status endpoint (and don't listen on 5021).
    let http = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(err)?;
    let mut out = Vec::new();
    let statuses = futures_status(&http, found.iter().map(|a| a.address.clone()).collect()).await;
    for (a, director) in found.into_iter().zip(statuses) {
        let mut v = serde_json::to_value(a).map_err(err)?;
        v["director"] = json!(director);
        out.push(v);
    }
    // Controllers running a Director first.
    out.sort_by_key(|v| v["director"] != "connected");
    Ok(json!(out))
}

/// `director` from each controller's `GET /api/v1/status`, concurrently; `None` if it
/// didn't answer.
async fn futures_status(http: &reqwest::Client, addrs: Vec<String>) -> Vec<Option<String>> {
    let mut set = tokio::task::JoinSet::new();
    for (i, addr) in addrs.iter().enumerate() {
        let (http, addr) = (http.clone(), addr.clone());
        set.spawn(async move {
            let v: Option<Value> = async { http.get(format!("https://{addr}/api/v1/status")).send().await.ok()?.json().await.ok() }.await;
            (i, v.and_then(|v| v["director"].as_str().map(String::from)))
        });
    }
    let mut out = vec![None; addrs.len()];
    while let Some(Ok((i, d))) = set.join_next().await {
        out[i] = d;
    }
    out
}

fn args<T: serde::de::DeserializeOwned + Default>(v: Value) -> R<T> {
    if v.is_null() { Ok(T::default()) } else { serde_json::from_value(v).map_err(err) }
}

fn req<T: serde::de::DeserializeOwned>(v: Value) -> R<T> {
    serde_json::from_value(v).map_err(|e| format!("bad arguments: {e}"))
}

/// One entry point for every project action, mirroring the MCP tools.
#[tauri::command]
pub async fn action(app: S<'_>, name: String, args: Option<Value>) -> R<Value> {
    let a = args.unwrap_or(Value::Null);
    let app: &Arc<App> = &app;
    let t = std::time::Instant::now();
    let r: Result<Value, AppError> = match name.as_str() {
        "director_info" => actions::director_info(app, self::args(a)?).await,
        "project_overview" => actions::overview(app, self::args(a)?).await,
        "project_tree" => actions::tree(app, self::args(a)?).await,
        "find_items" => actions::find_items(app, req(a)?).await,
        "get_item" => actions::get_item(app, req(a)?).await,
        "list_connections" => actions::connections(app, self::args(a)?).await,
        "get_programming" => actions::programming(app, self::args(a)?).await,
        "get_variables" => actions::variables(app, self::args(a)?).await,
        "network_status" => actions::network(app, self::args(a)?).await,
        "discover_sddp" => actions::discover_sddp(self::args(a)?).await,
        "zigbee" => actions::zigbee(app, req(a)?).await,
        "search_drivers" => actions::search_drivers(app, self::args(a)?).await,
        "list_backups" => Ok(actions::list_backups(app)),
        "backup_project" => actions::backup_now(app, self::args(a)?).await,
        "compare_projects" => actions::compare(app, req(a)?).await,
        "director_read" => actions::director_read(app, req(a)?).await,
        "propose_changes" => actions::propose(app, req(a)?, UI_SOURCE).await,
        "load_backup" => actions::load_backup(app, req(a)?, UI_SOURCE).await,
        "driver_status" => actions::driver_status(app, req(a)?).await,
        "install_driver" => actions::install_driver(app, req(a)?, UI_SOURCE).await,
        "controller_drivers" => actions::controller_drivers(app, self::args(a)?).await,
        "library_drivers" => Ok(actions::library_drivers(app)),
        "import_driver" => actions::import_driver(app, req(a)?),
        "add_driver" => actions::add_driver(app, req(a)?, UI_SOURCE).await,
        "driver_icons" => actions::driver_icons(app, self::args(a)?).await,
        "send_command" => actions::send_command(app, req(a)?, UI_SOURCE).await,
        "device_state" => actions::device_state(app, req(a)?).await,
        "driver_tabs" => actions::driver_tabs(app, req(a)?).await,
        "agent_view" => actions::agent_view(app, req(a)?).await,
        other => return Err(format!("unknown action {other}")),
    };
    if matches!(name.as_str(), "propose_changes" | "load_backup" | "backup_project" | "install_driver" | "add_driver" | "import_driver" | "send_command") {
        app.log(UI_SOURCE, &name, String::new(), r.is_ok(), t.elapsed().as_millis() as u64);
    }
    r.map_err(err)
}

/// The UI reports what it shows, so assistants can resolve "this" and "here".
#[tauri::command]
pub async fn set_ui_context(app: S<'_>, context: Value) -> R<()> {
    *app.ui.write().unwrap() = context;
    Ok(())
}

#[tauri::command]
pub async fn approvals(app: S<'_>) -> R<Vec<Approval>> {
    Ok(app.approvals.list())
}

#[tauri::command]
pub async fn decide_approval(app: S<'_>, id: String, approve: bool, note: Option<String>) -> R<bool> {
    Ok(app.approvals.decide(&id, approve, note.filter(|n| !n.trim().is_empty())))
}

#[tauri::command]
pub async fn activity(app: S<'_>) -> R<Vec<Activity>> {
    Ok(app.activity())
}

#[tauri::command]
pub async fn update_mcp(app: S<'_>, port: Option<u16>, lan: Option<bool>, new_token: Option<bool>) -> R<mcp::McpStatus> {
    app.update_config(|c| {
        if let Some(p) = port {
            c.mcp.port = p;
        }
        if let Some(l) = lan {
            c.mcp.lan = l;
        }
        if new_token == Some(true) {
            c.mcp.token = crate::config::new_token();
        }
    })
    .map_err(err)?;
    mcp::restart(app.inner().clone()).await;
    Ok(mcp::status())
}

#[tauri::command]
pub async fn update_agent(app: S<'_>, provider: Option<Provider>, claude_path: Option<String>, codex_path: Option<String>, model: Option<String>) -> R<()> {
    app.update_config(|c| {
        if let Some(p) = provider {
            c.agent.provider = p;
        }
        if let Some(p) = claude_path {
            c.agent.claude_path = Some(p).filter(|s| !s.is_empty());
        }
        if let Some(p) = codex_path {
            c.agent.codex_path = Some(p).filter(|s| !s.is_empty());
        }
        if let Some(m) = model {
            c.agent.model = Some(m).filter(|s| !s.is_empty());
        }
    })
    .map(|_| ())
    .map_err(err)
}

#[tauri::command]
pub async fn agent_providers(app: S<'_>) -> R<Vec<ProviderStatus>> {
    Ok(agent::providers(&app).await)
}

#[tauri::command]
pub async fn agent_list(app: S<'_>) -> R<Vec<ConversationInfo>> {
    Ok(app.agents.list())
}

#[tauri::command]
pub async fn agent_new(app: S<'_>, provider: Option<Provider>, model: Option<String>, effort: Option<String>) -> R<ConversationInfo> {
    Ok(app.agents.start(provider.unwrap_or(app.config().agent.provider), model, effort))
}

#[tauri::command]
pub async fn agent_configure(app: S<'_>, id: String, model: Option<String>, effort: Option<String>) -> R<ConversationInfo> {
    app.agents.configure(&id, model, effort).await.map_err(err)
}

#[tauri::command]
pub async fn agent_send(app: S<'_>, id: String, text: String, attachments: Option<Vec<String>>) -> R<()> {
    app.agents.send(&app, &id, text, attachments.unwrap_or_default()).await.map_err(err)
}

#[tauri::command]
pub async fn agent_stop(app: S<'_>, id: String) -> R<()> {
    app.agents.stop(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn agent_delete(app: S<'_>, id: String) -> R<()> {
    app.agents.remove(&id).await;
    Ok(())
}

/// MCP clients waiting for sign-in approval.
#[tauri::command]
pub async fn mcp_auth_pending() -> R<Vec<crate::oauth::AuthRequest>> {
    Ok(crate::oauth::pending())
}

#[tauri::command]
pub async fn mcp_auth_decide(app: S<'_>, id: String, approve: bool) -> R<bool> {
    let ok = crate::oauth::decide(&id, approve);
    app.emit("mcp-auth-decided", json!({ "id": id, "approve": approve }));
    Ok(ok)
}

#[derive(Serialize)]
pub struct GrantView {
    id: String,
    client_name: String,
    created: chrono::DateTime<chrono::Utc>,
    last_used: Option<chrono::DateTime<chrono::Utc>>,
}

/// MCP clients signed in through the browser.
#[tauri::command]
pub async fn mcp_grants(app: S<'_>) -> R<Vec<GrantView>> {
    Ok(app
        .config()
        .mcp
        .grants
        .into_iter()
        .map(|g| GrantView { id: g.id, client_name: g.client_name, created: g.created, last_used: g.last_used })
        .collect())
}

#[tauri::command]
pub async fn mcp_revoke(app: S<'_>, id: String) -> R<()> {
    app.update_config(|c| c.mcp.grants.retain(|g| g.id != id)).map(|_| ()).map_err(err)
}

// --- Controller takeover (SSH + cert swap) ---------------------------------------------
// Deliberately not exposed to the agent or MCP: a takeover writes to a controller and
// reboots it, so it runs only from an explicit, confirmed user action in the app.

/// Whether openComposer has a takeover CA yet, and where it came from.
#[tauri::command]
pub async fn takeover_status(app: S<'_>) -> R<Value> {
    let ca = crate::takeover::stored_ca(&app).map_err(err)?;
    Ok(json!({
        "has_ca": ca.is_some(),
        "ca_label": ca.as_ref().map(|c| c.label.clone()),
        "ca_cn": ca.and_then(|c| c4::takeover::ca::common_name_of(&c.cert_pem)),
    }))
}

/// Adopt an existing "Gary tool" `Certs` folder's CA (`public.pem` + `private.key`), so
/// certs openComposer issues chain to a CA the controller already trusts.
#[tauri::command]
pub async fn adopt_gary_ca(app: S<'_>, folder: String) -> R<String> {
    crate::takeover::adopt_gary_ca(&app, &PathBuf::from(folder)).map_err(err)
}

/// Take over a controller: install the CA into its trust chains and import a client cert.
/// `confirm` must be true — this writes to the controller and may reboot it.
#[tauri::command]
pub async fn take_over_controller(
    app: S<'_>,
    params: crate::takeover::Params,
    confirm: bool,
) -> R<crate::takeover::Report> {
    if !confirm {
        return Err("the takeover changes the controller and reboots it — confirm it first".into());
    }
    crate::takeover::run(app.inner(), params).await.map_err(err)
}

/// Undo a takeover: remove the CA from the controller's trust chains (and the MQTT signing
/// cert), turn password SSH back off on OS 4.2+, and reboot if anything changed. `confirm`
/// must be true.
#[tauri::command]
pub async fn revert_takeover(
    app: S<'_>,
    params: crate::takeover::RevertParams,
    confirm: bool,
) -> R<crate::takeover::Report> {
    if !confirm {
        return Err("reverting changes the controller and reboots it — confirm it first".into());
    }
    crate::takeover::revert(app.inner(), params).await.map_err(err)
}
