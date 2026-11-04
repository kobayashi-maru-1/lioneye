use std::{net::SocketAddr, path::PathBuf, process::ExitCode, time::Duration};

use clap::{Parser, ValueEnum};
use tokio::sync::{broadcast, watch};
use tracing::{error, info, warn};

mod log_reader;
mod server;
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

#[tokio::main]
async fn main() -> ExitCode {
    let (non_blocking, _guard) = tracing_appender::non_blocking(std::io::stdout());
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(non_blocking)
        .init();

    let args = Args::parse();

    let addr: SocketAddr = match args.address.parse() {
        Ok(addr) => addr,
        Err(err) => {
            error!("Bad --address {}: {}", args.address, err);
            return fail();
        }
    };
    let url = format!("http://{}/", addr);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            if already_running(addr).await {
                info!("Already running on {}, opening it", url);
                open_browser(args.browser, &url);
                return ExitCode::SUCCESS;
            }
            error!(
                "Another program is using {}. Close it (an old exile-log-api, for example) or pass --address with another port.",
                addr
            );
            return fail();
        }
        Err(err) => {
            error!(
                "Could not listen on {}: {}. Try --address with another port.",
                addr, err
            );
            return fail();
        }
    };

    info!("Guide: {}", url);
    info!("Close this window to stop the guide and auto-progress.");

    let (lines_tx, _) = broadcast::channel::<String>(256);
    let (status_tx, status_rx) = watch::channel(watcher::Status::Waiting);

    let state = server::AppState {
        lines: lines_tx.clone(),
        status: status_rx,
    };

    open_browser(args.browser, &url);

    let heart_beat = Duration::from_secs(args.heart_beat.max(1));
    let res = tokio::select! {
        res = server::serve(listener, state) => res,
        res = watcher::run(args.log_path, heart_beat, lines_tx, status_tx) => res,
    };

    match res {
        Ok(_) => ExitCode::SUCCESS,
        Err(err) => {
            error!("{}", err);
            fail()
        }
    }
}

/// Keeps the console open on an error when the exe was double-clicked, so the message can be read.
fn fail() -> ExitCode {
    use std::io::{IsTerminal, Write};
    if std::io::stdin().is_terminal() {
        // tracing writes through a background thread; give it a moment to flush.
        std::thread::sleep(Duration::from_millis(200));
        print!("Press Enter to close...");
        let _ = std::io::stdout().flush();
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    ExitCode::FAILURE
}

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
