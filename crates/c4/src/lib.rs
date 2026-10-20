//! Control4 Director client: protocol, project model, semantic diff, `.c4p` backups,
//! SDDP discovery and the online driver database.
//!
//! Nothing here knows about the desktop app or MCP; `app/` builds on it.

pub mod broker;
pub mod c4p;
pub mod dialect;
pub mod diff;
pub mod director;
pub mod drivers;
mod keys;
pub mod model;
pub mod ops;
pub mod sddp;
pub mod soap;
pub mod xml;

pub use director::{Catalog, Director, DirectorError, DirectorInfo, Snapshot};
pub use model::{Names, Project};
pub use ops::Op;
pub use soap::Identity;
