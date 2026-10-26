//! c4soap — the Director's wire protocol.
//!
//! OS 3.x Directors listen on TLS port 5021 and require a client certificate (the
//! handshake requests one; without it every call answers `Access denied`). Each
//! message is a single XML document terminated by a NUL byte:
//!
//! ```text
//! -> <c4soap name="GetItems" session="0" operation="RWX" category="composer" async="False">
//!      <param name="filter" type="number">0</param></c4soap>\0
//! <- <c4soap name="GetItems" result="1">…</c4soap>\0
//! <- <c4soap async="1" name="OnZigbeeMeshChanged" result="0">…</c4soap>\0   (event)
//! ```
//!
//! Replies carry no request id, so synchronous calls go strictly one at a time per
//! connection and are matched by method name. Anything with `async="1"` is an event
//! (pushed after `EnableEvents`) and goes to the broadcast channel instead.
//!
//! `result="1"` only means "Director handled the call": failures such as
//! `<error>Unable to add device.</error>` also come back with `result="1"`, so
//! [`Reply::check`] looks for an `<error>` element as well.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::xml::escape;

pub const TLS_PORT: u16 = 5021;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum SoapError {
    #[error("could not connect to {host}: {source}")]
    Connect { host: String, source: std::io::Error },
    #[error("TLS handshake with {host} failed: {source}")]
    Tls { host: String, source: std::io::Error },
    #[error("client certificate is not usable: {0}")]
    Identity(String),
    #[error("Director refused {method}: access denied (is this certificate trusted by the controller?)")]
    AccessDenied { method: String },
    #[error("Director returned an error for {method}: {message}")]
    Director { method: String, message: String },
    #[error("{method} timed out after {secs}s")]
    Timeout { method: String, secs: u64 },
    #[error("connection to Director closed")]
    Closed,
    #[error("malformed reply to {method}: {detail}")]
    Malformed { method: String, detail: String },
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = SoapError> = std::result::Result<T, E>;

/// A client certificate + key, as PEM.
#[derive(Clone)]
pub struct Identity {
    certs: Vec<CertificateDer<'static>>,
    key: Arc<PrivateKeyDer<'static>>,
}

impl Identity {
    pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self> {
        let certs = CertificateDer::pem_slice_iter(cert_pem)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| SoapError::Identity(format!("certificate: {e}")))?;
        if certs.is_empty() {
            return Err(SoapError::Identity("no CERTIFICATE block found".into()));
        }
        let key = PrivateKeyDer::from_pem_slice(key_pem)
            .map_err(|e| SoapError::Identity(format!("private key: {e}")))?;
        Ok(Self { certs, key: Arc::new(key) })
    }

    /// Subject CN and expiry of the leaf certificate are not parsed here; the app shows
    /// the SHA-256 fingerprint so a user can tell identities apart.
    pub fn fingerprint(&self) -> String {
        hex::encode(Sha256::digest(self.certs[0].as_ref()))
    }
}

/// One parameter value. `XmlString` is sent with `type="string"` but unescaped, which
/// is how Composer embeds documents (a whole project in `Download`, a command in
/// `AddCodeItem`'s `cmdcond`).
#[derive(Clone, Debug)]
pub enum Value {
    Number(i64),
    String(String),
    Bool(bool),
    XmlString(String),
}

#[derive(Clone, Debug)]
pub struct Call {
    pub method: String,
    pub params: Vec<(String, Value)>,
    pub timeout: Duration,
}

