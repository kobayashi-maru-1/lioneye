//! Public game data the Gear panel needs, fetched for the guide (the page can't call
//! these sites itself) and cached on disk: the trade site's leagues, stat list and item
//! list (for Trade buttons), poe.ninja's item lists (unique art), RePoE's base item
//! list (base art) and RePoE's passive tree (the game log's node ids, for the Tree panel).

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime},
};

use tracing::{info, warn};

/// How long a cached copy is used before it's fetched again.
const MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);
const USER_AGENT: &str = "exile-leveling-local/0.1 (leveling guide)";

/// poe.ninja item lists the guide reads art from.
const NINJA_TYPES: [&str; 6] = [
    "UniqueWeapon",
    "UniqueArmour",
    "UniqueAccessory",
    "UniqueFlask",
    "UniqueJewel",
    "BaseType",
];

/// What the guide may ask for; nothing else is fetched.
pub enum Source {
    TradeLeagues,
    TradeStats,
    TradeItems,
    /// RePoE's base item list: each base's art path on GGG's image server.
    RepoeBases,
    /// RePoE's passive tree, kept as id → node: the game log names a node by its id
    /// ("dexterity869"), the tree and PoB by its number (13009).
    RepoePassives,
    Ninja { league: String, kind: String },
}

impl Source {
    /// Parses `name` (and for poe.ninja the league and item list), refusing anything else.
    pub fn parse(name: &str, league: Option<&str>, kind: Option<&str>) -> Option<Source> {
        match name {
            "trade-leagues" => Some(Source::TradeLeagues),
            "trade-stats" => Some(Source::TradeStats),
            "trade-items" => Some(Source::TradeItems),
            "repoe-bases" => Some(Source::RepoeBases),
            "repoe-passives" => Some(Source::RepoePassives),
            "ninja" => {
                let league = league.filter(|l| is_league(l))?;
                let kind = kind.filter(|k| NINJA_TYPES.contains(k))?;
                Some(Source::Ninja {
                    league: league.to_string(),
                    kind: kind.to_string(),
                })
            }
            _ => None,
        }
    }

    fn url(&self) -> String {
        match self {
            Source::TradeLeagues => "https://www.pathofexile.com/api/trade/data/leagues".into(),
            Source::TradeStats => "https://www.pathofexile.com/api/trade/data/stats".into(),
            Source::TradeItems => "https://www.pathofexile.com/api/trade/data/items".into(),
            Source::RepoeBases => "https://repoe-fork.github.io/base_items.json".into(),
            Source::RepoePassives => {
                "https://repoe-fork.github.io/passive_skill_trees/Default.json".into()
            }
            Source::Ninja { league, kind } => format!(
                "https://poe.ninja/poe1/api/economy/stash/current/item/overview?league={}&type={kind}",
                league.replace(' ', "%20")
            ),
        }
    }

    fn cache_name(&self) -> String {
        match self {
            Source::TradeLeagues => "trade-leagues.json".into(),
            Source::TradeStats => "trade-stats.json".into(),
            Source::TradeItems => "trade-items.json".into(),
            Source::RepoeBases => "repoe-bases.json".into(),
            Source::RepoePassives => "repoe-passives.json".into(),
            Source::Ninja { league, kind } => {
                format!("ninja-{}-{kind}.json", league.replace(' ', "+"))
            }
        }
    }
}

/// League names are letters, digits, spaces, hyphens and brackets ("Hardcore SSF Mirage").
fn is_league(league: &str) -> bool {
    !league.is_empty()
        && league.len() <= 64
        && league
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '(' | ')'))
}

fn cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("exile-leveling")
        .join("cache")
}

/// The data as JSON bytes: a fresh cached copy, else a new download, else (offline) a
/// stale cached copy.
pub async fn fetch(source: Source) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || fetch_blocking(&source))
        .await
        .map_err(|err| format!("Download failed: {err}"))?
}

/// One download at a time, so two requests for the same file (a reload, or the guide open
/// twice) never write it together.
static DOWNLOADS: Mutex<()> = Mutex::new(());

