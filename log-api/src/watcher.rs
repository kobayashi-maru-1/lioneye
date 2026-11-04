use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use regex::RegexSet;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::sync::{broadcast, watch};
use tracing::info;

use crate::log_reader;

const PROCESS_NAME: &str = "PathOfExile";
const LOG_NAMES: [&str; 2] = ["LatestClient.txt", "Client.txt"];
const AREA_PATTERN: &str = r"Generating level \d+ area";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Looking for a running PoE client
    Waiting,
    /// Tailing this log file
    Watching(PathBuf),
}

impl Status {
    /// Text sent to the page. The page ignores anything that isn't an area line,
    /// so older pages are unaffected.
    pub fn message(&self) -> String {
        match self {
            Status::Waiting => "status:waiting".to_string(),
            Status::Watching(path) => format!("status:watching|{}", path.display()),
        }
    }
}

/// Finds the PoE log, tails it, and broadcasts area lines. Goes back to waiting
/// when the game closes so a restart (and a fresh LatestClient.txt) is picked up.
pub async fn run(
    fixed_path: Option<PathBuf>,
    heart_beat: Duration,
    lines: broadcast::Sender<String>,
    status: watch::Sender<Status>,
) -> anyhow::Result<()> {
    let patterns = RegexSet::new([AREA_PATTERN])?;
    let mut sys = System::new();
    let mut interval = tokio::time::interval(heart_beat);

    loop {
        status.send_replace(Status::Waiting);
        info!("Waiting for the Path of Exile client...");

        let log_path = loop {
            let found = match &fixed_path {
                Some(path) => path.try_exists().ok().filter(|x| *x).map(|_| path.clone()),
                None => find_running_log(&mut sys),
            };
            if let Some(path) = found {
                break path;
            }
            interval.tick().await;
        };

        info!("Log file: {}", log_path.display());
        status.send_replace(Status::Watching(log_path.clone()));

        let mut reader = match log_reader::build(&log_path, patterns.clone()) {
            Ok(reader) => reader,
            Err(err) => {
                info!("Could not open the log: {}", err);
                interval.tick().await;
                continue;
            }
        };

        let mut ticks: u32 = 0;
        loop {
            interval.tick().await;
            if let Err(err) = reader.read_latest(|line| {
                let _ = lines.send(line.to_string());
            }) {
                info!("Lost the log: {}", err);
                break;
            }

            // With a found log, notice when the game closes.
            ticks = ticks.wrapping_add(1);
            if fixed_path.is_none() && ticks % 5 == 0 && !game_running(&mut sys) {
                info!("Path of Exile closed");
                break;
            }
        }
    }
}

fn refresh(sys: &mut System) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
}

fn game_running(sys: &mut System) -> bool {
    refresh(sys);
    sys.processes_by_name(PROCESS_NAME.as_ref()).next().is_some()
}

fn find_running_log(sys: &mut System) -> Option<PathBuf> {
    refresh(sys);
    for process in sys.processes_by_name(PROCESS_NAME.as_ref()) {
        let dirs = [process.cwd(), process.exe().and_then(Path::parent)];
        for dir in dirs.into_iter().flatten() {
            if let Some(path) = first_log(dir) {
                return Some(path);
            }
        }
    }
    None
}

/// The most recently written of LatestClient.txt and Client.txt in `dir/logs`.
fn first_log(dir: &Path) -> Option<PathBuf> {
    LOG_NAMES
        .iter()
        .map(|name| dir.join("logs").join(name))
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}
