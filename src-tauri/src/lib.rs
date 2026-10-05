mod credentials;
mod http;
mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct ExitState {
    allowed: AtomicBool,
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle, state: tauri::State<'_, ExitState>) {
    state.allowed.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn create_app_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new-note", "New Note…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open Markdown…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save", "Save Markdown…")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-left-sidebar", "Show / Hide Notes")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-right-sidebar", "Show / Hide Context")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .build()?;
    let preferences = MenuItemBuilder::with_id("preferences", "Preferences…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    #[cfg(target_os = "macos")]
    let menu = {
        let application = SubmenuBuilder::new(app, "TypeNext")
            .item(&preferences)
            .separator()
            .item(&PredefinedMenuItem::hide(app, Some("Hide TypeNext"))?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, Some("Quit TypeNext"))?)
            .build()?;
        MenuBuilder::new(app)
            .item(&application)
            .item(&file)
            .item(&edit)
            .item(&view)
            .build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let application = SubmenuBuilder::new(app, "TypeNext")
            .item(&preferences)
            .separator()
            .item(&PredefinedMenuItem::quit(app, Some("Quit TypeNext"))?)
            .build()?;
        MenuBuilder::new(app)
            .item(&file)
            .item(&edit)
            .item(&view)
            .item(&application)
            .build()?
    };
    app.set_menu(menu)?;
    // macOS keeps its OS menu bar; other platforms use the compact title bar.
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        window.hide_menu()?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn)
                .build(),
        )
        .manage(workspace::WorkspaceState::default())
        .manage(credentials::CredentialState::default())
        .manage(ExitState::default())
        .setup(|app| {
            app.manage(http::HttpState::new()?);
            create_app_menu(app)?;
            app.on_menu_event(|app, event| {
                let name = match event.id().as_ref() {
                    "new-note" => "menu-new-note",
                    "open" => "menu-open",
                    "save" => "menu-save",
                    "preferences" => "menu-preferences",
                    "toggle-left-sidebar" => "menu-toggle-left-sidebar",
                    "toggle-right-sidebar" => "menu-toggle-right-sidebar",
                    _ => return,
                };
                if let Err(error) = app.emit(name, ()) {
                    log::warn!("Could not dispatch menu action: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::load_workspace,
            workspace::persist_workspace,
            workspace::write_markdown_file,
            workspace::open_workspace_folder,
            credentials::get_secret,
            credentials::set_secret,
            http::http_request,
            http::cancel_http_request,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("Could not start TypeNext")
        .run(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if !app.state::<ExitState>().allowed.load(Ordering::SeqCst) => {
                api.prevent_close();
                let _ = app.emit("native-close-requested", ());
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if !app.state::<ExitState>().allowed.load(Ordering::SeqCst) =>
            {
                api.prevent_exit();
                let _ = app.emit("native-close-requested", ());
            }
            _ => {}
        });
}
