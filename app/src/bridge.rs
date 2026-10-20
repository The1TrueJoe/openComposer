//! `openComposer --mcp-stdio`: an MCP stdio server that forwards to the running app.
//!
//! For clients configured with a command rather than a URL. It is the same executable
//! as the app (so it shows up as openComposer, not a stray interpreter), reads the port
//! and token from the app's settings, and relays JSON-RPC lines to `/mcp` over HTTP.
//! Approvals still happen in the app window, so the app must be running.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::config::{Config, Paths};

pub fn main(agent: bool) {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    rt.block_on(run(agent));
}

async fn run(agent: bool) {
    let cfg = Paths::resolve().map(|p| Config::load(&p.config())).unwrap_or_default();
    let url = format!("http://127.0.0.1:{}/{}", cfg.mcp.port, if agent { "agent/mcp" } else { "mcp" });
    let token = cfg.mcp.token;
    let http = reqwest::Client::new();
    let out = Arc::new(Mutex::new(tokio::io::stdout()));
    let protocol: Arc<Mutex<Option<String>>> = Default::default();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let (http, url, token, out, protocol) = (http.clone(), url.clone(), token.clone(), out.clone(), protocol.clone());
        // Each request runs on its own so a long approval doesn't block pings or cancels.
        tokio::spawn(async move {
            let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let mut req = http
                .post(&url)
                .bearer_auth(&token)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(line.clone());
            if let Some(v) = protocol.lock().await.clone() {
                req = req.header("mcp-protocol-version", v);
            }
            let replies = match req.send().await {
                Ok(r) if r.status().is_success() => {
                    let sse = r.headers().get("content-type").and_then(|c| c.to_str().ok()).is_some_and(|c| c.contains("event-stream"));
                    let body = r.text().await.unwrap_or_default();
                    if sse {
                        body.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect()
                    } else if body.trim().is_empty() {
                        vec![]
                    } else {
                        vec![body.trim().to_string()]
                    }
                }
                Ok(r) => error_reply(&msg, &format!("openComposer refused the request ({})", r.status())),
                Err(_) => error_reply(&msg, "openComposer isn't running — open the app, then retry"),
            };
            for r in replies {
                if let Ok(v) = serde_json::from_str::<Value>(&r) {
                    if let Some(p) = v["result"]["protocolVersion"].as_str() {
                        *protocol.lock().await = Some(p.to_string());
                    }
                }
                let mut o = out.lock().await;
                let _ = o.write_all(format!("{r}\n").as_bytes()).await;
                let _ = o.flush().await;
            }
        });
    }
}

fn error_reply(msg: &Value, text: &str) -> Vec<String> {
    match msg.get("id") {
        Some(id) if !id.is_null() => vec![json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": text } }).to_string()],
        _ => vec![],
    }
}
