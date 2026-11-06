//! Your character's passive points and quest points, read back from the game's log, so the
//! guide knows them even for a character started before the app (or before this run).
//!
//! - The character is the one the guide follows (its name, from level-up lines), else the
//!   one in the log's latest "<name> (<class>) is now level N" line.
//! - Its history starts at its "is now level 2" line, else at its first line the log still
//!   has. Party members' level-ups and deaths are logged too, so other names are ignored.
//! - "Successfully allocated passive skill id: <id>, name: <name>" lines are always the
//!   player's own (they name no character): all of them from the start count. A point taken
//!   on another of your characters in between would count too, and refunds aren't logged.
//! - "/passives" in game writes "N Passive Skill Points from quests:" and one "(N from
//!   <quest>)" line per quest: the latest such list is kept.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub struct CharacterLog {
    pub name: String,
    pub class: String,
    pub level: u32,
    /// Allocated passives' ids ("dexterity869"), in the order they were taken.
    pub allocated: Vec<String>,
    /// The latest "/passives" list: quest name and the points it gave.
    pub quests: Option<Vec<(String, u32)>>,
}

/// The line's message: what follows the "[INFO Client 1234] " prefix.
fn message(line: &str) -> &str {
    match line.find("] ") {
        Some(at) if line[..at].contains("Client") => &line[at + 2..],
        _ => line,
    }
}

/// ": KobayashiSRS (Witch) is now level 10" → (name, class, level).
pub fn level_up(message: &str) -> Option<(&str, &str, u32)> {
    let rest = message.strip_prefix(": ")?;
    let (who, level) = rest.rsplit_once(" is now level ")?;
    let level = level.trim().parse().ok()?;
    let (name, class) = who.rsplit_once(" (")?;
    let class = class.strip_suffix(')')?;
    (!name.is_empty() && !name.contains(' ')).then_some((name, class, level))
}

/// "Successfully allocated passive skill id: dexterity869, name: Dexterity" → the id.
pub fn allocated(message: &str) -> Option<&str> {
    let rest = message.strip_prefix("Successfully allocated passive skill id: ")?;
    let (id, _) = rest.split_once(", name: ")?;
    (!id.is_empty()).then_some(id)
}

/// ": 22 Passive Skill Points from quests:"
fn quests_header(message: &str) -> bool {
    message
        .strip_prefix(": ")
        .and_then(|rest| rest.strip_suffix(" Passive Skill Points from quests:"))
        .is_some_and(|n| n.parse::<u32>().is_ok())
}

/// ": (1 from The Marooned Mariner)" → (quest, points).
fn quest_line(message: &str) -> Option<(&str, u32)> {
    let rest = message.strip_prefix(": (")?.strip_suffix(')')?;
    let (points, quest) = rest.split_once(" from ")?;
    Some((quest, points.parse().ok()?))
}

/// The full log for a watched one: LatestClient.txt holds only this session, so its
/// Client.txt beside it (when there is one) has the history.
pub fn history_file(watched: &Path) -> PathBuf {
    let is_latest = watched
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("LatestClient.txt"));
    if is_latest {
        let full = watched.with_file_name("Client.txt");
        if full.is_file() {
            return full;
        }
    }
    watched.to_path_buf()
}

/// The last scan, reused while the log hasn't grown (pages refresh after many lines).
static LAST: Mutex<Option<(PathBuf, u64, Option<String>, Option<CharacterLog>)>> =
    Mutex::new(None);

/// `scan`, one at a time and cached until the log changes.
pub fn scan_cached(path: &Path, name: Option<&str>) -> std::io::Result<Option<CharacterLog>> {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let len = std::fs::metadata(path)?.len();
    if let Some((p, l, n, log)) = &*last
        && p == path
        && *l == len
        && n.as_deref() == name
    {
        return Ok(log.clone());
    }
    let log = scan(path, name)?;
    *last = Some((path.to_path_buf(), len, name.map(str::to_string), log.clone()));
    Ok(log)
}

/// Reads `name`'s history (else the latest character's) from the log at `path`; None when
/// the log doesn't name it.
pub fn scan(path: &Path, name: Option<&str>) -> std::io::Result<Option<CharacterLog>> {
    let mut file = File::open(path)?;
    let Some((name, class, level, start)) = find_character(&mut file, name)? else {
        return Ok(None);
    };
    file.seek(SeekFrom::Start(start))?;
    let mut log = CharacterLog {
        name,
        class,
        level,
        ..Default::default()
    };
    let mut list: Option<Vec<(String, u32)>> = None;
    for line in BufReader::new(file).split(b'\n') {
        let line = line?;
        let line = String::from_utf8_lossy(&line);
        let message = message(line.trim_end());
        if let Some(block) = &mut list {
            if let Some((quest, points)) = quest_line(message) {
                block.push((quest.to_string(), points));
                continue;
            }
            log.quests = list.take();
        }
        if let Some(id) = allocated(message) {
            log.allocated.push(id.to_string());
        } else if quests_header(message) {
            list = Some(Vec::new());
        }
    }
    if list.is_some() {
        log.quests = list;
    }
    Ok(Some(log))
}

