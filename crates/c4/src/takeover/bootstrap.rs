//! Regaining root SSH on an OS 4.2+ controller, which ships with password SSH turned off.
//!
//! The older path (a password, derived or factory, in [`super::authderive`]) no longer
//! opens these boxes. Instead the controller's REST API authenticates the **owner's own
//! Control4 account** (`POST /api/v1/jwt`), and a driver on the project runs Lua in the
//! Director process — which is root. So the bootstrap is:
//!
//!   1. the owner signs in with their Control4 account → a short-lived REST token;
//!   2. find a project item whose driver will run arbitrary Lua (`Data Analytics Agent`
//!      or `Stations`);
//!   3. post a `LUA_COMMANDS` call that re-enables `PasswordAuthentication` in
//!      `sshd_config`;
//!   4. `pkill -HUP sshd` so it takes effect.
//!
//! After that, [`super::ssh`] logs in with the factory password and installs a key for
//! durable access (and a revert can turn password auth back off). This module stops at
//! step 4 — it is the deliberate, owner-authorised way back into a box the owner owns, not
//! something run automatically; the `Op` that drives it goes through the approval flow.
//!
//! What this module is **not**: it never stores or forwards the account password. The
//! password is passed in for the single sign-in request to the controller's own endpoint
//! and then dropped; callers must not log it.

use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::soap::web_tls_config_seen;

/// Control4's fixed Composer application key for the account sign-in. Not a secret of the
/// owner's — it identifies the client to the controller's auth endpoint.
pub const APPLICATION_KEY: &str = "78f6791373d61bea49fdb9fb8897f1f3af193f11";

/// Driver/item names whose Lua runtime we can reach to run the bootstrap. These agents are
/// present on essentially every project and accept `LUA_COMMANDS`.
pub const WRITABLE_DRIVER_NAMES: &[&str] = &["Data Analytics Agent", "Stations"];

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("controller unreachable at {addr}: {source}")]
    Http { addr: String, source: reqwest::Error },
    #[error("account sign-in was refused (HTTP {status}); check the Control4 account email and password")]
    SignInRejected { status: u16 },
    #[error("the controller's sign-in reply had no token: {0}")]
    NoToken(String),
    #[error("no driver on this project can run the bootstrap (looked for {names})")]
    NoWritableDriver { names: String },
    #[error("controller refused {what}: HTTP {status} {body}")]
    Status { what: String, status: u16, body: String },
    #[error("could not build the TLS client: {0}")]
    Client(String),
}

type Result<T, E = BootstrapError> = std::result::Result<T, E>;

/// The Lua that re-enables password SSH: rewrite `sshd_config`, flipping a
/// `PasswordAuthentication no` line to `yes` (and leaving everything else untouched). Pure
/// `io`, matching what the Director's Lua sandbox is known to allow.
pub fn enable_password_auth_lua() -> &'static str {
    r#"local path = '/etc/ssh/sshd_config'
