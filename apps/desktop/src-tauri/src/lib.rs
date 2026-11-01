// Sikrets for macOS: a menu-bar icon and one window over the bundled `sikrets` CLI (a sidecar).
//
// The window never touches the vault itself. Every screen runs an allowlisted CLI command with
// --json and renders what comes back; none of those commands print a secret value, and this file
// never logs a command's input or output. Values the person types (a login's password, a master
// password) go to the CLI on stdin, never as arguments.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, State, WebviewUrl, WindowEvent};

const MAIN: &str = "main";
const TRAY: &str = "tray";
const AGENT_LABEL: &str = "agent";
const AGENT_URL: &str = "https://dan27asb93qem.cloudfront.net";
const SETTINGS_FILE: &str = "settings.json";
const CLI_NAME: &str = "sikrets";
const CONFIG_FILE: &str = "sikrets.json";
/// Finder-launched apps get a bare PATH; the CLI shells out to swiftc, bw, op, aws and terraform.
const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// CLI subcommands the window may run. Each prints names, dates and statuses only, never values.
/// `env`, `run`, `mcp` and anything else that can hand out a value are not here.
const ALLOWED: &[&str] = &["inventory", "status", "agent", "logins", "approvals", "recovery", "import", "link", "unlock", "init", "activity"];
/// `recovery` is limited to status: setup and rotate show a code once, so they run in Terminal.
const RECOVERY_ALLOWED: &[&str] = &["status"];
/// What "Open in Terminal" may start.
const TERMINAL_ALLOWED: &[&[&str]] = &[&["recovery", "setup"], &["recovery", "setup", "--split"], &["recovery", "rotate"]];

#[derive(Default, Serialize, Deserialize, Clone)]
struct Settings {
    project: Option<String>,
}

struct AppState {
    settings: Mutex<Settings>,
    approvals_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

#[derive(Serialize)]
struct CliOut {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    cli_path: String,
    project: Option<String>,
    /// Whether the project folder has a sikrets.json yet.
    initialized: bool,
    version: String,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("No config folder for the app")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The sidecar sits next to the app's own executable, in dev and in the bundle.
fn cli_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.parent().ok_or("No executable folder")?.join(CLI_NAME);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("The sikrets CLI is missing at {}", path.display()))
    }
}

fn child_path() -> String {
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{p}:{EXTRA_PATH}"),
        _ => EXTRA_PATH.to_string(),
    }
}

fn check_args(args: &[String]) -> Result<(), String> {
    let sub = args.first().map(String::as_str).unwrap_or_default();
    if !ALLOWED.contains(&sub) {
        return Err(format!("The app doesn't run `sikrets {sub}`"));
    }
    if sub == "recovery" && !RECOVERY_ALLOWED.contains(&args.get(1).map(String::as_str).unwrap_or("status")) {
        return Err("Recovery setup runs in Terminal, so the code is shown only there".into());
    }
    Ok(())
}

fn project_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let project = state.settings.lock().map_err(|e| e.to_string())?.project.clone();
    let dir = PathBuf::from(project.ok_or("Choose a project folder first")?);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("{} is not a folder", dir.display()))
    }
}

