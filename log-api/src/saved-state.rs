//! The guide's saved data (its browser storage: imported build, progress, layout), kept by
//! the exe in `state.json`. The guide opens in a browser profile of its own (edge.rs); this
//! copy lets a new or reset profile pick up where the last one left off.
//!
//! - Every page gets "state:<json>" ("state:null" before anything was saved) on connect.
//! - The guide's own window uploads "state:<json>" when its data changes; a fresh window
//!   (empty storage) loads the saved copy instead.
//! - Moving from the old setup (guide-move.rs), a window opened in each old profile answers
//!   "state-offer:<profile id>\n<json>".

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Mutex,
};

use tracing::{info, warn};

/// Browser storage is a few MB at most; leave room for big PoB codes.
const MAX_STATE: usize = 16 * 1024 * 1024;
/// The storage key of the imported build (web/src/state/pob).
const BUILD_KEY: &str = "pob-code";

pub struct SavedState {
    path: PathBuf,
    /// Held while the file is written, so saves land on disk in order.
    current: Mutex<Option<String>>,
    /// The old profiles' answers, by profile id.
    offers: Mutex<HashMap<String, String>>,
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
            offers: Mutex::new(HashMap::new()),
        }
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
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_deref() == Some(json) {
            return;
        }
        // Written beside, then renamed over, so a crash never leaves half a file.
        let temp = self.path.with_extension("json.tmp");
        let result = std::fs::write(&temp, json).and_then(|_| std::fs::rename(&temp, &self.path));
        match result {
            Ok(()) => {
                *current = Some(json.to_string());
                info!("Saved the guide's data ({} bytes)", json.len());
            }
            Err(err) => warn!("Couldn't save {}: {}", self.path.display(), err),
        }
    }

    /// An old profile's window sent what it had: "<profile id>\n<json>".
    pub fn offer(&self, message: &str) {
        let Some((id, json)) = message.split_once('\n') else {
            return;
        };
        if id.is_empty() || id.len() > 200 {
            return;
        }
        if let Some(storage) = parse(json) {
            info!("{id} sent {} saved entries", storage.len());
            self.offers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_string(), json.to_string());
        }
    }

    /// The answer from one old profile, once it has sent it.
    pub fn offer_from(&self, id: &str) -> Option<String> {
        self.offers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// The storage holds an imported build.
    pub fn has_build(json: &str) -> bool {
        parse(json).is_some_and(|storage| storage.contains_key(BUILD_KEY))
    }

    /// The storage holds nothing.
    pub fn is_empty(json: &str) -> bool {
        parse(json).is_none_or(|storage| storage.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::SavedState;

    #[test]
    fn offers_by_profile() {
        let state = SavedState::load(std::env::temp_dir().join("exile-leveling-test-none.json"));
        state.offer("edge:Default\n{\"route-progress\":\"x\"}");
        state.offer("edge:Profile 1\n{\"pob-code\":\"abc\"}");
        state.offer("no newline");
        state.offer("edge:Bad\nnot json");
        assert!(state.offer_from("edge:Default").is_some());
        assert!(SavedState::has_build(
            &state.offer_from("edge:Profile 1").unwrap()
        ));
        assert!(state.offer_from("edge:Bad").is_none());
        assert!(SavedState::is_empty("{}"));
        assert!(!SavedState::is_empty("{\"a\":\"b\"}"));
    }
}
