// No console window on Windows: the app lives in the tray (see tray.rs).
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{net::SocketAddr, path::PathBuf, process::ExitCode, time::Duration};

use clap::{Parser, ValueEnum};
use tokio::sync::{broadcast, watch};
use tracing::{error, info, warn};

#[cfg(windows)]
mod guide_window;
mod log_reader;
mod pob;
mod server;
#[cfg(windows)]
mod tray;
mod watcher;

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum Browser {
    /// Borderless Microsoft Edge app window (remembers its size and position)
    Edge,
    /// Your default browser, in a normal tab
    Default,
    /// Don't open anything
    None,
}

#[derive(Parser, Debug)]
#[command(version, about = "Exile Leveling with auto-progress, served locally", long_about = None)]
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
    /// How to open the guide on start
    #[arg(long, value_enum, default_value_t = Browser::Edge)]
    browser: Browser,
}

fn main() -> ExitCode {
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
    let state = server::AppState {
        lines: lines_tx.clone(),
        status: status_rx.clone(),
        pob: pob::Engine::start(),
    };

    // A guide window left open from an earlier run reconnects by itself; bring it up instead.
    if args.browser != Browser::None {
        show_guide(args.browser, &url);
    }

    // Server and watcher run on the runtime's threads; the main thread runs the tray.
    let heart_beat = Duration::from_secs(args.heart_beat.max(1));
    let log_path = args.log_path.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    runtime.spawn(async move {
        let res = tokio::select! {
            res = server::serve(listener, state) => res,
            res = watcher::run(log_path, heart_beat, lines_tx, status_tx) => res,
        };
        let _ = done_tx.send(res.map_err(|err| err.to_string()));
    });

    let code = wait(&args, &url, console, status_rx, done_rx);
    runtime.shutdown_timeout(Duration::from_secs(1));
    code
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
                show_guide(args.browser, &url);
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
    args: &Args,
    url: &str,
    console: bool,
    status: watch::Receiver<watcher::Status>,
    done: std::sync::mpsc::Receiver<Result<(), String>>,
) -> ExitCode {
    // Open from the tray always shows a window, even with --browser none.
    let browser = if args.browser == Browser::None { Browser::Edge } else { args.browser };
    let (stopped_tx, stopped_rx) = std::sync::mpsc::channel::<()>();
    let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    // Forward the server result so the tray loop wakes up when it stops.
    std::thread::spawn(move || {
        let res = done.recv().unwrap_or(Ok(()));
        let _ = result_tx.send(res);
        let _ = stopped_tx.send(());
    });

    info!("Running in the tray. Quit from its menu.");
    match tray::run(status, stopped_rx, || show_guide(browser, url)) {
        Ok(tray::Exit::Quit) => {
            // The guide is a separate Edge window; Quit closes it too.
            guide_window::close_all();
            ExitCode::SUCCESS
        }
        Ok(tray::Exit::Stopped) => match result_rx.try_recv() {
            Ok(Err(msg)) => fail(console, &msg),
            _ => ExitCode::SUCCESS,
        },
        Err(err) => {
            // No tray (rare): keep serving until the server stops, as before.
            warn!("Tray icon unavailable ({err}). End exile-leveling.exe in Task Manager to stop.");
            match result_rx.recv() {
                Ok(Err(msg)) => fail(console, &msg),
                _ => ExitCode::SUCCESS,
            }
        }
    }
}

#[cfg(not(windows))]
fn wait(
    _args: &Args,
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
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("exile-leveling").join("exile-leveling.log")
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
    let title = wide("Exile Leveling");
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
    if guide_window::show() {
        return;
    }
    open_browser(browser, url);
}

fn open_browser(browser: Browser, url: &str) {
    let result = match browser {
        Browser::None => return,
        Browser::Edge => spawn_edge(url),
        Browser::Default => spawn_default(url),
    };
    if let Err(err) = result {
        warn!("Could not open the guide ({}). Open {} yourself.", err, url);
    }
}

#[cfg(windows)]
fn spawn_edge(url: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "msedge", &format!("--app={url}")])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
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
fn spawn_edge(url: &str) -> std::io::Result<()> {
    spawn_default(url)
}

#[cfg(not(windows))]
fn spawn_default(url: &str) -> std::io::Result<()> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map(|_| ())
}
