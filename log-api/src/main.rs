// No console window on Windows: the app lives in the tray (see tray.rs).
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{net::SocketAddr, path::PathBuf, process::ExitCode, time::Duration};

use clap::{Parser, ValueEnum};
use tokio::sync::{broadcast, watch};
use tracing::{error, info, warn};

#[path = "app-settings.rs"]
mod app_settings;
#[path = "character-log.rs"]
mod character_log;
#[cfg(windows)]
mod edge;
#[cfg(windows)]
#[path = "guide-move.rs"]
mod guide_move;
#[cfg(windows)]
mod guide_window;
mod log_reader;
#[cfg(windows)]
mod overlay;
mod pob;
#[path = "pob-files.rs"]
mod pob_files;
#[path = "pob-routes.rs"]
mod pob_routes;
#[path = "saved-state.rs"]
mod saved_state;
mod web_data;
mod server;
#[cfg(windows)]
mod tray;
mod watcher;

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum Browser {
    /// Borderless Edge app window in the guide's own profile (remembers its place and data)
    App,
    /// Borderless Edge app window in your last-used Edge profile (as before 0.3)
    Edge,
    /// Your default browser, in a normal tab
    Default,
    /// Don't open anything
    None,
}

#[derive(Parser, Debug)]
#[command(version, about = "Lioneye: the Exile Leveling guide with auto-progress, served locally", long_about = None)]
struct Args {
    /// Address to serve the guide and the auto-progress socket on
    #[arg(long, default_value_t = { "127.0.0.1:6754".to_string() })]
    address: String,
    /// Path to the PoE client log. Found from the running game when left out
    #[arg(long)]
    log_path: Option<PathBuf>,
    /// Seconds between log reads
    #[arg(long, default_value_t = 1)]
    heart_beat: u64,
    /// How to open the guide. Left out: as set in Settings (else app)
    #[arg(long, value_enum)]
    browser: Option<Browser>,
}

impl Browser {
    fn name(self) -> &'static str {
        match self {
            Browser::App => "app",
            Browser::Edge => "edge",
            Browser::Default => "default",
            Browser::None => "none",
        }
    }

    fn from_name(name: &str) -> Browser {
        match name {
            "edge" => Browser::Edge,
            "default" => Browser::Default,
            "none" => Browser::None,
            _ => Browser::App,
        }
    }
}

/// The settings file for an address: one per port, like the saved data.
fn settings_file(url: &str) -> PathBuf {
    data_dir().join(match url.trim_end_matches('/').rsplit(':').next() {
        Some("6754") | None => "settings.json".to_string(),
        Some(port) => format!("settings-{port}.json"),
    })
}

fn load_settings(args: &Args, url: &str) -> app_settings::AppSettings {
    app_settings::AppSettings::load(
        settings_file(url),
        args.log_path.clone(),
        args.browser.map(|b| b.name().to_string()),
    )
}