impl Call {
    pub fn new(method: impl Into<String>) -> Self {
        Self { method: method.into(), params: Vec::new(), timeout: DEFAULT_TIMEOUT }
    }
    pub fn num(mut self, name: &str, v: impl Into<i64>) -> Self {
        self.params.push((name.into(), Value::Number(v.into())));
        self
    }
    pub fn str(mut self, name: &str, v: impl Into<String>) -> Self {
        self.params.push((name.into(), Value::String(v.into())));
        self
    }
    pub fn bool(mut self, name: &str, v: bool) -> Self {
        self.params.push((name.into(), Value::Bool(v)));
        self
    }
    pub fn xml(mut self, name: &str, v: impl Into<String>) -> Self {
        self.params.push((name.into(), Value::XmlString(v.into())));
        self
    }
    pub fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    pub fn encode(&self, is_async: bool) -> String {
        let mut s = format!(
            r#"<c4soap name="{}" session="0" operation="RWX" category="composer" async="{}">"#,
            escape(&self.method),
            if is_async { "True" } else { "False" }
        );
        for (name, v) in &self.params {
            let (ty, body) = match v {
                Value::Number(n) => ("number", n.to_string()),
                Value::String(t) => ("string", escape(t)),
                Value::Bool(b) => ("bool", if *b { "1" } else { "0" }.to_string()),
                Value::XmlString(x) => ("string", x.clone()),
            };
            s.push_str(&format!(r#"<param name="{}" type="{ty}">{body}</param>"#, escape(name)));
        }
        s.push_str("</c4soap>");
        s
    }
}

/// A synchronous reply. Kept as raw text; parse with [`Reply::doc`] where needed.
#[derive(Clone, Debug)]
pub struct Reply {
    pub method: String,
    pub raw: String,
}

impl Reply {
    pub fn doc(&self) -> Result<roxmltree::Document<'_>> {
        roxmltree::Document::parse(&self.raw)
            .map_err(|e| SoapError::Malformed { method: self.method.clone(), detail: e.to_string() })
    }

    /// The XML between `<c4soap …>` and `</c4soap>` (empty for a self-closing reply).
    pub fn body(&self) -> &str {
        let Some(open_end) = self.raw.find('>') else { return "" };
        if self.raw[..open_end].ends_with('/') {
            return "";
        }
        let close = self.raw.rfind("</c4soap>").unwrap_or(self.raw.len());
        &self.raw[open_end + 1..close.max(open_end + 1)]
    }

    /// Turn Director-level failures into errors.
    pub fn check(self) -> Result<Self> {
        if self.body().trim() == "Access denied" {
            return Err(SoapError::AccessDenied { method: self.method });
        }
        let head = &self.raw[..self.raw.find('>').unwrap_or(0)];
        if !head.contains(r#"result="1""#) {
            return Err(SoapError::Director { method: self.method.clone(), message: self.body().to_string() });
        }
        if let Ok(doc) = self.doc() {
            if let Some(e) = doc.descendants().find(|n| n.has_tag_name("error")) {
                return Err(SoapError::Director {
                    method: self.method.clone(),
                    message: e.text().unwrap_or("unknown error").to_string(),
                });
            }
        }
        Ok(self)
    }
}

/// Something Director pushed: `OnZigbeeMeshChanged`, `OnNetworkBindingRemoved`, …
#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub raw: String,
}

impl Event {
    /// `<param name="X" type="…">value</param>` → value (unescaped), first match.
    pub fn param(&self, name: &str) -> Option<String> {
        let doc = roxmltree::Document::parse(&self.raw).ok()?;
        let p = doc.descendants().find(|n| n.has_tag_name("param") && n.attribute("name") == Some(name))?;
        Some(p.text().unwrap_or_default().to_string())
    }
}

type Pending = Option<(String, oneshot::Sender<Result<Reply>>)>;

struct Inner {
    host: String,
    writer: Mutex<WriteHalf<TlsStream<TcpStream>>>,
    /// Held for the whole round trip of a synchronous call.
    call_lock: Mutex<()>,
    pending: StdMutex<Pending>,
    events: broadcast::Sender<Event>,
    closed: std::sync::atomic::AtomicBool,
}

/// A live connection to one Director. Cheap to clone.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
    /// SHA-256 of the controller's TLS certificate, hex. Pin it after first contact.
    pub server_fingerprint: String,
}

impl Connection {
    /// Connect and complete the TLS handshake. `pin` is the expected server certificate
    /// fingerprint; `None` trusts on first use (the caller should store the result).
    pub async fn connect(host: &str, port: u16, identity: &Identity, pin: Option<&str>) -> Result<Self> {
        let (config, seen) = tls_config(identity, pin)?;

        let tcp = connect_any(host, port).await.map_err(|source| SoapError::Connect { host: host.into(), source })?;
        tcp.set_nodelay(true).ok();
        let name = ServerName::try_from(host.to_string())
            .map_err(|e| SoapError::Identity(format!("bad host name {host}: {e}")))?;
        let tls = TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .map_err(|source| SoapError::Tls { host: host.into(), source })?;
        let server_fingerprint = seen.lock().unwrap().clone().unwrap_or_default();

        let (reader, writer) = tokio::io::split(tls);
        let (events, _) = broadcast::channel(1024);
        let inner = Arc::new(Inner {
            host: host.to_string(),
            writer: Mutex::new(writer),
            call_lock: Mutex::new(()),
            pending: StdMutex::new(None),
            events,
            closed: false.into(),
        });
        tokio::spawn(read_loop(reader, inner.clone()));
        Ok(Self { inner, server_fingerprint })
    }

