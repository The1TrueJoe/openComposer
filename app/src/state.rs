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

pub struct App {
    pub paths: Paths,
    pub config: RwLock<Config>,
    pub identity: RwLock<Option<StoredIdentity>>,
    pub identity_error: RwLock<Option<String>>,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
    pub approvals: Approvals,
    pub agents: crate::agent::Agents,
    activity: Mutex<VecDeque<Activity>>,
    activity_seq: AtomicU64,
    pub http: reqwest::Client,
    emitter: OnceLock<Emitter>,
}

/// One connected Director plus the cached views of its project.
pub struct Session {
    pub id: String,
    pub director: Director,
    snapshot: tokio::sync::RwLock<Option<(Instant, Arc<Snapshot>)>>,
    catalog: tokio::sync::RwLock<Option<Arc<Catalog>>>,
    /// One batch of writes at a time per Director.
    pub write_lock: tokio::sync::Mutex<()>,
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
    #[error("no client certificate yet — import composer.pem/.key (or a .p12) in Settings")]
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
        let (identity, identity_error) = match certs::load(&paths.identity()) {
            Ok(i) => (i, None),
            Err(e) => (None, Some(e.to_string())),
        };
        Arc::new(Self {
            paths,
            config: RwLock::new(config),
            identity: RwLock::new(identity),
            identity_error: RwLock::new(identity_error),
            sessions: Default::default(),
            approvals: Approvals::default(),
            agents: Default::default(),
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

    pub fn set_emitter(&self, f: Emitter) {
        let _ = self.emitter.set(f);
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
    }

    pub fn set_identity(&self, id: StoredIdentity) -> anyhow::Result<()> {
        certs::save(&self.paths.identity(), &id)?;
        *self.identity.write().unwrap() = Some(id);
        *self.identity_error.write().unwrap() = None;
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
        let identity = self
            .identity
            .read()
            .unwrap()
            .clone()
            .ok_or(AppError::NoIdentity)?
            .identity()?;
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
            write_lock: Default::default(),
        });
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
    /// Snapshots are reused for a few seconds so a burst of reads costs one Upload.
    pub async fn snapshot(&self, refresh: bool) -> AppResult<Arc<Snapshot>> {
        if !refresh {
            if let Some((at, s)) = self.snapshot.read().await.as_ref() {
                if at.elapsed().as_secs() < 5 {
                    return Ok(s.clone());
                }
            }
        }
        let s = Arc::new(self.director.snapshot().await?);
        *self.snapshot.write().await = Some((Instant::now(), s.clone()));
        Ok(s)
    }

    /// Driver definitions change only when drivers are added or updated.
    pub async fn catalog(&self, refresh: bool) -> AppResult<Arc<Catalog>> {
        if !refresh {
            if let Some(c) = self.catalog.read().await.as_ref() {
                return Ok(c.clone());
            }
        }
        let c = Arc::new(self.director.catalog().await?);
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
