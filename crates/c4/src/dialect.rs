//! Director versions and the protocol differences between them.
//!
//! Everything version-specific goes through [`Dialect`] so the rest of the code can
//! ask "how does *this* Director do X" instead of comparing version numbers inline.
//! Verified so far: 3.3.0 and 3.3.3 (real EA-1 and the Windows Virtual Director).
//! 2.x Directors are recognised but untested.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub build: u32,
}

impl Version {
    /// Parses `3.3.3.660628-res` (and anything shorter, missing parts become 0).
    pub fn parse(s: &str) -> Option<Self> {
        let core = s.split(['-', ' ']).next()?;
        let mut parts = core.split('.').map(|p| p.parse::<u32>().ok());
        let major = parts.next()??;
        let mut next = || parts.next().flatten().unwrap_or(0);
        Some(Self { major, minor: next(), patch: next(), build: next() })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}.{}", self.major, self.minor, self.patch, self.build)
    }
}

/// How a controller is taken over, by OS era. See [`Dialect::takeover_era`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TakeoverEra {
    /// OS ≤ 3.0: factory root password, single OpenVPN CA chain.
    Legacy,
    /// OS 3.1 – 4.1: MAC-derived root password over SSH, single OpenVPN CA chain.
    Derived,
    /// OS 4.2+: password SSH off (REST bootstrap for root), three CA chains, MQTT JWT bus.
    Modern,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dialect {
    pub version: Version,
    /// Whether this version has been exercised against real hardware or a Virtual Director.
    pub verified: bool,
    /// `flags` for `Upload` when taking a backup. Composer 3.x sends 32.
    pub upload_flags: i64,
}

impl Dialect {
    pub fn for_version(version: Version) -> Self {
        let verified = version.major == 3 && version.minor == 3;
        // ponytail: 2.x and 3.0–3.2 use the 3.3 behaviour until we can test them; the
        // Virtual Directors for 2.5.3 and 2.10.2 on the test PC are the upgrade path.
        Self { version, verified, upload_flags: 32 }
    }

    /// Which takeover era this controller is in — how root is reached and which cert
    /// chains exist. Kept here, with the rest of the version-specific knowledge, rather
    /// than as inline version checks in the takeover code.
    pub fn takeover_era(&self) -> TakeoverEra {
        match (self.version.major, self.version.minor) {
            // OS 4.2 moved certs under /opt/control4/etc/ssl, turned off password SSH, and
            // added the mosquitto JWT bus. Treat 4.2+ (and anything newer) as modern.
            (m, _) if m >= 5 => TakeoverEra::Modern,
            (4, n) if n >= 2 => TakeoverEra::Modern,
            // 3.1 removed the fixed root password in favour of the MAC-derived one; it and
            // early 4.x still accept password SSH.
            (4, _) => TakeoverEra::Derived,
            (3, n) if n >= 1 => TakeoverEra::Derived,
            // 3.0 and earlier still accept the factory password.
            _ => TakeoverEra::Legacy,
        }
    }

    /// The client-CA chain files this controller is expected to have, newest-layout first.
    /// The swap still probes each for existence — this only sets expectation and labels.
    pub fn client_ca_chains(&self) -> &'static [&'static str] {
        use crate::takeover::paths::*;
        match self.takeover_era() {
            TakeoverEra::Modern => &[SSL_CLIENT_CA, OPENVPN_CLIENT_CA, MOSQUITTO_CA_CHAIN],
            _ => &[OPENVPN_CLIENT_CA],
        }
    }

    /// Does this controller authenticate the MQTT bus with the `mosquitto-jwt-auth` plugin
    /// (OS 4.2+), i.e. is the `api.pem` patch + forged JWT relevant?
    pub fn has_mqtt_jwt_auth(&self) -> bool {
        self.takeover_era() == TakeoverEra::Modern
    }

    /// The `Director` entry of a `GetVersionInfo` reply.
    pub fn from_version_info(xml: &str) -> Option<Self> {
        let doc = roxmltree::Document::parse(xml).ok()?;
        let v = doc
            .descendants()
            .find(|n| n.has_tag_name("version") && n.attribute("name") == Some("Director"))?
            .attribute("version")?;
        Version::parse(v).map(Self::for_version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_director_versions() {
        assert_eq!(Version::parse("3.3.3.660628-res").unwrap().to_string(), "3.3.3.660628");
        assert_eq!(Version::parse("2.10.2").unwrap().build, 0);
        assert!(Version::parse("3.3.0.1") < Version::parse("3.3.3.1"));
    }

    fn era(v: &str) -> TakeoverEra {
        Dialect::for_version(Version::parse(v).unwrap()).takeover_era()
    }

    #[test]
    fn takeover_eras() {
        assert_eq!(era("2.10.2"), TakeoverEra::Legacy);
        assert_eq!(era("3.0.5"), TakeoverEra::Legacy);
        assert_eq!(era("3.1.0"), TakeoverEra::Derived);
        assert_eq!(era("3.3.3.660628"), TakeoverEra::Derived);
        assert_eq!(era("4.1.9"), TakeoverEra::Derived);
        assert_eq!(era("4.2.1.758346"), TakeoverEra::Modern);
        assert_eq!(era("5.0.0"), TakeoverEra::Modern);
    }

    #[test]
    fn chain_lists_by_era() {
        let legacy = Dialect::for_version(Version::parse("3.3.3").unwrap());
        assert_eq!(legacy.client_ca_chains(), &["/etc/openvpn/clientca-prod.pem"]);
        assert!(!legacy.has_mqtt_jwt_auth());

        let modern = Dialect::for_version(Version::parse("4.2.1").unwrap());
        assert_eq!(modern.client_ca_chains().len(), 3);
        assert!(modern.has_mqtt_jwt_auth());
    }
}
