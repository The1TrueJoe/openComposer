//! openComposer: a desktop app (Tauri) over the `c4` Director client, with an MCP
//! server and an in-app agent. One process; the only children are the user's own
//! agent CLIs, bound to it (see `proc`).

pub mod actions;
pub mod agent;
pub mod approvals;
pub mod backups;
pub mod bridge;
pub mod certs;
pub mod commands;
pub mod config;
pub mod library;
pub mod mcp;
pub mod proc;
pub mod state;
pub mod views;

use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn run() {
    tracing_subscriber::fmt().with_env_filter(std::env::var("OPENCOMPOSER_LOG").unwrap_or_else(|_| "info".into())).init();
    let paths = config::Paths::resolve().expect("app data directory");
    let app = state::App::new(paths);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, _args, _cwd| {
            // A second launch just brings the existing window forward: one app owns the MCP port.
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app.clone())
        .setup(move |tauri_app| {
            let handle = tauri_app.handle().clone();
            app.set_emitter(Box::new(move |event, payload| {
                if event == "attention" {
                    let focused = handle.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
                    if !focused {
                        let title = payload["title"].as_str().unwrap_or("A change needs your approval").to_string();
                        let _ = handle.notification().builder().title("openComposer: approval needed").body(title).show();
                    }
                }
                let _ = handle.emit(event, payload);
            }));
            tauri::async_runtime::spawn(mcp::restart(app.clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::import_identity_pem,
            commands::import_identity_p12,
            commands::add_director,
            commands::update_director,
            commands::remove_director,
            commands::set_active_director,
            commands::forget_fingerprint,
            commands::connect_director,
            commands::disconnect_director,
            commands::discover_controllers,
            commands::action,
            commands::set_ui_context,
            commands::approvals,
            commands::decide_approval,
            commands::activity,
            commands::update_mcp,
            commands::update_agent,
            commands::agent_providers,
            commands::agent_list,
            commands::agent_new,
            commands::agent_send,
            commands::agent_stop,
            commands::agent_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building openComposer")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                let app = handle.state::<std::sync::Arc<state::App>>().inner().clone();
                tauri::async_runtime::block_on(app.agents.stop_all());
            }
        });
}
