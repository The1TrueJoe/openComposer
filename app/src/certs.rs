//! The client certificate Directors trust, kept encrypted at rest.
//!
//! Cert + key are too large for Windows Credential Manager (2,560-byte limit), so the
//! PEM bundle is sealed with ChaCha20-Poly1305 in `identity.bin` and only the 32-byte
//! key lives in the OS keychain.

use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "openComposer";
const ACCOUNT: &str = "identity-key";

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredIdentity {
    pub cert_pem: String,
    pub key_pem: String,
    /// Where it came from, for the Settings screen.
    pub label: String,
}

impl StoredIdentity {
    pub fn identity(&self) -> anyhow::Result<c4::Identity> {
        Ok(c4::Identity::from_pem(self.cert_pem.as_bytes(), self.key_pem.as_bytes())?)
    }
}

fn keychain_key(create: bool) -> anyhow::Result<[u8; 32]> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
    match entry.get_password() {
        Ok(hexkey) => {
            let v = hex::decode(hexkey)?;
            v.try_into().map_err(|_| anyhow::anyhow!("keychain entry is not a 32-byte key"))
        }
        Err(keyring::Error::NoEntry) if create => {
            let mut k = [0u8; 32];
            rand::fill(&mut k);
            entry.set_password(&hex::encode(k))?;
            Ok(k)
        }
        Err(e) => Err(e.into()),
    }
}

pub fn save(path: &Path, id: &StoredIdentity) -> anyhow::Result<()> {
    // Refuse to store something Director can't use.
    id.identity()?;
    seal(path, &serde_json::to_vec(id)?)
}

pub fn load(path: &Path) -> anyhow::Result<Option<StoredIdentity>> {
    match unseal(path)? {
        Some(plain) => Ok(Some(serde_json::from_slice(&plain)?)),
        None => Ok(None),
    }
}

/// Seal arbitrary bytes under the same keychain-held key the identity uses (ChaCha20-
/// Poly1305, 12-byte nonce prefix), and write them owner-only. Used for the identity and
/// for the takeover CA's private key — anything too large or too sensitive for the OS
/// keychain itself.
pub fn seal(path: &Path, plain: &[u8]) -> anyhow::Result<()> {
    let key = keychain_key(true)?;
    let cipher = ChaCha20Poly1305::new(&Key::from(key));
    let mut nonce = [0u8; 12];
    rand::fill(&mut nonce);
    let sealed = cipher
        .encrypt(&Nonce::from(nonce), plain)
        .map_err(|_| anyhow::anyhow!("could not encrypt the data"))?;
    let mut out = nonce.to_vec();
    out.extend(sealed);
    std::fs::write(path, out)?;
    crate::config::restrict(path);
    Ok(())
}

/// Unseal bytes written by [`seal`]; `Ok(None)` when the file is absent.
pub fn unseal(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    let Ok(bytes) = std::fs::read(path) else { return Ok(None) };
    if bytes.len() < 13 {
        anyhow::bail!("sealed file is damaged");
    }
    let key = keychain_key(false)?;
    let cipher = ChaCha20Poly1305::new(&Key::from(key));
    let plain = cipher
        .decrypt(&Nonce::from(<[u8; 12]>::try_from(&bytes[..12])?), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("can't be decrypted with this keychain's key; import it again"))?;
    Ok(Some(plain))
}

pub fn from_pem_files(cert: &Path, key: &Path) -> anyhow::Result<StoredIdentity> {
    let cert_pem = std::fs::read_to_string(cert)?;
    // A .pem sometimes carries its key too; accept a single file for both.
    let key_pem = if cert == key { cert_pem.clone() } else { std::fs::read_to_string(key)? };
    Ok(StoredIdentity { cert_pem, key_pem, label: file_label(cert) })
}

