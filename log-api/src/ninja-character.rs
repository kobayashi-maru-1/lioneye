//! Your live character from poe.ninja, for the guide's Compare and Build health: the PoB
//! code poe.ninja's character page shows ("Import code for Path of Building"). Only a
//! public poe.ninja profile can be read; nothing here signs in.
//!
//! - `parse_link()`: the character page's address,
//!   `https://poe.ninja/poe1/profile/<account>/<league>/character/<name>`, checked part by
//!   part (nothing else is ever fetched).
//! - `version()`: the character's current data version, the first event of the page's own
//!   event stream (`/poe1/api/events/character/…`). It changes when poe.ninja has re-read
//!   the character from the game.
//! - `fetch()`: that version's character (`/poe1/api/profile/characters/…/model/<n>`):
//!   level, class and `pathOfBuildingExport`.
//! - `characters()`: an account's characters, as its profile page lists them (the
//!   account's own stream for the version, then `/poe1/api/profile/characters/<account>/<n>`),
//!   for Settings to pick from.
//!
//! poe.ninja's own re-reads of a character can be an hour or more apart. Asking it to
//! re-read now (`account/refresh-character`) needs your poe.ninja login, so that runs in
//! Lioneye's poe.ninja window (ninja-window.rs), not here.

use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

use serde::Serialize;
use tracing::warn;

const USER_AGENT: &str = "Lioneye (leveling guide)";
/// The character's data: a level-90 build's is a few hundred KB.
const MAX_MODEL: usize = 8 * 1024 * 1024;

/// A character on poe.ninja: its profile's account, the league's address part, its name.
#[derive(Debug, Clone, PartialEq)]
pub struct Character {
    pub account: String,
    pub league: String,
    pub name: String,
}

/// Account names carry a "-1234" tag; character names are letters, digits and underscores;
/// league parts are lowercase with hyphens. Anything else is refused.
fn part_ok(part: &str, extra: &[char]) -> bool {
    !part.is_empty()
        && part.len() <= 64
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || extra.contains(&c))
}

/// The character a poe.ninja character page names.
pub fn parse_link(link: &str) -> Option<Character> {
    let link = link.trim();
    let rest = link
        .strip_prefix("https://poe.ninja/")
        .or_else(|| link.strip_prefix("poe.ninja/"))?;
    // Its language versions (/de/poe1/…) name the same character.
    let rest = rest
        .split_once("poe1/profile/")
        .filter(|(lang, _)| lang.is_empty() || part_ok(lang.trim_end_matches('/'), &[]))
        .map(|(_, rest)| rest)?;
    let rest = rest.split(['?', '#']).next()?;
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    let [account, league, "character", name] = parts.as_slice() else {
        return None;
    };
    (part_ok(account, &['-']) && part_ok(league, &['-']) && part_ok(name, &[])).then(|| {
        Character {
            account: account.to_string(),
            league: league.to_string(),
            name: name.to_string(),
        }
    })
}

/// curl without a console window.
fn curl() -> Command {
    let mut curl = Command::new("curl.exe");
    curl.args(["--silent", "--show-error", "--location", "--compressed"])
        .args(["--user-agent", USER_AGENT]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        curl.creation_flags(CREATE_NO_WINDOW);
    }
    curl
}

const NOT_REACHED: &str = "poe.ninja not reached. Retry";
const NOT_FOUND: &str = "Character not found. Check profile is public";

/// "data: {"version":3}" → 3.
fn version_event(line: &str) -> Option<u64> {
    let json = line.strip_prefix("data:")?.trim();
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("version")?
        .as_u64()
}

/// The character's current data version: the first event poe.ninja's stream sends (the
/// stream stays open for later ones; it's closed once the first arrives). Blocking.
pub fn version(character: &Character) -> Result<u64, String> {
    first_version(&format!(
        "https://poe.ninja/poe1/api/events/character/{}/{}/{}",
        character.account, character.league, character.name
    ))
}

/// An account name as poe.ninja's addresses spell it: "Name#1234" → "Name-1234".
pub fn parse_account(account: &str) -> Option<String> {
    let account = account.trim().replace('#', "-");
    part_ok(&account, &['-']).then_some(account)
}

/// A character on a poe.ninja profile, for the guide's list to pick from.
#[derive(Debug, Serialize, PartialEq)]
pub struct Listed {
    pub name: String,
    pub level: u32,
    pub class: String,
    /// The league's name ("Allflame") and its address part ("allflame").
    pub league: String,
    #[serde(rename = "leagueUrl")]
    pub league_url: String,
    /// The character you're playing now, as poe.ninja last saw.
    pub current: bool,
}

