//! The MCP server: streamable HTTP on the configured port, bearer-token protected.
//!
//! `/mcp` is for external clients (Claude Code, Codex, anything MCP); `/agent/mcp`
//! is the same tool set for the in-app agent, so approval cards can say who asked.
//! Stateless JSON responses (as in junohouse/core) keep it simple for every client.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, ServerHandler, tool, tool_handler, tool_router};
use serde_json::{Value, json};

use crate::actions::{self, *};
use crate::state::{App, AppResult};

const INSTRUCTIONS: &str = "openComposer gives you a Control4 system the way Composer Pro sees it. \
Start with project_overview, then get_item for detail (properties, connections, events). \
Connections are bindings between a provider output and a consumer input of the same class. \
To change anything call propose_changes with a list of ops; the user reviews a project diff \
and approves or declines, and the result tells you what happened. Never assume a change \
was applied until the result says status=applied. Discovered network devices map to drivers \
through their SDDP search type (search_drivers with search_type).";

#[derive(Clone)]
pub struct OpenComposerMcp {
    app: Arc<App>,
    source: &'static str,
    tool_router: ToolRouter<Self>,
}

fn result(r: AppResult<Value>) -> Result<CallToolResult, McpError> {
    Ok(match r {
        Ok(v) if v.is_object() => CallToolResult::structured(v),
        Ok(v) => CallToolResult::structured(json!({ "result": v })),
        Err(e) => CallToolResult::structured_error(json!({ "error": e.to_string() })),
    })
}

impl OpenComposerMcp {
    pub fn new(app: Arc<App>, source: &'static str) -> Self {
        Self { app, source, tool_router: Self::tool_router() }
    }

    async fn run(&self, tool: &str, summary: String, f: impl Future<Output = AppResult<Value>>) -> Result<CallToolResult, McpError> {
        let t = Instant::now();
        let r = f.await;
        let ms = t.elapsed().as_millis() as u64;
        let detail = match &r {
            Ok(_) => summary,
            Err(e) => format!("{summary} — {e}"),
        };
        self.app.log(self.source, tool, detail, r.is_ok(), ms);
        result(r)
    }
}

