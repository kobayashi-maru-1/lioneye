use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::PathBuf,
};

use regex::RegexSet;

/// Bytes from the top of the log used to tell a new log file from the old one.
/// PoE starts each log with a timestamped "LOG FILE OPENING" line.
const FINGERPRINT_LEN: usize = 256;

pub struct Reader {
    path: PathBuf,
    patterns: RegexSet,
    byte_offset: u64,
    /// Start of the file being read. File times can't be trusted for this on
    /// Windows (NTFS keeps the old creation time for a quickly recreated file).
    fingerprint: Vec<u8>,
}

impl Reader {
    /// Reads lines added since the last call and passes the matching ones to `f`.
    pub fn read_latest(&mut self, mut f: impl FnMut(&str)) -> Result<(), std::io::Error> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        let head = fingerprint(&mut file)?;

        // Shrunk, or the top of the file changed: it's a new log, read it all.
        let same_start = head.len() >= self.fingerprint.len()
            && head[..self.fingerprint.len()] == self.fingerprint[..];
        if len < self.byte_offset || !same_start {
            self.byte_offset = 0;
        }
        self.fingerprint = head;

        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(self.byte_offset))?;

        // Only take complete lines; a line still being written is read next time.
        let mut buf = Vec::new();
        let mut offset = self.byte_offset;
        loop {
            buf.clear();
            let read = reader.read_until(b'\n', &mut buf)?;
            if read == 0 || buf.last() != Some(&b'\n') {
                break;
            }
            offset += read as u64;
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end_matches(['\r', '\n']);
            if self.patterns.matches(line).matched_any() {
                f(line)
            }
        }

        self.byte_offset = offset;
        Ok(())
    }
}

fn fingerprint(file: &mut File) -> Result<Vec<u8>, std::io::Error> {
    let mut head = Vec::with_capacity(FINGERPRINT_LEN);
    file.by_ref().take(FINGERPRINT_LEN as u64).read_to_end(&mut head)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(head)
}

/// Opens the log and skips to its end, so only new lines are reported.
pub fn build(path: impl Into<PathBuf>, patterns: RegexSet) -> Result<Reader, std::io::Error> {
    let path = path.into();
    let mut file = File::open(&path)?;
    let len = file.metadata()?.len();
    let fingerprint = fingerprint(&mut file)?;
    Ok(Reader {
        path,
        patterns,
        byte_offset: len,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_only_new_complete_matching_lines() {
        let dir = std::env::temp_dir().join(format!("exile-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Client.txt");
        std::fs::write(&path, "old line\r\n2026 Generating level 1 area \"1_1_1\"\r\n").unwrap();

        let patterns = RegexSet::new([r"Generating level \d+ area"]).unwrap();
        let mut reader = build(&path, patterns).unwrap();

        let mut seen = Vec::new();
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert!(seen.is_empty(), "existing lines are skipped");

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(f, "noise\r\n2026 Generating level 2 area \"1_1_2\" with seed 1\r\n2026 Generating level 3 area \"1_1_3\"").unwrap();
        drop(f);
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen, vec!["2026 Generating level 2 area \"1_1_2\" with seed 1"]);

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(f, " with seed 2\r\n").unwrap();
        drop(f);
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[1].contains("\"1_1_3\" with seed 2"));

        // Truncated or replaced: everything in it is new, so it's read from the start.
        std::fs::write(&path, "2026 Generating level 1 area \"1_1_town\" with seed 3\r\n").unwrap();
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen.len(), 3, "shrunk file read from the start");
        assert!(seen[2].contains("1_1_town"));

        // Replaced by a longer file with a different start (a quick game restart).
        let long = format!(
            "2026/11/05 ***** LOG FILE OPENING *****\r\n{}2026 Generating level 2 area \"1_1_2\" with seed 4\r\n",
            "filler line\r\n".repeat(20)
        );
        std::fs::write(&path, long).unwrap();
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen.len(), 4, "replaced file read from the start");
        assert!(seen[3].contains("1_1_2"));

        // Growing normally after that only reports new lines.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(f, "2026 Generating level 3 area \"1_1_3\" with seed 5\r\n").unwrap();
        drop(f);
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen.len(), 5);

        std::fs::remove_dir_all(&dir).ok();
    }
}
