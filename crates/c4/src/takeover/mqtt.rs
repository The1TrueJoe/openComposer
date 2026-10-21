//! The OS-4.2 MQTT leg: make the controller's MQTT broker accept a token openComposer
//! signs, so it can speak the message bus Composer 2026 uses alongside c4soap.
//!
//! On OS 4.2+ the broker authenticates MQTT clients with a signed token, and a plugin
//! checks the signature against the certificates in `/opt/control4/etc/ssl/certs/api.pem`.
//! Appending our own signing certificate there (then restarting the plugin) lets the
//! broker accept tokens we sign with the matching key. The token's fields were observed on
//! the wire / from the open-source jailbreak tool, not from Control4's code.
//!
//! What this module is **not**: it does not reach the controller itself. It is the pure
//! pieces — generate a signing keypair, build the patched `api.pem`, sign a token — that an
//! owner-confirmed takeover drives over SSH. It only matters where openComposer needs the
//! MQTT bus; the cert swap alone is enough for c4soap.

use rand::rngs::OsRng;
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyUsagePurpose};
use rsa::RsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rsa::signature::{SignatureEncoding, Signer};
use sha2_10::Sha256;

use super::certchain;

/// The common name the signing certificate carries. The broker's plugin keys on it, so it
/// is a fixed protocol value, not a label we choose — an observed wire constant.
pub const SIGNING_CN: &str = "composerexpress_auth";

/// The broker auth plugin's process name. It reads `api.pem` only at startup, so it is
/// killed to pick up a changed bundle; the controller's service manager respawns it.
pub const PLUGIN_PROCESS: &str = "mosquitto-jwt-auth";

/// The shell command that restarts the plugin so it re-reads `api.pem`. `-r` so nothing
/// runs when the process is already gone.
pub fn restart_plugin_cmd() -> String {
    format!("pidof {PLUGIN_PROCESS} | xargs -r kill -9")
}

#[derive(Debug, thiserror::Error)]
pub enum MqttError {
    #[error("could not generate the signing key: {0}")]
    KeyGen(String),
    #[error("could not build the signing certificate: {0}")]
    Cert(String),
    #[error("could not sign the token: {0}")]
    Sign(String),
}

type Result<T, E = MqttError> = std::result::Result<T, E>;

/// A signing keypair for MQTT tokens: the certificate goes into the controller's `api.pem`,
/// the key signs tokens. Generated once and kept (sealed) so re-runs reuse it.
#[derive(Clone, Debug)]
pub struct Signing {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Generate a fresh RSA 2048 signing keypair (a self-signed leaf with [`SIGNING_CN`]).
pub fn generate() -> Result<Signing> {
    let rsa = RsaPrivateKey::new(&mut OsRng, 2048).map_err(|e| MqttError::KeyGen(e.to_string()))?;
    let key_pem =
        rsa.to_pkcs8_pem(LineEnding::LF).map_err(|e| MqttError::KeyGen(e.to_string()))?.to_string();
    let key = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&key_pem, &rcgen::PKCS_RSA_SHA256)
        .map_err(|e| MqttError::KeyGen(e.to_string()))?;

    let mut params = CertificateParams::new(vec![]).map_err(|e| MqttError::Cert(e.to_string()))?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, SIGNING_CN);
    params.distinguished_name = dn;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let cert = params.self_signed(&key).map_err(|e| MqttError::Cert(e.to_string()))?;

    Ok(Signing { cert_pem: cert.pem(), key_pem: key_pem.clone() })
}

impl Signing {
    /// Build the patched `api.pem`: keep every certificate except a stale self-signed one of
    /// ours from a previous run (same [`SIGNING_CN`]), then append this signing cert. The
    /// controller's real cert of that CN is issued by a different root, so it is kept.
    /// `changed` is false when the bundle already ends with exactly this.
    pub fn patch_api_pem(&self, current: &str) -> certchain::Merge {
        let kept: Vec<String> = certchain::cert_blocks(current)
            .into_iter()
            .filter(|b| !certchain::is_stale_ca(b, SIGNING_CN))
            .collect();
        let mut kept_text = kept.join("\n");
        if !kept_text.is_empty() {
            kept_text.push('\n');
        }
        // Appending our cert and deduping gives the normalised target to compare against.
        let target = certchain::merge(&kept_text, &self.cert_pem);
        let before = {
            let mut s = certchain::cert_blocks(current).join("\n");
            if !s.is_empty() {
                s.push('\n');
            }
            s
        };
        certchain::Merge { changed: target.chain != before, chain: target.chain }
    }

