//! Merging our CA into a controller's client-CA chain — the pure transform at the heart
//! of the cert swap.
//!
//! A controller trusts a Composer client certificate when the CA that signed it is in the
//! chain file (e.g. `/etc/openvpn/clientca-prod.pem`). Taking over a controller means
//! appending the owner's CA to that chain. This module does only the text transform:
//! download the chain, run it through [`merge`], and upload the result if it changed —
//! the download/upload is the caller's (an `Op`'s) job.
//!
//! Two subtleties match what the controller actually tolerates:
//!   * **Dedupe by subject, keeping the last.** Re-running a takeover after regenerating
//!     the CA leaves an old CA cert with the same subject but different bytes; keeping the
//!     last entry replaces it instead of letting stale CAs pile up.
//!   * **Idempotency.** If our CA is already the newest entry for its subject, [`merge`]
//!     reports no change so the caller skips the upload and the reboot.

use x509_parser::prelude::*;

const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
const END: &str = "-----END CERTIFICATE-----";

/// Split a PEM bundle into its complete `CERTIFICATE` blocks, each trimmed, in order. A
/// truncated final block (BEGIN with no END) is dropped rather than half-included.
pub fn cert_blocks(pem: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(b) = pem[from..].find(BEGIN) {
        let start = from + b;
        let Some(e) = pem[start..].find(END) else { break };
        let end = start + e + END.len();
        out.push(pem[start..end].trim().to_string());
        from = end;
    }
    out
}

/// The DER bytes of a PEM certificate block, or `None` if it does not decode.
fn der_of(block: &str) -> Option<Vec<u8>> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(block.as_bytes()).ok()?;
    Some(pem.contents)
}

/// `(subject, issuer)` RFC 2253 strings of a PEM certificate block, if it parses.
fn names_of(block: &str) -> Option<(String, String)> {
    let der = der_of(block)?;
    let (_, cert) = X509Certificate::from_der(&der).ok()?;
    Some((cert.subject().to_string(), cert.issuer().to_string()))
}

/// A cert is identified for dedupe by its parsed subject; a cert that will not parse falls
/// back to its exact text, so unreadable entries are kept and deduped only against copies
/// of themselves rather than being silently merged with something else.
fn identity(block: &str) -> String {
    match names_of(block) {
        Some((subject, _)) => format!("subj:{subject}"),
        None => format!("raw:{block}"),
    }
}

/// Keep one block per identity — the last, so a later entry supersedes an earlier one of
/// the same subject — preserving first-seen order otherwise.
fn dedupe(blocks: Vec<String>) -> Vec<String> {
    // Last index per identity decides which copy survives.
    let mut last: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, b) in blocks.iter().enumerate() {
        last.insert(identity(b), i);
    }
    blocks
        .iter()
        .enumerate()
        .filter(|(i, b)| last.get(&identity(b)) == Some(i))
        .map(|(_, b)| b.clone())
        .collect()
}

/// Does `block` look like a stale self-signed CA from a previous takeover whose subject CN
/// is `ca_cn`? Such a cert is self-issued (subject == issuer) and carries that CN; the real
/// Control4 cert of the same CN is issued by a different root, so it is not matched.
pub fn is_stale_ca(block: &str, ca_cn: &str) -> bool {
    match names_of(block) {
        Some((subject, issuer)) => {
            subject == issuer && subject.contains(&format!("CN={ca_cn}"))
        }
        None => false,
    }
}

/// The result of merging a CA into a chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    /// The chain to upload (always normalised: deduped, one blank line between blocks,
    /// trailing newline), whether or not it changed.
    pub chain: String,
    /// Whether the chain differs from the input (deduped for comparison, so a no-op
    /// re-run of an already-patched chain reports `false`).
    pub changed: bool,
}

fn join(blocks: &[String]) -> String {
    let mut s = blocks.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    s
}

/// Append `ca_pem` (one or more CA certs) to `chain` and dedupe by subject, keeping the
/// appended copy. Reports `changed = false` when the deduped input already ends with
/// exactly this, so the caller can skip the upload and reboot.
pub fn merge(chain: &str, ca_pem: &str) -> Merge {
    let existing = dedupe(cert_blocks(chain));
    let adding = cert_blocks(ca_pem);

    // Appending then deduping (last-wins) moves any already-present CA to the end, which is
    // the same normalised result as a fresh append — so comparing against it detects a
    // genuine no-op regardless of where the CA sat before.
    let mut combined = existing.clone();
    combined.extend(adding);
    let merged = dedupe(combined);

    let before = join(&existing);
    let after = join(&merged);
    Merge { changed: after != before, chain: after }
}

