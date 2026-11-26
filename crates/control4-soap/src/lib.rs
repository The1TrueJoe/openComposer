//! control4-soap — the c4soap wire protocol for Control4 Directors.
//!
//! c4soap is the Director's own protocol: a single XML document per message,
//! NUL-terminated, over cert-pinned mutual TLS on port 5021. This crate is the
//! client side of it, shared by openComposer and the Control4 navigator tools.
//!
//! - [`soap`] — the protocol: [`soap::Connection`], the typed [`soap::Call`]
//!   builder (byte-exact, test-locked — not a generic serializer), [`soap::Reply`],
//!   [`soap::Event`], [`soap::Identity`], and the TLS/pinning setup.
//! - [`xml`] — small read helpers over `roxmltree` used by the protocol.
//!
//! Only the protocol layer lives here. openComposer's project model, Director
//! client, agents, and op-authoring stay in openComposer: they are coupled to
//! app-domain modules (agents, takeover, ops) and are not part of the shared
//! wire protocol. See `DESIGN.md` for the boundary and why.

pub mod soap;
pub mod xml;

// The legacy-RSA key provider the TLS layer falls back to for the sub-2048-bit
// RSA client keys Composer issues and `ring` refuses. Internal to the protocol.
mod keys;
