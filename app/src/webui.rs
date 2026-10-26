//! Driver web tabs (`<tabs><tab name file/>` in driver.xml), hosted the way Composer hosts
//! them: the page from the driver's www folder, opened with
//! `?apihost=<controller>&driverid=<id>&apitoken=<JWT>`, talking to the controller's web API
//! and socket.io over `https://<apihost>`.
//!
//! The controller's certificate is self-signed, which Composer's embedded browser ignores
//! but the app's web view won't. So openComposer serves the page itself, injects a small
//! script that sends the page's `https://<apihost>` traffic (fetch, XHR, WebSocket,
//! EventSource) through this server, and forwards it to the controller — trusting its
//! certificate the way the rest of openComposer does. Pages work unchanged.
//!
//! Routes live under `/ui/<key>/…` on the MCP server's port. `key` is random per launch:
//! an iframe can't send the MCP bearer token, and the pages can't be reached without it.

use std::sync::{Arc, OnceLock};

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message as AxMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as TMessage;

use crate::state::{App, AppError, AppResult};

pub fn key() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(crate::config::new_token)
}

fn web_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .use_preconfigured_tls(c4::soap::web_tls_config(None))
            .user_agent(c4::soap::USER_AGENT)
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("http client")
    })
}

/// Where a Director's web API and package files are: (`host[:port]` the page calls, base URLs to try for files).
fn endpoints(app: &App, director: &str) -> AppResult<(String, Vec<String>)> {
    let saved = app.resolve_director(Some(director))?;
    let api = saved.web_api_addr.clone().unwrap_or_else(|| saved.host.clone());
    Ok((api.clone(), vec![format!("http://{}", saved.host), format!("https://{api}")]))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/ui/{key}/{director}/shim.js", get(shim))
        .route("/ui/{key}/{director}/page/{stem}/{*path}", get(page))
        .route("/ui/{key}/{director}/api/{*rest}", any(api))
        .with_state(app)
}

fn check(k: &str) -> Result<(), StatusCode> {
    if k == key() { Ok(()) } else { Err(StatusCode::NOT_FOUND) }
}

/// The tabs a device's driver declares, with URLs the UI can put in an iframe.
pub async fn tabs(app: &Arc<App>, director: Option<&str>, device: u32) -> AppResult<Value> {
    let s = app.session(director).await?;
    let cat = s.catalog(false).await?;
    let snap = s.snapshot(false).await?;
    let info = cat.devices.get(&device).ok_or_else(|| AppError::Other(format!("no driver definition for #{device}")))?;
    if info.tabs.is_empty() {
        return Ok(json!({ "tabs": [] }));
    }
    let driver = snap.project.item(device).and_then(|i| i.driver.clone()).unwrap_or_default();
    let stem = driver.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(driver);
    let broker = app.broker(&s).await?;
    let (api, _) = endpoints(app, &s.id)?;
    let port = crate::mcp::status().port;
    let enc = |v: &str| v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let tabs: Vec<Value> = info
        .tabs
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "url": format!(
                    "http://127.0.0.1:{port}/ui/{}/{}/page/{}/{}?apihost={}&driverid={device}&apitoken={}",
                    key(), enc(&s.id), enc(&stem), t.file.trim_start_matches('/'), enc(&api), enc(broker.token())
                ),
            })
        })
        .collect();
    Ok(json!({ "tabs": tabs }))
}

async fn shim(State(app): State<Arc<App>>, Path((k, director)): Path<(String, String)>) -> Result<Response, StatusCode> {
    check(&k)?;
    let (api, _) = endpoints(&app, &director).map_err(|_| StatusCode::NOT_FOUND)?;
    let js = format!(
        r#"(() => {{
  const API = "https://{api}", WSAPI = "wss://{api}";
  const PROXY = location.origin + "/ui/{k}/{director}/api", WSPROXY = PROXY.replace(/^http/, "ws");
  const map = (u) => {{
    const s = String(u);
    if (s.startsWith(API)) return PROXY + s.slice(API.length);
    if (s.startsWith(WSAPI)) return WSPROXY + s.slice(WSAPI.length);
    return u;
  }};
  const f = window.fetch;
  window.fetch = (input, init) => (input instanceof Request) ? f(new Request(map(input.url), input), init) : f(map(input), init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {{ return open.call(this, m, map(u), ...rest); }};
  const WS = window.WebSocket;
  const Shim = function (u, p) {{ return new WS(map(u), p); }};
  Shim.prototype = WS.prototype; Object.assign(Shim, {{ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }});
  window.WebSocket = Shim;
  if (window.EventSource) {{ const ES = window.EventSource; window.EventSource = function (u, c) {{ return new ES(map(u), c); }}; }}
}})();"#
    );
    Ok(([(header::CONTENT_TYPE, "application/javascript"), (header::CACHE_CONTROL, "no-store")], js).into_response())
}

