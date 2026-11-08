use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use regex::RegexSet;
use sysinfo::{Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::sync::{broadcast, watch};
use tracing::info;

use crate::log_reader;

const PROCESS_NAME: &str = "PathOfExile";
/// PoE2's client uses the same process names; its install folder tells it apart.
const POE2_DIR: &str = "Path of Exile 2";
const LOG_NAMES: [&str; 2] = ["LatestClient.txt", "Client.txt"];
const AREA_PATTERN: &str = r"Generating level \d+ area";
/// `] : KobayashiSRS (Witch) is now level 8` — the guide follows your level.
const LEVEL_PATTERN: &str = r"\] : .+ \(\w+\) is now level \d+";
/// `] Sin: Abberath!` — speech from the speakers whose lines mark a boss death (the guide
/// matches the exact lines; see web/src/state/boss-kills.ts). Only these speakers, so the
/// rest of the log (half its lines look like "Name: text") isn't sent to the guide.
const SPEECH_PATTERN: &str =
    r"\] (?:Sin|Piety|Gravicius|Dominus|Malachai|Maligaro, the Inquisitor): ";
/// `] : You have been permanently weakened by Kitava's ...` — Kitava's death, a system line.
const KITAVA_PATTERN: &str = r"\] : You have been permanently weakened by Kitava";
/// `] Successfully allocated passive skill id: dexterity869, name: Dexterity` — your tree.
const ALLOCATED_PATTERN: &str = r"\] Successfully allocated passive skill id: ";
/// `/passives` in game: `] : 22 Passive Skill Points from quests:` then `] : (1 from <quest>)`.
const QUESTS_PATTERN: &str = r"\] : (?:\d+ Passive Skill Points from quests:|\(\d+ from [^)]+\)$)";
/// `] : KobayashiSRS has been slain.` — tells which character is playing (deaths).
const SLAIN_PATTERN: &str = r"\] : \S+ has been slain\.$";
const PATTERNS: [&str; 7] = [
    AREA_PATTERN,
    LEVEL_PATTERN,
    SPEECH_PATTERN,
    KITAVA_PATTERN,
    ALLOCATED_PATTERN,
    QUESTS_PATTERN,
    SLAIN_PATTERN,
];
// Where you are, for the in-game bar (these lines aren't sent to the guide). Each is the
// game's own line from its start (`2026/11/08 06:46:49 798362062 890d9dbc [INFO Client
// 47200] …`), so chat can't fake one.
/// `… [DEBUG Client 1] Generating level 23 area "1_2_town"` — a zone: you're playing.
const ZONE_PATTERN: &str =
    r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \d+ [0-9a-f]+ \[\w+ Client \d+\] Generating level \d+ area";
/// `… [INFO Client 1] Async connecting to wdc.login.pathofexile.com:20489` — the game went
/// to its login server: logging in, or logging out to character select.
const LOGIN_PATTERN: &str =
    r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \d+ [0-9a-f]+ \[\w+ Client \d+\] Async connecting to \S*login\.";
/// `2026/11/08 06:46:28 ***** LOG FILE OPENING *****` — the game started (login screen next).
const OPENING_PATTERN: &str = r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \*{5} LOG FILE OPENING";
/// `… [INFO Client 1] [SCENE] Set Source [(unknown)]` — no scene: back at the login screen
/// (Exit to Login Screen, or after a disconnect).
const NO_SCENE_PATTERN: &str =
    r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \d+ [0-9a-f]+ \[\w+ Client \d+\] \[SCENE\] Set Source \[\(unknown\)\]";
/// `… [INFO Client 1] Abnormal disconnect: …` — dropped to the login screen.
const DISCONNECT_PATTERN: &str =
    r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \d+ [0-9a-f]+ \[\w+ Client \d+\] Abnormal disconnect";
/// In the order `in_zone` reads them: in a zone, then the ones that aren't.
const PLACE_PATTERNS: [&str; 5] = [
    ZONE_PATTERN,
    LOGIN_PATTERN,
    OPENING_PATTERN,
    NO_SCENE_PATTERN,
    DISCONNECT_PATTERN,
];
/// How much of the log before its end is read for where you are when it's first opened
/// (zone or login lines come far more often than this in play).
const PLACE_TAIL: u64 = 1024 * 1024;

/// True for a line that puts you in a zone, false for login or character select, None for
/// any other line.
fn in_zone(places: &RegexSet, line: &str) -> Option<bool> {
    let matched = places.matches(line);
    if matched.matched(0) {
        Some(true)
    } else if matched.matched_any() {
        Some(false)
    } else {
        None
    }
}

/// Where the log's last such line before `end` (where the reader starts) puts you. None:
/// none in the last MB before it.
fn last_place(path: &Path, end: u64, places: &RegexSet) -> Option<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let start = end.saturating_sub(PLACE_TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.take(end - start).read_to_end(&mut tail).ok()?;
    String::from_utf8_lossy(&tail)
        .lines()
        .rev()
        .find_map(|line| in_zone(places, line))
}

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

/// Finds the PoE log, tails it, and broadcasts area, level and speech lines. Goes back to waiting
/// when the game closes so a restart (and a fresh LatestClient.txt) is picked up. `fixed` is
/// the log set on the command line or in Settings (None: found from the running game); a
/// change starts over with it. `in_zone` follows whether you're in a zone (true) or at
/// login or character select (false); None while no log is read or it doesn't say.
pub async fn run(
    mut fixed: watch::Receiver<Option<PathBuf>>,
    heart_beat: Duration,
    lines: broadcast::Sender<String>,
    status: watch::Sender<Status>,
    zone: watch::Sender<Option<bool>>,
) -> anyhow::Result<()> {
    let patterns = RegexSet::new(PATTERNS)?;
    let places = RegexSet::new(PLACE_PATTERNS)?;
    // The reader passes on both kinds of line; only `patterns`' go to the guide.
    let read = RegexSet::new(PATTERNS.iter().chain(&PLACE_PATTERNS))?;
    let mut sys = System::new();
    let mut interval = tokio::time::interval(heart_beat);

    loop {
        status.send_replace(Status::Waiting);
        zone.send_replace(None);
        info!("Waiting for the Path of Exile client...");

        let fixed_path = fixed.borrow_and_update().clone();
        let log_path = loop {
            if fixed.has_changed().unwrap_or(false) {
                break None;
            }
            let found = match &fixed_path {
                Some(path) if path.is_dir() => folder_log(path),
                Some(path) => path.try_exists().ok().filter(|x| *x).map(|_| path.clone()),
                None => find_running_log(&mut sys),
            };
            if let Some(path) = found {
                break Some(path);
            }
            interval.tick().await;
        };
        // The setting changed while waiting: start over with it.
        let Some(log_path) = log_path else { continue };

        info!("Log file: {}", log_path.display());
        status.send_replace(Status::Watching(log_path.clone()));

        let mut reader = match log_reader::build(&log_path, read.clone()) {
            Ok(reader) => reader,
            Err(err) => {
                info!("Could not open the log: {}", err);
                interval.tick().await;
                continue;
            }
        };
        // Up to where the reader starts, so no line is missed or read twice.
        let end = reader.offset();
        let path = log_path.clone();
        let tail_places = places.clone();
        let place = tokio::task::spawn_blocking(move || last_place(&path, end, &tail_places))
            .await
            .unwrap_or(None);
        zone.send_replace(place);

        let mut ticks: u32 = 0;
        loop {
            interval.tick().await;
            if fixed.has_changed().unwrap_or(false) {
                info!("Log setting changed");
                break;
            }
            if let Err(err) = reader.read_latest(|line| {
                if let Some(now) = in_zone(&places, line) {
                    zone.send_if_modified(|was| {
                        let changed = *was != Some(now);
                        *was = Some(now);
                        changed
                    });
                }
                if patterns.is_match(line) {
                    let _ = lines.send(line.to_string());
                }
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

/// Running PoE1 clients. Names match by substring, which also catches PoE2.
fn poe1_processes(sys: &System) -> impl Iterator<Item = &Process> {
    sys.processes_by_name(PROCESS_NAME.as_ref())
        .filter(|p| ![p.exe(), p.cwd()].into_iter().flatten().any(in_poe2_dir))
}

fn in_poe2_dir(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(POE2_DIR))
}

fn game_running(sys: &mut System) -> bool {
    refresh(sys);
    poe1_processes(sys).next().is_some()
}

fn find_running_log(sys: &mut System) -> Option<PathBuf> {
    refresh(sys);
    for process in poe1_processes(sys) {
        let dirs = [process.cwd(), process.exe().and_then(Path::parent)];
        for dir in dirs.into_iter().flatten() {
            if let Some(path) = first_log(dir) {
                return Some(path);
            }
        }
    }
    None
}

/// A game folder's log, as set in Settings: its newest LatestClient.txt or Client.txt.
pub fn folder_log(dir: &Path) -> Option<PathBuf> {
    first_log(dir)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poe2_installs_are_skipped() {
        assert!(in_poe2_dir(Path::new(
            "C:/Program Files (x86)/Grinding Gear Games/Path of Exile 2/PathOfExile_x64.exe"
        )));
        assert!(in_poe2_dir(Path::new(
            "D:/SteamLibrary/steamapps/common/path of exile 2"
        )));
        assert!(!in_poe2_dir(Path::new(
            "D:/SteamLibrary/steamapps/common/Path of Exile/PathOfExileSteam.exe"
        )));
        assert!(!in_poe2_dir(Path::new("D:/Games/Path of Exile 2 backup/x")));
    }

    #[test]
    fn forwards_area_level_and_speech_lines_only() {
        let patterns = RegexSet::new(PATTERNS).unwrap();
        let prefix = "2026/11/05 07:38:21 542259468 cffb065b [INFO Client 52060]";
        let forwarded = |rest: &str| patterns.is_match(&format!("{prefix}{rest}"));
        assert!(forwarded(r#" Generating level 1 area "1_1_1" with seed 1"#));
        assert!(forwarded(" : KobayashiSRS (Witch) is now level 8"));
        assert!(forwarded(" Malachai: Why... are you so in love with Death?"));
        assert!(forwarded(" Sin: Abberath!"));
        assert!(forwarded(" Maligaro, the Inquisitor: You have murdered... an artist..."));
        assert!(!forwarded(" ALTERNATE TREE JEWEL: something"));
        assert!(!forwarded(" Merveil, the Siren: This is love's true face!"));
        assert!(!forwarded(" #Global: hello"));
        assert!(!forwarded(" @From Someone: wtb"));
        assert!(!forwarded(" $Trader: selling"));
        assert!(forwarded(
            " : You have been permanently weakened by Kitava's cruel affliction. You now have -30% to all Resistances."
        ));
        assert!(!forwarded(" : You have entered The Coast."));
        assert!(forwarded(" Successfully allocated passive skill id: dexterity869, name: Dexterity"));
        assert!(forwarded(" : 22 Passive Skill Points from quests:"));
        assert!(forwarded(" : (0 from The Dweller of the Deep)"));
        assert!(forwarded(" : KobayashiSRS has been slain."));
        assert!(!forwarded(" #Bob: (1 from chat)"));
        assert!(!forwarded(" Async connecting to wdc.login.pathofexile.com:20489"));
    }

    #[test]
    fn zones_login_and_character_select_are_told_apart() {
        let places = RegexSet::new(PLACE_PATTERNS).unwrap();
        let prefix = "2026/11/08 06:46:49 798362062 890d9dbc [INFO Client 47200]";
        let place = |rest: &str| in_zone(&places, &format!("{prefix}{rest}"));
        assert_eq!(place(r#" Generating level 23 area "1_2_town" with seed 1"#), Some(true));
        assert_eq!(place(" Async connecting to wdc.login.pathofexile.com:20489"), Some(false));
        assert_eq!(place(" Connecting to instance server at 170.23.221.76:6112"), None);
        assert_eq!(place(" : You have entered The Coast."), None);
        assert_eq!(place(" [SCENE] Set Source [(unknown)]"), Some(false));
        assert_eq!(place(" [SCENE] Set Source [The Coast]"), None);
        assert_eq!(
            place(" Abnormal disconnect: An unexpected disconnection occurred."),
            Some(false)
        );
        assert_eq!(in_zone(&places, "2026/11/08 06:46:28 ***** LOG FILE OPENING *****"), Some(false));
        // Chat can't fake them.
        assert_eq!(place(" #Bob: ] Async connecting to x.login.y"), None);
        assert_eq!(place(&format!(" #Bob: {prefix} Abnormal disconnect")), None);
        assert_eq!(place(" #Bob: 2026/11/08 06:46:28 ***** LOG FILE OPENING *****"), None);
        assert_eq!(place(&format!(" #Bob: {prefix} Generating level 1 area")), None);
    }

    #[test]
    fn the_last_place_in_the_log_counts() {
        let dir = std::env::temp_dir().join(format!("exile-place-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Client.txt");
        let places = RegexSet::new(PLACE_PATTERNS).unwrap();
        let area = "2026/11/08 06:46:54 798367250 1186a8a3 [DEBUG Client 1] Generating level 2 area \"1_1_2\" with seed 4";
        let login = "2026/11/08 06:46:49 798362062 890d9dbc [INFO Client 1] Async connecting to wdc.login.pathofexile.com:20489";
        let len = |path: &Path| std::fs::metadata(path).unwrap().len();
        std::fs::write(&path, format!("{area}\r\n{login}\r\nnoise\r\n")).unwrap();
        assert_eq!(last_place(&path, len(&path), &places), Some(false));
        std::fs::write(&path, format!("{login}\r\n{area}\r\nnoise\r\n")).unwrap();
        assert_eq!(last_place(&path, len(&path), &places), Some(true));
        // Only up to where the reader starts: a later login line is the reader's.
        let before = (login.len() + area.len() + 4) as u64;
        std::fs::write(&path, format!("{login}\r\n{area}\r\n{login}\r\n")).unwrap();
        assert_eq!(last_place(&path, before, &places), Some(true));
        std::fs::write(&path, "noise\r\n").unwrap();
        assert_eq!(last_place(&path, len(&path), &places), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
