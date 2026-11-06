//! What the guide's Settings page sets for the exe: where the game log is and which browser
//! opens the guide. Kept in `settings.json` (`settings-<port>.json` for a test run on another
//! port). A `--log-path` or `--browser` on the command line wins over them.
//!
//! Both apply at once: the log path through `log_path` (the watcher restarts on it), the
//! browser through `browser` (read each time the guide opens).

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

/// The browsers the page may pick; "none" only comes from the command line.
pub const BROWSERS: [&str; 3] = ["app", "edge", "default"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The game's Client.txt; None: found from the running game.
    pub log_path: Option<PathBuf>,
    /// "app", "edge" or "default"; None: "app".
    pub browser: Option<String>,
}

/// A change from the page; a field left out stays as it is.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// An empty path: back to finding it from the running game.
    pub log_path: Option<String>,
    pub browser: Option<String>,
}

pub struct AppSettings {
    path: PathBuf,
    settings: Mutex<Settings>,
    cli_log: Option<PathBuf>,
    cli_browser: Option<String>,
    /// The log the watcher reads: the command line's, else the setting.
    pub log_path: watch::Sender<Option<PathBuf>>,
    /// How the guide opens: the command line's, else the setting, else "app".
    pub browser: watch::Sender<String>,
}

impl AppSettings {
    pub fn load(path: PathBuf, cli_log: Option<PathBuf>, cli_browser: Option<String>) -> Self {
        let settings: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let log = cli_log.clone().or_else(|| settings.log_path.clone());
        let browser = effective_browser(cli_browser.as_deref(), &settings);
        Self {
            path,
            settings: Mutex::new(settings),
            cli_log,
            cli_browser,
            log_path: watch::channel(log).0,
            browser: watch::channel(browser).0,
        }
    }

    /// What the page shows: the settings, and which ones the command line overrides.
    pub fn view(&self) -> serde_json::Value {
        let settings = self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        serde_json::json!({
            "logPath": settings.log_path,
            "browser": settings.browser.as_deref().unwrap_or("app"),
            "logFromCommandLine": self.cli_log,
            "browserFromCommandLine": self.cli_browser,
        })
    }

    /// Applies and saves a change from the page. Err: why it can't be used, for the page.
    pub fn update(&self, change: Change) -> Result<(), String> {
        let mut settings = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = settings.clone();
        if let Some(log) = change.log_path {
            let log = log.trim().trim_matches('"');
            next.log_path = if log.is_empty() {
                None
            } else {
                Some(check_log(Path::new(log))?)
            };
        }
        if let Some(browser) = change.browser {
            if !BROWSERS.contains(&browser.as_str()) {
                return Err("Unknown browser.".to_string());
            }
            next.browser = Some(browser);
        }
        if next == *settings {
            return Ok(());
        }
        let text = serde_json::to_string_pretty(&next).map_err(|err| err.to_string())?;
        std::fs::write(&self.path, text).map_err(|err| {
            warn!("Couldn't save {}: {err}", self.path.display());
            "Not saved. Try again.".to_string()
        })?;
        *settings = next;
        info!("Settings: {:?}", *settings);
        if self.cli_log.is_none() {
            self.log_path.send_replace(settings.log_path.clone());
        }
        self.browser
            .send_replace(effective_browser(self.cli_browser.as_deref(), &settings));
        Ok(())
    }
}

fn effective_browser(cli: Option<&str>, settings: &Settings) -> String {
    cli.map(str::to_string)
        .or_else(|| settings.browser.clone())
        .unwrap_or_else(|| "app".to_string())
}

/// A log file to read: an existing file, or a game folder holding logs\LatestClient.txt or
/// logs\Client.txt (the newer of the two).
fn check_log(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        let found = ["LatestClient.txt", "Client.txt"]
            .iter()
            .map(|name| path.join("logs").join(name))
            .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, p)| p);
        if let Some(found) = found {
            return Ok(found);
        }
    }
    Err("Log not found. Pick Client.txt or the game folder.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_applies_changes() {
        let dir = std::env::temp_dir().join(format!("lioneye-settings-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let log = dir.join("logs").join("Client.txt");
        std::fs::write(&log, "x").unwrap();
        let file = dir.join("settings.json");
        let settings = AppSettings::load(file.clone(), None, None);
        assert_eq!(*settings.browser.borrow(), "app");

        // A game folder finds its log; the watcher gets it at once.
        let folder = dir.to_string_lossy().to_string();
        settings
            .update(Change { log_path: Some(folder), browser: Some("edge".into()) })
            .unwrap();
        assert_eq!(settings.log_path.borrow().as_deref(), Some(log.as_path()));
        assert_eq!(*settings.browser.borrow(), "edge");
        // Saved: a new start reads it back.
        let again = AppSettings::load(file.clone(), None, None);
        assert_eq!(*again.browser.borrow(), "edge");

        assert!(settings.update(Change { log_path: Some("C:/nope/x.txt".into()), browser: None }).is_err());
        assert!(settings.update(Change { log_path: None, browser: Some("opera".into()) }).is_err());
        // Cleared: back to finding it from the game.
        settings.update(Change { log_path: Some(String::new()), browser: None }).unwrap();
        assert!(settings.log_path.borrow().is_none());

        // The command line wins.
        let cli = AppSettings::load(file, Some(log.clone()), Some("default".into()));
        assert_eq!(*cli.browser.borrow(), "default");
        assert_eq!(cli.log_path.borrow().as_deref(), Some(log.as_path()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
