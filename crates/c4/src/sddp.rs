//! SDDP, Control4's device discovery: HTTP-like text over UDP multicast
//! 239.255.255.250:1902.
//!
//! Devices announce themselves (`NOTIFY ALIVE SDDP/1.0`) and answer searches
//! (`SEARCH <type> SDDP/1.0`). Seen on a real network:
//!
//! ```text
//! NOTIFY ALIVE SDDP/1.0
//! From: "192.168.1.109:1902"
//! Host: "leaf_ultra_lu862-70b3d50c1637"
//! Max-Age: 1800
//! Type: "c4:leaf_ultra_hdmivswitch_c"
//! Primary-Proxy: "avswitch"
//! Proxies: "avswitch"
//! Manufacturer: "Leaf Audio"
//! Model: "ULTRA LU862"
//! Driver: "leaf_ultra_lu862_ip.c4i"
//! ```
//!
//! `Driver` names the driver file to add, and `Type` is the search type a network
//! binding uses, so a discovered device maps straight onto an `AddDevice` +
//! `AddNetworkBinding` pair.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;

pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
pub const PORT: u16 = 1902;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Announcement {
    /// `NOTIFY ALIVE`, `NOTIFY OFFLINE`, or a search response (`200 OK`).
    pub kind: String,
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
    /// Every header, for anything not lifted into a field.
    pub headers: BTreeMap<String, String>,
}

impl Announcement {
    pub fn is_controller(&self) -> bool {
        self.device_type.starts_with("c4:control4_") && !self.device_type.contains("sr2")
    }
}

/// Parse one datagram. Searches from other clients return `None`.
pub fn parse(datagram: &str) -> Option<Announcement> {
    let mut lines = datagram.split("\r\n");
    let first = lines.next()?.trim();
    let kind = if let Some(rest) = first.strip_prefix("NOTIFY ") {
        format!("NOTIFY {}", rest.trim_end_matches("SDDP/1.0").trim())
    } else if first.starts_with("SDDP/1.0 ") {
        first.trim_start_matches("SDDP/1.0 ").to_string()
    } else {
        return None;
    };
    let mut headers = BTreeMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    let h = |k: &str| headers.get(k).cloned().unwrap_or_default();
    let from = h("From");
    Some(Announcement {
        kind,
        address: from.rsplit_once(':').map(|(ip, _)| ip.to_string()).unwrap_or(from.clone()),
        host: h("Host"),
        device_type: h("Type"),
        primary_proxy: h("Primary-Proxy"),
        proxies: h("Proxies").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        manufacturer: h("Manufacturer"),
        model: h("Model"),
        driver: h("Driver"),
        config_url: h("Config-URL"),
        max_age: headers.get("Max-Age").and_then(|m| m.parse().ok()),
        headers,
    })
}

/// A socket joined to the SDDP group, shared with other listeners on the port.
fn socket() -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(unix)]
    s.set_reuse_port(true)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT).into())?;
    s.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED)?;
    UdpSocket::from_std(s.into())
}

/// Send `SEARCH <pattern>` and collect announcements and replies for `window`.
/// Devices are keyed by `Host`, keeping the most recent message for each.
pub async fn discover(pattern: &str, window: Duration) -> std::io::Result<Vec<Announcement>> {
    let sock = socket()?;
    let local = local_ipv4().unwrap_or(Ipv4Addr::UNSPECIFIED);
    let search = format!("SEARCH {pattern} SDDP/1.0\r\nFrom: \"{local}:{PORT}\"\r\nTran: 1\r\nTimeout: 3\r\n\r\n");
    sock.send_to(search.as_bytes(), (GROUP, PORT)).await?;
    let mut found: BTreeMap<String, Announcement> = BTreeMap::new();
    let deadline = Instant::now() + window;
    let mut buf = vec![0u8; 65535];
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match tokio::time::timeout(left, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                if let Some(a) = parse(&String::from_utf8_lossy(&buf[..n])) {
                    found.insert(if a.host.is_empty() { a.address.clone() } else { a.host.clone() }, a);
                }
            }
            Ok(Err(e)) => return Err(e),
            Err(_) => break,
        }
    }
    Ok(found.into_values().collect())
}

/// The address the OS would use to reach the LAN (no packets are sent).
fn local_ipv4() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect((GROUP, PORT)).ok()?;
    match s.local_addr().ok()? {
        std::net::SocketAddr::V4(a) => Some(*a.ip()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_real_notify() {
        let raw = "NOTIFY ALIVE SDDP/1.0\r\nFrom: \"192.168.1.109:1902\"\r\nHost: \"leaf_ultra_lu862-70b3d50c1637\"\r\nMax-Age: 1800\r\nType: \"c4:leaf_ultra_hdmivswitch_c\"\r\nPrimary-Proxy: \"avswitch\"\r\nProxies: \"avswitch\"\r\nManufacturer: \"Leaf Audio\"\r\nModel: \"ULTRA LU862\"\r\nDriver: \"leaf_ultra_lu862_ip.c4i\"\r\nConfig-URL: \"http://192.168.1.109\"\r\n\r\n";
        let a = parse(raw).unwrap();
        assert_eq!(a.kind, "NOTIFY ALIVE");
        assert_eq!(a.address, "192.168.1.109");
        assert_eq!(a.driver, "leaf_ultra_lu862_ip.c4i");
        assert_eq!(a.proxies, ["avswitch"]);
        assert_eq!(a.max_age, Some(1800));
    }

    #[test]
    fn ignores_other_searches() {
        assert!(parse("SEARCH c4:control4_ea1 SDDP/1.0\r\nFrom: \"192.168.1.159:1902\"\r\n").is_none());
    }
}
