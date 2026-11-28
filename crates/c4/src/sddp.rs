//! SDDP discovery for openComposer.
//!
//! The protocol — parsing and the UDP-multicast sweep — comes from the owner's
//! shared [`sddp`] crate (the same one `control4-audio-client` and
//! `openhc-control4` use). This module is only the thin openComposer-specific
//! layer on top: a serializable projection of a discovered device for the UI
//! and MCP, and the Control4-controller heuristic. No networking lives here.
//!
//! This is the discovery/browse side (find devices to identify). `sddp` also
//! has an announcer; openComposer doesn't use it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A discovered device, flattened the way openComposer serializes it for the
/// UI (`host`/`model`/`address`/`device_type`) and MCP. Built from
/// [`sddp::Device`]; the crate's `Option`/`IpAddr` fields become the empty
/// string / a string so the JSON shape stays stable for the frontend.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Announcement {
    pub address: String,
    pub host: String,
    pub device_type: String,
    pub primary_proxy: String,
    pub proxies: Vec<String>,
    pub manufacturer: String,
    pub model: String,
    pub driver: String,
    pub config_url: String,
    pub max_age: Option<u32>,
}

impl From<sddp::Device> for Announcement {
    fn from(d: sddp::Device) -> Self {
        Announcement {
            address: d.address.to_string(),
            host: d.host,
            device_type: d.device_type,
            primary_proxy: d.primary_proxy.unwrap_or_default(),
            proxies: d.proxies,
            manufacturer: d.manufacturer.unwrap_or_default(),
            model: d.model.unwrap_or_default(),
            driver: d.driver.unwrap_or_default(),
            config_url: d.config_url.unwrap_or_default(),
            max_age: d.max_age,
        }
    }
}

impl Announcement {
    /// A Control4 controller (any `c4:control4_*` type) but not an SR-2 remote,
    /// which advertises a `control4_` type yet isn't a Director host.
    pub fn is_controller(&self) -> bool {
        self.device_type.starts_with("c4:control4_") && !self.device_type.contains("sr2")
    }
}

/// Search the LAN for `pattern` (`*` or an exact SDDP type) for `window`, and
/// return the matching devices as [`Announcement`]s. Devices are de-duplicated
/// by `Host` by the `sddp` crate (latest wins).
pub async fn discover(pattern: &str, window: Duration) -> std::io::Result<Vec<Announcement>> {
    let devices = sddp::Discovery::new()
        .target(pattern)
        .timeout(window)
        .discover()
        .await?;
    Ok(devices.into_iter().map(Announcement::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_heuristic() {
        let ctrl = |t: &str| Announcement { device_type: t.into(), ..Default::default() };
        assert!(ctrl("c4:control4_ea1").is_controller());
        assert!(ctrl("c4:control4_ea5").is_controller());
        assert!(!ctrl("c4:control4_sr260").is_controller()); // SR-2 remote, not a host
        assert!(!ctrl("c4:leaf_ultra_hdmivswitch_c").is_controller());
    }

    #[test]
    fn projects_a_device() {
        // Build a Device the way the sddp crate does, then project it.
        let msg: sddp::Message = "NOTIFY ALIVE SDDP/1.0\r\n\
From: \"192.168.1.172:1902\"\r\n\
Host: \"control4_ea1-0010abcd\"\r\n\
Type: \"c4:control4_ea1\"\r\n\
Driver: \"control4_ea1.c4i\"\r\n\r\n"
            .parse()
            .unwrap();
        let d = sddp::Device::from_message(&msg, None).unwrap();
        let a = Announcement::from(d);
        assert_eq!(a.address, "192.168.1.172");
        assert_eq!(a.driver, "control4_ea1.c4i");
        assert!(a.is_controller());
    }
}
