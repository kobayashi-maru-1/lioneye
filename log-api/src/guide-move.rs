//! The one-time move from the old setup, where the guide opened in your last-used Edge
//! profile (or Chrome's, in 0.2) and its data (imported build, progress, layout) was saved
//! there. The profiles whose storage holds the guide's address are found on disk; the guide
//! opens briefly in each ("?migrate=<id>"), each sends what it has ("state-offer:"), and
//! the best becomes the exe's copy (saved-state.rs), which the guide's own window loads.
//!
//! Every answer is also kept in `moved\<id>.json` as a backup. `moved\done` marks the move
//! finished; while it runs, `moving` stops anything else opening the guide (another launch
//! included).

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use tracing::{info, warn};

use crate::saved_state::SavedState;
use crate::{edge, guide_window};

/// How long a profile's window gets to answer, and how many tries it gets.
const ANSWER: Duration = Duration::from_secs(25);
const TRIES: u32 = 2;
/// Time for windows to close before the next one opens.
const SETTLE: Duration = Duration::from_millis(1500);

/// A browser profile that has the guide's data on disk.
pub struct OldProfile {
    /// "edge:Default", "chrome:Profile 1": how its answer is matched.
    pub id: String,
    browser: PathBuf,
    profile: String,
    /// When its storage last changed: the newest wins (old_profiles sorts by it).
    changed: SystemTime,
}

enum Phase {
    /// Windows closing; then the next profile opens (or the move finishes).
    Closing(Instant),
    /// A profile's window is open, waiting for its answer.
    Waiting(Instant),
}

pub struct GuideMove {
    url: String,
    profiles: Vec<OldProfile>,
    next: usize,
    tries: u32,
    phase: Phase,
}

fn moved_dir() -> PathBuf {
    crate::data_dir().join("moved")
}

fn lock_file() -> PathBuf {
    crate::data_dir().join("moving")
}

/// True while a move is running (in this or another copy of the exe): don't open the guide.
pub fn in_progress() -> bool {
    lock_file().exists()
}

/// "http://127.0.0.1:6754/" → "http://127.0.0.1:6754", as browsers key storage.
fn origin(url: &str) -> &str {
    url.trim_end_matches('/')
}

impl GuideMove {
    /// The old profiles to move from, when the move hasn't been done yet: none for a new
    /// user, or for a test run on another port (no profile has that address).
    pub fn needed(url: &str) -> Option<Vec<OldProfile>> {
        // A stale lock from a copy that was stopped mid-move: start over.
        let _ = std::fs::remove_file(lock_file());
        if moved_dir().join("done").exists() {
            return None;
        }
        let profiles = old_profiles(origin(url));
        (!profiles.is_empty()).then_some(profiles)
    }

    /// Closes the guide windows open from the old setup and starts with the first profile.
    pub fn start(url: &str, profiles: Vec<OldProfile>) -> Self {
        let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
        info!("Moving the guide's data from {}", ids.join(", "));
        let _ = std::fs::create_dir_all(moved_dir());
        let _ = std::fs::write(lock_file(), "");
        guide_window::close_all();
        Self {
            url: url.to_string(),
            profiles,
            next: 0,
            tries: 0,
            phase: Phase::Closing(Instant::now()),
        }
    }

