//! Run openComposer's MCP server without a window, for end-to-end tests.
//!
//!   OPENCOMPOSER_DATA=/tmp/oc C4_CERT=composer.pem C4_KEY=composer.key \
//!     cargo run -p opencomposer --example headless -- <writable-host> [<read-only-host>]
//!
//! Writes to the first host are approved automatically (point it at a Virtual
//! Director only); the second host is added read-only.

use std::time::Duration;

use opencomposer::config::{AccessMode, SavedDirector};
use opencomposer::{certs, config, mcp, state};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let hosts: Vec<String> = std::env::args().skip(1).collect();
    let app = state::App::new(config::Paths::resolve()?);
    let id = certs::from_pem_files(std::env::var("C4_CERT")?.as_ref(), std::env::var("C4_KEY")?.as_ref())?;
    app.use_identity(id);
    app.update_config(|c| {
        c.directors.clear();
        for (i, h) in hosts.iter().enumerate() {
            c.directors.push(SavedDirector {
                id: format!("d{i}"),
                name: if i == 0 { "Virtual".into() } else { "Real".into() },
                host: h.clone(),
                fingerprint: None,
                mode: if i == 0 { AccessMode::Approve } else { AccessMode::ReadOnly },
                // Only the virtual one; its web API is loopback-only, reached via an SSH tunnel.
                web_api: i == 0,
                web_api_addr: if i == 0 { std::env::var("VIRTUAL_WEB_API").ok() } else { None },
                web_api_fingerprint: None,
            });
        }
        c.active_director = Some("d0".into());
    })?;
    mcp::restart(app.clone()).await;
    let cfg = app.config();
    println!("MCP {} token {} webui-key {}", mcp::status().url, cfg.mcp.token, opencomposer::webui::key());

    // Auto-approver for the writable (virtual) Director only.
    let a2 = app.clone();
    tokio::spawn(async move {
        loop {
            for ap in a2.approvals.list() {
                if ap.status == opencomposer::approvals::Status::Pending && ap.director_id == "d0" {
                    println!("auto-approving: {:?}", ap.descriptions);
                    a2.approvals.decide(&ap.id, true, None);
                }
            }
            // Stand-in for the person clicking Allow on an MCP sign-in.
            for r in opencomposer::oauth::pending() {
                println!("auto-approving sign-in for {}", r.client_name);
                opencomposer::oauth::decide(&r.id, true);
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    });
    tokio::signal::ctrl_c().await?;
    Ok(())
}
