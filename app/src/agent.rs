//! The in-app agent: the user's own `claude` or `codex` CLI, driven over pipes.
//!
//! The CLI gets openComposer's MCP tools and nothing else (no shell, no file tools,
//! none of the user's other MCP servers), runs in a private working directory, and
//! uses whatever subscription the user is signed in with. Every write it proposes
//! goes through the same approval cards as any other MCP client.
//!
//! Claude: one long-lived `claude -p --input-format stream-json` per conversation;
//! each user turn is a JSON line on its stdin, so context carries over naturally.
//! Codex: one `codex exec --json` per turn, resumed by thread id.
//! ponytail: the Codex path follows its documented flags but has not been run (no
//! Codex on the development machine); verify `exec resume` and the event names.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

use crate::config::Provider;
use crate::proc;
use crate::state::{App, AppError, AppResult};

const SYSTEM: &str = "You are openComposer's assistant for a Control4 home automation system, working \
through openComposer's MCP tools (they mirror what Composer Pro can see and do). Look before you act: \
read the project, the item and its connections first. Changes go through propose_changes, which \
shows the user a project diff to approve; batch related changes into one proposal with a clear \
reason, and report what actually happened from the tool result. If something is ambiguous (which \
room, which input), ask. Be concise and use the project's own names for rooms and devices. \
Messages may start with [Looking at: …] — what the user has open in the app; \"this\" and \"here\" refer \
to it (ui_context has the details). Use ui_show to bring up what you're talking about, and add_driver to \
add devices (it installs driver files as needed).";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Entry {
    User { text: String, at: DateTime<Utc> },
    Assistant { text: String, streaming: bool },
    Tool { id: String, name: String, input: Value, output: Option<Value>, is_error: bool },
    Status { text: String },
    Error { text: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationInfo {
    pub id: String,
    pub provider: Provider,
    pub title: String,
    pub created: DateTime<Utc>,
    pub busy: bool,
    pub entries: Vec<Entry>,
    pub cost_usd: f64,
    /// Model alias or id (`sonnet`, `opus`, a full id); `None` = the CLI's default.
    pub model: Option<String>,
    /// Claude's effort level (low … max); `None` = default.
    pub effort: Option<String>,
    /// openComposer tools the CLI loaded at start (`None` until it has started).
    pub tools: Option<usize>,
}

pub struct Conversation {
    id: String,
    provider: Provider,
    created: DateTime<Utc>,
    title: Mutex<String>,
    entries: Mutex<Vec<Entry>>,
    busy: AtomicBool,
    cost: Mutex<f64>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    child: tokio::sync::Mutex<Option<Child>>,
    session: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    effort: Mutex<Option<String>>,
    tools: Mutex<Option<usize>>,
}

#[derive(Default)]
pub struct Agents {
    convs: Mutex<HashMap<String, Arc<Conversation>>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderStatus {
    pub provider: Provider,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn cli_path(app: &App, p: Provider) -> Option<PathBuf> {
    let cfg = app.config().agent;
    let explicit = match p {
        Provider::Claude => cfg.claude_path,
        Provider::Codex => cfg.codex_path,
    };
    explicit.map(PathBuf::from).filter(|p| p.is_file()).or_else(|| {
        proc::which(match p {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        })
    })
}

pub async fn providers(app: &App) -> Vec<ProviderStatus> {
    let mut out = Vec::new();
    for p in [Provider::Claude, Provider::Codex] {
        let path = cli_path(app, p);
        let version = match &path {
            Some(bin) => tokio::process::Command::new(bin)
                .arg("--version")
                .env("PATH", proc::search_path())
                .output()
                .await
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
            None => None,
        };
        out.push(ProviderStatus { provider: p, installed: path.is_some(), path: path.map(|p| p.display().to_string()), version });
    }
    out
}

impl Conversation {
    fn info(&self) -> ConversationInfo {
        ConversationInfo {
            id: self.id.clone(),
            provider: self.provider,
            title: self.title.lock().unwrap().clone(),
            created: self.created,
            busy: self.busy.load(Ordering::Relaxed),
            entries: self.entries.lock().unwrap().clone(),
            cost_usd: *self.cost.lock().unwrap(),
            model: self.model.lock().unwrap().clone(),
            effort: self.effort.lock().unwrap().clone(),
            tools: *self.tools.lock().unwrap(),
        }
    }

    fn push(&self, app: &App, e: Entry) {
        self.entries.lock().unwrap().push(e);
        app.emit("agent", self.info());
    }

    /// Append streamed text to the assistant message being written.
    fn stream_text(&self, app: &App, delta: &str) {
        let mut es = self.entries.lock().unwrap();
        match es.last_mut() {
            Some(Entry::Assistant { text, streaming: true }) => text.push_str(delta),
            _ => es.push(Entry::Assistant { text: delta.into(), streaming: true }),
        }
        drop(es);
        app.emit("agent", self.info());
    }

    fn finish_text(&self, full: Option<&str>) {
        let mut es = self.entries.lock().unwrap();
        match es.last_mut() {
            Some(Entry::Assistant { text, streaming }) if *streaming => {
                if let Some(f) = full {
                    *text = f.to_string();
                }
                *streaming = false;
            }
            _ => {
                if let Some(f) = full.filter(|f| !f.is_empty()) {
                    es.push(Entry::Assistant { text: f.into(), streaming: false });
                }
            }
        }
    }

    fn tool_result(&self, id: &str, output: Value, is_error: bool) {
        let mut es = self.entries.lock().unwrap();
        if let Some(Entry::Tool { output: o, is_error: e, .. }) =
            es.iter_mut().rev().find(|x| matches!(x, Entry::Tool { id: tid, .. } if tid == id))
        {
            *o = Some(output);
            *e = is_error;
        }
    }
}

impl Agents {
    pub fn list(&self) -> Vec<ConversationInfo> {
        let mut v: Vec<_> = self.convs.lock().unwrap().values().map(|c| c.info()).collect();
        v.sort_by(|a, b| b.created.cmp(&a.created));
        v
    }

    pub fn get(&self, id: &str) -> Option<ConversationInfo> {
        self.convs.lock().unwrap().get(id).map(|c| c.info())
    }

    pub fn start(&self, provider: Provider, model: Option<String>, effort: Option<String>) -> ConversationInfo {
        let c = Arc::new(Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            provider,
            created: Utc::now(),
            title: Mutex::new("New conversation".into()),
            entries: Default::default(),
            busy: AtomicBool::new(false),
            cost: Mutex::new(0.0),
            stdin: Default::default(),
            child: Default::default(),
            session: Default::default(),
            model: Mutex::new(model.filter(|m| !m.trim().is_empty())),
            effort: Mutex::new(effort.filter(|m| !m.trim().is_empty())),
            tools: Mutex::new(None),
        });
        let info = c.info();
        self.convs.lock().unwrap().insert(c.id.clone(), c);
        info
    }

    pub async fn stop(&self, id: &str) {
        let c = self.convs.lock().unwrap().get(id).cloned();
        if let Some(c) = c {
            *c.stdin.lock().await = None;
            if let Some(mut ch) = c.child.lock().await.take() {
                let _ = ch.kill().await;
            }
            c.busy.store(false, Ordering::Relaxed);
        }
    }

    pub async fn remove(&self, id: &str) {
        self.stop(id).await;
        self.convs.lock().unwrap().remove(id);
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.convs.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    /// Change model/effort. A running CLI is stopped; the next message resumes the same
    /// session with the new settings, so the conversation carries on.
    pub async fn configure(&self, id: &str, model: Option<String>, effort: Option<String>) -> AppResult<ConversationInfo> {
        let c = self.convs.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::Other("no such conversation".into()))?;
        if c.busy.load(Ordering::Relaxed) {
            return Err(AppError::Other("wait for the current reply to finish (or stop it) before switching".into()));
        }
        *c.model.lock().unwrap() = model.filter(|m| !m.trim().is_empty());
        *c.effort.lock().unwrap() = effort.filter(|m| !m.trim().is_empty());
        *c.stdin.lock().await = None;
        if let Some(mut ch) = c.child.lock().await.take() {
            let _ = ch.kill().await;
        }
        Ok(c.info())
    }

    pub async fn send(&self, app: &Arc<App>, id: &str, text: String, attachments: Vec<String>) -> AppResult<()> {
        let c = self.convs.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::Other("no such conversation".into()))?;
        if c.busy.swap(true, Ordering::Relaxed) {
            return Err(AppError::Other("still working on the previous message".into()));
        }
        {
            let mut t = c.title.lock().unwrap();
            if *t == "New conversation" {
                // The ask bar prefixes "[Looking at: …]"; title from what was actually asked.
                let asked = text.lines().filter(|l| !l.starts_with("[Looking at:")).collect::<Vec<_>>().join(" ");
                *t = asked.trim().chars().take(60).collect();
            }
        }
        let text = attach(app, &c.id, text, &attachments)?;
        c.push(app, Entry::User { text: text.clone(), at: Utc::now() });
        let r = match c.provider {
            Provider::Claude => send_claude(app, &c, &text).await,
            Provider::Codex => send_codex(app, &c, &text).await,
        };
        if let Err(e) = &r {
            c.busy.store(false, Ordering::Relaxed);
            c.push(app, Entry::Error { text: e.to_string() });
        }
        r
    }
}

fn mcp_url(app: &App) -> (String, String) {
    let m = app.config().mcp;
    let port = Some(crate::mcp::status().port).filter(|p| *p != 0).unwrap_or(m.port);
    (format!("http://127.0.0.1:{port}/agent/mcp"), m.token)
}

async fn send_claude(app: &Arc<App>, c: &Arc<Conversation>, text: &str) -> AppResult<()> {
    let mut stdin = c.stdin.lock().await;
    if stdin.is_none() {
        let bin = cli_path(app, Provider::Claude)
            .ok_or_else(|| AppError::Other("Claude Code isn't installed (or set its path in Settings)".into()))?;
        let (url, token) = mcp_url(app);
        let cfg_path = app.paths.agent().join("mcp.json");
        let cfg = json!({ "mcpServers": { "openComposer": { "type": "http", "url": url,
            "headers": { "Authorization": format!("Bearer {token}") } } } });
        std::fs::write(&cfg_path, cfg.to_string()).map_err(|e| AppError::Other(e.to_string()))?;
        crate::config::restrict(&cfg_path);
        let mut args: Vec<String> = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            // Only openComposer's tools, plus Read for files attached to this conversation.
            "--include-partial-messages", "--tools", "Read", "--strict-mcp-config",
            "--allowedTools", "mcp__openComposer", "Read(./attachments/**)", "--append-system-prompt", SYSTEM,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend(["--mcp-config".into(), cfg_path.display().to_string()]);
        if let Some(m) = c.model.lock().unwrap().clone().or(app.config().agent.model) {
            args.extend(["--model".into(), m]);
        }
        if let Some(e) = c.effort.lock().unwrap().clone() {
            args.extend(["--effort".into(), e]);
        }
        // Restarted after a model change: pick the same conversation back up.
        if let Some(sid) = c.session.lock().unwrap().clone() {
            args.extend(["--resume".into(), sid]);
        }
        let mut child = proc::spawn(&bin, &args, &app.paths.agent()).map_err(|e| AppError::Other(format!("could not start claude: {e}")))?;
        *stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        *c.child.lock().await = Some(child);
        let (app2, c2) = (app.clone(), c.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&l) {
                    on_claude_event(&app2, &c2, &v);
                }
            }
            c2.busy.store(false, Ordering::Relaxed);
            *c2.stdin.lock().await = None;
            c2.push(&app2, Entry::Status { text: "Agent session ended.".into() });
        });
        let (app3, c3) = (app.clone(), c.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if !l.trim().is_empty() {
                    tracing::warn!("claude: {l}");
                    if l.to_lowercase().contains("error") {
                        c3.push(&app3, Entry::Error { text: l });
                    }
                }
            }
        });
    }
    let msg = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } });
    let w = stdin.as_mut().unwrap();
    w.write_all(format!("{msg}\n").as_bytes()).await.map_err(|e| AppError::Other(format!("agent stopped: {e}")))?;
    w.flush().await.ok();
    Ok(())
}

