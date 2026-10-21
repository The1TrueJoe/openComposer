//! The certificate authority openComposer signs its client certificate with.
//!
//! A controller trusts a client certificate when the CA that signed it is in the
//! controller's trust chain (see [`super::certchain`]). So taking over a controller has
//! two cert halves: a CA whose public cert we append to the chain, and a client ("composer")
//! certificate that CA signs for openComposer to present.
//!
//! Two ways to get the CA:
//!   * [`Ca::generate`] — a fresh CA, for a controller we are taking over for the first
//!     time (its public cert is what gets appended).
//!   * [`Ca::adopt`] — load an **existing** CA (key + cert), so certificates we issue chain
//!     to a CA the controller already trusts. This is how an existing "Gary tool" `Certs`
//!     folder keeps working: adopt its `private.key` + `public.pem` and we can mint fresh
//!     composer certs under it without re-patching the controller.
//!
//! Keys are RSA 2048: these controllers' legacy TLS expects RSA, and it matches what the
//! prior tooling issued. rcgen's ring backend can sign with an RSA key but not generate
//! one, so the key comes from the `rsa` crate and rcgen builds the X.509 around it.

use rand::rngs::OsRng;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
    IsCa, KeyUsagePurpose, SignatureAlgorithm,
};
use rsa::RsaPrivateKey;
use rsa::pkcs8::{EncodePrivateKey, LineEnding};

/// RSA 2048, SHA-256 — the signature algorithm for every cert this module makes.
fn sign_algo() -> &'static SignatureAlgorithm {
    &rcgen::PKCS_RSA_SHA256
}

#[derive(Debug, thiserror::Error)]
pub enum CaError {
    #[error("could not generate an RSA key: {0}")]
    KeyGen(String),
    #[error("could not load the CA key or certificate: {0}")]
    Load(String),
    #[error("could not issue the certificate: {0}")]
    Issue(String),
}

type Result<T, E = CaError> = std::result::Result<T, E>;

/// Generate a fresh RSA 2048 private key as PKCS#8 PEM.
fn generate_rsa_pem() -> Result<String> {
    let key = RsaPrivateKey::new(&mut OsRng, 2048).map_err(|e| CaError::KeyGen(e.to_string()))?;
    Ok(key.to_pkcs8_pem(LineEnding::LF).map_err(|e| CaError::KeyGen(e.to_string()))?.to_string())
}

fn dn(cn: &str) -> DistinguishedName {
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, cn);
    dn
}

/// A loaded CA: its key (to sign with) and self-signed certificate (to append to chains).
pub struct Ca {
    key_pem: String,
    cert_pem: String,
    cn: String,
}

impl Ca {
    /// A fresh CA with the given common name.
    pub fn generate(common_name: &str) -> Result<Self> {
        let key_pem = generate_rsa_pem()?;
        let key = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&key_pem, sign_algo())
            .map_err(|e| CaError::KeyGen(e.to_string()))?;

        let mut params = CertificateParams::new(vec![]).map_err(|e| CaError::Issue(e.to_string()))?;
        params.distinguished_name = dn(common_name);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let cert = params.self_signed(&key).map_err(|e| CaError::Issue(e.to_string()))?;

