//! Client keys that ring won't sign with.
//!
//! Composer client certificates are 1024-bit RSA with a SHA-1 signature. ring (and
//! most modern stacks) refuse RSA keys under 2048 bits, but Director accepts them, so
//! the key provider falls back to RustCrypto's `rsa` for any RSA key ring rejects.
//! The handshake itself is still TLS 1.3 with RSA-PSS/SHA-256, chosen from what the
//! controller offers.

use std::sync::Arc;

use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{RandomizedSigner, SignatureEncoding, Signer as _};
use rustls::crypto::KeyProvider;
use rustls::pki_types::PrivateKeyDer;
use rustls::sign::{Signer, SigningKey};
use rustls::{SignatureAlgorithm, SignatureScheme};
use sha2_10::{Sha256, Sha384, Sha512};

#[derive(Debug)]
pub(crate) struct FallbackKeys;

pub(crate) static FALLBACK_KEYS: FallbackKeys = FallbackKeys;

impl KeyProvider for FallbackKeys {
    fn load_private_key(&self, key_der: PrivateKeyDer<'static>) -> Result<Arc<dyn SigningKey>, rustls::Error> {
        if let Ok(k) = rustls::crypto::ring::default_provider().key_provider.load_private_key(key_der.clone_key()) {
            return Ok(k);
        }
        let key = match &key_der {
            PrivateKeyDer::Pkcs1(k) => rsa::RsaPrivateKey::from_pkcs1_der(k.secret_pkcs1_der()).ok(),
            PrivateKeyDer::Pkcs8(k) => rsa::RsaPrivateKey::from_pkcs8_der(k.secret_pkcs8_der()).ok(),
            _ => None,
        }
        .ok_or_else(|| rustls::Error::General("unsupported private key (not RSA, ECDSA or EdDSA)".into()))?;
        Ok(Arc::new(LegacyRsa(key)))
    }
}

#[derive(Debug)]
struct LegacyRsa(rsa::RsaPrivateKey);

const PREFERENCE: [SignatureScheme; 6] = [
    SignatureScheme::RSA_PSS_SHA256,
    SignatureScheme::RSA_PSS_SHA384,
    SignatureScheme::RSA_PSS_SHA512,
    SignatureScheme::RSA_PKCS1_SHA256,
    SignatureScheme::RSA_PKCS1_SHA384,
    SignatureScheme::RSA_PKCS1_SHA512,
];

impl SigningKey for LegacyRsa {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        let scheme = PREFERENCE.into_iter().find(|s| offered.contains(s))?;
        Some(Box::new(LegacySigner { key: self.0.clone(), scheme }))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::RSA
    }
}

#[derive(Debug)]
struct LegacySigner {
    key: rsa::RsaPrivateKey,
    scheme: SignatureScheme,
}

impl Signer for LegacySigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        use rsa::{pkcs1v15, pss};
        let mut rng = rand_core::OsRng;
        let k = self.key.clone();
        let sig = match self.scheme {
            SignatureScheme::RSA_PSS_SHA256 => pss::BlindedSigningKey::<Sha256>::new(k).try_sign_with_rng(&mut rng, message).map(|s| s.to_vec()),
            SignatureScheme::RSA_PSS_SHA384 => pss::BlindedSigningKey::<Sha384>::new(k).try_sign_with_rng(&mut rng, message).map(|s| s.to_vec()),
            SignatureScheme::RSA_PSS_SHA512 => pss::BlindedSigningKey::<Sha512>::new(k).try_sign_with_rng(&mut rng, message).map(|s| s.to_vec()),
            SignatureScheme::RSA_PKCS1_SHA256 => pkcs1v15::SigningKey::<Sha256>::new(k).try_sign(message).map(|s| s.to_vec()),
            SignatureScheme::RSA_PKCS1_SHA384 => pkcs1v15::SigningKey::<Sha384>::new(k).try_sign(message).map(|s| s.to_vec()),
            SignatureScheme::RSA_PKCS1_SHA512 => pkcs1v15::SigningKey::<Sha512>::new(k).try_sign(message).map(|s| s.to_vec()),
            other => return Err(rustls::Error::General(format!("unsupported signature scheme {other:?}"))),
        };
        sig.map_err(|e| rustls::Error::General(format!("RSA signing failed: {e}")))
    }

    fn scheme(&self) -> SignatureScheme {
        self.scheme
    }
}