fn on_claude_event(app: &App, c: &Conversation, v: &Value) {
    match v["type"].as_str() {
        Some("system") if v["subtype"] == "init" => {
            *c.session.lock().unwrap() = v["session_id"].as_str().map(String::from);
            let tools = v["tools"]
                .as_array()
                .map(|t| t.iter().filter(|x| x.as_str().is_some_and(|n| n.starts_with("mcp__openComposer__"))).count())
                .unwrap_or(0);
            *c.tools.lock().unwrap() = Some(tools);
            if tools == 0 {
                let st = crate::mcp::status();
                let why = st.error.unwrap_or_else(|| if st.listening { "the agent couldn't reach it".into() } else { "it isn't running".into() });
                c.push(app, Entry::Error {
                    text: format!("openComposer's tools didn't load, so this chat can't see the project ({why}). Check Settings → MCP, then start a new chat."),
                });
            } else {
                let model = v["model"].as_str().map(|m| format!(" · {m}")).unwrap_or_default();
                c.push(app, Entry::Status { text: format!("Connected to Claude{model} · {tools} openComposer tools") });
            }
        }
        Some("stream_event") => {
            let e = &v["event"];
            if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                c.stream_text(app, e["delta"]["text"].as_str().unwrap_or_default());
            }
        }
        Some("assistant") => {
            let blocks = v["message"]["content"].as_array().cloned().unwrap_or_default();
            let text: String = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
            c.finish_text(Some(&text).filter(|t| !t.is_empty()).map(|t| t.as_str()));
            for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
                let name = b["name"].as_str().unwrap_or_default().trim_start_matches("mcp__openComposer__").to_string();
                c.entries.lock().unwrap().push(Entry::Tool {
                    id: b["id"].as_str().unwrap_or_default().into(),
                    name,
                    input: b["input"].clone(),
                    output: None,
                    is_error: false,
                });
            }
            app.emit("agent", c.info());
        }
        Some("user") => {
            for b in v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result") {
                let out = match &b["content"] {
                    Value::Array(parts) => {
                        let t: String = parts.iter().filter_map(|p| p["text"].as_str()).collect();
                        serde_json::from_str(&t).unwrap_or(Value::String(t))
                    }
                    other => other.clone(),
                };
                c.tool_result(b["tool_use_id"].as_str().unwrap_or_default(), out, b["is_error"].as_bool().unwrap_or(false));
            }
            app.emit("agent", c.info());
        }
        Some("result") => {
            c.finish_text(None);
            if let Some(cost) = v["total_cost_usd"].as_f64() {
                *c.cost.lock().unwrap() = cost;
            }
            if v["is_error"].as_bool() == Some(true) {
                let msg = v["result"].as_str().unwrap_or("the agent reported an error").to_string();
                c.entries.lock().unwrap().push(Entry::Error { text: msg });
            }
            c.busy.store(false, Ordering::Relaxed);
            app.emit("agent", c.info());
        }
        _ => {}
    }
}

