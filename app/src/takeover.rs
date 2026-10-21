//! Taking over a controller the owner owns: install openComposer's CA so its client
//! certificate is trusted, driving the `c4::takeover` engine and this app's storage.
//!
//! The engine (SSH, the REST bootstrap, the CA, the cert-chain swap) lives in `c4`; this
//! module owns the *app* side: where the CA is kept (sealed, under the data dir, like the
//! client identity), adopting an existing "Gary tool" CA so issued certs chain to what a
//! controller already trusts, and the orchestration that an explicit, confirmed user
//! action calls.
//!
//! What this module is **not**: it is not exposed to the in-app agent or MCP, and nothing
//! here runs on its own. [`run`] writes to a controller and reboots it, so it happens only
//! when the owner triggers it for a controller they have OK'd — never against the
//! read-only EA-1 unless the owner says so, and never automatically. The owner's Control4
//! account password (OS 4.2+ only) is used for the one sign-in request and never stored.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use c4::dialect::{Dialect, TakeoverEra, Version};
use c4::takeover::{bootstrap::Bootstrap, ca::Ca, ssh, swap};
use serde::{Deserialize, Serialize};

use crate::state::{App, AppError, AppResult};

/// The common name openComposer issues its own client certificate under. Must start with
/// `Composer_` for a controller to accept it as a Composer client.
const COMPOSER_CN: &str = "Composer_openComposer";

/// The CA sealed at rest: its certificate (public, appended to controllers) and private
/// key (signs client certs — as sensitive as the client identity, so sealed the same way).
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredCa {
    pub cert_pem: String,
    pub key_pem: String,
    /// Where it came from, for the UI ("generated" or a Gary folder path).
    pub label: String,
}

fn ca_path(app: &App) -> PathBuf {
    app.paths.data.join("ca.bin")
}

fn local_backups(app: &App) -> PathBuf {
    app.paths.data.join("ca-backups")
}