async fn page(
    State(app): State<Arc<App>>,
    Path((k, director, stem, path)): Path<(String, String, String, String)>,
) -> Result<Response, StatusCode> {
    check(&k)?;
    let (_, bases) = endpoints(&app, &director).map_err(|_| StatusCode::NOT_FOUND)?;
    // Sources that couldn't be reached are skipped for the rest of the launch (a Virtual
    // Director's PC has no web server; waiting on it for every file adds up).
    static DEAD: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let dead = DEAD.get_or_init(Default::default);
    let mut found = None;
    for base in bases {
        if dead.lock().unwrap().contains(&base) {
            continue;
        }
        let url = format!("{base}/c4z/{stem}/www/{path}");
        let Ok(r) = web_client().get(&url).timeout(std::time::Duration::from_secs(4)).send().await else {
            dead.lock().unwrap().insert(base);
            continue;
        };
        if !r.status().is_success() {
            continue;
        }
        let ct = r.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
        found = Some((ct, r.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?));
        break;
    }
    // No web server for packages (a Virtual Director): read the file out of the package.
    if found.is_none() {
        found = from_package(&app, &director, &stem, &path).await;
    }
    if let Some((ct, body)) = found {
        if ct.contains("text/html") {
            let html = String::from_utf8_lossy(&body);
            let tag = format!(r#"<script src="/ui/{k}/{director}/shim.js"></script>"#);
            // First thing in <head>, so the page's own scripts already see the shim.
            let injected = match html.to_ascii_lowercase().find("<head") {
                Some(i) => {
                    let end = html[i..].find('>').map(|e| i + e + 1).unwrap_or(i);
                    format!("{}{tag}{}", &html[..end], &html[end..])
                }
                None => format!("{tag}{html}"),
            };
            return Ok(([(header::CONTENT_TYPE, ct)], injected).into_response());
        }
        return Ok(([(header::CONTENT_TYPE, ct)], body).into_response());
    }
    Err(StatusCode::NOT_FOUND)
}

/// A file from a driver package's www folder, downloading the package once per launch.
async fn from_package(app: &Arc<App>, director: &str, stem: &str, path: &str) -> Option<(String, Bytes)> {
    use std::collections::HashMap;
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
    let key = format!("{director}/{stem}");
    let cache = CACHE.get_or_init(Default::default);
    // Looked up on its own line: a guard in the match scrutinee would live through the
    // arms, and the miss arm locks the cache again.
    let cached = cache.lock().await.get(&key).cloned();
    let pkg = match cached {
        Some(p) => p,
        None => {
            let file = format!("{stem}.c4z");
            // The controller's own copy, else the driver library (a Virtual Director loads
            // drivers from Composer's folder, which its web API doesn't serve).
            let mut bytes = None;
            if let Ok(s) = app.session(Some(director)).await {
                if let Ok(b) = app.broker(&s).await {
                    bytes = b.download_driver(&file).await.ok().flatten();
                }
            }
            let bytes = Arc::new(bytes.or_else(|| crate::library::find(app, &file).map(|(b, _)| b))?);
            cache.lock().await.insert(key, bytes.clone());
            bytes
        }
    };
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(pkg.as_slice())).ok()?;
    let mut f = z.by_name(&format!("www/{path}")).ok()?;
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut out).ok()?;
    Some((mime_for(path).to_string(), Bytes::from(out)))
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// The page's controller traffic: plain requests are forwarded; WebSocket upgrades
/// (socket.io) are bridged frame by frame.
async fn api(
    State(app): State<Arc<App>>,
    Path((k, director, rest)): Path<(String, String, String)>,
    RawQuery(query): RawQuery,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    check(&k)?;
    let (api, _) = endpoints(&app, &director).map_err(|_| StatusCode::NOT_FOUND)?;
    let q = query.map(|q| format!("?{q}")).unwrap_or_default();
    if let Ok(ws) = ws {
        let target = format!("wss://{api}/{rest}{q}");
        return Ok(ws.on_upgrade(move |socket| bridge(socket, target)));
    }
    let url = format!("https://{api}/{rest}{q}");
    let mut req = web_client().request(method, &url);
    for h in [header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT] {
        if let Some(v) = headers.get(&h) {
            req = req.header(h, v);
        }
    }
    let r = req.body(body).send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let ct = r.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = r.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = status;
    if let Some(ct) = ct {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    Ok(resp)
}

async fn bridge(client: WebSocket, target: String) {
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(c4::soap::web_tls_config(None)));
    let Ok((upstream, _)) = tokio_tungstenite::connect_async_tls_with_config(target.as_str(), None, false, Some(connector)).await else {
        return;
    };
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();
    let to_up = async {
        while let Some(Ok(m)) = cl_rx.next().await {
            let m = match m {
                AxMessage::Text(t) => TMessage::text(t.as_str()),
                AxMessage::Binary(b) => TMessage::binary(b),
                AxMessage::Ping(p) => TMessage::Ping(p),
                AxMessage::Pong(p) => TMessage::Pong(p),
                AxMessage::Close(_) => break,
            };
            if up_tx.send(m).await.is_err() {
                break;
            }
        }
    };
    let to_client = async {
        while let Some(Ok(m)) = up_rx.next().await {
            let m = match m {
                TMessage::Text(t) => AxMessage::Text(t.as_str().into()),
                TMessage::Binary(b) => AxMessage::Binary(b),
                TMessage::Ping(p) => AxMessage::Ping(p),
                TMessage::Pong(p) => AxMessage::Pong(p),
                TMessage::Close(_) | TMessage::Frame(_) => break,
            };
            if cl_tx.send(m).await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _ = to_up => {}, _ = to_client => {} }
}
