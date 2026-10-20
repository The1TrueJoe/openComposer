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
}