/// The stored CA, if openComposer has one yet.
pub fn stored_ca(app: &App) -> anyhow::Result<Option<StoredCa>> {
    match crate::certs::unseal(&ca_path(app))? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

fn save_ca(app: &App, ca: &StoredCa) -> anyhow::Result<()> {
    crate::certs::seal(&ca_path(app), &serde_json::to_vec(ca)?)
}

/// Load the stored CA, or generate a fresh one and store it. The fresh CA's cert is what a
/// first-time takeover appends to a controller's trust chains.
pub fn load_or_generate_ca(app: &App) -> AppResult<Ca> {
    if let Some(s) = stored_ca(app).map_err(AppError::from)? {
        return Ca::adopt(&s.cert_pem, &s.key_pem).map_err(|e| AppError::Other(e.to_string()));
    }
    let ca = Ca::generate("openComposer CA").map_err(|e| AppError::Other(e.to_string()))?;
    save_ca(
        app,
        &StoredCa {
            cert_pem: ca.cert_pem().to_string(),
            key_pem: ca.key_pem().to_string(),
            label: "generated".into(),
        },
    )
    .map_err(AppError::from)?;
    Ok(ca)
}

/// The MQTT signing keypair, sealed like the CA. Generated once and reused so the
/// certificate in the controller's `api.pem` keeps matching the key we sign tokens with.
#[derive(Clone, Serialize, Deserialize)]
struct StoredSigning {
    cert_pem: String,
    key_pem: String,
}

fn signing_path(app: &App) -> PathBuf {
    app.paths.data.join("mqtt.bin")
}

fn load_or_generate_signing(app: &App) -> AppResult<c4::takeover::mqtt::Signing> {
    use c4::takeover::mqtt::Signing;
    if let Some(bytes) = crate::certs::unseal(&signing_path(app)).map_err(AppError::from)? {
        let s: StoredSigning = serde_json::from_slice(&bytes).map_err(|e| AppError::Other(e.to_string()))?;
        return Ok(Signing { cert_pem: s.cert_pem, key_pem: s.key_pem });
    }
    let s = c4::takeover::mqtt::generate().map_err(|e| AppError::Other(e.to_string()))?;
    crate::certs::seal(
        &signing_path(app),
        &serde_json::to_vec(&StoredSigning { cert_pem: s.cert_pem.clone(), key_pem: s.key_pem.clone() })
            .map_err(|e| AppError::Other(e.to_string()))?,
    )
    .map_err(AppError::from)?;
    Ok(s)
}

/// Adopt an existing CA from a "Gary tool" `Certs` folder (its `public.pem` + `private.key`)
/// so certs openComposer issues chain to a CA controllers already trust — no re-patching of
/// an already-jailbroken controller. Returns the adopted CA's common name.
pub fn adopt_gary_ca(app: &App, folder: &Path) -> AppResult<String> {
    let cert = folder.join("public.pem");
    let key = folder.join("private.key");
    let cert_pem = std::fs::read_to_string(&cert)
        .map_err(|e| AppError::Other(format!("can't read {}: {e}", cert.display())))?;
    let key_pem = std::fs::read_to_string(&key)
        .map_err(|e| AppError::Other(format!("can't read {}: {e}", key.display())))?;
    let ca = Ca::adopt(&cert_pem, &key_pem).map_err(|e| AppError::Other(e.to_string()))?;
    let cn = ca.common_name().to_string();
    save_ca(
        app,
        &StoredCa { cert_pem, key_pem, label: format!("adopted from {}", folder.display()) },
    )
    .map_err(AppError::from)?;
    Ok(cn)
}

/// What a takeover run needs. The caller (a confirmed UI action) fills this.
#[derive(Clone, Debug, Deserialize)]
pub struct Params {
    /// The controller's IP or hostname.
    pub host: String,
    /// Its OS version string (from discovery), which selects the era.
    pub os_version: String,
    /// The owner's Control4 account, required on OS 4.2+ for the root bootstrap.
    pub account_email: Option<String>,
    pub account_password: Option<String>,
    /// A dealer-set root password, if the owner knows one (older firmware).
    pub dealer_password: Option<String>,
    /// The controller's MAC, for the derived-password path (older firmware).
    pub mac: Option<String>,
    /// Reboot the controller if a chain changed (required for the swap to take effect).
    pub reboot: bool,
    /// Also set up the OS-4.2 MQTT bus (patch `api.pem`, restart the plugin). Off unless
    /// asked — it touches the broker; the cert swap alone is enough for c4soap.
    #[serde(default)]
    pub mqtt: bool,
}

/// What a takeover run did.
#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub era: String,
    pub patched: Vec<String>,
    pub already_patched: Vec<String>,
    pub missing: Vec<String>,
    pub rebooted: bool,
    pub issued_cn: String,
    pub ca_label: String,
    /// Whether the MQTT `api.pem` was patched (OS 4.2+ with `mqtt` requested).
    pub mqtt_patched: bool,
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%d-%m--%H-%M-%S").to_string()
}

