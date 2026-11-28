//! Control4 Director client: protocol, project model, semantic diff, `.c4p` backups,
//! SDDP discovery and the online driver database.
//!
//! Nothing here knows about the desktop app or MCP; `app/` builds on it.

pub mod agent_ops;
pub mod agents;
pub mod broker;
pub mod c4p;
pub mod dialect;
pub mod diff;
pub mod director;
pub mod driver_update;
pub mod drivers;
pub mod model;
pub mod ops;
pub mod program;
pub mod sddp;
pub mod sidecar;
// The c4soap protocol and its XML helpers come from the shared `control4-soap` crate.
pub use control4_soap::{soap, xml};

/// How openComposer identifies itself to a controller's HTTP services (the web API broker and
/// driver web tabs): the honest product name and version. It deliberately does not impersonate
/// Composer.
pub const USER_AGENT: &str = concat!("openComposer/", env!("CARGO_PKG_VERSION"));
pub mod takeover;
pub mod zigbee;

pub use director::{Catalog, Director, DirectorError, DirectorInfo, Snapshot};
pub use model::{Names, Project};
pub use ops::Op;
pub use soap::Identity;