    pub fn host(&self) -> &str {
        &self.inner.host
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    /// Send a call and wait for its reply. Does not interpret the reply; see [`Self::call`].
    pub async fn call_raw(&self, call: &Call) -> Result<Reply> {
        if self.is_closed() {
            return Err(SoapError::Closed);
        }
        let _turn = self.inner.call_lock.lock().await;
        let (tx, rx) = oneshot::channel();
        *self.inner.pending.lock().unwrap() = Some((call.method.clone(), tx));
        self.write(&call.encode(false)).await?;
        match tokio::time::timeout(call.timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(SoapError::Closed),
            Err(_) => {
                // A late reply would be mistaken for the next call's, so this
                // connection can't be trusted any more.
                self.inner.pending.lock().unwrap().take();
                self.close().await;
                Err(SoapError::Timeout { method: call.method.clone(), secs: call.timeout.as_secs() })
            }
        }
    }

    /// Send a call, wait for the reply and turn Director-level failures into errors.
    pub async fn call(&self, call: Call) -> Result<Reply> {
        self.call_raw(&call).await?.check()
    }

    /// Fire an `async="True"` call whose answer arrives as an event (the Zigbee queries).
    pub async fn send_async(&self, call: &Call) -> Result<()> {
        self.write(&call.encode(true)).await
    }

    pub async fn enable_events(&self) -> Result<()> {
        self.send_async(&Call::new("EnableEvents").bool("enable", true)).await
    }

    /// Send an async call and wait for the first event named `event`.
    pub async fn request_event(&self, call: &Call, event: &str, timeout: Duration) -> Result<Event> {
        let mut rx = self.events();
        self.send_async(call).await?;
        tokio::time::timeout(timeout, async {
            loop {
                match rx.recv().await {
                    Ok(e) if e.name == event => return Ok(e),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return Err(SoapError::Closed),
                }
            }
        })
        .await
        .map_err(|_| SoapError::Timeout { method: call.method.clone(), secs: timeout.as_secs() })?
    }

    pub async fn close(&self) {
        self.inner.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.inner.writer.lock().await.shutdown().await;
    }

    async fn write(&self, msg: &str) -> Result<()> {
        let mut w = self.inner.writer.lock().await;
        let mut bytes = Vec::with_capacity(msg.len() + 1);
        bytes.extend_from_slice(msg.as_bytes());
        bytes.push(0);
        w.write_all(&bytes).await?;
        w.flush().await?;
        Ok(())
    }
}

/// TLS settings for talking to a controller as Composer does: our client certificate
/// (legacy RSA keys allowed), the controller's certificate pinned by fingerprint.
/// The returned cell receives the fingerprint the controller presented.
pub fn tls_config(identity: &Identity, pin: Option<&str>) -> Result<(rustls::ClientConfig, Arc<StdMutex<Option<String>>>)> {
    let provider = Arc::new(CryptoProvider {
        key_provider: &crate::keys::FALLBACK_KEYS,
        ..rustls::crypto::ring::default_provider()
    });
    let seen = Arc::new(StdMutex::new(None));
    let verifier = PinVerifier {
        pin: pin.map(|p| p.to_ascii_lowercase()),
        seen: seen.clone(),
        provider: provider.clone(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| SoapError::Identity(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(identity.certs.clone(), identity.key.clone_key())
        .map_err(|e| SoapError::Identity(e.to_string()))?;
    Ok((config, seen))
}

/// TLS for a controller's web API when a token, not a client certificate, authenticates:
/// the controller's self-signed certificate is accepted (pinned when `pin` is given).
pub fn web_tls_config(pin: Option<&str>) -> rustls::ClientConfig {
    web_tls_config_seen(pin).0
}

/// Like [`web_tls_config`], but also returns the cell that receives the fingerprint the
/// controller presented, so a token-authenticated caller can pin it for later (the cell is
/// filled during the TLS handshake, i.e. after the first request on the client completes).
pub fn web_tls_config_seen(pin: Option<&str>) -> (rustls::ClientConfig, Arc<StdMutex<Option<String>>>) {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let seen = Arc::new(StdMutex::new(None));
    let verifier = PinVerifier { pin: pin.map(|p| p.to_ascii_lowercase()), seen: seen.clone(), provider: provider.clone() };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    (config, seen)
}

/// `host`, `host:port`, `[v6]` or `[v6]:port` → (host, port). A Director's address carries a
/// port when it's reached through a forward, e.g. an SSH tunnel to a remote-support relay
/// (`127.0.0.1:15021`); a bare IPv6 address (several colons) is taken as a host.
pub fn split_addr(addr: &str, default_port: u16) -> (String, u16) {
    let a = addr.trim();
    if let Some(rest) = a.strip_prefix('[') {
        if let Some((h, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(default_port);
            return (h.to_string(), port);
        }
    }
    match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => match p.parse() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (a.to_string(), default_port),
        },
        _ => (a.to_string(), default_port),
    }
}

/// Try every address a name resolves to at once and keep the first that answers.
/// `.local` names often resolve to an IPv6 link-local address that never connects,
/// or to an interface on another subnet, before the one that works.
async fn connect_any(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await?.collect();
    let mut set = tokio::task::JoinSet::new();
    for addr in addrs {
        set.spawn(async move { tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(addr)).await });
    }
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "name did not resolve");
    while let Some(res) = set.join_next().await {
        match res {
            Ok(Ok(Ok(s))) => return Ok(s),
            Ok(Ok(Err(e))) => last = e,
            Ok(Err(_)) => last = std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"),
            Err(e) => last = std::io::Error::other(e),
        }
    }
    Err(last)
}

async fn read_loop(mut reader: ReadHalf<TlsStream<TcpStream>>, inner: Arc<Inner>) {
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(pos) = buf.iter().position(|b| *b == 0) {
            let msg: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&msg[..msg.len() - 1]).into_owned();
            dispatch(&inner, text);
        }
    }
    inner.closed.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some((_, tx)) = inner.pending.lock().unwrap().take() {
        let _ = tx.send(Err(SoapError::Closed));
    }
    let _ = inner.events.send(Event { name: "Disconnected".into(), raw: String::new() });
}

