//! The controller's REST "broker" (Node.js; HTTPS 443 on a controller, 127.0.0.1:8443
//! for the Windows Virtual Director). Used for what c4soap doesn't carry: driver files.
//!
//! Auth: `POST /api/v1/localjwt` over mutual TLS with a client certificate the
//! controller trusts returns `{"token": <JWT>}` (RS256, signed by the controller,
//! `Permissions: /director,/sysman`, valid 24 h). Protected routes take it as a bearer
//! token. Issuing a token changes nothing on the controller.
//!
//! Driver files: `GET /api/v1/drivers/files/<name>/info` (404 when absent),
//! `GET /api/v1/drivers/files/<name>` (download), `PUT` same path with the file as the
//! raw body (install; the broker tells Director's driver-update agent to rescan).

use std::time::Duration;

use crate::soap::{Identity, SoapError, tls_config};

#[derive(Debug, thiserror::Error)]
pub enum BrokerError {
    #[error(transparent)]
    Tls(#[from] SoapError),
    #[error("controller web API unreachable at {addr}: {source}")]
    Http { addr: String, source: reqwest::Error },
    #[error("controller refused {what}: HTTP {status} {body}")]
    Status { what: String, status: u16, body: String },
    #[error("controller did not issue a token: {0}")]
    NoToken(String),
}

pub type Result<T, E = BrokerError> = std::result::Result<T, E>;

pub struct Broker {
    base: String,
    http: reqwest::Client,
    token: String,
    /// SHA-256 of the HTTPS certificate presented (separate from the port 5021 one).
    pub fingerprint: String,
}

impl Broker {
    /// `addr` is `host` (port 443) or `host:port`.
    pub async fn connect(addr: &str, identity: &Identity, pin: Option<&str>) -> Result<Self> {
        let (config, seen) = tls_config(identity, pin)?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|source| BrokerError::Http { addr: addr.into(), source })?;
        let base = format!("https://{addr}");
        let r = http
            .post(format!("{base}/api/v1/localjwt"))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|source| BrokerError::Http { addr: addr.into(), source })?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(BrokerError::Status { what: "a token".into(), status: status.as_u16(), body: trim(&body) });
        }
        let token = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["token"].as_str().map(String::from))
            .ok_or_else(|| BrokerError::NoToken(trim(&body)))?;
        let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();
        Ok(Self { base, http, token, fingerprint })
    }

    fn url(&self, name: &str, suffix: &str) -> String {
        let enc: String = name
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        format!("{}/api/v1/drivers/files/{enc}{suffix}", self.base)
    }

    /// Metadata for an installed driver file, or `None` if the controller doesn't have it.
    pub async fn driver_info(&self, name: &str) -> Result<Option<serde_json::Value>> {
        let r = self.http.get(self.url(name, "/info")).bearer_auth(&self.token).send().await.map_err(|e| self.http_err(e))?;
        match r.status().as_u16() {
            404 => Ok(None),
            s if (200..300).contains(&s) => Ok(r.json().await.ok()),
            s => Err(BrokerError::Status { what: format!("info for {name}"), status: s, body: trim(&r.text().await.unwrap_or_default()) }),
        }
    }

    /// Download a driver file (for complete backups).
    pub async fn download_driver(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let r = self.http.get(self.url(name, "")).bearer_auth(&self.token).send().await.map_err(|e| self.http_err(e))?;
        match r.status().as_u16() {
            404 => Ok(None),
            s if (200..300).contains(&s) => Ok(Some(r.bytes().await.map_err(|e| self.http_err(e))?.to_vec())),
            s => Err(BrokerError::Status { what: format!("download of {name}"), status: s, body: trim(&r.text().await.unwrap_or_default()) }),
        }
    }

    /// Install (or replace) a driver file. Changes the controller: approval required.
    pub async fn install_driver(&self, name: &str, bytes: Vec<u8>) -> Result<()> {
        let r = self
            .http
            .put(self.url(name, ""))
            .bearer_auth(&self.token)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|e| self.http_err(e))?;
        if r.status().is_success() {
            Ok(())
        } else {
            Err(BrokerError::Status { what: format!("install of {name}"), status: r.status().as_u16(), body: trim(&r.text().await.unwrap_or_default()) })
        }
    }

    fn http_err(&self, source: reqwest::Error) -> BrokerError {
        BrokerError::Http { addr: self.base.clone(), source }
    }
}

fn trim(s: &str) -> String {
    s.chars().take(300).collect()
}