/// The cached copy if it's younger than MAX_AGE.
fn fresh(path: &Path) -> Option<Vec<u8>> {
    let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    if age < MAX_AGE { fs::read(path).ok() } else { None }
}

fn fetch_blocking(source: &Source) -> Result<Vec<u8>, String> {
    let dir = cache_dir();
    let path = dir.join(source.cache_name());
    if let Some(bytes) = fresh(&path) {
        return Ok(bytes);
    }
    let _guard = DOWNLOADS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Another request may have just downloaded it.
    if let Some(bytes) = fresh(&path) {
        return Ok(bytes);
    }

    let _ = fs::create_dir_all(&dir);
    let partial = path.with_extension("download");
    let url = source.url();
    let mut curl = Command::new("curl.exe");
    curl.args(["--fail", "--silent", "--show-error", "--location", "--compressed"])
        .args(["--max-time", "60", "--user-agent", USER_AGENT, "--output"])
        .arg(&partial)
        .arg(&url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // curl is a console program; don't flash a console window from the tray app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        curl.creation_flags(CREATE_NO_WINDOW);
    }
    let downloaded = match curl.output() {
        // Only valid JSON replaces the cache (an error page would be served for 12 hours).
        Ok(out) if out.status.success() => {
            let valid = match source {
                // 2 MB of tree for a 70 KB lookup: kept trimmed.
                Source::RepoePassives => fs::read(&partial)
                    .ok()
                    .and_then(|bytes| passive_ids(&bytes))
                    .is_some_and(|ids| fs::write(&partial, ids).is_ok()),
                _ => fs::read(&partial).is_ok_and(|bytes| {
                    serde_json::from_slice::<serde::de::IgnoredAny>(&bytes).is_ok()
                }),
            };
            if !valid {
                warn!("{url} didn't return JSON");
            }
            valid && fs::rename(&partial, &path).is_ok()
        }
        Ok(out) => {
            warn!("Downloading {url} failed: {}", String::from_utf8_lossy(&out.stderr).trim());
            false
        }
        Err(err) => {
            warn!("Couldn't run curl.exe for {url}: {err}");
            false
        }
    };
    if downloaded {
        info!("Downloaded {}", source.cache_name());
    } else {
        let _ = fs::remove_file(&partial);
    }
    // A stale copy beats nothing when the site can't be reached.
    fs::read(&path).map_err(|_| "Download failed. Check your connection.".to_string())
}

/// RePoE's tree as {"dexterity869": 13009, ...}: each passive's id and its node number.
fn passive_ids(tree: &[u8]) -> Option<Vec<u8>> {
    let tree: serde_json::Value = serde_json::from_slice(tree).ok()?;
    let passives = tree.get("passives")?.as_object()?;
    let ids: serde_json::Map<String, serde_json::Value> = passives
        .values()
        .filter_map(|p| Some((p.get("id")?.as_str()?.to_string(), p.get("hash")?.clone())))
        .collect();
    (!ids.is_empty()).then(|| serde_json::to_vec(&ids).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_sources_and_safe_leagues() {
        assert!(Source::parse("trade-stats", None, None).is_some());
        assert!(Source::parse("repoe-bases", None, None).is_some());
        assert!(Source::parse("repoe-passives", None, None).is_some());
        assert!(Source::parse("ninja", Some("Hardcore Mirage"), Some("BaseType")).is_some());
        assert!(Source::parse("ninja", Some("Mirage&x=1"), Some("BaseType")).is_none());
        assert!(Source::parse("ninja", Some("Mirage"), Some("Currency")).is_none());
        assert!(Source::parse("ninja", None, Some("BaseType")).is_none());
        assert!(Source::parse("anything", None, None).is_none());
    }

    #[test]
    fn keeps_passive_ids_only() {
        let tree = br#"{"passives":{"13009":{"id":"dexterity869","hash":13009,"name":"Dexterity"},"x":{"name":"no id"}}}"#;
        let ids: serde_json::Value = serde_json::from_slice(&passive_ids(tree).unwrap()).unwrap();
        assert_eq!(ids, serde_json::json!({"dexterity869": 13009}));
        assert!(passive_ids(b"{}").is_none());
    }
}
