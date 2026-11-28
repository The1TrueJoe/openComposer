//! SSH to a controller, for the older takeover path and for landing the CA chain files.
//!
//! These controllers run old sshd (diffie-hellman-group14-sha1, ssh-rsa) that modern
//! OpenSSH only talks to with explicit legacy `-o` options. Rather than bundle and
//! specially configure a Rust SSH client, this wraps the system `ssh`/`sshpass` (and
//! PuTTY `plink` on Windows, which has no `sshpass`) — all of which ship on or are easily
//! installed on macOS, Linux and Windows 10+. The command assembly is a pure function so
//! it can be tested without a controller; only [`Ssh::run`] actually spawns anything.
//!
//! This is the transport, not the policy: it does not decide which password to try or when
//! to swap a cert. The caller (an `Op`, driven through approvals) does that, against a
//! controller the owner has OK'd.

use std::io::Write;
use std::process::{Command, Stdio};

/// Legacy `-o` options every connection to these controllers needs.
pub fn legacy_opts() -> &'static [&'static str] {
    &[
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=8",
        "-o", "KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1",
        "-o", "HostKeyAlgorithms=+ssh-rsa",
        "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    ]
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("{host}: `{cmd}` failed ({code}): {msg}")]
    Command { host: String, cmd: String, code: i32, msg: String },
    #[error(
        "password SSH needs a helper to pass the password non-interactively: `sshpass` on \
         macOS/Linux (brew install sshpass, apt install sshpass) or PuTTY's `plink` on \
         Windows (winget install PuTTY.PuTTY). Or use a key."
    )]
    NoHelper,
    #[error("could not run ssh: {0}")]
    Spawn(String),
}

/// How a connection authenticates. Passwords come from the caller's ladder (dealer-set,
/// MAC-derived, or factory); a key is used once the takeover has installed one.
#[derive(Clone, Debug)]
pub enum Auth {
    Password(String),
    /// Path to a private key file; `None` password means pure key/agent auth.
    Key(std::path::PathBuf),
    /// Whatever the user's ssh-agent / default key offers.
    Agent,
}

/// A controller we can run commands on.
#[derive(Clone, Debug)]
pub struct Ssh {
    pub host: String,
    pub user: String,
    pub auth: Auth,
}

/// The program and argument vector a connection would run (everything up to the remote
/// command). Pure, so tests can assert the legacy options and auth shape without spawning.
pub fn command_line(user: &str, host: &str, auth: &Auth) -> Result<(String, Vec<String>), SshError> {
    let target = format!("{user}@{host}");
    let opts = || legacy_opts().iter().map(|s| s.to_string());
    match auth {
        Auth::Password(pw) => {
            if cfg!(windows) {
                // plink's option spelling is nothing like OpenSSH's; -batch never prompts.
                if which("plink").is_none() {
                    return Err(SshError::NoHelper);
                }
                Ok((
                    "plink".into(),
                    vec![
                        "-ssh".into(), "-batch".into(), "-no-antispoof".into(),
                        "-pw".into(), pw.clone(), "-l".into(), user.into(), host.into(),
                    ],
                ))
            } else {
                if which("sshpass").is_none() {
                    return Err(SshError::NoHelper);
                }
                let mut args = vec!["-p".into(), pw.clone(), "ssh".into()];
                args.extend(opts());
                args.push(target);
                Ok(("sshpass".into(), args))
            }
        }
        Auth::Key(path) => {
            let mut args: Vec<String> = vec!["-i".into(), path.to_string_lossy().into_owned()];
            args.extend(opts());
            args.push(target);
            Ok(("ssh".into(), args))
        }
        Auth::Agent => {
            let mut args: Vec<String> = opts().collect();
            args.push(target);
            Ok(("ssh".into(), args))
        }
    }
}

/// Retries through the ~1-in-10 spurious login refusal these controllers exhibit.
const AUTH_TRIES: usize = 3;

impl Ssh {
    pub fn new(host: impl Into<String>, user: impl Into<String>, auth: Auth) -> Self {
        Ssh { host: host.into(), user: user.into(), auth }
    }

    fn base(&self) -> Result<Command, SshError> {
        let (prog, args) = command_line(&self.user, &self.host, &self.auth)?;
        let mut c = Command::new(prog);
        c.args(args);
        Ok(c)
    }