/// Run the takeover: gain root (bootstrap on OS 4.2+, else a password login), append the CA
/// to every client-CA chain present, reboot if anything changed, then issue and import an
/// openComposer client certificate signed by that CA.
///
/// This writes to the controller and reboots it; the caller must have the owner's explicit
/// go-ahead before calling.
pub async fn run(app: &Arc<App>, p: Params) -> AppResult<Report> {
    let version = Version::parse(&p.os_version)
        .ok_or_else(|| AppError::Other(format!("could not read an OS version from {:?}", p.os_version)))?;
    let dialect = Dialect::for_version(version);
    let era = dialect.takeover_era();
    let chains: Vec<&'static str> = dialect.client_ca_chains().to_vec();

    let ca = load_or_generate_ca(app)?;
    let ca_label = stored_ca(app).ok().flatten().map(|s| s.label).unwrap_or_default();
    let ca_cert = ca.cert_pem().to_string();

    // 1. On OS 4.2+, the owner's account re-enables password SSH via a driver Lua command.
    if era == TakeoverEra::Modern {
        let (email, pw) = match (&p.account_email, &p.account_password) {
            (Some(e), Some(pw)) if !e.is_empty() && !pw.is_empty() => (e.clone(), pw.clone()),
            _ => {
                return Err(AppError::Other(
                    "this controller (OS 4.2+) needs your Control4 account email and password to \
                     re-enable SSH for the takeover"
                        .into(),
                ));
            }
        };
        let boot = Bootstrap::sign_in(&p.host, &email, &pw, None)
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        boot.enable_password_ssh().await.map_err(|e| AppError::Other(e.to_string()))?;
        // `pw` drops here — never stored.
    }

    // 2. Log in as root (blocking SSH off the async runtime).
    let host = p.host.clone();
    let dealer = p.dealer_password.clone();
    let mac = p.mac.clone();
    let session = tokio::task::spawn_blocking(move || {
        // A box just told to re-enable sshd may need a moment; the ladder itself retries.
        let candidates = ssh::candidates(era, dealer.as_deref(), mac.as_deref());
        ssh::first_working(&host, &candidates)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .ok_or_else(|| {
        AppError::Other(format!(
            "could not log in as root on {} — no password worked (and SSH may still be disabled)",
            p.host
        ))
    })?;

    // 3. Read, plan, and apply the chain swap (all blocking SSH).
    let stamp = stamp();
    let (applied, plan_paths) = {
        let session = session.clone();
        let ca_cert = ca_cert.clone();
        let chains = chains.clone();
        let stamp = stamp.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let read = swap::read_chains(&session, &chains);
            let plan = swap::plan(&read, &ca_cert, &stamp);
            let applied = swap::apply(&session, &plan).map_err(|e| e.to_string())?;
            let paths: Vec<String> = plan.iter().map(|c| c.path.clone()).collect();
            Ok((applied, paths))
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)?
    };
    let _ = plan_paths;

    // Keep the original chains locally too, so a revert never depends on the controller.
    if !applied.patched.is_empty() {
        let dir = local_backups(app);
        let _ = std::fs::create_dir_all(&dir);
        for (path, original) in &applied.patched {
            let safe = path.trim_start_matches('/').replace('/', "_");
            let _ = std::fs::write(dir.join(format!("{safe}.{stamp}.backup")), original);
        }
    }

    // 4. The MQTT bus (OS 4.2+, opt-in): append our signing cert to api.pem and restart the
    // broker plugin so it accepts tokens we sign. No reboot — the plugin respawns itself.
    let mut mqtt_patched = false;
    if era == TakeoverEra::Modern && p.mqtt {
        let signing = load_or_generate_signing(app)?;
        let session = session.clone();
        let stamp = stamp.clone();
        mqtt_patched = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let api = c4::takeover::paths::API_PEM;
            let Some(current) = session.read_file(api) else { return Ok(false) };
            let patch = signing.patch_api_pem(&current);
            if !patch.changed {
                return Ok(false);
            }
            let backup = swap::backup_path(api, &stamp);
            session.run(&format!("cp -p {api} {backup}"), true).map_err(|e| e.to_string())?;
            session.put_stream(patch.chain.as_bytes(), &format!("cat > {api}")).map_err(|e| e.to_string())?;
            session.run(&c4::takeover::mqtt::restart_plugin_cmd(), false).map_err(|e| e.to_string())?;
            Ok(true)
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)?;
    }

    // 5. Reboot if a chain changed and the caller asked (so the new trust takes effect).
    let mut rebooted = false;
    if applied.reboot_needed() && p.reboot {
        let session = session.clone();
        tokio::task::spawn_blocking(move || swap::reboot(&session))
            .await
            .map_err(|e| AppError::Other(e.to_string()))?
            .map_err(|e| AppError::Other(e.to_string()))?;
        rebooted = true;
    }

    // 6. Issue our client cert under the CA and import it as the identity to connect with.
    let issued = ca.issue_composer(COMPOSER_CN).map_err(|e| AppError::Other(e.to_string()))?;
    let id = crate::certs::StoredIdentity {
        cert_pem: issued.cert_pem,
        key_pem: issued.key_pem,
        label: format!("issued by {}", ca.common_name()),
    };
    app.set_identity(id).map_err(AppError::from)?;

    Ok(Report {
        era: format!("{era:?}"),
        patched: applied.patched.into_iter().map(|(p, _)| p).collect(),
        already_patched: applied.already,
        missing: applied.missing,
        rebooted,
        issued_cn: COMPOSER_CN.into(),
        ca_label,
        mqtt_patched,
    })
}

/// What a revert needs: the same way back in as the takeover, for the same controller.
#[derive(Clone, Debug, Deserialize)]
pub struct RevertParams {
    pub host: String,
    pub os_version: String,
    pub account_email: Option<String>,
    pub account_password: Option<String>,
    pub dealer_password: Option<String>,
    pub mac: Option<String>,
    pub reboot: bool,
}

