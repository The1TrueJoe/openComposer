//! Sign-in for MCP clients (OAuth 2.1 as the MCP spec describes it), so a client like
//! Claude Code needs no pasted token: it is told to sign in, opens the browser here, and
//! the person approves it **in the openComposer window** — the browser page only waits for
//! that, so someone else on the network can't approve themselves.
//!
//! Endpoints (all on the MCP port): protected-resource and authorization-server metadata,
//! dynamic client registration, `/authorize` (PKCE S256 required), `/token`
//! (authorization_code and refresh_token). Only hashes of issued tokens are stored, each
//! grant is listed in Settings and revocable. The fixed token keeps working for the stdio
//! bridge, the in-app agent and clients that prefer a header.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Form, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config::{Grant, new_token};
use crate::state::App;

const CODE_TTL: Duration = Duration::from_secs(300);
const REQUEST_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize)]
pub struct AuthRequest {
    pub id: String,
    pub client_name: String,
    pub redirect_uri: String,
    /// Where the request came from, as the browser reached us (for the approval card).
    pub host: String,
    #[serde(skip)]
    challenge: String,
    #[serde(skip)]
    state: Option<String>,
    #[serde(skip)]
    created: Option<Instant>,
}

#[derive(Clone)]
enum Decision {
    Pending,
    Approved(String),
    Denied,
}

struct Client {
    name: String,
    redirect_uris: Vec<String>,
}

struct Code {
    client_id: String,
    client_name: String,
    redirect_uri: String,
    challenge: String,
    issued: Instant,
}