fn dispatch(inner: &Inner, text: String) {
    let head = &text[..text.find('>').unwrap_or(text.len())];
    let name = attr(head, "name").unwrap_or_default();
    if attr(head, "async").as_deref() == Some("1") {
        let _ = inner.events.send(Event { name, raw: text });
        return;
    }
    let mut pending = inner.pending.lock().unwrap();
    match pending.take() {
        Some((method, tx)) if method == name => {
            let _ = tx.send(Ok(Reply { method, raw: text }));
        }
        other => {
            tracing::debug!(%name, "unsolicited reply dropped");
            *pending = other;
        }
    }
}

/// Read `name="value"` from an opening tag without a full parse.
fn attr(head: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = head.find(&needle)? + needle.len();
    let end = head[start..].find('"')? + start;
    Some(head[start..end].to_string())
}

/// Controllers present self-signed certificates, so instead of a CA chain we pin the
/// certificate's SHA-256 (trust on first use) and still check handshake signatures.
#[derive(Debug)]
struct PinVerifier {
    pin: Option<String>,
    seen: Arc<StdMutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let fp = hex::encode(Sha256::digest(end_entity.as_ref()));
        *self.seen.lock().unwrap() = Some(fp.clone());
        match &self.pin {
            Some(p) if *p != fp => Err(rustls::Error::General(format!(
                "controller certificate changed: expected {p}, got {fp}"
            ))),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod addr_tests {
    use super::split_addr;

    #[test]
    fn addresses_with_and_without_ports() {
        assert_eq!(split_addr("192.168.1.172", 5021), ("192.168.1.172".into(), 5021));
        assert_eq!(split_addr("127.0.0.1:15021", 5021), ("127.0.0.1".into(), 15021));
        assert_eq!(split_addr("optiplex.local", 5021), ("optiplex.local".into(), 5021));
        assert_eq!(split_addr("fe80::1", 5021), ("fe80::1".into(), 5021));
        assert_eq!(split_addr("[fe80::1]:6000", 5021), ("fe80::1".into(), 6000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_composer() {
        let c = Call::new("AddBinding").num("idproviderdevice", 1327).str("class", "IR_OUT");
        assert_eq!(
            c.encode(false),
            r#"<c4soap name="AddBinding" session="0" operation="RWX" category="composer" async="False"><param name="idproviderdevice" type="number">1327</param><param name="class" type="string">IR_OUT</param></c4soap>"#
        );
    }

    #[test]
    fn errors_hidden_behind_result_1_are_errors() {
        let r = Reply {
            method: "AddDevice".into(),
            raw: r#"<c4soap name="AddDevice" result="1"><error>Unable to add device.</error></c4soap>"#.into(),
        };
        assert!(matches!(r.check(), Err(SoapError::Director { .. })));
        let denied = Reply {
            method: "GetItems".into(),
            raw: r#"<c4soap name="GetItems" result="1">Access denied</c4soap>"#.into(),
        };
        assert!(matches!(denied.check(), Err(SoapError::AccessDenied { .. })));
    }

    #[test]
    fn self_closing_reply_has_empty_body() {
        let r = Reply { method: "ReloadDatabase".into(), raw: r#"<c4soap name="ReloadDatabase" result="1"/>"#.into() };
        assert_eq!(r.body(), "");
        assert!(r.check().is_ok());
    }
}