    /// Run a remote command, capturing stdout. With `check`, a non-zero exit is an error.
    pub fn run(&self, cmd: &str, check: bool) -> Result<String, SshError> {
        let mut last = None;
        for attempt in 0..AUTH_TRIES {
            let mut c = self.base()?;
            c.arg(cmd);
            c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let out = c.output().map_err(|e| SshError::Spawn(e.to_string()))?;
            if spurious_refusal(&out.status, &out.stderr) && attempt + 1 < AUTH_TRIES {
                std::thread::sleep(std::time::Duration::from_millis(700));
                continue;
            }
            last = Some(out);
            break;
        }
        let out = last.expect("loop always sets it");
        if check && !out.status.success() {
            let msg = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
            return Err(SshError::Command {
                host: self.host.clone(),
                cmd: cmd.to_string(),
                code: out.status.code().unwrap_or(-1),
                msg: msg.trim().chars().take(300).collect(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Reachable and authenticating?
    pub fn ok(&self) -> bool {
        self.run("echo oc-ok", false).map(|o| o.trim() == "oc-ok").unwrap_or(false)
    }

    pub fn read_file(&self, path: &str) -> Option<String> {
        let out = self.run(&format!("cat {path} 2>/dev/null"), false).ok()?;
        (!out.trim().is_empty()).then_some(out)
    }

    pub fn exists(&self, path: &str) -> bool {
        self.run(&format!("test -e {path} && echo oc-yes"), false)
            .map(|o| o.trim() == "oc-yes")
            .unwrap_or(false)
    }

    /// Pipe bytes into a remote command's stdin — how a chain file lands, without scp.
    pub fn put_stream(&self, data: &[u8], remote_cmd: &str) -> Result<String, SshError> {
        let mut last: Option<std::process::Output> = None;
        for attempt in 0..AUTH_TRIES {
            let mut c = self.base()?;
            c.arg(remote_cmd);
            c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = c.spawn().map_err(|e| SshError::Spawn(e.to_string()))?;
            let wrote = child.stdin.take().unwrap().write_all(data);
            let out = child.wait_with_output().map_err(|e| SshError::Spawn(e.to_string()))?;
            if spurious_refusal(&out.status, &out.stderr) && attempt + 1 < AUTH_TRIES {
                std::thread::sleep(std::time::Duration::from_millis(700));
                continue;
            }
            if let Err(e) = wrote {
                if out.status.success() {
                    // Consumed less than we sent but exited 0 — a truncated file, worse
                    // than a clean failure.
                    return Err(SshError::Spawn(format!("short write to `{remote_cmd}`: {e}")));
                }
            }
            last = Some(out);
            break;
        }
        let out = last.expect("loop always sets it");
        if !out.status.success() {
            return Err(SshError::Command {
                host: self.host.clone(),
                cmd: remote_cmd.to_string(),
                code: out.status.code().unwrap_or(-1),
                msg: String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// The factory root password, valid up to OS 3.0 and again after the OS-4.2 bootstrap
/// re-enables password SSH. On a 3.1–4.1 box the MAC-derived one is tried before it.
pub const FACTORY_PASSWORD: &str = "t0talc0ntr0l4!";

/// The ordered list of `(user, auth)` logins to try for a password takeover, best first:
/// a dealer-supplied password, then the MAC-derived default (only for a Control4 unit, and
/// only where that era uses it), then the factory password. All as `root`.
///
/// This is just the ordering; [`first_working`] is what actually tries them. On OS 4.2+
/// the caller runs the REST bootstrap first and then this ladder finds the factory login.
pub fn candidates(
    era: crate::dialect::TakeoverEra,
    dealer_password: Option<&str>,
    mac: Option<&str>,
) -> Vec<(String, Auth)> {
    use crate::dialect::TakeoverEra;
    let mut out: Vec<(String, Auth)> = Vec::new();
    if let Some(pw) = dealer_password.filter(|p| !p.trim().is_empty()) {
        out.push(("root".into(), Auth::Password(pw.to_string())));
    }
    // The MAC-derived default only exists from OS 3.1; don't bother on Legacy.
    if era != TakeoverEra::Legacy {
        if let Some(mac) = mac {
            if super::authderive::is_control4_mac(mac) {
                if let Some(pw) = super::authderive::derive_root_pw(mac) {
                    out.push(("root".into(), Auth::Password(pw)));
                }
            }
        }
    }
    out.push(("root".into(), Auth::Password(FACTORY_PASSWORD.into())));
    out
}

/// Try each login in order; return the first that answers. Blocking (SSH shells out).
pub fn first_working(host: &str, candidates: &[(String, Auth)]) -> Option<Ssh> {
    for (user, auth) in candidates {
        let ssh = Ssh::new(host, user.clone(), auth.clone());
        if ssh.ok() {
            return Some(ssh);
        }
    }
    None
}

/// Append `public_key` (one OpenSSH authorized_keys line) to root's `authorized_keys`,
/// creating `~/.ssh` with safe permissions if needed, and only if the key is not already
/// there — so a re-run does not stack duplicates. This is how a takeover earns durable key
/// access after the one-time password (or bootstrap) login, so later runs need no password.
pub fn install_authorized_key(ssh: &Ssh, public_key: &str) -> Result<(), SshError> {
    let key = public_key.trim();
    // grep -qF: fixed-string, quiet; appends only when absent. Single remote shell command.
    let script = format!(
        "mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh && \
         touch /home/root/.ssh/authorized_keys && chmod 600 /home/root/.ssh/authorized_keys && \
         grep -qF {key:?} /home/root/.ssh/authorized_keys || echo {key:?} >> /home/root/.ssh/authorized_keys"
    );
    ssh.run(&script, true).map(|_| ())
}

/// Turn password SSH back off and reload sshd — the reverse of the OS-4.2 bootstrap, for a
/// takeover revert. Only flips the `PasswordAuthentication yes` the bootstrap set, so a box
/// that already allowed passwords is unchanged.
pub fn disable_password_auth(ssh: &Ssh) -> Result<(), SshError> {
    ssh.run(
        "sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config; \
         pkill -HUP sshd",
        false,
    )
    .map(|_| ())
}

/// A login refusal (ssh's own exit 255 with an auth message), as opposed to a remote
/// command that genuinely failed — only the former is retried.
fn spurious_refusal(status: &std::process::ExitStatus, stderr: &[u8]) -> bool {
    if status.code() != Some(255) {
        return false;
    }
    let e = String::from_utf8_lossy(stderr);
    e.contains("Permission denied") || e.contains("Authentication failed")
}

/// Find a program on PATH (honouring PATHEXT on Windows, where a bare name is not a file).
fn which(prog: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.BAT;.CMD".into())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![]
    };
    std::env::split_paths(&path).find_map(|dir| {
        let direct = dir.join(prog);
        if direct.is_file() {
            return Some(direct);
        }
        exts.iter().find_map(|e| {
            let p = dir.join(format!("{prog}{e}"));
            p.is_file().then_some(p)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_auth_uses_ssh_with_legacy_opts() {
        let (prog, args) =
            command_line("root", "10.0.0.5", &Auth::Key("/k/id".into())).unwrap();
        assert_eq!(prog, "ssh");
        assert_eq!(args[0], "-i");
        assert_eq!(args[1], "/k/id");
        assert!(args.iter().any(|a| a == "HostKeyAlgorithms=+ssh-rsa"));
        assert_eq!(args.last().unwrap(), "root@10.0.0.5");
    }

    #[test]
    fn agent_auth_is_plain_ssh() {
        let (prog, args) = command_line("root", "h", &Auth::Agent).unwrap();
        assert_eq!(prog, "ssh");
        assert_eq!(args.last().unwrap(), "root@h");
        assert!(args.iter().any(|a| a == "KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1"));
    }

    #[test]
    fn candidate_ladder_order() {
        use crate::dialect::TakeoverEra;
        let mac = "00:0F:FF:1F:35:65";

        // Derived era, dealer pw + a Control4 MAC: dealer, then derived, then factory.
        let c = candidates(TakeoverEra::Derived, Some("dealerpw"), Some(mac));
        let pw = |a: &Auth| match a { Auth::Password(p) => p.clone(), _ => String::new() };
        assert_eq!(pw(&c[0].1), "dealerpw");
        assert_eq!(pw(&c[2].1), FACTORY_PASSWORD);
        assert_eq!(c.len(), 3);

        // Legacy era skips the MAC-derived password entirely.
        let c = candidates(TakeoverEra::Legacy, None, Some(mac));
        assert_eq!(c.len(), 1);
        assert_eq!(pw(&c[0].1), FACTORY_PASSWORD);

        // A non-Control4 MAC contributes no derived password.
        let c = candidates(TakeoverEra::Derived, None, Some("ac:de:48:00:11:22"));
        assert_eq!(c.len(), 1);
    }

    // Password auth needs sshpass/plink on PATH, which CI may lack, so assert only the
    // shape when the helper happens to be present — never fail for its absence.
    #[test]
    fn password_auth_shape_when_helper_present() {
        match command_line("root", "h", &Auth::Password("pw".into())) {
            Ok((prog, args)) => {
                if cfg!(windows) {
                    assert_eq!(prog, "plink");
                    assert!(args.iter().any(|a| a == "-pw"));
                } else {
                    assert_eq!(prog, "sshpass");
                    assert_eq!(args[0], "-p");
                    assert_eq!(args[2], "ssh");
                }
            }
            Err(SshError::NoHelper) => {} // helper not installed here; fine
            Err(e) => panic!("unexpected: {e}"),
        }
    }
}