fn run_cli(dir: &Path, args: &[String], stdin: Option<String>) -> Result<CliOut, String> {
    let mut child = Command::new(cli_path()?)
        .args(args)
        .current_dir(dir)
        .env("PATH", child_path())
        .env("NO_COLOR", "1")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start sikrets: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
        // Dropping the pipe closes stdin so the CLI stops reading.
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(CliOut {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs an allowlisted `sikrets` command in the chosen project folder.
#[tauri::command]
async fn cli(state: State<'_, AppState>, args: Vec<String>, stdin: Option<String>) -> Result<CliOut, String> {
    check_args(&args)?;
    let dir = project_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || run_cli(&dir, &args, stdin))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn info(state: State<'_, AppState>) -> Result<Info, String> {
    let project = state.settings.lock().map_err(|e| e.to_string())?.project.clone();
    Ok(Info {
        cli_path: cli_path().map(|p| p.display().to_string()).unwrap_or_default(),
        initialized: project.as_ref().is_some_and(|p| Path::new(p).join(CONFIG_FILE).is_file()),
        project,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
fn set_project(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.project = Some(path);
    save_settings(&app, &settings)
}

/// Single-quotes a word for a POSIX shell.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Opens Terminal on an allowlisted command, for steps that must show something only to a person.
#[tauri::command]
fn open_terminal(state: State<'_, AppState>, args: Vec<String>) -> Result<(), String> {
    let wanted: Vec<&str> = args.iter().map(String::as_str).collect();
    if !TERMINAL_ALLOWED.iter().any(|a| *a == wanted.as_slice()) {
        return Err("Not something the app opens in Terminal".into());
    }
    let dir = project_dir(&state)?;
    let line = format!(
        "cd {} && {} {}",
        sh_quote(&dir.display().to_string()),
        sh_quote(&cli_path()?.display().to_string()),
        args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ")
    );
    // The command goes in as argv, never spliced into the AppleScript.
    Command::new("osascript")
        .args(["-e", "on run argv", "-e", "tell application \"Terminal\"", "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", &line])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows the security agent's chat as a webview inside the main window, over the given area.
#[tauri::command]
fn agent_show(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let (pos, size) = (LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)));
    if let Some(view) = app.get_webview(AGENT_LABEL) {
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        return view.show().map_err(|e| e.to_string());
    }
    let window = app.get_window(MAIN).ok_or("No main window")?;
    let url = WebviewUrl::External(agent_url()?);
    window.add_child(WebviewBuilder::new(AGENT_LABEL, url), pos, size).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn agent_hide(app: AppHandle) -> Result<(), String> {
    match app.get_webview(AGENT_LABEL) {
        Some(view) => view.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn agent_reload(app: AppHandle) -> Result<(), String> {
    match app.get_webview(AGENT_LABEL) {
        Some(view) => view.navigate(agent_url()?).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Pending approvals: a count beside the menu-bar icon and in its menu.
#[tauri::command]
fn set_pending(app: AppHandle, state: State<'_, AppState>, count: u32) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY) {
        tray.set_title(if count > 0 { Some(count.to_string()) } else { None::<String> }).map_err(|e| e.to_string())?;
    }
    if let Some(item) = state.approvals_item.lock().map_err(|e| e.to_string())?.as_ref() {
        let text = if count > 0 { format!("Approvals ({count})") } else { "Approvals".to_string() };
        item.set_text(text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn agent_url() -> Result<tauri::Url, String> {
    tauri::Url::parse(AGENT_URL).map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle, route: Option<&str>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(r) = route {
        let _ = app.emit("navigate", r);
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState { settings: Mutex::new(load_settings(&handle)), approvals_item: Mutex::new(None) });

            let open = MenuItem::with_id(app, "open", "Open Sikrets", true, None::<&str>)?;
            let approvals = MenuItem::with_id(app, "approvals", "Approvals", true, None::<&str>)?;
            let keys = MenuItem::with_id(app, "keys", "Keys", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Sikrets", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &keys, &approvals, &PredefinedMenuItem::separator(app)?, &quit])?;
            *app.state::<AppState>().approvals_item.lock().unwrap() = Some(approvals);

            TrayIconBuilder::with_id(TRAY)
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Sikrets")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app, None),
                    "keys" => show_main(app, Some("keys")),
                    "approvals" => show_main(app, Some("approvals")),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } | TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle(), None);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Sikrets in the menu bar; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![cli, info, set_project, open_terminal, agent_show, agent_hide, agent_reload, set_pending])
        .build(tauri::generate_context!())
        .expect("error while building Sikrets");

    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            show_main(app, None);
        }
    });
}