/// Whatever files someone picked or dropped: PEM certificates and keys in any
/// arrangement, or a .p12. A certificate is often kept beside its key
/// (`client.pem` + `client.key`), so a lone certificate brings its sibling `.key` along.
pub fn from_files(paths: &[std::path::PathBuf], password: Option<&str>) -> anyhow::Result<StoredIdentity> {
    let is_p12 = |p: &Path| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("p12") || e.eq_ignore_ascii_case("pfx"));
    if let Some(p12) = paths.iter().find(|p| is_p12(p)) {
        return match password {
            Some(pw) => from_p12(p12, pw),
            None => anyhow::bail!("NEEDS_PASSWORD: {} is password-protected; enter its password", file_label(p12)),
        };
    }
    let mut certs = String::new();
    let mut key: Option<String> = None;
    let mut label = None;
    let mut take = |p: &Path, blocks: Vec<String>| {
        for block in blocks {
            if block.contains("CERTIFICATE-----") {
                certs.push_str(&block);
                label.get_or_insert_with(|| file_label(p));
            } else if block.contains("PRIVATE KEY-----") && key.is_none() {
                key = Some(block);
            }
        }
    };
    for p in paths {
        take(p, read_blocks(p)?);
    }
    // client.pem + client.key: a certificate on its own brings the .key beside it.
    let siblings: Vec<_> = paths.iter().map(|p| p.with_extension("key")).filter(|s| s.is_file() && !paths.contains(s)).collect();
    for s in siblings {
        take(&s, read_blocks(&s)?);
    }
    let names = paths.iter().map(|p| file_label(p)).collect::<Vec<_>>().join(", ");
    if certs.is_empty() {
        anyhow::bail!("no certificate in {names}; choose a certificate (.pem with its .key) or a .p12");
    }
    let Some(key_pem) = key else {
        anyhow::bail!("{names} holds the certificate but not its private key, and there was no matching .key beside it; choose the .key file too");
    };
    let id = StoredIdentity { cert_pem: certs, key_pem, label: label.unwrap_or_default() };
    id.identity().map_err(|e| anyhow::anyhow!("the certificate and key don't work together: {e}"))?;
    Ok(id)
}

fn read_blocks(p: &Path) -> anyhow::Result<Vec<String>> {
    let text = std::fs::read_to_string(p).map_err(|e| anyhow::anyhow!("can't read {}: {e}", file_label(p)))?;
    Ok(pem_blocks(&text))
}

/// `-----BEGIN …-----` … `-----END …-----` blocks, each with its trailing newline.
fn pem_blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    for line in text.lines() {
        if line.starts_with("-----BEGIN ") {
            cur = Some(String::new());
        }
        if let Some(c) = cur.as_mut() {
            c.push_str(line.trim_end());
            c.push('\n');
        }
        if line.starts_with("-----END ") {
            out.extend(cur.take());
        }
    }
    out
}

pub fn from_p12(path: &Path, password: &str) -> anyhow::Result<StoredIdentity> {
    let data = std::fs::read(path)?;
    let ks = p12_keystore::KeyStore::from_pkcs12(&data, password, p12_keystore::Pkcs12ImportPolicy::Relaxed)
        .map_err(|e| anyhow::anyhow!("could not open {}: {e}", path.display()))?;
    let (_, chain) = ks.private_key_chain().ok_or_else(|| anyhow::anyhow!("no private key in {}", path.display()))?;
    let cert_pem = chain.certs().iter().map(|c| pem("CERTIFICATE", c.as_der())).collect::<String>();
    let key_pem = pem("PRIVATE KEY", chain.key().as_der());
    Ok(StoredIdentity { cert_pem, key_pem, label: file_label(path) })
}

