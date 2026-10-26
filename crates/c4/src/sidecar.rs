//! Finding Composer Pro's remote-support relay so openComposer can reach the same controller
//! through it, as an additional standard client.
//!
//! What this is. While a Composer Pro remote-support session is open, Composer brings up a
//! local virtual network adapter in the 10.123.0.0/16 range on the PC and relays the
//! controller's own ports (Director 5021, web API 443/80, …) through Control4's cloud to that
//! local address. Any compatible client on that PC — or one reaching the PC through an SSH or
//! port forward — can then talk to the controller at that local address exactly as Composer
//! does, because it presents the same dealer certificate and speaks the same protocol
//! (`category="composer"`, mutual TLS on 5021), not through any trickery.
//!
//! What this is NOT. It does not touch, read or decrypt Composer's protected key store, and it
//! does not forge or work around the cloud relay's own authentication. Detection only observes
//! this machine's network interfaces and makes a plain TCP connection to see whether a Director
//! is listening — it is read-only and needs no certificate. The owner supplies their own dealer
//! certificate (as for any Director) for the actual connection.

use std::net::Ipv4Addr;
use std::time::Duration;

use serde::Serialize;

use crate::soap::{TLS_PORT, split_addr};

/// Composer's remote-support adapter always falls in 10.123.0.0/16.
pub const RELAY_PREFIX: [u8; 2] = [10, 123];

/// A local address at which a controller looks reachable through a Composer remote session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SidecarCandidate {
    /// The virtual adapter's own IPv4 address (10.123.x.y).
    pub adapter_ip: String,
    /// The interface the address was found on (for display and debugging).
    pub interface: String,
    /// Address to add as a Director: `<adapter_ip>:5021`.
    pub director_addr: String,
    /// Where the controller's web API is on the same relay (`<adapter_ip>`, port 443 by
    /// default — openComposer derives it from the Director host when none is set explicitly).
    pub web_api_addr: String,
}

/// Pick the candidate relay endpoints out of this computer's IPv4 interface addresses. Pure so
/// it can be tested over synthetic interface lists; the platform enumeration lives in the app.
pub fn candidates_from_ifaces<'a>(ifaces: impl IntoIterator<Item = (&'a str, Ipv4Addr)>) -> Vec<SidecarCandidate> {
    let mut out: Vec<SidecarCandidate> = ifaces
        .into_iter()
        .filter(|(_, ip)| {
            let o = ip.octets();
            o[0] == RELAY_PREFIX[0] && o[1] == RELAY_PREFIX[1]
        })
        .map(|(name, ip)| SidecarCandidate {
            adapter_ip: ip.to_string(),
            interface: name.to_string(),
            director_addr: format!("{ip}:{TLS_PORT}"),
            web_api_addr: ip.to_string(),
        })
        .collect();
    // A relay address can show up on more than one interface entry; list each once, in order.
    out.sort_by(|a, b| a.adapter_ip.cmp(&b.adapter_ip));
    out.dedup_by(|a, b| a.adapter_ip == b.adapter_ip);
    out
}

/// Whether something answers a TCP connection at `addr` (a Director on 5021 when it's a live
/// relay). Read-only: a plain connect, no TLS handshake and no certificate.
pub async fn director_listening(addr: &str, timeout: Duration) -> bool {
    let (host, port) = split_addr(addr, TLS_PORT);
    matches!(
        tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port))).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn picks_only_the_relay_adapter() {
        let ifaces = [
            ("lo0", ip("127.0.0.1")),
            ("en0", ip("192.168.1.42")),
            ("ethernet_32773", ip("10.123.4.2")), // Composer's virtual adapter
            ("utun3", ip("10.0.0.5")),            // 10/8 but not 10.123 — a VPN, not the relay
        ];
        let got = candidates_from_ifaces(ifaces);
        assert_eq!(got.len(), 1);
        let c = &got[0];
        assert_eq!(c.adapter_ip, "10.123.4.2");
        assert_eq!(c.interface, "ethernet_32773");
        assert_eq!(c.director_addr, "10.123.4.2:5021");
        assert_eq!(c.web_api_addr, "10.123.4.2");
    }

    #[test]
    fn none_when_no_relay_present() {
        let ifaces = [("en0", ip("192.168.1.42")), ("lo0", ip("127.0.0.1"))];
        assert!(candidates_from_ifaces(ifaces).is_empty());
    }

    #[test]
    fn deduplicates_a_relay_seen_twice() {
        let ifaces = [("ethernet_1", ip("10.123.9.9")), ("ethernet_1:1", ip("10.123.9.9"))];
        let got = candidates_from_ifaces(ifaces);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].director_addr, "10.123.9.9:5021");
    }

    #[test]
    fn several_relays_are_sorted() {
        let ifaces = [("b", ip("10.123.5.1")), ("a", ip("10.123.1.1"))];
        let got = candidates_from_ifaces(ifaces);
        assert_eq!(got.iter().map(|c| c.adapter_ip.as_str()).collect::<Vec<_>>(), ["10.123.1.1", "10.123.5.1"]);
    }
}