        Ok(Self { key_pem, cert_pem: cert.pem(), cn: common_name.to_string() })
    }

    /// Load an existing CA from its private key and certificate PEM (e.g. a Gary `Certs`
    /// folder's `private.key` + `public.pem`), so issued certs chain to what controllers
    /// already trust.
    pub fn adopt(cert_pem: &str, key_pem: &str) -> Result<Self> {
        // Confirm the key loads and the cert parses, and recover the CA's CN for labels.
        rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(key_pem, sign_algo())
            .map_err(|e| CaError::Load(format!("key: {e}")))?;
        let cn = common_name_of(cert_pem)
            .ok_or_else(|| CaError::Load("certificate has no Common Name".into()))?;
        Ok(Self { key_pem: key_pem.to_string(), cert_pem: cert_pem.to_string(), cn })
    }

    /// The CA certificate, to append to a controller's trust chain.
    pub fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    /// The CA private key PEM, to store at rest (encrypted, like the client identity).
    pub fn key_pem(&self) -> &str {
        &self.key_pem
    }

    /// The CA's common name.
    pub fn common_name(&self) -> &str {
        &self.cn
    }

    /// Sign a client ("composer") certificate under this CA. `cn` must start with
    /// `Composer_` for a controller to accept it as a Composer client. The certificate is a
    /// non-CA client+server-auth leaf, matching what the controllers expect.
    pub fn issue_composer(&self, cn: &str) -> Result<Issued> {
        let ca_key = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&self.key_pem, sign_algo())
            .map_err(|e| CaError::Load(e.to_string()))?;
        let ca_params = CertificateParams::from_ca_cert_pem(&self.cert_pem)
            .map_err(|e| CaError::Load(e.to_string()))?;
        let ca_cert = ca_params.self_signed(&ca_key).map_err(|e| CaError::Load(e.to_string()))?;

        let leaf_key_pem = generate_rsa_pem()?;
        let leaf_key = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&leaf_key_pem, sign_algo())
            .map_err(|e| CaError::KeyGen(e.to_string()))?;

        let mut params = CertificateParams::new(vec![cn.to_string()])
            .map_err(|e| CaError::Issue(e.to_string()))?;
        params.distinguished_name = dn(cn);
        params.is_ca = IsCa::NoCa;
        params.key_usages =
            vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ClientAuth,
            ExtendedKeyUsagePurpose::ServerAuth,
        ];
        let cert = params
            .signed_by(&leaf_key, &ca_cert, &ca_key)
            .map_err(|e| CaError::Issue(e.to_string()))?;

        Ok(Issued { cert_pem: cert.pem(), key_pem: leaf_key_pem })
    }
}

/// A freshly issued client certificate and its private key, both PEM.
#[derive(Clone, Debug)]
pub struct Issued {
    pub cert_pem: String,
    pub key_pem: String,
}

/// The Common Name of the first certificate in `pem`, if it parses.
pub fn common_name_of(pem: &str) -> Option<String> {
    use x509_parser::prelude::*;
    let (_, p) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).ok()?;
    let (_, cert) = X509Certificate::from_der(&p.contents).ok()?;
    cert.subject().iter_common_name().next()?.as_str().ok().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::prelude::*;

    fn parsed(pem: &str) -> X509Certificate<'static> {
        // Leak the DER so the borrow lives for the test; fine for a handful of certs.
        let (_, p) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).unwrap();
        let der: &'static [u8] = Box::leak(p.contents.into_boxed_slice());
        X509Certificate::from_der(der).unwrap().1
    }

    #[test]
    fn generated_ca_is_a_ca_and_issues_a_usable_leaf() {
        let ca = Ca::generate("openComposer CA").unwrap();
        let ca_cert = parsed(ca.cert_pem());
        assert!(ca_cert.is_ca());
        assert_eq!(ca.common_name(), "openComposer CA");

        let issued = ca.issue_composer("Composer_test").unwrap();
        let leaf = parsed(&issued.cert_pem);
        assert!(!leaf.is_ca());
        // The leaf is issued by the CA.
        assert_eq!(leaf.issuer().to_string(), ca_cert.subject().to_string());
        // It carries client auth.
        let eku = leaf.extended_key_usage().unwrap().unwrap().value;
        assert!(eku.client_auth);
    }

    #[test]
    fn adopt_round_trips_and_signs_under_the_adopted_ca() {
        // Make a CA, then adopt it from its own PEM and issue under the adopted copy.
        let original = Ca::generate("Adopt Me CA").unwrap();
        let adopted = Ca::adopt(original.cert_pem(), original.key_pem()).unwrap();
        assert_eq!(adopted.common_name(), "Adopt Me CA");

        let issued = adopted.issue_composer("Composer_adopted").unwrap();
        let leaf = parsed(&issued.cert_pem);
        let ca_cert = parsed(original.cert_pem());
        assert_eq!(leaf.issuer().to_string(), ca_cert.subject().to_string());
    }

    #[test]
    fn issued_identity_loads_as_a_tls_identity() {
        // The whole point: the issued cert+key must work as a c4 client identity.
        let ca = Ca::generate("Id CA").unwrap();
        let issued = ca.issue_composer("Composer_id").unwrap();
        crate::soap::Identity::from_pem(issued.cert_pem.as_bytes(), issued.key_pem.as_bytes())
            .expect("issued cert+key should load as an Identity");
    }
}