async fn send_codex(app: &Arc<App>, c: &Arc<Conversation>, text: &str) -> AppResult<()> {
    let bin = cli_path(app, Provider::Codex)
        .ok_or_else(|| AppError::Other("Codex isn't installed (or set its path in Settings)".into()))?;
    let me = std::env::current_exe().map_err(|e| AppError::Other(e.to_string()))?;
    let mut args: Vec<String> = vec!["exec".into()];
    let session = c.session.lock().unwrap().clone();
    if let Some(s) = &session {
        args.extend(["resume".into(), s.clone()]);
    }
    args.extend([
        "--json".into(),
        "--skip-git-repo-check".into(),
        "-c".into(),
        format!("mcp_servers.openComposer.command={}", toml_str(&me.display().to_string())),
        "-c".into(),
        "mcp_servers.openComposer.args=[\"--mcp-stdio\",\"--agent\"]".into(),
    ]);
    if let Some(m) = c.model.lock().unwrap().clone().or(app.config().agent.model) {
        args.extend(["-m".into(), m]);
    }
    let prompt = if session.is_none() { format!("{SYSTEM}\n\n{text}") } else { text.to_string() };
    args.push(prompt);
    let mut child = proc::spawn(&bin, &args, &app.paths.agent()).map_err(|e| AppError::Other(format!("could not start codex: {e}")))?;
    drop(child.stdin.take());
    let stdout = child.stdout.take().unwrap();
    *c.child.lock().await = Some(child);
    let (app2, c2) = (app.clone(), c.clone());
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
            match v["type"].as_str() {
                Some("thread.started") => *c2.session.lock().unwrap() = v["thread_id"].as_str().map(String::from),
                Some("item.completed") | Some("item.started") => {
                    let item = &v["item"];
                    match item["type"].as_str() {
                        Some("agent_message") if v["type"] == "item.completed" => {
                            c2.push(&app2, Entry::Assistant { text: item["text"].as_str().unwrap_or_default().into(), streaming: false })
                        }
                        Some("mcp_tool_call") => {
                            let id = item["id"].as_str().unwrap_or_default().to_string();
                            if v["type"] == "item.started" {
                                c2.push(&app2, Entry::Tool {
                                    id,
                                    name: item["tool"].as_str().unwrap_or_default().into(),
                                    input: item["arguments"].clone(),
                                    output: None,
                                    is_error: false,
                                });
                            } else {
                                c2.tool_result(&id, item["result"].clone(), item["status"] == "failed");
                                app2.emit("agent", c2.info());
                            }
                        }
                        _ => {}
                    }
                }
                Some("error") | Some("turn.failed") => c2.push(&app2, Entry::Error { text: v.to_string() }),
                _ => {}
            }
        }
        c2.busy.store(false, Ordering::Relaxed);
        app2.emit("agent", c2.info());
    });
    Ok(())
}

fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Copy attached files into the conversation's folder (the agent may read only there) and
/// tell the agent where they are.
fn attach(app: &App, conv: &str, text: String, files: &[String]) -> AppResult<String> {
    if files.is_empty() {
        return Ok(text);
    }
    let dir = app.paths.agent().join("attachments").join(conv);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let mut lines = Vec::new();
    for f in files {
        let src = std::path::Path::new(f);
        let name: String = src
            .file_name()
            .map(|n| n.to_string_lossy().chars().map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect())
            .ok_or_else(|| AppError::Other(format!("{f} isn't a file")))?;
        std::fs::copy(src, dir.join(&name)).map_err(|e| AppError::Other(format!("can't attach {name}: {e}")))?;
        lines.push(format!("- attachments/{conv}/{name}"));
    }
    Ok(format!("{text}\n\nAttached files (read them with your Read tool):\n{}", lines.join("\n")))
}
