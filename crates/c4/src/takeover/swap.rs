//! Planning and carrying out the client-CA chain swap on a controller.
//!
//! The swap appends the owner's CA ([`super::ca`]) to each client-CA trust chain the
//! controller has, so openComposer's client certificate is trusted. Planning is pure and
//! tested here; the execution is a thin, blocking driver over an [`super::ssh::Ssh`] that
//! the caller runs deliberately (through the app's confirmation), against a controller the
//! owner has OK'd — a reboot follows, so it is never automatic.
//!
//! The plan is always computed from the chain contents read off the controller, so a
//! missing chain is skipped and an already-patched one is a no-op (no needless reboot).
//! Before overwriting a chain the controller keeps a timestamped `.backup` beside it, and
//! the caller also keeps the original locally (see the app's takeover storage), so the
//! change is reversible.

use super::certchain;
use super::ssh::{Ssh, SshError};

/// What the swap will do to one chain file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// The file is not on this controller (its era does not have it).
    Missing,
    /// The CA is already present and newest — nothing to do.
    AlreadyPatched,
    /// Replace the chain with `new_content`, keeping `backup` of the original first.
    Patch { backup: String, old_content: String, new_content: String },
}

/// The plan for one chain file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainPlan {
    pub path: String,
    pub action: Action,
}

impl ChainPlan {
    pub fn changes(&self) -> bool {
        matches!(self.action, Action::Patch { .. })
    }
}

/// `<file>.<stamp>.backup` beside the original (same directory).
pub fn backup_path(path: &str, stamp: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/{file}.{stamp}.backup"),
        None => format!("{path}.{stamp}.backup"),
    }
}

/// Plan the swap from chain contents already read off the controller. Each entry is
/// `(path, Some(contents))` when the file exists, or `(path, None)` when it is absent.
/// `stamp` names the backups (one timestamp for the whole run).
pub fn plan(chains: &[(String, Option<String>)], ca_pem: &str, stamp: &str) -> Vec<ChainPlan> {
    chains
        .iter()
        .map(|(path, contents)| {
            let action = match contents {
                None => Action::Missing,
                Some(current) => {
                    let merged = certchain::merge(current, ca_pem);
                    if merged.changed {
                        Action::Patch {
                            backup: backup_path(path, stamp),
                            old_content: current.clone(),
                            new_content: merged.chain,
                        }
                    } else {
                        Action::AlreadyPatched
                    }
                }
            };
            ChainPlan { path: path.clone(), action }
        })
        .collect()
}

/// Plan the reverse: take our CA back out of each chain. Same shape as [`plan`] — a
/// `Patch` whose `new_content` is the chain with our CA removed — so [`apply`] runs it
/// unchanged, and a chain that never had our CA is left alone.
pub fn plan_revert(chains: &[(String, Option<String>)], ca_pem: &str, stamp: &str) -> Vec<ChainPlan> {
    chains
        .iter()
        .map(|(path, contents)| {
            let action = match contents {
                None => Action::Missing,
                Some(current) => {
                    let stripped = certchain::strip(current, ca_pem);
                    if stripped.changed {
                        Action::Patch {
                            backup: backup_path(path, stamp),
                            old_content: current.clone(),
                            new_content: stripped.chain,
                        }
                    } else {
                        Action::AlreadyPatched
                    }
                }
            };
            ChainPlan { path: path.clone(), action }
        })
        .collect()
}

/// What a completed swap did, for the caller to report and to decide on a reboot.
#[derive(Debug, Clone, Default)]
pub struct Applied {
    /// Chains that were patched (path + the local copy of the original, to keep).
    pub patched: Vec<(String, String)>,
    /// Chains found already patched.
    pub already: Vec<String>,
    /// Chains not present on this controller.
    pub missing: Vec<String>,
}

impl Applied {
    /// A reboot is needed exactly when at least one chain changed.
    pub fn reboot_needed(&self) -> bool {
        !self.patched.is_empty()
    }
}

