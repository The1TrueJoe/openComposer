//! Shared application state: settings, the client identity, live Director sessions,
//! approvals and the activity log. Tauri commands, the MCP server and the agent all
//! hold an `Arc<App>`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

use c4::director::{Catalog, Snapshot};
use c4::{Director, Names};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::approvals::Approvals;
use crate::certs::{self, StoredIdentity};
use crate::config::{AccessMode, Config, Paths, SavedDirector};

type Emitter = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;
type SharedEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// How often a session in use re-reads its project in the background, to notice changes made
/// elsewhere (Composer, a touchscreen, another openComposer).
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// A session nobody has read from for this long isn't watched: no Uploads while idle.
const WATCH_IDLE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

pub struct App {
    pub paths: Paths,
    pub config: RwLock<Config>,
    pub identity: RwLock<Option<StoredIdentity>>,
    pub identity_error: RwLock<Option<String>>,
    /// Becomes true once the stored identity has been read (or found absent).
    unlocked: tokio::sync::watch::Sender<bool>,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
    pub approvals: Approvals,
    pub agents: crate::agent::Agents,
    /// What the window is showing (view, selected item, tab), reported by the UI so an
    /// assistant can answer "this" questions and steer the window.
    pub ui: RwLock<serde_json::Value>,
    activity: Mutex<VecDeque<Activity>>,
    activity_seq: AtomicU64,
    pub http: reqwest::Client,
    emitter: OnceLock<SharedEmitter>,
}