fn main() -> ExitCode {
    // Sharp text in the in-game bar on scaled (high-DPI) monitors.
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
        };
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    // Started from a terminal: print there. Double-clicked: no console at all.
    let console = attach_parent_console();
    let (_log_guards, log) = init_logging(console);

    // With no console, a bad argument would vanish silently; show it in a box instead.
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(err) => {
            use clap::error::ErrorKind;
            if console || matches!(err.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
                err.exit();
            }
            return fail(console, &err.to_string());
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => return fail(console, &format!("Could not start: {err}")),
    };

    let (listener, url) = match runtime.block_on(listen(&args)) {
        Ok(Some(found)) => found,
        Ok(None) => return ExitCode::SUCCESS,
        Err(msg) => return fail(console, &msg),
    };

    // Only the copy that serves starts a fresh log; a second launch must not wipe it.
    if let Some(file) = log {
        let _ = file.set_len(0);
    }
    info!("Guide: {}", url);
    info!("Log: {}", log_file().display());

    let (lines_tx, _) = broadcast::channel::<String>(256);
    let (status_tx, status_rx) = watch::channel(watcher::Status::Waiting);
    // The in-game bar's place and settings from the last run.
    #[cfg(windows)]
    let saved_overlay = overlay::load();
    #[cfg(windows)]
    let overlay_config = saved_overlay.config.clone();
    #[cfg(not(windows))]
    let overlay_config = server::OverlayConfig::default();
    let (overlay_tx, overlay_rx) = watch::channel(overlay_config);
    // A bar button with no guide open asks the tray thread to open one.
    let (open_tx, open_rx) = std::sync::mpsc::channel::<()>();
    // The guide's saved data, kept by the exe for the guide's own browser profile; one per
    // address, so a test run on another port never touches the real guide's.
    let state_file = match url.trim_end_matches('/').rsplit(':').next() {
        Some("6754") | None => "state.json".to_string(),
        Some(port) => format!("state-{port}.json"),
    };
    let saved = std::sync::Arc::new(saved_state::SavedState::load(data_dir().join(state_file)));
    // Settings from the guide's Settings page (game log, browser); the command line wins.
    let settings = std::sync::Arc::new(load_settings(&args, &url));
    let browser_now = Browser::from_name(&settings.browser.borrow());
    let guides = std::sync::Arc::new(server::Guides::new(open_tx));
    let guides_open = guides.clone();
    // The guide pages' linked PoB build files; the latest is watched for saves in PoB.
    let pob_links = std::sync::Arc::new(pob_files::Links::new());
    let pob_file_rx = pob_links.watched.subscribe();
    let (pob_saved_tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let state = server::AppState {
        pob_links,
        pob_saved: pob_saved_tx.clone(),
        settings: settings.clone(),
        lines: lines_tx.clone(),
        status: status_rx.clone(),
        pob: pob::Engine::start(move || guides_open.any_open()),
        overlay: std::sync::Arc::new(overlay_tx),
        guides,
        tips: std::sync::Arc::new(watch::channel(server::Tips::new()).0),
        saved: saved.clone(),
    };
    // First run since the guide got its own profile: move its data from the old profiles.
    // A lock left by a copy stopped mid-move is stale: only one copy serves an address.
    #[cfg(windows)]
    guide_move::clear_lock(&url);
    #[cfg(windows)]
    let moving = (browser_now == Browser::App)
        .then(|| guide_move::GuideMove::needed(&url, saved.exists()))
        .flatten()
        .map(|profiles| guide_move::GuideMove::start(&url, profiles));
    #[cfg(windows)]
    let opening = moving.is_none();
    #[cfg(not(windows))]
    let opening = true;
    #[cfg(windows)]
    let bar = Bar {
        overlay: overlay::Overlay::new(&url, overlay_rx, &saved_overlay),
        open_requests: open_rx,
        moving,
        saved,
        placement: guide_window::PlacementKeeper::load(placement_file(&url)),
    };
    #[cfg(not(windows))]
    let _ = (overlay_rx, open_rx, saved);

    // A guide window left open from an earlier run reconnects by itself; bring it up instead.
    if opening && browser_now != Browser::None {
        show_guide(browser_now, &url);
    }

    // Server and watcher run on the runtime's threads; the main thread runs the tray.
    let heart_beat = Duration::from_secs(args.heart_beat.max(1));
    let log_path = settings.log_path.subscribe();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    runtime.spawn(pob_files::watch(pob_file_rx, pob_saved_tx));
    runtime.spawn(async move {
        let res = tokio::select! {
            res = server::serve(listener, state) => res,
            res = watcher::run(log_path, heart_beat, lines_tx, status_tx) => res,
        };
        let _ = done_tx.send(res.map_err(|err| err.to_string()));
    });

    #[cfg(windows)]
    let code = wait(&url, console, status_rx, done_rx, bar, settings);
    #[cfg(not(windows))]
    let code = wait(&url, console, status_rx, done_rx);
    runtime.shutdown_timeout(Duration::from_secs(1));
    code
}

/// The in-game bar and the guide-open requests from its buttons; both run on the tray thread.
#[cfg(windows)]
struct Bar {
    overlay: overlay::Overlay,
    open_requests: std::sync::mpsc::Receiver<()>,
    /// The one-time move of the guide's data from your Edge profiles, while it runs.
    moving: Option<guide_move::GuideMove>,
    saved: std::sync::Arc<saved_state::SavedState>,
    /// Where the guide window sits, so it reopens there.
    placement: guide_window::PlacementKeeper,
}

/// `%LOCALAPPDATA%\exile-leveling` (or the temp folder): the log, caches and saved settings.
fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("exile-leveling")
}

/// Where the guide window was last, one per address like the saved data.
#[cfg(windows)]
fn placement_file(url: &str) -> PathBuf {
    data_dir().join(match url.trim_end_matches('/').rsplit(':').next() {
        Some("6754") | None => "guide-window.json".to_string(),
        Some(port) => format!("guide-window-{port}.json"),
    })
}