#[derive(Default)]
struct Store {
    clients: HashMap<String, Client>,
    requests: HashMap<String, (AuthRequest, String, Decision)>,
    codes: HashMap<String, Code>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Is this bearer token one we issued (and not revoked)? Records its use.
pub fn valid(app: &App, token: &str) -> bool {
    let h = hash(token);
    let known = app.config.read().unwrap().mcp.grants.iter().any(|g| g.access_hash == h);
    if known {
        let _ = app.update_config(|c| {
            if let Some(g) = c.mcp.grants.iter_mut().find(|g| g.access_hash == h) {
                g.last_used = Some(chrono::Utc::now());
            }
        });
    }
    known
}

/// The origin a client used to reach us (`http://host:port`), for metadata URLs.
pub fn origin(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("127.0.0.1");
    format!("http://{host}")
}

/// The `WWW-Authenticate` value that tells an MCP client where to sign in.
pub fn challenge(headers: &HeaderMap) -> String {
    format!(r#"Bearer resource_metadata="{}/.well-known/oauth-protected-resource""#, origin(headers))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(resource_meta))
        .route("/.well-known/oauth-protected-resource/{*rest}", get(resource_meta))
        .route("/.well-known/oauth-authorization-server", get(server_meta))
        .route("/.well-known/oauth-authorization-server/{*rest}", get(server_meta))
        .route("/register", post(register))
        .route("/authorize", get(authorize))
        .route("/authorize/status", get(status))
        .route("/token", post(token))
        .with_state(app)
}

async fn resource_meta(headers: HeaderMap) -> Json<Value> {
    let o = origin(&headers);
    Json(json!({
        "resource": format!("{o}/mcp"),
        "authorization_servers": [o],
        "bearer_methods_supported": ["header"],
        "resource_name": "openComposer",
    }))
}

async fn server_meta(headers: HeaderMap) -> Json<Value> {
    let o = origin(&headers);
    Json(json!({
        "issuer": o,
        "authorization_endpoint": format!("{o}/authorize"),
        "token_endpoint": format!("{o}/token"),
        "registration_endpoint": format!("{o}/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }))
}

#[derive(Deserialize)]
struct Registration {
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    redirect_uris: Vec<String>,
}

async fn register(Json(r): Json<Registration>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if r.redirect_uris.is_empty() {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", "at least one redirect_uri is required"));
    }
    let id = new_token();
    let name = r.client_name.unwrap_or_else(|| "MCP client".into());
    store().lock().unwrap().clients.insert(id.clone(), Client { name: name.clone(), redirect_uris: r.redirect_uris.clone() });
    Ok(Json(json!({
        "client_id": id,
        "client_name": name,
        "redirect_uris": r.redirect_uris,
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    })))
}

#[derive(Deserialize)]
struct AuthorizeQuery {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    state: Option<String>,
}

async fn authorize(State(app): State<Arc<App>>, headers: HeaderMap, Query(q): Query<AuthorizeQuery>) -> Response {
    let mut s = store().lock().unwrap();
    let Some(client) = s.clients.get(&q.client_id) else {
        return page("Unknown client", "This client hasn't registered with openComposer. Start the sign-in again from the client.", None);
    };
    if !client.redirect_uris.contains(&q.redirect_uri) {
        return page("Redirect not allowed", "The return address doesn't match the client's registration.", None);
    }
    if q.response_type != "code" || q.code_challenge_method.as_deref() != Some("S256") || q.code_challenge.is_none() {
        return page("Unsupported request", "openComposer needs the authorization-code flow with PKCE (S256).", None);
    }
    let id = new_token();
    let req = AuthRequest {
        id: id.clone(),
        client_name: client.name.clone(),
        redirect_uri: q.redirect_uri.clone(),
        host: origin(&headers),
        challenge: q.code_challenge.clone().unwrap_or_default(),
        state: q.state.clone(),
        created: Some(Instant::now()),
    };
    s.requests.insert(id.clone(), (req.clone(), q.client_id.clone(), Decision::Pending));
    drop(s);
    app.emit("mcp-auth", &req);
    app.emit("attention", json!({ "kind": "mcp-auth", "id": id, "title": format!("{} wants to connect to openComposer", req.client_name) }));
    page(
        &format!("Approve {} in openComposer", req.client_name),
        "Switch to the openComposer window and choose Allow or Deny. This page continues on its own.",
        Some(&id),
    )
}

/// Called from the app when the person decides.
pub fn decide(id: &str, approve: bool) -> bool {
    let mut s = store().lock().unwrap();
    let Some((req, client_id, decision)) = s.requests.get_mut(id) else { return false };
    if !matches!(decision, Decision::Pending) {
        return false;
    }
    if !approve {
        *decision = Decision::Denied;
        return true;
    }
    let code = new_token();
    let (client_id, req) = (client_id.clone(), req.clone());
    *decision = Decision::Approved(code.clone());
    s.codes.insert(code, Code {
        client_id,
        client_name: req.client_name.clone(),
        redirect_uri: req.redirect_uri.clone(),
        challenge: req.challenge.clone(),
        issued: Instant::now(),
    });
    true
}

pub fn pending() -> Vec<AuthRequest> {
    let mut s = store().lock().unwrap();
    s.requests.retain(|_, (r, _, _)| r.created.is_some_and(|c| c.elapsed() < REQUEST_TTL));
    s.requests.values().filter(|(_, _, d)| matches!(d, Decision::Pending)).map(|(r, _, _)| r.clone()).collect()
}

#[derive(Deserialize)]
struct StatusQuery {
    id: String,
}

/// The waiting browser page polls this until the app decides, then follows `redirect`.
async fn status(Query(q): Query<StatusQuery>) -> Json<Value> {
    let s = store().lock().unwrap();
    let Some((req, _, decision)) = s.requests.get(&q.id) else { return Json(json!({ "state": "gone" })) };
    let back = |params: &str| {
        let sep = if req.redirect_uri.contains('?') { '&' } else { '?' };
        let state = req.state.as_ref().map(|s| format!("&state={}", urlencode(s))).unwrap_or_default();
        format!("{}{sep}{params}{state}", req.redirect_uri)
    };
    Json(match decision {
        Decision::Pending => json!({ "state": "pending" }),
        Decision::Approved(code) => json!({ "state": "approved", "redirect": back(&format!("code={code}")) }),
        Decision::Denied => json!({ "state": "denied", "redirect": back("error=access_denied") }),
    })
}

#[derive(Deserialize)]
struct TokenForm {
    grant_type: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

async fn token(State(app): State<Arc<App>>, Form(f): Form<TokenForm>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let bad = |e: &str, d: &str| oauth_error(StatusCode::BAD_REQUEST, e, d);
    match f.grant_type.as_str() {
        "authorization_code" => {
            let code = f.code.ok_or_else(|| bad("invalid_request", "code is required"))?;
            let c = store().lock().unwrap().codes.remove(&code).ok_or_else(|| bad("invalid_grant", "unknown or used code"))?;
            if c.issued.elapsed() > CODE_TTL {
                return Err(bad("invalid_grant", "code expired"));
            }
            if f.client_id.as_deref() != Some(c.client_id.as_str()) || f.redirect_uri.as_deref() != Some(c.redirect_uri.as_str()) {
                return Err(bad("invalid_grant", "client or redirect_uri doesn't match"));
            }
            let verifier = f.code_verifier.ok_or_else(|| bad("invalid_request", "code_verifier is required"))?;
            let derived = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            if derived != c.challenge {
                return Err(bad("invalid_grant", "PKCE verification failed"));
            }
            Ok(Json(issue(&app, &c.client_name, None)))
        }
        "refresh_token" => {
            let rt = f.refresh_token.ok_or_else(|| bad("invalid_request", "refresh_token is required"))?;
            let h = hash(&rt);
            let grant = app.config.read().unwrap().mcp.grants.iter().find(|g| g.refresh_hash == h).cloned();
            let grant = grant.ok_or_else(|| bad("invalid_grant", "unknown or revoked refresh token"))?;
            Ok(Json(issue(&app, &grant.client_name, Some(&grant.id))))
        }
        _ => Err(bad("unsupported_grant_type", "use authorization_code or refresh_token")),
    }
}

/// New tokens; refreshing replaces the grant's tokens in place (rotation).
fn issue(app: &App, client_name: &str, replacing: Option<&str>) -> Value {
    let (access, refresh) = (new_token(), new_token());
    let _ = app.update_config(|c| {
        if let Some(id) = replacing {
            if let Some(g) = c.mcp.grants.iter_mut().find(|g| g.id == id) {
                g.access_hash = hash(&access);
                g.refresh_hash = hash(&refresh);
                return;
            }
        }
        c.mcp.grants.push(Grant {
            id: uuid::Uuid::new_v4().to_string(),
            client_name: client_name.to_string(),
            access_hash: hash(&access),
            refresh_hash: hash(&refresh),
            created: chrono::Utc::now(),
            last_used: None,
        });
    });
    json!({ "access_token": access, "token_type": "Bearer", "refresh_token": refresh })
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": error, "error_description": description })))
}

fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn esc(s: &str) -> String {
    crate::views::html_escape(s)
}

/// The browser side of sign-in: a short message, and (while waiting) a poll that follows the
/// app's decision.
fn page(title: &str, message: &str, wait_for: Option<&str>) -> Response {
    let script = wait_for
        .map(|id| {
            format!(
                r#"<script>
const poll = async () => {{
  try {{
    const r = await (await fetch("/authorize/status?id={id}")).json();
    if (r.state === "approved" || r.state === "denied") {{
      document.querySelector("p").textContent = r.state === "approved" ? "Approved — returning to the client…" : "Denied.";
      location.href = r.redirect; return;
    }}
    if (r.state === "gone") {{ document.querySelector("p").textContent = "This request expired. Start the sign-in again."; return; }}
  }} catch (e) {{}}
  setTimeout(poll, 1000);
}};
poll();
</script>"#
            )
        })
        .unwrap_or_default();
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>openComposer</title>
<style>
:root {{ color-scheme: light dark; font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }}
main {{ max-width: 420px; padding: 32px; text-align: center; }}
h1 {{ font-size: 19px; margin: 0 0 8px; }} p {{ opacity: .75; margin: 0; }} b {{ font-weight: 600; }}
</style></head><body><main><b>openComposer</b><h1>{}</h1><p>{}</p></main>{script}</body></html>"#,
        esc(title),
        esc(message)
    ))
    .into_response()
}