fn file_label(p: &Path) -> String {
    p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A client certificate found in a place Composer Pro keeps one, offered so the owner can reuse
/// their existing dealer identity instead of exporting it by hand. Metadata only — no key bytes
/// are read here; the actual import happens through `from_files`/`from_p12` when the owner picks
/// one, and a `.p12` still needs its password (we never recover Composer's — the owner enters it).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FoundCert {
    pub path: String,
    pub label: String,
    /// "pem" (a certificate + key, used as-is) or "p12" (asks for its password).
    pub kind: &'static str,
    pub needs_password: bool,
    /// Where it was found, for the UI ("Composer (AppData)").
    pub source: String,
}

/// Client certificates in the well-known Composer locations that exist on this computer.
/// Composer stores the dealer identity under its app-data folder (`…/Control4/Composer/`), as a
/// password-protected `composer.p12` and sometimes an exported `.pem`/`.key` pair. We look only
/// in those fixed spots — no disk walk — and classify by name, without opening the files.
pub fn discover() -> Vec<FoundCert> {
    // `config_dir()` is %APPDATA%\Roaming on Windows and ~/Library/Application Support on macOS —
    // the root of Composer's app-data tree in both.
    match directories::BaseDirs::new() {
        Some(base) => discover_in(base.config_dir()),
        None => Vec::new(),
    }
}

/// `discover`, parameterised on the app-data root so it can be tested against a temp layout.
fn discover_in(config_dir: &Path) -> Vec<FoundCert> {
    let mut out: Vec<FoundCert> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let src = if cfg!(windows) { "Composer (AppData)" } else { "Composer app data" };
    let mut push = |path: std::path::PathBuf| {
        let is_p12 = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("p12") || e.eq_ignore_ascii_case("pfx"));
        // A lone cert needs its key beside it; without one it isn't a usable identity.
        let usable = is_p12 || path.with_extension("key").is_file();
        if usable && path.is_file() && seen.insert(path.clone()) {
            out.push(FoundCert {
                label: file_label(&path),
                kind: if is_p12 { "p12" } else { "pem" },
                needs_password: is_p12,
                source: src.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    };
    let dir = config_dir.join("Control4").join("Composer");
    for name in ["composer.p12", "composer.pem", "client.p12", "client.pem"] {
        push(dir.join(name));
    }
    // Any other .p12 Composer left in that folder (e.g. a renamed export).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("p12") || x.eq_ignore_ascii_case("pfx")) {
                push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod discover_tests {
    use super::discover_in;

    #[test]
    fn finds_composer_p12_and_pem_pair() {
        let tmp = std::env::temp_dir().join(format!("oc-disc-{}", std::process::id()));
        let dir = tmp.join("Control4").join("Composer");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("composer.p12"), b"not a real keystore").unwrap();
        // A pem with a key beside it is usable; a lone pem (no .key) is skipped.
        std::fs::write(dir.join("composer.pem"), b"cert").unwrap();
        std::fs::write(dir.join("composer.key"), b"key").unwrap();
        std::fs::write(dir.join("ca.pem"), b"ca only").unwrap();

        let found = discover_in(&tmp);
        let by = |name: &str| found.iter().find(|f| f.label == name);
        let p12 = by("composer.p12").expect("composer.p12 found");
        assert_eq!(p12.kind, "p12");
        assert!(p12.needs_password);
        let pem = by("composer.pem").expect("composer.pem (with key) found");
        assert_eq!(pem.kind, "pem");
        assert!(!pem.needs_password);
        assert!(by("ca.pem").is_none(), "a cert with no sibling key is not a usable identity");

        std::fs::remove_dir_all(&tmp).ok();
    }
}

fn pem(tag: &str, der: &[u8]) -> String {
    use std::fmt::Write;
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut b64 = String::new();
    for chunk in der.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                b64.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                b64.push('=');
            }
        }
    }
    let mut out = format!("-----BEGIN {tag}-----\n");
    for line in b64.as_bytes().chunks(64) {
        let _ = writeln!(out, "{}", std::str::from_utf8(line).unwrap());
    }
    let _ = writeln!(out, "-----END {tag}-----");
    out
}
