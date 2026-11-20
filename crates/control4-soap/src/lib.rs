//! control4-soap — the c4soap wire protocol and a connected-Director client.
//!
//! **Scaffold only.** No protocol code lives here yet. The public API and the
//! migration plan are in `DESIGN.md` next to this file; the move is gated on
//! openComposer PRs #6 and #7 (both edit `crates/c4/src/ops.rs`).
//!
//! The shared asset is the cert-pinned XML-over-TLS protocol that openComposer's
//! `c4::soap` already implements and test-locks. When it lands, this crate will
//! re-export the `protocol` layer at the root (`Connection`, `Call`, `Value`,
//! `Reply`, `Event`, `Identity`, `tls_config`, `split_addr`) and gate the typed
//! `model`, `client`, and `ops` layers behind Cargo features. See `DESIGN.md`.

// Intentionally empty until the extraction (post #6/#7). Keeping the crate a
// real workspace member now means the three consumers and the publish tooling
// can reference it, and the design is reviewable, before any code moves.
