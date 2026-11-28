//! Settings persisted as JSON in the app's data directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_MCP_PORT: u16 = 7710;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    /// Every tool that changes the project is refused.
    ReadOnly,
    /// Writes pause for an approval card showing the predicted diff.
    Approve,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedDirector {
    pub id: String,
    pub name: String,
    pub host: String,
    /// SHA-256 of the controller's TLS certificate, pinned on first connect.
    pub fingerprint: Option<String>,
    pub mode: AccessMode,
    /// Use the controller's web API (driver files). Asking it for a token changes
    /// nothing, but it can be switched off per Director.
    #[serde(default = "yes")]
    pub web_api: bool,
    /// Web API address when it isn't `host:443` (a Virtual Director serves it on
    /// 127.0.0.1:8443 of its own PC).
    #[serde(default)]
    pub web_api_addr: Option<String>,
    #[serde(default)]
    pub web_api_fingerprint: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpConfig {
    pub port: u16,
    /// Listen on all interfaces (token still required) instead of loopback only.
    pub lan: bool,
    pub token: String,
    /// Clients that signed in with OAuth (see `oauth.rs`), each revocable.
    #[serde(default)]
    pub grants: Vec<Grant>,
}

/// An MCP client signed in through the browser and approved in the app. Only hashes of
/// its tokens are kept.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    pub client_name: String,
    pub access_hash: String,
    pub refresh_hash: String,
    pub created: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub last_used: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentConfig {
    pub provider: Provider,
    /// Explicit CLI paths; when unset the usual install locations are searched.
    pub claude_path: Option<String>,
    pub codex_path: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub directors: Vec<SavedDirector>,
    pub active_director: Option<String>,
    pub mcp: McpConfig,
    pub agent: AgentConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            directors: vec![],
            active_director: None,
            mcp: McpConfig { port: DEFAULT_MCP_PORT, lan: true, token: new_token(), grants: vec![] },
            agent: AgentConfig { provider: Provider::Claude, claude_path: None, codex_path: None, model: None },
        }
    }
}

pub fn new_token() -> String {
    let mut b = [0u8; 24];
    rand::fill(&mut b);
    hex::encode(b)
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
}

impl Paths {
    /// `OPENCOMPOSER_DATA` overrides the location (tests, side-by-side instances).
    pub fn resolve() -> anyhow::Result<Self> {
        let data = match std::env::var_os("OPENCOMPOSER_DATA") {
            Some(d) => PathBuf::from(d),
            None => directories::ProjectDirs::from("com", "openComposer", "openComposer")
                .ok_or_else(|| anyhow::anyhow!("no home directory to keep settings in"))?
                .data_dir()
                .to_path_buf(),
        };
        for d in [&data, &data.join("backups"), &data.join("agent")] {
            std::fs::create_dir_all(d)?;
        }
        Ok(Self { data })
    }
    pub fn config(&self) -> PathBuf {
        self.data.join("config.json")
    }
    pub fn identity(&self) -> PathBuf {
        self.data.join("identity.bin")
    }
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
    /// The agent's working directory: kept apart from anything of the user's.
    pub fn agent(&self) -> PathBuf {
        self.data.join("agent")
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        restrict(&tmp);
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn director(&self, id: &str) -> Option<&SavedDirector> {
        self.directors.iter().find(|d| d.id == id)
    }
}

/// Owner-only permissions for files that hold the MCP token or key material.
pub fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}
