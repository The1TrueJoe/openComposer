//! Taking ownership of a controller you own, so openComposer's client certificate is
//! trusted and it can speak to the Director without a dealer account.
//!
//! Two eras, picked by the controller's OS version (see [`crate::dialect`]):
//!
//!   * **Older firmware** (the "Gary tool" path) — root over SSH with a password
//!     (`t0talc0ntr0l4!` up to OS 3.0, then the MAC-derived default from OS 3.1,
//!     see [`authderive`]), and a single client-CA chain at
//!     `/etc/openvpn/clientca-prod.pem` to append our CA to.
//!   * **OS 4.2+** — password SSH is off, so root is reached by a REST bootstrap
//!     (the owner's Control4 account authorises a driver command that re-enables
//!     `sshd` password auth), there are three CA chains to patch, and the MQTT bus
//!     wants a forged signing cert. Those pieces land in later modules; this one
//!     carries the version policy and the parts that are pure and testable offline.
//!
//! What this module is **not**: it does not itself write to a controller. The actual
//! swap + reboot is a `crate::ops::Op` proposed through `app`'s approval flow, against a
//! controller the owner has explicitly OK'd — never automatically, and never against the
//! read-only EA-1 unless the owner says so. Everything here is either a pure transform
//! (chain merge, password derivation) or a transport the caller drives deliberately.

pub mod authderive;
pub mod bootstrap;
pub mod ca;
pub mod certchain;
pub mod mqtt;
pub mod ssh;
pub mod swap;

/// Well-known controller file paths touched by the CA swap. Which of these actually exist
/// depends on the OS, so the swap probes each and skips the missing ones rather than
/// trusting the version — but [`crate::dialect::Dialect`] says which to *expect*.
pub mod paths {
    /// The OpenVPN client-CA chain. Present on every era; the only one on older firmware.
    pub const OPENVPN_CLIENT_CA: &str = "/etc/openvpn/clientca-prod.pem";
    /// The client-CA chain under Control4's SSL dir (OS 4.2 moved certs here).
    pub const SSL_CLIENT_CA: &str = "/opt/control4/etc/ssl/certs/clientca-prod.pem";
    /// The chain mosquitto validates the Composer cert against (OS 4.2+).
    pub const MOSQUITTO_CA_CHAIN: &str = "/etc/mosquitto/certs/ca-chain.pem";
    /// The bundle the `mosquitto-jwt-auth` plugin reads (OS 4.2+); patched for the MQTT JWT.
    pub const API_PEM: &str = "/opt/control4/etc/ssl/certs/api.pem";
}
