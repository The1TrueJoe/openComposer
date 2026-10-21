//! The MAC-derived stock root password used by Control4 firmware from OS 3.1.0 on.
//!
//! OS 3.1.0 removed the fixed default root password and instead derives root's password
//! deterministically from the unit's MAC (PBKDF2-HMAC-SHA384 over the uppercase 12-hex
//! MAC). The scheme is not published by Control4; it was recovered by the community
//! `Control4.Jailbreak` tool and is reproduced here so openComposer can obtain root on a
//! controller its owner is taking over without hand-typing a password.
//!
//! This only helps where the password is still the MAC-derived default. A dealer-set
//! custom password just fails the guess and the caller falls back to its other logins, so
//! this grants no access the owner does not already have. On OS 4.2+ SSH password auth is
//! off entirely, so this path no longer opens the box — the REST bootstrap does.

use pbkdf2::pbkdf2_hmac;
use sha2_10::Sha384;

/// Fixed KDF salt for the OS 3.1.0+ root-password derivation.
const SALT: [u8; 32] = [
    0x49, 0x39, 0x6a, 0x24, 0x67, 0x75, 0x7d, 0x39, 0x23, 0x23, 0x6e, 0x42, 0x5b, 0x3d, 0x61,
    0x2b, 0x56, 0x2e, 0x31, 0x44, 0x6c, 0x79, 0x70, 0x3f, 0x52, 0x75, 0x39, 0x40, 0x6a, 0x7a,
    0x70, 0x5e,
];
/// Derived-key length in bytes (matches the vendor scheme).
const DKLEN: usize = 33;
/// Iteration count is proportional to the MAC-string length (12 * this).
const ITERS_PER_CHAR: u32 = 397;

/// Control4's OUI prefixes, as ARP prints them (the second form is macOS stripping the
/// leading zero of each octet). Used to decide whether a MAC is even worth deriving from.
pub const C4_OUI: &[&str] = &["00:0f:ff", "0:f:ff"];

/// Is `mac` a Control4 unit by its OUI? Lets the caller avoid trying a derived password
/// on some unrelated host that happens to be in the ARP table.
pub fn is_control4_mac(mac: &str) -> bool {
    let m = mac.to_ascii_lowercase();
    C4_OUI.iter().any(|p| m.starts_with(p))
}

/// Normalise a MAC to the form the derivation hashes: 12 uppercase hex digits, no
/// separators. Returns `None` if it is not 12 hex digits.
fn canon_mac(mac: &str) -> Option<String> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return None;
    }
    Some(hex.to_ascii_uppercase())
}

/// Standard base64 (RFC 4648, with padding). Hand-rolled to keep the derivation free of a
/// base64 dependency for one 33-byte encode.
fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(A[(n >> 18 & 63) as usize] as char);
        out.push(A[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// The MAC-derived stock root password, or `None` if `mac` is not a valid MAC.
pub fn derive_root_pw(mac: &str) -> Option<String> {
    let m = canon_mac(mac)?;
    let mut dk = [0u8; DKLEN];
    pbkdf2_hmac::<Sha384>(m.as_bytes(), &SALT, m.len() as u32 * ITERS_PER_CHAR, &mut dk);
    Some(b64(&dk))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The EA3 lab unit (MAC 00:0F:FF:1F:35:65) has a confirmed-working derived root
    // password; this pins the whole chain (canon, KDF params, base64).
    #[test]
    fn known_ea3() {
        assert_eq!(
            derive_root_pw("00:0F:FF:1F:35:65").as_deref(),
            Some("P3jnsCkGx+DApstYaNEFO10eNYiFdTJISTR4AZ2nDemR")
        );
    }

    #[test]
    fn separators_and_case_do_not_matter() {
        assert_eq!(derive_root_pw("000fff1f3565"), derive_root_pw("00:0F:FF:1F:35:65"));
    }

    #[test]
    fn rejects_bad_mac() {
        assert!(derive_root_pw("nope").is_none());
        assert!(derive_root_pw("00:0f:ff").is_none());
    }

    #[test]
    fn oui_gate() {
        assert!(is_control4_mac("00:0F:FF:1F:35:65"));
        assert!(is_control4_mac("0:f:ff:1f:35:65"));
        assert!(!is_control4_mac("ac:de:48:00:11:22"));
    }
}
