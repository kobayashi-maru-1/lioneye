//! Your character's passive points and quest points, read back from the game's log, so the
//! guide knows them even for a character started before the app (or before this run).
//!
//! - The character is the one in the log's latest "<name> (<class>) is now level N" line.
//! - Its history starts at its "is now level 2" line (the start of the log when that's gone).
//! - From there, "Successfully allocated passive skill id: <id>, name: <name>" lines are its
//!   points while it's the one playing (the last level-up or death line names who that is;
//!   the allocation lines themselves name no character). Refunds aren't logged.
//! - "/passives" in game writes "N Passive Skill Points from quests:" and one "(N from
//!   <quest>)" line per quest: the latest such list for the character is kept.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
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

/// ": KobayashiSRS has been slain." → the name.
fn slain(message: &str) -> Option<&str> {
    let name = message.strip_prefix(": ")?.strip_suffix(" has been slain.")?;
    (!name.is_empty() && !name.contains(' ')).then_some(name)
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

/// Reads the character's history from the log at `path`; None when the log names none.
pub fn scan(path: &Path) -> std::io::Result<Option<CharacterLog>> {
    let mut file = File::open(path)?;
    let Some((name, class, level, start)) = find_character(&mut file)? else {
        return Ok(None);
    };
    file.seek(SeekFrom::Start(start))?;
    let mut log = CharacterLog {
        name: name.clone(),
        class,
        level,
        ..Default::default()
    };
    let mut playing = true;
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
        if let Some((who, _, _)) = level_up(message) {
            playing = who == name;
        } else if let Some(who) = slain(message) {
            playing = who == name;
        } else if playing {
            if let Some(id) = allocated(message) {
                log.allocated.push(id.to_string());
            } else if quests_header(message) {
                list = Some(Vec::new());
            }
        }
    }
    if list.is_some() {
        log.quests = list;
    }
    Ok(Some(log))
}

/// The latest character (name, class, level) and where its history starts: its level 2
/// line, else the start of the file. Reads backwards in chunks.
fn find_character(file: &mut File) -> std::io::Result<Option<(String, String, u32, u64)>> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let len = file.metadata()?.len();
    let mut end = len;
    // The start of a line cut by the chunk boundary, carried to the next (earlier) chunk.
    let mut carry: Vec<u8> = Vec::new();
    let mut found: Option<(String, String, u32)> = None;
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
                        match &found {
                            None => {
                                found = Some((name.to_string(), class.to_string(), level));
                            }
                            Some((current, _, _)) if current == name && level == 2 => {
                                let (name, class, level) = found.unwrap();
                                return Ok(Some((name, class, level, begin + line_start as u64)));
                            }
                            _ => {}
                        }
                    }
                }
                line_end = at;
            }
        }
        carry = buf[..first_break].to_vec();
        end = begin;
    }
    Ok(found.map(|(name, class, level)| (name, class, level, 0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "2026/11/06 10:00:00 123 abc [INFO Client 52060]";

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
        assert_eq!(slain(message(&format!("{P} : KobayashiSRS has been slain."))), Some("KobayashiSRS"));
        assert!(quests_header(message(&format!("{P} : 22 Passive Skill Points from quests:"))));
        assert_eq!(
            quest_line(message(&format!("{P} : (0 from The Dweller of the Deep)"))),
            Some(("The Dweller of the Deep", 0))
        );
        // Chat isn't a system line.
        assert!(level_up(message(&format!("{P} #Bob: Alice (Witch) is now level 9"))).is_none());
    }

    #[test]
    fn keeps_the_latest_characters_history() {
        let lines = [
            ": Old (Ranger) is now level 2",
            "Successfully allocated passive skill id: old1, name: X",
            ": New (Witch) is now level 2",
            "Successfully allocated passive skill id: new1, name: A",
            ": Old (Ranger) is now level 3",
            "Successfully allocated passive skill id: old2, name: Y",
            ": New has been slain.",
            "Successfully allocated passive skill id: new2, name: B",
            ": 2 Passive Skill Points from quests:",
            ": (1 from The Dweller of the Deep)",
            ": (0 from The Marooned Mariner)",
            ": You have entered The Coast.",
            ": New (Witch) is now level 4",
        ];
        let text: String = lines.iter().map(|l| format!("{P} {l}\n")).collect();
        let path = std::env::temp_dir().join(format!("lioneye-client-{}.txt", std::process::id()));
        std::fs::write(&path, text).unwrap();
        let log = scan(&path).unwrap().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(log.name, "New");
        assert_eq!(log.class, "Witch");
        assert_eq!(log.level, 4);
        assert_eq!(log.allocated, ["new1", "new2"]);
        assert_eq!(
            log.quests,
            Some(vec![
                ("The Dweller of the Deep".to_string(), 1),
                ("The Marooned Mariner".to_string(), 0)
            ])
        );
    }
}