    /// Steps the move along (from the tray loop). True once it's done; the caller then
    /// opens the guide's own window.
    pub fn tick(&mut self, saved: &SavedState) -> bool {
        match self.phase {
            Phase::Waiting(since) => {
                let current = &self.profiles[self.next];
                if let Some(json) = saved.offer_from(&current.id) {
                    let backup = moved_dir().join(format!("{}.json", file_name(&current.id)));
                    let _ = std::fs::write(backup, json);
                    self.next += 1;
                    self.tries = 0;
                } else if since.elapsed() >= ANSWER {
                    warn!("No answer from {}", current.id);
                    if self.tries >= TRIES {
                        self.next += 1;
                        self.tries = 0;
                    }
                } else {
                    return false;
                }
                guide_window::close_all();
                self.phase = Phase::Closing(Instant::now());
                false
            }
            Phase::Closing(since) if since.elapsed() >= SETTLE => {
                if let Some(profile) = self.profiles.get(self.next) {
                    self.tries += 1;
                    let url = format!("{}?migrate={}", self.url, encode(&profile.id));
                    if let Err(err) =
                        edge::open_profile_window(&profile.browser, &profile.profile, &url)
                    {
                        warn!("Couldn't open {}: {err}", profile.id);
                    }
                    self.phase = Phase::Waiting(Instant::now());
                    return false;
                }
                self.finish(saved);
                true
            }
            Phase::Closing(_) => false,
        }
    }

    /// Keeps the best answer as the exe's copy: the most recently changed profile that has
    /// an imported build, else the most recently changed with any data. Nothing found leaves
    /// no copy (the own window starts fresh).
    fn finish(&self, saved: &SavedState) {
        let answers: Vec<(&OldProfile, String)> = self
            .profiles
            .iter()
            .filter_map(|p| saved.offer_from(&p.id).map(|json| (p, json)))
            .collect();
        let best = answers
            .iter()
            .find(|(_, json)| SavedState::has_build(json))
            .or_else(|| answers.iter().find(|(_, json)| !SavedState::is_empty(json)));
        match best {
            Some((profile, json)) => {
                info!("Moved the guide's data from {}", profile.id);
                saved.save(json);
            }
            None => info!("No guide data to move"),
        }
        let _ = std::fs::write(moved_dir().join("done"), "");
        let _ = std::fs::remove_file(lock_file());
    }
}

/// "edge:Profile 1" → "edge-Profile 1" (a file name).
fn file_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Percent-encodes a profile id for the page's address.
fn encode(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Edge's and Chrome's profiles whose storage holds the guide's address, newest first.
fn old_profiles(origin: &str) -> Vec<OldProfile> {
    let needle = format!("_{origin}\0");
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut found = Vec::new();
    for (name, user_data, browser) in [
        (
            "edge",
            local.join(r"Microsoft\Edge\User Data"),
            edge::msedge(),
        ),
        (
            "chrome",
            local.join(r"Google\Chrome\User Data"),
            edge::chrome(),
        ),
    ] {
        let Some(browser) = browser else { continue };
        for profile in profile_dirs(&user_data) {
            let storage = user_data.join(&profile).join(r"Local Storage\leveldb");
            if let Some(changed) = storage_changed(&storage, needle.as_bytes()) {
                found.push(OldProfile {
                    id: format!("{name}:{profile}"),
                    browser: browser.clone(),
                    profile,
                    changed,
                });
            }
        }
    }
    found.sort_by(|a, b| b.changed.cmp(&a.changed));
    found
}

/// A browser's profile folders, from its Local State.
fn profile_dirs(user_data: &Path) -> Vec<String> {
    let state: serde_json::Value = std::fs::read_to_string(user_data.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    state["profile"]["info_cache"]
        .as_object()
        .map(|cache| cache.keys().cloned().collect())
        .unwrap_or_default()
}

/// When a profile's storage files holding the guide's address last changed; None when
/// none holds it.
fn storage_changed(dir: &Path, needle: &[u8]) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "ldb" && ext != "log" {
            continue;
        }
        // The browser may hold the file open; Rust opens with shared read and write.
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.windows(needle.len()).any(|w| w == needle) {
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            newest = newest.max(modified).or(modified);
        }
    }
    newest
}

#[cfg(test)]
mod tests {
    use super::{encode, file_name, origin};

    #[test]
    fn names() {
        assert_eq!(origin("http://127.0.0.1:6754/"), "http://127.0.0.1:6754");
        assert_eq!(encode("edge:Profile 1"), "edge%3AProfile%201");
        assert_eq!(file_name("edge:Profile 1"), "edge-Profile 1");
    }
}