/// Undo a takeover: take our CA back out of every trust chain, strip our MQTT signing cert
/// from `api.pem`, turn password SSH back off (OS 4.2+), and reboot if a chain changed. The
/// imported client identity is left in place for the owner to remove in Settings.
pub async fn revert(app: &Arc<App>, p: RevertParams) -> AppResult<Report> {
    let version = Version::parse(&p.os_version)
        .ok_or_else(|| AppError::Other(format!("could not read an OS version from {:?}", p.os_version)))?;
    let dialect = Dialect::for_version(version);
    let era = dialect.takeover_era();
    let chains: Vec<&'static str> = dialect.client_ca_chains().to_vec();

    let ca = load_or_generate_ca(app)?;
    let ca_cert = ca.cert_pem().to_string();
    let ca_label = stored_ca(app).ok().flatten().map(|s| s.label).unwrap_or_default();

    // Getting root for a revert mirrors the takeover (bootstrap re-enables SSH on OS 4.2+).
    if era == TakeoverEra::Modern {
        let (email, pw) = match (&p.account_email, &p.account_password) {
            (Some(e), Some(pw)) if !e.is_empty() && !pw.is_empty() => (e.clone(), pw.clone()),
            _ => return Err(AppError::Other(
                "this controller (OS 4.2+) needs your Control4 account email and password to re-enable SSH for the revert".into(),
            )),
        };
        let boot = Bootstrap::sign_in(&p.host, &email, &pw, None).await.map_err(|e| AppError::Other(e.to_string()))?;
        boot.enable_password_ssh().await.map_err(|e| AppError::Other(e.to_string()))?;
    }

    let host = p.host.clone();
    let dealer = p.dealer_password.clone();
    let mac = p.mac.clone();
    let session = tokio::task::spawn_blocking(move || {
        let candidates = ssh::candidates(era, dealer.as_deref(), mac.as_deref());
        ssh::first_working(&host, &candidates)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .ok_or_else(|| AppError::Other(format!("could not log in as root on {} to revert", p.host)))?;

    let stamp = stamp();
    let applied = {
        let session = session.clone();
        let ca_cert = ca_cert.clone();
        let chains = chains.clone();
        let stamp = stamp.clone();
        let signing = load_or_generate_signing(app).ok();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            // Take the CA back out of the trust chains.
            let read = swap::read_chains(&session, &chains);
            let plan = swap::plan_revert(&read, &ca_cert, &stamp);
            let applied = swap::apply(&session, &plan).map_err(|e| e.to_string())?;
            // Strip our MQTT signing cert from api.pem and restart the plugin.
            if let Some(signing) = signing {
                let api = c4::takeover::paths::API_PEM;
                if let Some(current) = session.read_file(api) {
                    let kept: Vec<String> = c4::takeover::certchain::cert_blocks(&current)
                        .into_iter()
                        .filter(|b| !c4::takeover::certchain::is_stale_ca(b, c4::takeover::mqtt::SIGNING_CN))
                        .collect();
                    let mut rebuilt = kept.join("\n");
                    if !rebuilt.is_empty() {
                        rebuilt.push('\n');
                    }
                    let _ = &signing; // keypair stays stored; only the remote cert is removed
                    if rebuilt.trim() != current.trim() {
                        session.put_stream(rebuilt.as_bytes(), &format!("cat > {api}")).map_err(|e| e.to_string())?;
                        session.run(&c4::takeover::mqtt::restart_plugin_cmd(), false).map_err(|e| e.to_string())?;
                    }
                }
            }
            // OS 4.2+: turn password SSH back off.
            if era == TakeoverEra::Modern {
                ssh::disable_password_auth(&session).map_err(|e| e.to_string())?;
            }
            Ok(applied)
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)?
    };

    let mut rebooted = false;
    if applied.reboot_needed() && p.reboot {
        let session = session.clone();
        tokio::task::spawn_blocking(move || swap::reboot(&session))
            .await
            .map_err(|e| AppError::Other(e.to_string()))?
            .map_err(|e| AppError::Other(e.to_string()))?;
        rebooted = true;
    }

    Ok(Report {
        era: format!("{era:?}"),
        patched: applied.patched.into_iter().map(|(p, _)| p).collect(),
        already_patched: applied.already,
        missing: applied.missing,
        rebooted,
        issued_cn: String::new(),
        ca_label,
        mqtt_patched: false,
    })
}
