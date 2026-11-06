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
/// The storage keys of the imported build and of your place on the route (web/src/state).
const BUILD_KEY: &str = "pob-code";
const PROGRESS_KEY: &str = "active-edge";

/// A stored entry's value: the guide stores `{"version": n, "value": …}` (web/src/state).
fn stored_value(storage: &Storage, key: &str) -> Option<serde_json::Value> {
    let entry: serde_json::Value = serde_json::from_str(storage.get(key)?).ok()?;
    let value = entry.get("value")?.clone();
    (!value.is_null()).then_some(value)
}

pub struct SavedState {
    path: PathBuf,
    /// Held while the file is written, so saves land on disk in order.
    current: Mutex<Option<String>>,
    /// The old profiles' answers, by profile id.
    offers: Mutex<HashMap<String, String>>,
}

/// The page's fingerprint of a copy (web/src/state/saved-state.ts): FNV-1a over its UTF-16
/// code units, as hex. Sent back as "saved:<fingerprint>" once a copy is on disk.
pub fn fingerprint(json: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in json.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:x}")
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

    /// True once something was saved.
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
    /// True when the copy holds it now (saved, or it already did).
    pub fn save(&self, json: &str) -> bool {
        if parse(json).is_none() {
            return false;
        }
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_deref() == Some(json) {
            return true;
        }
        // Written beside, then renamed over, so a crash never leaves half a file.
        let temp = self.path.with_extension("json.tmp");
        let result = std::fs::write(&temp, json).and_then(|_| std::fs::rename(&temp, &self.path));
        match result {
            Ok(()) => {
                *current = Some(json.to_string());
                info!("Saved the guide's data ({} bytes)", json.len());
                true
            }
            Err(err) => {
                warn!("Couldn't save {}: {}", self.path.display(), err);
                false
            }
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

    /// The storage holds an imported build (not an empty or reset one).
    pub fn has_build(json: &str) -> bool {
        parse(json).is_some_and(|storage| {
            stored_value(&storage, BUILD_KEY)
                .is_some_and(|value| value.as_str().is_some_and(|code| !code.is_empty()))
        })
    }

    /// How good a profile's data is to move: an imported build, then how far along the
    /// route it is (the current zone), then how much it holds.
    pub fn rank(json: &str) -> (bool, i64, usize) {
        let zone = parse(json)
            .and_then(|storage| stored_value(&storage, PROGRESS_KEY))
            .and_then(|value| value.get(0).and_then(|zone| zone.as_i64()))
            .unwrap_or(-1);
        (Self::has_build(json), zone, json.len())
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
    fn ranks_build_then_progress() {
        let build = |code: &str| format!(r#"{{"version":0,"value":{code}}}"#);
        let storage = |pob: Option<&str>, zone: i64| {
            let mut map = serde_json::Map::new();
            if let Some(code) = pob {
                map.insert("pob-code".into(), build(code).into());
            }
            map.insert(
                "active-edge".into(),
                format!(r#"{{"version":0,"value":[{zone}]}}"#).into(),
            );
            serde_json::Value::Object(map).to_string()
        };
        let with_build = storage(Some("\"abc\""), 3);
        let further = storage(None, 40);
        let reset = storage(Some("null"), 50);
        assert!(SavedState::has_build(&with_build));
        assert!(!SavedState::has_build(&reset));
        assert!(SavedState::rank(&with_build) > SavedState::rank(&further));
        assert!(SavedState::rank(&further) > SavedState::rank(&storage(None, 2)));
    }

    #[test]
    fn fingerprints_like_the_page() {
        // FNV-1a of "" and of a small copy, as web/src/state/saved-state.ts computes them.
        assert_eq!(super::fingerprint(""), "811c9dc5");
        assert_eq!(super::fingerprint("{}"), "5465b825");
        assert_eq!(super::fingerprint("é"), format!("{:x}", (0x811c_9dc5u32 ^ 0xe9).wrapping_mul(0x0100_0193)));
    }

    #[test]
    fn offers_by_profile() {
        let state = SavedState::load(std::env::temp_dir().join("exile-leveling-test-none.json"));
        state.offer("edge:Default\n{\"route-progress\":\"x\"}");
        state.offer(
            r#"edge:Profile 1
{"pob-code":"{\"version\":0,\"value\":\"abc\"}"}"#,
        );
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
