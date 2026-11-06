//! The guide's saved data (its browser storage: imported build, progress, layout), kept by
//! the exe in `%LOCALAPPDATA%\exile-leveling\state.json`. The guide opens in a browser
//! profile of its own (main.rs); this copy lets a new profile pick up where the last left off.
//!
//! - Every page gets "state:<json>" ("state:null" before anything was saved) on connect.
//! - The guide's own window uploads "state:<json>" when its data changes; a fresh window
//!   (empty storage) loads the saved copy instead.
//! - Moving from the old setup, a window opened in each Edge profile answers
//!   "state-offer:<json>"; the exe keeps the most complete (`best_offer`).

use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};

use tracing::{info, warn};

/// Browser storage is a few hundred KB at most; leave room for big PoB codes.
const MAX_STATE: usize = 16 * 1024 * 1024;

pub struct SavedState {
    path: PathBuf,
    current: Mutex<Option<String>>,
    offers: Mutex<Vec<String>>,
}

/// Storage as the page sends it: key → stored string.
type Storage = BTreeMap<String, String>;

fn parse(json: &str) -> Option<Storage> {
    if json.len() > MAX_STATE {
        return None;
    }
    serde_json::from_str(json).ok()
}

impl SavedState {
    pub fn load(path: PathBuf) -> Self {
        let current = std::fs::read_to_string(&path)
            .ok()
            .filter(|text| parse(text).is_some());
        Self {
            path,
            current: Mutex::new(current),
            offers: Mutex::new(Vec::new()),
        }
    }

    /// True once something was saved (so the move from the old setup is done).
    pub fn exists(&self) -> bool {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// "state:<json>", or "state:null" before anything was saved.
    pub fn message(&self) -> String {
        let current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        format!("state:{}", current.as_deref().unwrap_or("null"))
    }

    /// Keeps what the guide sent, here and on disk. Ignored when it isn't storage JSON.
    pub fn save(&self, json: &str) {
        if parse(json).is_none() {
            return;
        }
        {
            let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
            if current.as_deref() == Some(json) {
                return;
            }
            *current = Some(json.to_string());
        }
        // Written beside, then renamed over, so a crash never leaves half a file.
        let temp = self.path.with_extension("json.tmp");
        let result = std::fs::write(&temp, json).and_then(|_| std::fs::rename(&temp, &self.path));
        match result {
            Ok(()) => info!("Saved the guide's data ({} bytes)", json.len()),
            Err(err) => warn!("Couldn't save {}: {}", self.path.display(), err),
        }
    }

    /// A window opened in an old Edge profile sent what it had.
    pub fn offer(&self, json: &str) {
        if let Some(storage) = parse(json) {
            info!("An Edge profile sent {} saved entries", storage.len());
            self.offers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(json.to_string());
        }
    }

    pub fn offer_count(&self) -> usize {
        self.offers.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// The most complete of the offers: one with an imported build first, then the most data.
    pub fn best_offer(&self) -> Option<String> {
        let offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
        offers
            .iter()
            .filter_map(|json| parse(json).map(|storage| (json, storage)))
            .filter(|(_, storage)| !storage.is_empty())
            .max_by_key(|(json, storage)| (storage.contains_key("pob-code"), json.len()))
            .map(|(json, _)| json.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::SavedState;

    #[test]
    fn prefers_the_offer_with_a_build() {
        let state = SavedState::load(std::env::temp_dir().join("exile-leveling-test-none.json"));
        state.offer(r#"{"route-progress":"{\"version\":0,\"value\":[1,2,3,4,5,6,7,8]}"}"#);
        state.offer(r#"{"pob-code":"\"abc\"","route-progress":"x"}"#);
        state.offer(r#"{}"#);
        state.offer("not json");
        assert_eq!(state.offer_count(), 3);
        assert!(state.best_offer().unwrap().contains("pob-code"));
    }

    #[test]
    fn nothing_to_move_from_empty_profiles() {
        let state = SavedState::load(std::env::temp_dir().join("exile-leveling-test-none2.json"));
        state.offer("{}");
        assert_eq!(state.best_offer(), None);
    }
}