/// Read a controller's chains, returning `(path, Some(contents)|None)` per candidate.
/// Blocking (SSH shells out); run it off the async executor.
pub fn read_chains(ssh: &Ssh, paths: &[&str]) -> Vec<(String, Option<String>)> {
    paths
        .iter()
        .map(|p| {
            let contents = if ssh.exists(p) { ssh.read_file(p) } else { None };
            (p.to_string(), contents)
        })
        .collect()
}

/// Carry out a plan over SSH: for each `Patch`, copy the original to its backup on the
/// controller, then overwrite the chain. Blocking. Returns what was done; the caller
/// reboots if [`Applied::reboot_needed`].
///
/// Errors leave earlier chains patched (each with its backup on the controller), so a
/// failure is recoverable from the backups rather than losing a chain.
pub fn apply(ssh: &Ssh, plan: &[ChainPlan]) -> Result<Applied, SwapError> {
    let mut done = Applied::default();
    for item in plan {
        match &item.action {
            Action::Missing => done.missing.push(item.path.clone()),
            Action::AlreadyPatched => done.already.push(item.path.clone()),
            Action::Patch { backup, old_content, new_content } => {
                // Back up the current file on the controller before touching it.
                ssh.run(&format!("cp -p {} {}", item.path, backup), true)
                    .map_err(|source| SwapError::Backup { path: item.path.clone(), source })?;
                ssh.put_stream(new_content.as_bytes(), &format!("cat > {}", item.path))
                    .map_err(|source| SwapError::Write { path: item.path.clone(), source })?;
                done.patched.push((item.path.clone(), old_content.clone()));
            }
        }
    }
    Ok(done)
}

/// Ask the controller to reboot (so a changed chain takes effect). Deliberately separate
/// from [`apply`] so the caller decides and confirms.
pub fn reboot(ssh: &Ssh) -> Result<(), SshError> {
    // Detach so the command returns before SSH drops with the box.
    ssh.run("(sleep 1; reboot) >/dev/null 2>&1 &", false).map(|_| ())
}

#[derive(Debug, thiserror::Error)]
pub enum SwapError {
    #[error("could not back up {path} before changing it: {source}")]
    Backup { path: String, source: SshError },
    #[error("backed up {path} but could not write the new chain: {source}")]
    Write { path: String, source: SshError },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn self_signed(cn: &str) -> String {
        let ca = crate::takeover::ca::Ca::generate(cn).unwrap();
        ca.cert_pem().to_string()
    }

    #[test]
    fn backup_path_sits_beside_the_file() {
        assert_eq!(
            backup_path("/etc/openvpn/clientca-prod.pem", "2026-21-10--12-00-00"),
            "/etc/openvpn/clientca-prod.pem.2026-21-10--12-00-00.backup"
        );
    }

    #[test]
    fn plan_skips_missing_patches_new_and_noops_present() {
        let ca = self_signed("openComposer CA");
        let other = self_signed("Something Else");
        let chains = vec![
            ("/a/missing.pem".to_string(), None),
            ("/b/fresh.pem".to_string(), Some(other.clone())),
            ("/c/done.pem".to_string(), Some(format!("{other}\n{ca}"))),
        ];
        let p = plan(&chains, &ca, "STAMP");

        assert_eq!(p[0].action, Action::Missing);
        assert!(matches!(p[1].action, Action::Patch { .. }));
        assert_eq!(p[2].action, Action::AlreadyPatched);

        // Only the fresh chain counts as a change (→ reboot).
        assert_eq!(p.iter().filter(|c| c.changes()).count(), 1);
        if let Action::Patch { backup, new_content, .. } = &p[1].action {
            assert_eq!(backup, "/b/fresh.pem.STAMP.backup");
            assert!(new_content.contains(&ca));
            assert!(new_content.contains(&other));
        }
    }

    #[test]
    fn applied_reboot_logic() {
        let a = Applied { patched: vec![("/x".into(), "old".into())], ..Default::default() };
        assert!(a.reboot_needed());
        let b = Applied { already: vec!["/y".into()], ..Default::default() };
        assert!(!b.reboot_needed());
    }
}