fn listed_from(list: &[u8]) -> Option<Vec<Listed>> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(list).ok()?;
    Some(
        list.iter()
            .filter_map(|c| {
                let text = |key: &str| c.get(key)?.as_str().map(str::to_string);
                let league_url = text("leagueUrl")?;
                let name = text("name")?;
                (part_ok(&league_url, &['-']) && part_ok(&name, &[])).then(|| Listed {
                    level: c.get("level").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    class: text("className").unwrap_or_default(),
                    league: text("league").unwrap_or_else(|| league_url.clone()),
                    current: c.get("isCurrent").and_then(|v| v.as_bool()).unwrap_or(false),
                    name,
                    league_url,
                })
            })
            .collect(),
    )
}

/// The characters on an account's public poe.ninja profile, as its page lists them.
/// Blocking.
pub fn characters(account: &str) -> Result<Vec<Listed>, String> {
    let version = first_version(&format!(
        "https://poe.ninja/poe1/api/events/characters/{account}"
    ))
    .map_err(|err| if err == NOT_FOUND { NO_PROFILE.into() } else { err })?;
    let url = format!("https://poe.ninja/poe1/api/profile/characters/{account}/{version}");
    let (status, body) = get(&url)?;
    match status.as_str() {
        "200" => listed_from(&body).ok_or_else(|| {
            warn!("poe.ninja's character list wasn't readable ({url})");
            NOT_REACHED.to_string()
        }),
        "404" | "401" | "403" => Err(NO_PROFILE.into()),
        _ => {
            warn!("poe.ninja answered {status} for {url}");
            Err(NOT_REACHED.into())
        }
    }
}

const NO_PROFILE: &str = "Profile not found. Check the name and that it's public";

/// A GET's status and body (at most MAX_MODEL bytes kept). Blocking.
fn get(url: &str) -> Result<(String, Vec<u8>), String> {
    let out = curl()
        .args(["--max-time", "30", "--write-out", "\n%{http_code}"])
        .args(["--max-filesize", &MAX_MODEL.to_string()])
        .arg(url)
        .output()
        .map_err(|err| {
            warn!("Couldn't run curl.exe for {url}: {err}");
            NOT_REACHED.to_string()
        })?;
    // Cut short (a timeout, too big): never read as an answer.
    if !out.status.success() {
        warn!("Reading {url} failed: curl exit {:?}", out.status.code());
        return Err(NOT_REACHED.into());
    }
    let body = out.stdout;
    let split = body.iter().rposition(|&b| b == b'\n').unwrap_or(0);
    let status = String::from_utf8_lossy(&body[split..]).trim().to_string();
    Ok((status, body[..split].to_vec()))
}

/// The first version event of one of poe.ninja's event streams. Blocking.
fn first_version(url: &str) -> Result<u64, String> {
    let url = url.to_string();
    let mut child = curl()
        .args(["--no-buffer", "--max-time", "15", "--write-out", "\nstatus:%{http_code}\n"])
        .args(["--header", "Accept: text/event-stream"])
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| {
            warn!("Couldn't run curl.exe for {url}: {err}");
            NOT_REACHED.to_string()
        })?;
    let mut found = None;
    let mut status = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if let Some(version) = version_event(&line) {
                found = Some(version);
                break;
            }
            if let Some(code) = line.strip_prefix("status:") {
                status = Some(code.trim().to_string());
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    match (found, status.as_deref()) {
        (Some(version), _) => Ok(version),
        (None, Some("404" | "401" | "403")) => Err(NOT_FOUND.into()),
        _ => Err(NOT_REACHED.into()),
    }
}

/// Your live character as the guide uses it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Live {
    pub version: u64,
    pub name: String,
    pub class: String,
    pub level: u32,
    /// The PoB code poe.ninja's page shows.
    pub code: String,
    /// When poe.ninja last saw it change (UTC, ISO 8601).
    pub updated: Option<String>,
}

/// The character's data (charModel) as the guide uses it; None when it isn't one.
fn live_from_model(version: u64, model: &[u8]) -> Option<Live> {
    let value: serde_json::Value = serde_json::from_slice(model).ok()?;
    let character = value.get("charModel")?;
    let text = |key: &str| character.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let code = text("pathOfBuildingExport").filter(|code| !code.is_empty())?;
    Some(Live {
        version,
        name: text("name")?,
        class: text("class").unwrap_or_default(),
        level: character.get("level")?.as_u64()?.try_into().ok()?,
        code,
        updated: text("updatedUtc"),
    })
}