/// One connected Director plus the cached views of its project.
pub struct Session {
    pub id: String,
    pub director: Director,
    /// The project as last read, kept in memory: reads are served from it at once, and the
    /// watcher (`Session::watch`) replaces it when the Director's copy changes.
    snapshot: tokio::sync::RwLock<Option<(Instant, Arc<Snapshot>)>>,
    catalog: tokio::sync::RwLock<Option<Arc<Catalog>>>,
    /// When something last read the project; the watcher sleeps while this is old.
    last_read: Mutex<Instant>,
    /// One Upload at a time: a read that finds one running waits for it instead of starting another.
    fetching: tokio::sync::Mutex<()>,
    /// One batch of writes at a time per Director.
    pub write_lock: tokio::sync::Mutex<()>,
    broker: tokio::sync::Mutex<Option<(Instant, Arc<c4::broker::Broker>)>>,
    /// Driver file → icon as a data URL (or None when it has none we can fetch).
    pub icons: tokio::sync::Mutex<HashMap<String, Option<String>>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Activity {
    pub seq: u64,
    pub at: DateTime<Utc>,
    pub source: String,
    pub tool: String,
    pub summary: String,
    pub ok: bool,
    pub ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("no client certificate yet — import a certificate and its key (or a .p12) in Settings")]
    NoIdentity,
    #[error("no Director is set up — add one in Directors")]
    NoDirector,
    #[error("no Director called “{0}” (use list_directors to see the names)")]
    UnknownDirector(String),
    #[error("{0} is read-only in openComposer; switch it to “approve each write” in Directors to allow changes")]
    ReadOnly(String),
    #[error(transparent)]
    Director(#[from] c4::DirectorError),
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl App {
    pub fn new(paths: Paths) -> Arc<Self> {
        let config = Config::load(&paths.config());
        // Persist a generated MCP token on first run.
        let _ = config.save(&paths.config());
        // The identity is unlocked later (`unlock_identity`): reading the keychain can wait on
        // a macOS prompt, and the window and MCP server must not wait with it.
        let (identity, identity_error) = (None, None);
        let (unlocked, _) = tokio::sync::watch::channel(false);
        Arc::new(Self {
            paths,
            config: RwLock::new(config),
            identity: RwLock::new(identity),
            identity_error: RwLock::new(identity_error),
            unlocked,
            sessions: Default::default(),
            approvals: Approvals::default(),
            agents: Default::default(),
            ui: RwLock::new(serde_json::Value::Null),
            activity: Mutex::new(VecDeque::new()),
            activity_seq: AtomicU64::new(0),
            http: reqwest::Client::builder()
                .user_agent(concat!("openComposer/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
            emitter: OnceLock::new(),
        })
    }

    /// Read the stored identity off the startup path. The OS may ask the person for keychain
    /// access first; everything that needs the certificate waits for this (`identity_for_use`).
    pub fn unlock_identity(self: &Arc<Self>) {
        let app = self.clone();
        std::thread::spawn(move || {
            match certs::load(&app.paths.identity()) {
                Ok(i) => *app.identity.write().unwrap() = i,
                Err(e) => *app.identity_error.write().unwrap() = Some(e.to_string()),
            }
            app.unlocked.send_replace(true);
            app.emit("identity", serde_json::json!({ "unlocked": true }));
        });
    }

    pub fn identity_unlocked(&self) -> bool {
        *self.unlocked.borrow()
    }

    /// The client identity, waiting (up to two minutes) for the keychain unlock at startup.
    async fn identity_for_use(&self) -> AppResult<c4::Identity> {
        let mut rx = self.unlocked.subscribe();
        if tokio::time::timeout(std::time::Duration::from_secs(120), rx.wait_for(|v| *v)).await.is_err() {
            return Err(AppError::Other("still waiting for keychain access to the certificate — answer the macOS prompt".into()));
        }
        Ok(self.identity.read().unwrap().clone().ok_or(AppError::NoIdentity)?.identity()?)
    }

    pub fn set_emitter(&self, f: Emitter) {
        let _ = self.emitter.set(Arc::from(f));
    }

    /// Push an event to the UI (no-op before the window exists, e.g. in stdio mode).
    pub fn emit(&self, event: &str, payload: impl Serialize) {
        if let Some(f) = self.emitter.get() {
            f(event, serde_json::to_value(payload).unwrap_or_default());
        }
    }

    pub fn config(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    pub fn update_config(&self, f: impl FnOnce(&mut Config)) -> anyhow::Result<Config> {
        let mut c = self.config.write().unwrap();
        f(&mut c);
        c.save(&self.paths.config())?;
        let out = c.clone();
        drop(c);
        self.emit("config", &out);
        Ok(out)
    }

    /// Use an identity for this run only, without touching the keychain (tests).
    pub fn use_identity(&self, id: StoredIdentity) {
        *self.identity.write().unwrap() = Some(id);
        self.unlocked.send_replace(true);
    }

    pub fn set_identity(&self, id: StoredIdentity) -> anyhow::Result<()> {
        certs::save(&self.paths.identity(), &id)?;
        *self.identity.write().unwrap() = Some(id);
        *self.identity_error.write().unwrap() = None;
        self.unlocked.send_replace(true);
        Ok(())
    }

    /// Find a saved Director by id, name or host; `None` means the active one.
    pub fn resolve_director(&self, which: Option<&str>) -> AppResult<SavedDirector> {
        let c = self.config.read().unwrap();
        let wanted = which.map(str::trim).filter(|w| !w.is_empty());
        let found = match wanted {
            Some(w) => c.directors.iter().find(|d| {
                d.id == w || d.host.eq_ignore_ascii_case(w) || d.name.eq_ignore_ascii_case(w)
            }),
            None => c
                .active_director
                .as_deref()
                .and_then(|a| c.director(a))
                .or_else(|| c.directors.first()),
        };
        match (found, wanted) {
            (Some(d), _) => Ok(d.clone()),
            (None, Some(w)) => Err(AppError::UnknownDirector(w.into())),
            (None, None) => Err(AppError::NoDirector),
        }
    }

    /// A live session, connecting (or reconnecting) as needed.
    pub async fn session(&self, which: Option<&str>) -> AppResult<Arc<Session>> {
        let saved = self.resolve_director(which)?;
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get(&saved.id) {
            if !s.director.conn.is_closed() {
                return Ok(s.clone());
            }
        }
        let identity = self.identity_for_use().await?;
        let director = Director::connect(&saved.host, &identity, saved.fingerprint.as_deref()).await?;
        if saved.fingerprint.is_none() {
            let fp = director.info.server_fingerprint.clone();
            let id = saved.id.clone();
            self.update_config(|c| {
                if let Some(d) = c.directors.iter_mut().find(|d| d.id == id) {
                    d.fingerprint = Some(fp);
                }
            })?;
        }
        let s = Arc::new(Session {
            id: saved.id.clone(),
            director,
            snapshot: Default::default(),
            catalog: Default::default(),
            last_read: Mutex::new(Instant::now()),
            fetching: Default::default(),
            write_lock: Default::default(),
            broker: Default::default(),
            icons: Default::default(),
        });
        tokio::spawn(Session::watch(Arc::downgrade(&s), self.emitter.get().cloned()));
        sessions.insert(saved.id.clone(), s.clone());
        drop(sessions);
        self.emit("director", serde_json::json!({ "id": saved.id, "connected": true, "info": s.director.info }));
        Ok(s)
    }

    pub async fn connected(&self) -> Vec<String> {
        self.sessions
            .lock()
            .await
            .iter()
            .filter(|(_, s)| !s.director.conn.is_closed())
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub async fn disconnect(&self, id: &str) {
        if let Some(s) = self.sessions.lock().await.remove(id) {
            s.director.conn.close().await;
        }
        self.emit("director", serde_json::json!({ "id": id, "connected": false }));
    }

    /// The controller's web API for this session; tokens are renewed after 12 hours.
    pub async fn broker(&self, s: &Session) -> AppResult<Arc<c4::broker::Broker>> {
        let saved = self.resolve_director(Some(&s.id))?;
        if !saved.web_api {
            return Err(AppError::Other(format!(
                "the web API is switched off for {} (Directors → web API); driver files need it",
                saved.name
            )));
        }
        let mut slot = s.broker.lock().await;
        if let Some((at, b)) = slot.as_ref() {
            if at.elapsed().as_secs() < 12 * 3600 {
                return Ok(b.clone());
            }
        }
        let identity = self.identity_for_use().await?;
        // A Director reached through a forwarded port has its web API somewhere else; without a
        // web API address of its own, assume the usual port on the same host.
        let addr = saved.web_api_addr.clone().unwrap_or_else(|| c4::soap::split_addr(&saved.host, 0).0);
        let b = Arc::new(
            c4::broker::Broker::connect(&addr, &identity, saved.web_api_fingerprint.as_deref())
                .await
                .map_err(|e| AppError::Other(e.to_string()))?,
        );
        if saved.web_api_fingerprint.is_none() {
            let (id, fp) = (saved.id.clone(), b.fingerprint.clone());
            self.update_config(|c| {
                if let Some(d) = c.directors.iter_mut().find(|d| d.id == id) {
                    d.web_api_fingerprint = Some(fp);
                }
            })?;
        }
        *slot = Some((Instant::now(), b.clone()));
        Ok(b)
    }

    pub fn ensure_writable(&self, saved: &SavedDirector) -> AppResult<()> {
        match saved.mode {
            AccessMode::ReadOnly => Err(AppError::ReadOnly(saved.name.clone())),
            AccessMode::Approve => Ok(()),
        }
    }

    pub fn log(&self, source: &str, tool: &str, summary: String, ok: bool, ms: u64) {
        let a = Activity {
            seq: self.activity_seq.fetch_add(1, Ordering::Relaxed),
            at: Utc::now(),
            source: source.into(),
            tool: tool.into(),
            summary,
            ok,
            ms,
        };
        let mut log = self.activity.lock().unwrap();
        log.push_back(a.clone());
        while log.len() > 500 {
            log.pop_front();
        }
        drop(log);
        self.emit("activity", &a);
    }

    pub fn activity(&self) -> Vec<Activity> {
        self.activity.lock().unwrap().iter().cloned().collect()
    }
}

impl Session {
    /// The project. Served from memory when there is a copy (the watcher keeps it current);
    /// `refresh` reads it from the Director now — before and after a write, where only the
    /// Director's own copy will do.
    pub async fn snapshot(&self, refresh: bool) -> AppResult<Arc<Snapshot>> {
        *self.last_read.lock().unwrap() = Instant::now();
        if !refresh {
            if let Some((_, s)) = self.snapshot.read().await.as_ref() {
                return Ok(s.clone());
            }
        }
        let started = Instant::now();
        let _one = self.fetching.lock().await;
        // Someone else's Upload finished while this one waited: theirs is as fresh as ours.
        if let Some((at, s)) = self.snapshot.read().await.as_ref() {
            if *at >= started {
                return Ok(s.clone());
            }
        }
        let s = Arc::new(self.director.snapshot().await?);
        *self.snapshot.write().await = Some((Instant::now(), s.clone()));
        Ok(s)
    }

    /// Re-reads the project every `WATCH_EVERY` while the session is in use and, when the
    /// Director's copy differs from ours, swaps it in and tells the UI (`project-changed`), so
    /// changes made elsewhere show up without every click waiting on an Upload.
    async fn watch(me: std::sync::Weak<Session>, emit: Option<SharedEmitter>) {
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            let Some(s) = me.upgrade() else { return };
            if s.director.conn.is_closed() {
                return;
            }
            let have = s.snapshot.read().await.as_ref().map(|(_, x)| x.clone());
            let Some(old) = have else { continue };
            if s.last_read.lock().unwrap().elapsed() > WATCH_IDLE {
                continue;
            }
            let started = Instant::now();
            let _one = s.fetching.lock().await;
            if s.snapshot.read().await.as_ref().is_some_and(|(at, _)| *at >= started) {
                continue;
            }
            let Ok(new) = s.director.snapshot().await else { continue };
            let changed = without_ciphertext(&new.xml) != without_ciphertext(&old.xml);
            let items_changed = changed && new.project.items.keys().ne(old.project.items.keys());
            *s.snapshot.write().await = Some((Instant::now(), Arc::new(new)));
            drop(_one);
            if items_changed {
                // New or removed items need their driver definitions: re-read on next use.
                *s.catalog.write().await = None;
            }
            if changed {
                tracing::info!("project on {} changed outside openComposer; reloaded", s.id);
                if let Some(f) = &emit {
                    f("project-changed", serde_json::json!({ "director": s.id, "source": "watch" }));
                }
            }
        }
    }

    /// Driver definitions change only when drivers are added or updated. The exception is
    /// the Scheduler, whose events are its entries: those are taken from the latest snapshot
    /// (`GetItems` keeps a stale copy of them until Director restarts).
    pub async fn catalog(&self, refresh: bool) -> AppResult<Arc<Catalog>> {
        let cached = if refresh { None } else { self.catalog.read().await.clone() };
        let c = match cached {
            Some(c) => c,
            None => Arc::new(self.director.catalog().await?),
        };
        let snap = self.snapshot.read().await.as_ref().map(|(_, s)| s.clone());
        let c = match snap {
            Some(s) if !c.has_schedule_events(&s.project) => {
                let mut fresh = (*c).clone();
                fresh.set_schedule_events(&s.project);
                Arc::new(fresh)
            }
            _ => c,
        };
        *self.catalog.write().await = Some(c.clone());
        Ok(c)
    }

    pub async fn names(&self) -> AppResult<Names> {
        Ok(self.catalog(false).await?.names())
    }

    pub async fn invalidate(&self) {
        *self.snapshot.write().await = None;
        *self.catalog.write().await = None;
    }
}

/// The project XML without encrypted property values: Director re-encrypts them (driver
/// passwords) with fresh randomness on every Upload, so two reads of an unchanged project never
/// match byte for byte. Their values sit in `<value encrypted="true">…</value>`, escaped inside
/// an item's `<state>`.
fn without_ciphertext(xml: &str) -> String {
    let mut text = xml.to_string();
    for (open, close) in [(r#"encrypted="true"&gt;"#, "&lt;/value&gt;"), (r#"encrypted="true">"#, "</value>")] {
        let mut out = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some(a) = rest.find(open) {
            let start = a + open.len();
            out.push_str(&rest[..start]);
            rest = &rest[start..];
            if let Some(z) = rest.find(close) {
                rest = &rest[z..];
            }
        }
        out.push_str(rest);
        text = out;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::without_ciphertext;

    #[test]
    fn ignores_reencrypted_values() {
        let a = r#"<state>&lt;value encrypted="true"&gt;AAA&lt;/value&gt;&lt;x&gt;1</state><value encrypted="true">Q</value>"#;
        let b = r#"<state>&lt;value encrypted="true"&gt;BBBB&lt;/value&gt;&lt;x&gt;1</state><value encrypted="true">R</value>"#;
        assert_eq!(without_ciphertext(a), without_ciphertext(b));
        let c = r#"<state>&lt;value encrypted="true"&gt;AAA&lt;/value&gt;&lt;x&gt;2</state><value encrypted="true">Q</value>"#;
        assert_ne!(without_ciphertext(a), without_ciphertext(c));
    }
}