local lines = {}
for line in io.lines(path) do
  if line:match('^%s*PasswordAuthentication%s+no') then
    lines[#lines+1] = 'PasswordAuthentication yes'
  else
    lines[#lines+1] = line
  end
end
local f = assert(io.open(path, 'w'))
for _, l in ipairs(lines) do f:write(l, '\n') end
f:close()
"#
}

/// The JSON body for the account sign-in. Built here (not inline) so a test can pin its
/// exact shape without a network call — and so the password lives in a `String` the
/// request owns and drops, never in a log line.
pub fn sign_in_body(email: &str, password: &str) -> String {
    serde_json::json!({
        "applicationkey": APPLICATION_KEY,
        "env": "Prod",
        "email": email,
        "pwd": password,
        "dev": false,
    })
    .to_string()
}

/// The JSON body for a `LUA_COMMANDS` call (synchronous).
pub fn lua_command_body(lua: &str) -> String {
    serde_json::json!({
        "command": "LUA_COMMANDS",
        "async": false,
        "tParams": { "COMMANDS": lua },
    })
    .to_string()
}

#[derive(Deserialize)]
struct TokenReply {
    token: Option<String>,
}

/// The token from a `/api/v1/jwt` reply, or an error naming what was missing.
pub fn parse_token(body: &str) -> Result<String> {
    let reply: TokenReply =
        serde_json::from_str(body).map_err(|_| BootstrapError::NoToken(trim(body)))?;
    reply.token.filter(|t| !t.is_empty()).ok_or_else(|| BootstrapError::NoToken(trim(body)))
}

#[derive(Deserialize)]
struct Item {
    id: Option<serde_json::Value>,
    name: Option<String>,
}

/// The id of the first item whose name is one we can run Lua through.
pub fn find_writable_driver(items_json: &str) -> Result<String> {
    let items: Vec<Item> = serde_json::from_str(items_json).unwrap_or_default();
    for item in items {
        if let Some(name) = &item.name {
            if WRITABLE_DRIVER_NAMES.contains(&name.as_str()) {
                if let Some(id) = item.id {
                    // Ids come back as a number or a string; normalise to text.
                    let id = match id {
                        serde_json::Value::String(s) => s,
                        other => other.to_string(),
                    };
                    if !id.is_empty() && id != "null" {
                        return Ok(id);
                    }
                }
            }
        }
    }
    Err(BootstrapError::NoWritableDriver { names: WRITABLE_DRIVER_NAMES.join(", ") })
}

/// A controller reached with the owner's account token, ready to run the bootstrap.
pub struct Bootstrap {
    base: String,
    http: reqwest::Client,
    token: String,
    /// SHA-256 of the HTTPS certificate the controller presented, for the caller to pin.
    pub fingerprint: String,
}

impl Bootstrap {
    /// Sign in with the owner's Control4 account and hold the resulting token. `host` is an
    /// IP or name (port 443 assumed) or `host:port`. `pin`, when given, requires the
    /// controller's HTTPS cert to match (trust-on-first-use otherwise).
    ///
    /// `password` is used only for this one request and then dropped; it is never stored.
    pub async fn sign_in(host: &str, email: &str, password: &str, pin: Option<&str>) -> Result<Self> {
        let (config, seen) = web_tls_config_seen(pin);
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| BootstrapError::Client(e.to_string()))?;
        let base = if host.contains(':') { format!("https://{host}") } else { format!("https://{host}:443") };

        let r = http
            .post(format!("{base}/api/v1/jwt"))
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(sign_in_body(email, password))
            .send()
            .await
            .map_err(|source| BootstrapError::Http { addr: base.clone(), source })?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(BootstrapError::SignInRejected { status: status.as_u16() });
        }
        let token = parse_token(&body)?;
        let fingerprint = fingerprint(&seen);
        Ok(Self { base, http, token, fingerprint })
    }

    async fn get(&self, path: &str, what: &str) -> Result<String> {
        let r = self
            .http
            .get(format!("{}{path}", self.base))
            .header("accept", "application/json")
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|source| BootstrapError::Http { addr: self.base.clone(), source })?;
        self.body(r, what).await
    }

    async fn body(&self, r: reqwest::Response, what: &str) -> Result<String> {
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(BootstrapError::Status { what: what.into(), status: status.as_u16(), body: trim(&body) });
        }
        Ok(body)
    }

    /// The id of a project item we can run Lua through.
    pub async fn writable_driver_id(&self) -> Result<String> {
        let items = self.get("/api/v1/items", "the item list").await?;
        find_writable_driver(&items)
    }

    /// Run Lua in the Director via driver `id`. The Lua runs as root — the caller is
    /// responsible for proposing this through the approval flow.
    pub async fn run_lua(&self, id: &str, lua: &str) -> Result<()> {
        let r = self
            .http
            .post(format!("{}/api/v1/items/{id}/commands", self.base))
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("authorization", format!("Bearer {}", self.token))
            .body(lua_command_body(lua))
            .send()
            .await
            .map_err(|source| BootstrapError::Http { addr: self.base.clone(), source })?;
        self.body(r, "the Lua command").await.map(|_| ())
    }

    /// `pkill -HUP sshd` through the sysman endpoint, so a changed `sshd_config` is read.
    pub async fn reload_sshd(&self) -> Result<()> {
        self.get("/api/v1/sysman/ssh?command=pkill%20-HUP%20sshd", "the sshd reload").await.map(|_| ())
    }

    /// The whole re-enable: find a driver, flip `PasswordAuthentication` on, reload sshd.
    /// After this the caller can SSH in with a password and install a durable key.
    pub async fn enable_password_ssh(&self) -> Result<()> {
        let id = self.writable_driver_id().await?;
        self.run_lua(&id, enable_password_auth_lua()).await?;
        self.reload_sshd().await
    }
}

/// The fingerprint the pin-verifier recorded during the handshake (empty if none seen).
fn fingerprint(seen: &Arc<Mutex<Option<String>>>) -> String {
    seen.lock().unwrap().clone().unwrap_or_default()
}

fn trim(s: &str) -> String {
    s.trim().chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_body_has_the_fixed_shape() {
        let body = sign_in_body("me@example.com", "secret");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["applicationkey"], APPLICATION_KEY);
        assert_eq!(v["env"], "Prod");
        assert_eq!(v["email"], "me@example.com");
        assert_eq!(v["pwd"], "secret");
        assert_eq!(v["dev"], false);
    }

    #[test]
    fn lua_body_is_synchronous_lua_commands() {
        let v: serde_json::Value = serde_json::from_str(&lua_command_body("print(1)")).unwrap();
        assert_eq!(v["command"], "LUA_COMMANDS");
        assert_eq!(v["async"], false);
        assert_eq!(v["tParams"]["COMMANDS"], "print(1)");
    }

    #[test]
    fn token_parsing() {
        assert_eq!(parse_token(r#"{"token":"abc.def.ghi"}"#).unwrap(), "abc.def.ghi");
        assert!(parse_token(r#"{"token":""}"#).is_err());
        assert!(parse_token(r#"{"error":"nope"}"#).is_err());
        assert!(parse_token("not json").is_err());
    }

    #[test]
    fn finds_a_writable_driver_by_name() {
        let json = r#"[
            {"id": 42, "name": "Living Room"},
            {"id": 1327, "name": "Data Analytics Agent"},
            {"id": 9, "name": "Stations"}
        ]"#;
        assert_eq!(find_writable_driver(json).unwrap(), "1327");
    }

    #[test]
    fn writable_driver_id_may_be_a_string() {
        let json = r#"[{"id": "uuid-1", "name": "Stations"}]"#;
        assert_eq!(find_writable_driver(json).unwrap(), "uuid-1");
    }

    #[test]
    fn no_writable_driver_is_an_error() {
        let json = r#"[{"id": 1, "name": "Thermostat"}]"#;
        assert!(matches!(find_writable_driver(json), Err(BootstrapError::NoWritableDriver { .. })));
    }

    #[test]
    fn enable_lua_targets_password_auth() {
        let lua = enable_password_auth_lua();
        assert!(lua.contains("sshd_config"));
        assert!(lua.contains("PasswordAuthentication yes"));
    }
}