/// The character at its current version. Blocking.
pub fn fetch(character: &Character) -> Result<Live, String> {
    let version = version(character)?;
    let url = format!(
        "https://poe.ninja/poe1/api/profile/characters/{}/{}/{}/model/{version}",
        character.account, character.league, character.name
    );
    let (status, model) = get(&url)?;
    match status.as_str() {
        "200" => live_from_model(version, &model).ok_or_else(|| {
            warn!("poe.ninja's character data had no PoB code ({url})");
            "No PoB code on poe.ninja yet. Retry later".to_string()
        }),
        "404" | "401" | "403" => Err(NOT_FOUND.into()),
        _ => {
            warn!("poe.ninja answered {status} for {url}");
            Err(NOT_REACHED.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_character_pages_are_read() {
        let page = "https://poe.ninja/poe1/profile/KobayashiRyu-5788/allflame/character/KobayashiSRS";
        let want = Character {
            account: "KobayashiRyu-5788".into(),
            league: "allflame".into(),
            name: "KobayashiSRS".into(),
        };
        assert_eq!(parse_link(page), Some(want.clone()));
        assert_eq!(parse_link(&format!("  {page}/?tab=items ")), Some(want.clone()));
        assert_eq!(
            parse_link("https://poe.ninja/de/poe1/profile/KobayashiRyu-5788/allflame/character/KobayashiSRS"),
            Some(want)
        );
        assert!(parse_link("https://evil.example/poe1/profile/a/b/character/c").is_none());
        assert!(parse_link("https://poe.ninja/poe1/profile/a/b/c").is_none());
        assert!(parse_link("https://poe.ninja/poe1/profile/a/b/character/c/../../x").is_none());
        assert!(parse_link("https://poe.ninja/poe1/profile/a b/l/character/c").is_none());
        assert!(parse_link("https://poe.ninja/poe1/profile/a/l%2F/character/c").is_none());
        assert!(parse_link("https://poe.ninja/poe2/profile/a/l/character/c").is_none());
    }

    /// Your character, read from poe.ninja: `cargo test fetches_a_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fetches_a_real_character() {
        let character = parse_link(
            "https://poe.ninja/poe1/profile/KobayashiRyu-5788/allflame/character/KobayashiSRS",
        )
        .unwrap();
        for listed in characters("KobayashiRyu-5788").unwrap() {
            println!("listed: {listed:?}");
        }
        let live = fetch(&character).unwrap();
        println!(
            "v{} {} {} level {} updated {:?}, code {} chars",
            live.version,
            live.name,
            live.class,
            live.level,
            live.updated,
            live.code.len()
        );
    }

    #[test]
    fn reads_accounts_and_lists() {
        assert_eq!(parse_account(" KobayashiRyu#5788 ").as_deref(), Some("KobayashiRyu-5788"));
        assert_eq!(parse_account("KobayashiRyu-5788").as_deref(), Some("KobayashiRyu-5788"));
        assert!(parse_account("a/b").is_none());
        assert!(parse_account("").is_none());
        let list = br#"[{"name":"Kob","level":27,"className":"Witch","league":"Allflame","leagueUrl":"allflame","isCurrent":true},{"name":"bad/name","leagueUrl":"x"}]"#;
        assert_eq!(
            listed_from(list),
            Some(vec![Listed {
                name: "Kob".into(),
                level: 27,
                class: "Witch".into(),
                league: "Allflame".into(),
                league_url: "allflame".into(),
                current: true,
            }])
        );
    }

    #[test]
    fn reads_the_version_event() {
        assert_eq!(version_event(r#"data: {"version":3}"#), Some(3));
        assert_eq!(version_event(": keep-alive"), None);
        assert_eq!(version_event("data: nope"), None);
    }

    #[test]
    fn reads_the_character() {
        let model = br#"{"type":"x","charModel":{"name":"Kob","class":"Witch","level":27,"pathOfBuildingExport":"eNrl","updatedUtc":"2026-11-08T18:51:36Z"}}"#;
        assert_eq!(
            live_from_model(3, model),
            Some(Live {
                version: 3,
                name: "Kob".into(),
                class: "Witch".into(),
                level: 27,
                code: "eNrl".into(),
                updated: Some("2026-11-08T18:51:36Z".into()),
            })
        );
        assert!(live_from_model(3, br#"{"charModel":{"name":"Kob","level":1,"pathOfBuildingExport":""}}"#).is_none());
        assert!(live_from_model(3, b"not json").is_none());
    }
}