/// The character (name, class, level from its latest level-up) and where its history
/// starts: its level 2 line, else its earliest level-up line in the log. Reads backwards.
fn find_character(
    file: &mut File,
    wanted: Option<&str>,
) -> std::io::Result<Option<(String, String, u32, u64)>> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let len = file.metadata()?.len();
    let mut end = len;
    // The start of a line cut by the chunk boundary, carried to the next (earlier) chunk.
    let mut carry: Vec<u8> = Vec::new();
    // (name, class, level) from the latest level-up, and the earliest offset seen for it.
    let mut found: Option<(String, String, u32)> = None;
    let mut earliest = 0u64;
    while end > 0 {
        let begin = end.saturating_sub(CHUNK);
        let mut buf = vec![0u8; (end - begin) as usize];
        file.seek(SeekFrom::Start(begin))?;
        file.read_exact(&mut buf)?;
        buf.extend_from_slice(&carry);
        // Lines whose start is in this chunk (the first may be partial unless begin is 0).
        let first_break = if begin == 0 {
            0
        } else {
            match buf.iter().position(|&b| b == b'\n') {
                Some(at) => at + 1,
                None => {
                    carry = buf;
                    end = begin;
                    continue;
                }
            }
        };
        let mut line_end = buf.len();
        let mut at = buf.len();
        while at > first_break {
            at -= 1;
            if buf[at] == b'\n' || at == first_break {
                let line_start = if buf[at] == b'\n' { at + 1 } else { at };
                if line_start < line_end {
                    let line = String::from_utf8_lossy(&buf[line_start..line_end]);
                    if let Some((name, class, level)) = level_up(message(line.trim_end())) {
                        let offset = begin + line_start as u64;
                        let ours = match (&found, wanted) {
                            (Some((current, _, _)), _) => current == name,
                            (None, Some(wanted)) => wanted == name,
                            (None, None) => true,
                        };
                        if ours {
                            if found.is_none() {
                                found = Some((name.to_string(), class.to_string(), level));
                            }
                            earliest = offset;
                            if level == 2 {
                                let (name, class, level) = found.take().unwrap_or_default();
                                return Ok(Some((name, class, level, offset)));
                            }
                        }
                    }
                }
                line_end = at;
            }
        }
        carry = buf[..first_break].to_vec();
        end = begin;
    }
    Ok(found.map(|(name, class, level)| (name, class, level, earliest)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "2026/11/06 10:00:00 123 abc [INFO Client 52060]";

    fn write(lines: &[&str], tag: &str) -> PathBuf {
        let text: String = lines.iter().map(|l| format!("{P} {l}\n")).collect();
        let path = std::env::temp_dir().join(format!("lioneye-{tag}-{}.txt", std::process::id()));
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn reads_the_lines() {
        assert_eq!(
            level_up(message(&format!("{P} : KobayashiSRS (Witch) is now level 10"))),
            Some(("KobayashiSRS", "Witch", 10))
        );
        assert_eq!(
            allocated(message(&format!(
                "{P} Successfully allocated passive skill id: dexterity869, name: Dexterity"
            ))),
            Some("dexterity869")
        );
        assert!(quests_header(message(&format!("{P} : 22 Passive Skill Points from quests:"))));
        assert_eq!(
            quest_line(message(&format!("{P} : (0 from The Dweller of the Deep)"))),
            Some(("The Dweller of the Deep", 0))
        );
        // Chat isn't a system line.
        assert!(level_up(message(&format!("{P} #Bob: Alice (Witch) is now level 9"))).is_none());
    }

    #[test]
    fn follows_the_named_character_past_party_members() {
        let path = write(
            &[
                ": Old (Ranger) is now level 2",
                "Successfully allocated passive skill id: old1, name: X",
                ": New (Witch) is now level 2",
                "Successfully allocated passive skill id: new1, name: A",
                // A party member levels and dies: still your points.
                ": Friend (Ranger) is now level 30",
                "Successfully allocated passive skill id: new2, name: B",
                ": Friend has been slain.",
                ": 2 Passive Skill Points from quests:",
                ": (1 from The Dweller of the Deep)",
                ": (0 from The Marooned Mariner)",
                ": You have entered The Coast.",
                ": New (Witch) is now level 4",
                ": Friend (Ranger) is now level 31",
            ],
            "party",
        );
        let log = scan(&path, Some("New")).unwrap().unwrap();
        // Unnamed, the latest level-up (a party member) would be picked: the guide names it.
        let latest = scan(&path, None).unwrap().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!((log.name.as_str(), log.class.as_str(), log.level), ("New", "Witch", 4));
        assert_eq!(log.allocated, ["new1", "new2"]);
        assert_eq!(
            log.quests,
            Some(vec![
                ("The Dweller of the Deep".to_string(), 1),
                ("The Marooned Mariner".to_string(), 0)
            ])
        );
        assert_eq!(latest.name, "Friend");
    }

    #[test]
    fn starts_at_level_two_or_the_characters_first_line() {
        // Just reached level 2: its own line starts it.
        let path = write(
            &[
                "Successfully allocated passive skill id: other1, name: X",
                ": New (Witch) is now level 2",
                "Successfully allocated passive skill id: new1, name: A",
            ],
            "two",
        );
        let log = scan(&path, Some("New")).unwrap().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(log.allocated, ["new1"]);

        // Its level 2 is gone from the log: from its first level-up the log still has.
        let path = write(
            &[
                "Successfully allocated passive skill id: other1, name: X",
                ": New (Witch) is now level 40",
                "Successfully allocated passive skill id: new1, name: A",
                ": New (Witch) is now level 41",
            ],
            "old",
        );
        let log = scan(&path, Some("New")).unwrap().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(log.allocated, ["new1"]);
        assert_eq!(log.level, 41);
    }

    #[test]
    fn reads_client_txt_beside_latest() {
        let dir = std::env::temp_dir().join(format!("lioneye-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let latest = dir.join("LatestClient.txt");
        std::fs::write(&latest, "").unwrap();
        assert_eq!(history_file(&latest), latest);
        std::fs::write(dir.join("Client.txt"), "").unwrap();
        assert_eq!(history_file(&latest), dir.join("Client.txt"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