/// Binds the address. `Ok(None)` means another copy is already running and was brought up instead.
async fn listen(args: &Args) -> Result<Option<(tokio::net::TcpListener, String)>, String> {
    let addr: SocketAddr = args
        .address
        .parse()
        .map_err(|err| format!("Bad --address {}: {}", args.address, err))?;
    // 0.0.0.0 / [::] listen everywhere but can't be opened or connected to; use loopback for those.
    let local = if addr.ip().is_unspecified() {
        let ip: std::net::IpAddr = if addr.is_ipv4() {
            std::net::Ipv4Addr::LOCALHOST.into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        };
        SocketAddr::new(ip, addr.port())
    } else {
        addr
    };
    let url = format!("http://{}/", local);

    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => Ok(Some((listener, url))),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            if already_running(local).await {
                info!("Already running on {}, opening it", url);
                let browser = Browser::from_name(&load_settings(args, &url).browser.borrow());
                show_guide(browser, &url);
                return Ok(None);
            }
            Err(format!(
                "Another program is using {}. Close it (an old exile-log-api, for example) or pass --address with another port.",
                addr
            ))
        }
        Err(err) => Err(format!(
            "Could not listen on {}: {}. Try --address with another port.",
            addr, err
        )),
    }
}

/// Runs until Quit in the tray, or until the server or watcher stops.
#[cfg(windows)]
fn wait(
    url: &str,
    console: bool,
    status: watch::Receiver<watcher::Status>,
    done: std::sync::mpsc::Receiver<Result<(), String>>,
    mut bar: Bar,
    settings: std::sync::Arc<app_settings::AppSettings>,
) -> ExitCode {
    // As set now (Settings can change it). Open from the tray always shows a window, even
    // with --browser none.
    let browser = move || match Browser::from_name(&settings.browser.borrow()) {
        Browser::None => Browser::App,
        browser => browser,
    };
    let (stopped_tx, stopped_rx) = std::sync::mpsc::channel::<()>();
    let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    // Forward the server result so the tray loop wakes up when it stops.
    std::thread::spawn(move || {
        let res = done.recv().unwrap_or(Ok(()));
        let _ = result_tx.send(res);
        let _ = stopped_tx.send(());
    });

    info!("Running in the tray. Quit from its menu.");
    // Clicks before the new guide connects would each open another window: one is enough.
    let mut last_open: Option<std::time::Instant> = None;
    let tick = || {
        // While the guide's data is moving, its windows come and go: no other opening.
        if let Some(moving) = &mut bar.moving {
            if moving.tick(&bar.saved) {
                bar.moving = None;
                open_browser(browser(), url);
            }
            while bar.open_requests.try_recv().is_ok() {}
            bar.overlay.tick();
            return;
        }
        if bar.open_requests.try_recv().is_ok()
            && last_open.is_none_or(|t| t.elapsed() >= Duration::from_secs(5))
        {
            last_open = Some(std::time::Instant::now());
            show_guide(browser(), url);
        }
        while bar.open_requests.try_recv().is_ok() {}
        bar.overlay.tick();
        bar.placement.tick();
    };
    match tray::run(status, stopped_rx, || show_guide(browser(), url), tick) {
        Ok(tray::Exit::Quit) => {
            // The guide is a separate Edge window; Quit closes it too (and drops the lock of
            // a move it stopped, which then runs again next start).
            guide_window::close_all();
            guide_move::clear_lock(url);
            ExitCode::SUCCESS
        }
        Ok(tray::Exit::Stopped) => match result_rx.try_recv() {
            Ok(Err(msg)) => fail(console, &msg),
            _ => ExitCode::SUCCESS,
        },
        Err(err) => {
            // No tray (rare): keep serving until the server stops, as before.
            warn!("Tray icon unavailable ({err}). End lioneye.exe in Task Manager to stop.");
            match result_rx.recv() {
                Ok(Err(msg)) => fail(console, &msg),
                _ => ExitCode::SUCCESS,
            }
        }
    }
}

#[cfg(not(windows))]
fn wait(
    _url: &str,
    console: bool,
    _status: watch::Receiver<watcher::Status>,
    done: std::sync::mpsc::Receiver<Result<(), String>>,
) -> ExitCode {
    info!("Press Ctrl+C to stop.");
    match done.recv() {
        Ok(Err(msg)) => fail(console, &msg),
        _ => ExitCode::SUCCESS,
    }
}

/// Logs the error and, with no console to show it, puts it in a message box.
fn fail(console: bool, msg: &str) -> ExitCode {
    error!("{}", msg);
    if !console {
        show_error(msg);
    }
    ExitCode::FAILURE
}