    /// Sign an MQTT token for `controller_cn` whose client identity is `user_cn` (our
    /// composer cert's CN), valid from `iat` to `exp` (Unix seconds). RS256 over
    /// `base64url(header).base64url(payload)`.
    pub fn sign_token(&self, controller_cn: &str, user_cn: &str, iat: i64, exp: i64) -> Result<String> {
        let header = r#"{"alg":"RS256","typ":"JWT"}"#.to_string();
        // Field names and the fixed Services/Permissions/UserName shape are observed wire
        // values the broker's plugin checks.
        let payload = format!(
            "{{\"CommonName\":\"{cn}\",\"Services\":\"director,sysman\",\
             \"UserName\":\"CN={user},L=Draper,ST=Utah,C=US\",\
             \"Permissions\":\"/sysman,/director\",\"iat\":{iat},\"exp\":{exp}}}",
            cn = json_escape(controller_cn),
            user = json_escape(user_cn),
        );
        let signing_input =
            format!("{}.{}", base64url(header.as_bytes()), base64url(payload.as_bytes()));

        let key = RsaPrivateKey::from_pkcs8_pem(&self.key_pem).map_err(|e| MqttError::Sign(e.to_string()))?;
        let signer = SigningKey::<Sha256>::new(key);
        let sig = signer.try_sign(signing_input.as_bytes()).map_err(|e| MqttError::Sign(e.to_string()))?;
        Ok(format!("{signing_input}.{}", base64url(&sig.to_bytes())))
    }
}

/// Base64url without padding (RFC 7515).
pub fn base64url(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(A[(n >> 18 & 63) as usize] as char);
        out.push(A[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(A[(n >> 6 & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(A[(n & 63) as usize] as char);
        }
    }
    out
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url_decode(s: &str) -> Vec<u8> {
        let mut t = s.replace('-', "+").replace('_', "/");
        while t.len() % 4 != 0 {
            t.push('=');
        }
        // Minimal std-free base64 decode for the test.
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let idx = |c: u8| A.iter().position(|&x| x == c);
        let mut out = Vec::new();
        for chunk in t.as_bytes().chunks(4) {
            let vals: Vec<u8> = chunk.iter().take_while(|&&c| c != b'=').filter_map(|&c| idx(c).map(|v| v as u8)).collect();
            if vals.len() >= 2 {
                out.push((vals[0] << 2) | (vals[1] >> 4));
            }
            if vals.len() >= 3 {
                out.push((vals[1] << 4) | (vals[2] >> 2));
            }
            if vals.len() >= 4 {
                out.push((vals[2] << 6) | vals[3]);
            }
        }
        out
    }

    #[test]
    fn token_has_three_segments_and_expected_claims() {
        let s = generate().unwrap();
        let jwt = s.sign_token("ControllerCN", "Composer_openComposer", 1000, 2000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);

        let header = String::from_utf8(b64url_decode(parts[0])).unwrap();
        assert!(header.contains("\"RS256\""));
        let payload = String::from_utf8(b64url_decode(parts[1])).unwrap();
        assert!(payload.contains("\"CommonName\":\"ControllerCN\""));
        assert!(payload.contains("\"UserName\":\"CN=Composer_openComposer,L=Draper,ST=Utah,C=US\""));
        assert!(payload.contains("\"Permissions\":\"/sysman,/director\""));
        assert!(payload.contains("\"iat\":1000"));
        assert!(payload.contains("\"exp\":2000"));
    }

    #[test]
    fn signature_verifies_with_the_public_key() {
        use rsa::pkcs1v15::{Signature, VerifyingKey};
        use rsa::signature::Verifier;

        let s = generate().unwrap();
        let jwt = s.sign_token("C", "U", 1, 2).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let sig = Signature::try_from(b64url_decode(parts[2]).as_slice()).unwrap();

        let key = RsaPrivateKey::from_pkcs8_pem(&s.key_pem).unwrap();
        let vk = VerifyingKey::<Sha256>::new(key.to_public_key());
        vk.verify(signing_input.as_bytes(), &sig).expect("our own signature should verify");
    }

    #[test]
    fn api_pem_patch_adds_once_and_is_idempotent() {
        let s = generate().unwrap();
        let other = super::super::ca::Ca::generate("Real api cert").unwrap().cert_pem().to_string();
        let first = s.patch_api_pem(&other);
        assert!(first.changed);
        assert!(first.chain.contains(&s.cert_pem.trim().to_string()));
        assert!(first.chain.contains(&other.trim().to_string()));
        let second = s.patch_api_pem(&first.chain);
        assert!(!second.changed);
    }
}
