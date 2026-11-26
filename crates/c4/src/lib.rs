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
pub mod drivers;
pub mod model;
pub mod ops;
pub mod program;
pub mod sddp;
pub mod sidecar;
// The c4soap protocol + its XML helpers live in the shared `control4-soap` crate
// now; re-exported so `c4::soap::…` / `c4::xml::…` and in-crate `crate::soap`/
// `crate::xml` paths are unchanged.
pub use control4_soap::{soap, xml};
pub mod takeover;
pub mod zigbee;

pub use director::{Catalog, Director, DirectorError, DirectorInfo, Snapshot};
pub use model::{Names, Project};
pub use ops::Op;
pub use soap::Identity;