/// `%LOCALAPPDATA%\exile-leveling\exile-leveling.log` (or the temp folder), cleared when a copy starts serving.
fn log_file() -> PathBuf {
    data_dir().join("exile-leveling.log")
}

/// Returns the writer guards (flush on drop) and a handle for clearing the log once this copy serves.
/// The file is opened for append, so clearing it later makes new lines start at the top.
fn init_logging(
    console: bool,
) -> (Vec<tracing_appender::non_blocking::WorkerGuard>, Option<std::fs::File>) {
    use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};

    let mut guards = Vec::new();
    let file = {
        let path = log_file();
        path.parent()
            .and_then(|dir| std::fs::create_dir_all(dir).ok())
            .and_then(|_| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .ok()
            })
    };
    let clear = file.as_ref().and_then(|file| file.try_clone().ok());
    let file_writer = file.map(|file| {
        let (writer, guard) = tracing_appender::non_blocking(file);
        guards.push(guard);
        writer
    });
    let out_writer = console.then(|| {
        let (writer, guard) = tracing_appender::non_blocking(std::io::stdout());
        guards.push(guard);
        writer
    });

    let writer = match (file_writer, out_writer) {
        (Some(file), Some(out)) => BoxMakeWriter::new(file.and(out)),
        (Some(file), None) => BoxMakeWriter::new(file),
        (None, Some(out)) => BoxMakeWriter::new(out),
        (None, None) => BoxMakeWriter::new(std::io::sink),
    };
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(writer)
        .init();
    (guards, clear)
}

/// Attaches to the terminal that started us, if any. Ctrl+C or closing that terminal
/// then quits through the tray loop, so the icon is removed and the log flushed.
#[cfg(windows)]
fn attach_parent_console() -> bool {
    use windows_sys::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, SetConsoleCtrlHandler,
    };
    unsafe extern "system" fn on_ctrl(_event: u32) -> windows_sys::core::BOOL {
        tray::request_quit();
        // Give the tray loop time to remove the icon before Windows ends the process.
        std::thread::sleep(Duration::from_millis(500));
        1
    }
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return false;
        }
        SetConsoleCtrlHandler(Some(on_ctrl), 1);
    }
    true
}

#[cfg(not(windows))]
fn attach_parent_console() -> bool {
    true
}

#[cfg(windows)]
fn show_error(msg: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(msg);
    let title = wide("Lioneye");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(windows))]
fn show_error(_msg: &str) {}

/// True when the program on `addr` is another copy of this exe.
async fn already_running(addr: SocketAddr) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let check = async {
        let mut stream = tokio::net::TcpStream::connect(addr).await.ok()?;
        let request = format!(
            "GET {} HTTP/1.0\r\nHost: {}\r\n\r\n",
            server::WHOAMI_PATH,
            addr
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.ok()?;
        Some(String::from_utf8_lossy(&response).ends_with(server::WHOAMI))
    };
    matches!(
        tokio::time::timeout(Duration::from_secs(2), check).await,
        Ok(Some(true))
    )
}

/// Brings back the open guide window (restoring it if minimized), or opens one.
fn show_guide(browser: Browser, url: &str) {
    #[cfg(windows)]
    {
        // The guide's data is moving (this or another copy of the exe): its windows come
        // and go, and the own window opens when it's done.
        if guide_move::in_progress(url) {
            info!("The guide's data is moving; it opens when that's done");
            return;
        }
        if guide_window::show() {
            return;
        }
    }
    open_browser(browser, url);
}

fn open_browser(browser: Browser, url: &str) {
    let result = match browser {
        Browser::None => return,
        #[cfg(windows)]
        Browser::App => edge::open_own(
            url,
            guide_window::PlacementKeeper::load(placement_file(url)).last(),
        ),
        #[cfg(windows)]
        Browser::Edge => edge::open_last_profile(&format!("{url}?own=edge")),
        #[cfg(not(windows))]
        Browser::App | Browser::Edge => spawn_default(&format!("{url}?own=default")),
        Browser::Default => spawn_default(&format!("{url}?own=default")),
    };
    if let Err(err) = result {
        warn!("Could not open the guide ({}). Open {} yourself.", err, url);
    }
}

#[cfg(windows)]
fn spawn_default(url: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}


#[cfg(not(windows))]
fn spawn_default(url: &str) -> std::io::Result<()> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map(|_| ())
}