/// Remove from `chain` every certificate whose subject matches a certificate in `ca_pem`
/// (the inverse of [`merge`]), deduping the rest. This reverts a takeover: it takes our CA
/// back out of the controller's trust chain. `changed` is false when the CA was not there.
pub fn strip(chain: &str, ca_pem: &str) -> Merge {
    let remove: std::collections::HashSet<String> =
        cert_blocks(ca_pem).iter().map(|b| identity(b)).collect();
    let existing = dedupe(cert_blocks(chain));
    let kept: Vec<String> =
        existing.iter().filter(|b| !remove.contains(&identity(b))).cloned().collect();

    let before = join(&existing);
    let after = join(&kept);
    Merge { changed: after != before, chain: after }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway self-signed cert with the given CommonName, generated fresh each call so
    /// two certs of the same CN (alpha vs alpha2) differ in their bytes — which is exactly
    /// the "regenerated CA, same subject" case last-wins dedupe exists for.
    fn self_signed(cn: &str) -> String {
        let mut params = rcgen::CertificateParams::new(vec![]).unwrap();
        params.distinguished_name = rcgen::DistinguishedName::new();
        params.distinguished_name.push(rcgen::DnType::CommonName, cn);
        let key = rcgen::KeyPair::generate().unwrap();
        params.self_signed(&key).unwrap().pem().trim().to_string()
    }

    #[test]
    fn blocks_split_and_trim() {
        let (a, b) = (self_signed("alpha"), self_signed("beta"));
        let bundle = format!("noise\n{a}\n\n{b}\ntrailing");
        assert_eq!(cert_blocks(&bundle), vec![a.clone(), b.clone()]);
    }

    #[test]
    fn truncated_tail_dropped() {
        let a = self_signed("alpha");
        let broken = format!("{a}\n{BEGIN}\nhalf");
        assert_eq!(cert_blocks(&broken), vec![a]);
    }

    #[test]
    fn append_changes_once_then_idempotent() {
        let (a, b) = (self_signed("alpha"), self_signed("beta"));
        let (a, b) = (a.as_str(), b.as_str());
        let first = merge(b, a);
        assert!(first.changed);
        assert!(first.chain.contains(a));
        assert!(first.chain.contains(b));
        // Re-merging the same CA into the result is a no-op.
        let second = merge(&first.chain, a);
        assert!(!second.changed);
        assert_eq!(second.chain, first.chain);
    }

    #[test]
    fn same_subject_is_replaced_not_duplicated() {
        // A chain already carrying an older cert for CN=alpha; merging a new one of the
        // same subject (fresh key → different bytes) replaces it rather than stacking two.
        let (a, b, a2) = (self_signed("alpha"), self_signed("beta"), self_signed("alpha"));
        let chain = format!("{b}\n{a}");
        let out = merge(&chain, &a2);
        assert_eq!(out.chain.matches(BEGIN).count(), 2, "beta + one alpha, not three");
        assert!(out.chain.contains(&a2));
        assert!(!out.chain.contains(&a));
    }

    #[test]
    fn stale_ca_detected_by_cn() {
        let a = self_signed("alpha");
        assert!(is_stale_ca(&a, "alpha"));
        assert!(!is_stale_ca(&a, "beta"));
    }

    #[test]
    fn strip_removes_our_ca_and_is_idempotent() {
        let (a, b) = (self_signed("alpha"), self_signed("beta"));
        let patched = merge(&b, &a).chain; // beta + alpha
        let out = strip(&patched, &a);
        assert!(out.changed);
        assert!(out.chain.contains(&b));
        assert!(!out.chain.contains(&a));
        // Stripping again changes nothing.
        assert!(!strip(&out.chain, &a).changed);
    }

    #[test]
    fn strip_absent_ca_is_a_noop() {
        let (a, b) = (self_signed("alpha"), self_signed("beta"));
        assert!(!strip(&b, &a).changed);
    }
}