#[tool_router]
impl OpenComposerMcp {
    #[tool(description = "List the Control4 Directors set up in openComposer, which is active, and their access mode.",
        annotations(read_only_hint = true))]
    async fn list_directors(&self) -> Result<CallToolResult, McpError> {
        let connected = self.app.connected().await;
        self.run("list_directors", String::new(), async { Ok(actions::list_directors(&self.app, &connected)) }).await
    }

    #[tool(description = "Connect to a Director (if needed) and return its name, OS version and access mode.",
        annotations(read_only_hint = true))]
    async fn director_info(&self, Parameters(a): Parameters<DirectorArg>) -> Result<CallToolResult, McpError> {
        self.run("director_info", a.director.clone().unwrap_or_default(), actions::director_info(&self.app, a)).await
    }

    #[tool(description = "Rooms with their devices (ids, names, driver files), agents, and project counts. Start here.",
        annotations(read_only_hint = true))]
    async fn project_overview(&self, Parameters(a): Parameters<DirectorArg>) -> Result<CallToolResult, McpError> {
        self.run("project_overview", String::new(), actions::overview(&self.app, a)).await
    }

    #[tool(description = "Find items by name, driver file name or room name.", annotations(read_only_hint = true))]
    async fn find_items(&self, Parameters(a): Parameters<FindArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("“{}”", a.query);
        self.run("find_items", s, actions::find_items(&self.app, a)).await
    }

    #[tool(description = "Everything about one item: driver/manufacturer/model, properties with their types and options, \
        actions, every connection and what it is connected to, network identity, variables, events with programming, proxies.",
        annotations(read_only_hint = true))]
    async fn get_item(&self, Parameters(a): Parameters<ItemArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("#{}", a.id);
        self.run("get_item", s, actions::get_item(&self.app, a)).await
    }

    #[tool(description = "Connection (binding) definitions across the project with what each is connected to. \
        Filter by device, class (HDMI, IR_OUT, STEREO…) or only unconnected ones.", annotations(read_only_hint = true))]
    async fn list_connections(&self, Parameters(a): Parameters<ConnectionsArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{:?} {:?}", a.device, a.class);
        self.run("list_connections", s, actions::connections(&self.app, a)).await
    }

    #[tool(description = "Programming: each event and the lines of code under it, optionally for one device or agent.",
        annotations(read_only_hint = true))]
    async fn get_programming(&self, Parameters(a): Parameters<ProgrammingArgs>) -> Result<CallToolResult, McpError> {
        self.run("get_programming", format!("{:?}", a.device), actions::programming(&self.app, a)).await
    }

    #[tool(description = "Variables programming can test and set (If/While conditions, add_variable_command): \
        each with its owner device, type (String, Number, Float, Boolean…), whether it's read-only, and its value.",
        annotations(read_only_hint = true))]
    async fn get_variables(&self, Parameters(a): Parameters<VariablesArgs>) -> Result<CallToolResult, McpError> {
        self.run("get_variables", format!("{:?}", a.device), actions::variables(&self.app, a)).await
    }

    #[tool(description = "Network identities (SDDP/IP/Zigbee bindings) in the project and every device Director has \
        discovered, including discovered devices not yet in the project.", annotations(read_only_hint = true))]
    async fn network_status(&self, Parameters(a): Parameters<DirectorArg>) -> Result<CallToolResult, McpError> {
        self.run("network_status", String::new(), actions::network(&self.app, a)).await
    }

    #[tool(description = "Listen for SDDP announcements on this computer's network: device type, IP, manufacturer, \
        model and the driver file each device names.", annotations(read_only_hint = true))]
    async fn discover_sddp(&self, Parameters(a): Parameters<SddpArgs>) -> Result<CallToolResult, McpError> {
        self.run("discover_sddp", String::new(), actions::discover_sddp(a)).await
    }

    #[tool(description = "Zigbee mesh information from the controller: server, mesh, nodes or zaps.",
        annotations(read_only_hint = true))]
    async fn zigbee(&self, Parameters(a): Parameters<ZigbeeArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{:?}", a.query);
        self.run("zigbee", s, actions::zigbee(&self.app, a)).await
    }

    #[tool(description = "Search Control4's online driver database (~25k drivers) by text or by SDDP search type. \
        Returns driver file names, connections, proxies and certification.", annotations(read_only_hint = true))]
    async fn search_drivers(&self, Parameters(a): Parameters<DriverSearchArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("“{}” {:?}", a.text, a.search_type);
        self.run("search_drivers", s, actions::search_drivers(&self.app, a)).await
    }

    #[tool(description = "Backups (.c4p) in openComposer's library, including restore points taken before each approved change.",
        annotations(read_only_hint = true))]
    async fn list_backups(&self) -> Result<CallToolResult, McpError> {
        self.run("list_backups", String::new(), async { Ok(actions::list_backups(&self.app)) }).await
    }

    #[tool(description = "Save the live project to the backup library as a .c4p (only reads from the Director).",
        annotations(read_only_hint = true))]
    async fn backup_project(&self, Parameters(a): Parameters<DirectorArg>) -> Result<CallToolResult, McpError> {
        self.run("backup_project", String::new(), actions::backup_now(&self.app, a)).await
    }

    #[tool(description = "Semantic diff between two projects: `live`, `live:<director>` or `backup:<file>`.",
        annotations(read_only_hint = true))]
    async fn compare_projects(&self, Parameters(a): Parameters<CompareArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{} → {}", a.from, a.to);
        self.run("compare_projects", s, actions::compare(&self.app, a)).await
    }

    #[tool(description = "Call any read-only Director method (Get*/Is*) directly, for data the other tools don't cover.",
        annotations(read_only_hint = true))]
    async fn director_read(&self, Parameters(a): Parameters<ReadArgs>) -> Result<CallToolResult, McpError> {
        let s = a.method.clone();
        self.run("director_read", s, actions::director_read(&self.app, a)).await
    }

    #[tool(description = "Change the project. Give an ordered list of ops (add_device, add_room, add_location (site/building/floor), remove_item, rename_item, \
        move_item, add_connection, remove_connection, add_network_binding, remove_network_binding, set_property, run_action, add_code, remove_code, add_conditional, add_else, add_control, add_variable_command, move_code, set_code_enabled, \
        add_schedule_entry, modify_schedule_entry, remove_schedule_entry, and for other built-in agents (ids and current settings from agent_view): \
        add_lighting_scene, rename_lighting_scene, remove_lighting_scene, set_scene_light, remove_scene_light, add_announcement, modify_announcement, \
        remove_announcement, add_wake_sleep_room, modify_wake_sleep_room, remove_wake_sleep_room, add/modify/remove_push_notification, \
        add/modify/remove_email_template). For add_code take the event id from the device's events and the command from the target's commands (both in get_item). \
        Programming: lines go at `before` (a line id, 0 = the end) under `parent` (an If/While/Else id, 0 = top level). add_conditional adds an If (`loop`: true for a While) \
        testing a device conditional (`{type: device, target, name, logic, params}` from the target's `conditionals` in get_item) or a variable \
        (`{type: variable, variable: {device, id}, logic, value | other}` from get_variables); add_else puts an Else right after an If (parent = the If's parent, before = the line after it); \
        add_control adds `{type: delay, ms}`, stop, break or `{type: comment, text}`; lines inside a new If go in a later change, once it has an id (get_programming). The user sees a \
        project diff and approves or declines; this call waits for that and returns what happened, including new item ids.",
        annotations(read_only_hint = false, destructive_hint = true))]
    async fn propose_changes(&self, Parameters(a): Parameters<ProposeArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{} change(s)", a.ops.len());
        self.run("propose_changes", s, actions::propose(&self.app, a, self.source)).await
    }

    #[tool(description = "Whether a driver file (e.g. roku.c4z) is on the controller, with its version and details.",
        annotations(read_only_hint = true))]
    async fn driver_status(&self, Parameters(a): Parameters<DriverArgs>) -> Result<CallToolResult, McpError> {
        let s = a.filename.clone();
        self.run("driver_status", s, actions::driver_status(&self.app, a)).await
    }

    #[tool(description = "Put a driver file on the controller so devices can use it. The file comes from \
        `path:<absolute path>`, `backup:<library file>` or `director:<another Director>`. Needs approval.",
        annotations(read_only_hint = false, destructive_hint = false))]
    async fn install_driver(&self, Parameters(a): Parameters<InstallDriverArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{} from {}", a.filename, a.from);
        self.run("install_driver", s, actions::install_driver(&self.app, a, self.source)).await
    }

    #[tool(description = "Driver files installed on the controller (manufacturer, model, version, SDDP search types).",
        annotations(read_only_hint = true))]
    async fn controller_drivers(&self, Parameters(a): Parameters<DirectorArg>) -> Result<CallToolResult, McpError> {
        self.run("controller_drivers", String::new(), actions::controller_drivers(&self.app, a)).await
    }

    #[tool(description = "Driver files in openComposer's library (imported, from backups, or Composer's folders on this PC).",
        annotations(read_only_hint = true))]
    async fn library_drivers(&self) -> Result<CallToolResult, McpError> {
        self.run("library_drivers", String::new(), async { Ok(actions::library_drivers(&self.app)) }).await
    }

    #[tool(description = "Copy a .c4z/.c4i from this computer into openComposer's driver library.",
        annotations(read_only_hint = false, destructive_hint = false))]
    async fn import_driver(&self, Parameters(a): Parameters<ImportDriverArgs>) -> Result<CallToolResult, McpError> {
        let s = a.path.clone();
        self.run("import_driver", s, async { actions::import_driver(&self.app, a) }).await
    }

    #[tool(description = "Add a device to a room from a driver file, installing the file first when the controller \
        doesn't have it (from the library or another Director) and optionally identifying it on the network — one \
        approval. Use this rather than propose_changes when adding drivers.",
        annotations(read_only_hint = false, destructive_hint = false))]
    async fn add_driver(&self, Parameters(a): Parameters<AddDriverArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{} → #{}", a.filename, a.room);
        self.run("add_driver", s, actions::add_driver(&self.app, a, self.source)).await
    }

    #[tool(description = "What the openComposer window is showing right now: view, selected item (id, name, path), \
        inspector tab. Use it to resolve \"this\", \"here\", \"the selected device\".", annotations(read_only_hint = true))]
    async fn ui_context(&self) -> Result<CallToolResult, McpError> {
        self.run("ui_context", String::new(), async { Ok(actions::ui_context(&self.app)) }).await
    }

    #[tool(description = "Steer the openComposer window: switch view, select an item in the project tree, pick the \
        inspector tab, or open the approvals drawer. Use it to show the user what you're talking about.",
        annotations(read_only_hint = false, destructive_hint = false))]
    async fn ui_show(&self, Parameters(a): Parameters<UiShowArgs>) -> Result<CallToolResult, McpError> {
        self.run("ui_show", format!("{:?} {:?} {:?}", a.view, a.item, a.tab), async { actions::ui_show(&self.app, a) }).await
    }

    #[tool(description = "What Composer's own editor shows for a built-in agent: Scheduler events \
        (time, repeat, next run, the programming under each), Advanced Lighting scenes with their lights' steps, \
        announcements, Wake/Sleep room defaults, push/email notifications, plus the choices an editor offers \
        (lights, rooms, screens, media sources, snapshot providers). Entries carry a `spec` to start a change from. \
        Change them with propose_changes: *_schedule_entry, *_lighting_scene, set/remove_scene_light, *_announcement, \
        *_wake_sleep_room, *_push_notification, *_email_template.",
        annotations(read_only_hint = true))]
    async fn agent_view(&self, Parameters(a): Parameters<ItemArgs>) -> Result<CallToolResult, McpError> {
        self.run("agent_view", format!("#{}", a.id), actions::agent_view(&self.app, a)).await
    }

    #[tool(description = "A device's variables right now (power, level, input…): its live state.",
        annotations(read_only_hint = true))]
    async fn device_state(&self, Parameters(a): Parameters<StateArgs>) -> Result<CallToolResult, McpError> {
        self.run("device_state", format!("#{}", a.device), actions::device_state(&self.app, a)).await
    }

    #[tool(description = "Send a command to a device now (e.g. ON, SET_LEVEL with LEVEL=50) — it acts on real \
        equipment, so the user approves it first. Commands come from get_item → commands.",
        annotations(read_only_hint = false, destructive_hint = true))]
    async fn send_command(&self, Parameters(a): Parameters<CommandArgs>) -> Result<CallToolResult, McpError> {
        let s = format!("{} → #{}", a.command, a.device);
        self.run("send_command", s, actions::send_command(&self.app, a, self.source)).await
    }

    #[tool(description = "Replace the Director's whole project with a backup from the library (Composer's Load Project). \
        Needs approval; a restore point of the current project is saved first.",
        annotations(read_only_hint = false, destructive_hint = true))]
    async fn load_backup(&self, Parameters(a): Parameters<LoadBackupArgs>) -> Result<CallToolResult, McpError> {
        let s = a.backup.clone();
        self.run("load_backup", s, actions::load_backup(&self.app, a, self.source)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for OpenComposerMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("openComposer", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

async fn require_token(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    let expected = app.config.read().unwrap().mcp.token.clone();
    let header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    let query = req.uri().query().and_then(|q| {
        q.split('&').find_map(|kv| kv.strip_prefix("token=")).map(str::to_string)
    });
    let given = header.or(query).unwrap_or_default();
    // The fixed token (stdio bridge, in-app agent, header-configured clients) or one issued
    // through sign-in.
    if constant_time_eq(given.as_bytes(), expected.as_bytes()) || (!given.is_empty() && crate::oauth::valid(&app, &given)) {
        return next.run(req).await;
    }
    // Tell MCP clients where to sign in (they then open the browser to /authorize).
    let challenge = crate::oauth::challenge(req.headers());
    (StatusCode::UNAUTHORIZED, [(axum::http::header::WWW_AUTHENTICATE, challenge)]).into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct McpStatus {
    pub listening: bool,
    pub url: String,
    pub lan: bool,
    pub error: Option<String>,
    /// The port actually bound — the configured one, or a fallback when it was taken (the
    /// in-app agent always uses this).
    pub port: u16,
}

static RUNNING: OnceLock<Mutex<Option<tokio::task::AbortHandle>>> = OnceLock::new();
static STATUS: OnceLock<Mutex<McpStatus>> = OnceLock::new();

pub fn status() -> McpStatus {
    STATUS
        .get_or_init(|| Mutex::new(McpStatus { listening: false, url: String::new(), lan: false, error: None, port: 0 }))
        .lock()
        .unwrap()
        .clone()
}

fn set_status(app: &App, s: McpStatus) {
    *STATUS.get_or_init(|| Mutex::new(s.clone())).lock().unwrap() = s.clone();
    app.emit("mcp", &s);
}

/// (Re)start the server with the current settings.
pub async fn restart(app: Arc<App>) {
    if let Some(h) = RUNNING.get_or_init(Default::default).lock().unwrap().take() {
        h.abort();
    }
    let cfg = app.config().mcp;
    let ip = if cfg.lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((ip, cfg.port));
    let url = format!("http://{}:{}/mcp", if cfg.lan { lan_ip().unwrap_or_else(|| "127.0.0.1".into()) } else { "127.0.0.1".into() }, cfg.port);
    // If the port is taken (another openComposer, a test server…), still serve the in-app
    // agent on a free loopback port, and say so: external clients need the configured one.
    let (listener, fallback) = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => (l, None),
        Err(e) => match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
            Ok(l) => (l, Some(format!("port {} is in use ({e}); external MCP clients can't connect until it's free", cfg.port))),
            Err(e2) => {
                set_status(&app, McpStatus { listening: false, url, lan: cfg.lan, error: Some(format!("can't listen on {addr}: {e}; no fallback either: {e2}")), port: 0 });
                return;
            }
        },
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(cfg.port);
    let service = |source: &'static str| {
        let app = app.clone();
        StreamableHttpService::new(
            move || Ok(OpenComposerMcp::new(app.clone(), source)),
            LocalSessionManager::default().into(),
            {
                let mut c = StreamableHttpServerConfig::default();
                c.legacy_session_mode = false;
                c.json_response = true;
                // The token is the gate; LAN clients reach us by IP or hostname.
                c.allowed_hosts = vec![];
                c
            },
        )
    };
    let router = axum::Router::new()
        .nest_service("/mcp", service("MCP client"))
        .nest_service("/agent/mcp", service("In-app agent"))
        .layer(middleware::from_fn_with_state(app.clone(), require_token))
        // Driver web tabs: guarded by a per-launch key in the path, not the bearer token.
        .merge(crate::webui::router(app.clone()))
        // Sign-in for MCP clients; approval happens in the app window.
        .merge(crate::oauth::router(app.clone()));
    set_status(&app, McpStatus { listening: true, url, lan: cfg.lan, error: fallback, port });
    let task = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("MCP server stopped: {e}");
        }
    });
    *RUNNING.get_or_init(Default::default).lock().unwrap() = Some(task.abort_handle());
}

/// This machine's LAN address, for the URL shown to other machines.
pub fn lan_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}
