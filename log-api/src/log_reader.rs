use std::{
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::PathBuf,
};

use regex::RegexSet;

pub struct Reader {
    path: PathBuf,
    patterns: RegexSet,
    byte_offset: u64,
}

impl Reader {
    /// Reads lines added since the last call and passes the matching ones to `f`.
    pub fn read_latest(&mut self, mut f: impl FnMut(&str)) -> Result<(), std::io::Error> {
        let file = File::open(&self.path)?;
        let len = file.metadata()?.len();

        // The file was replaced or truncated: skip what is already there.
        if len < self.byte_offset {
            self.byte_offset = len;
            return Ok(());
        }

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

/// Opens the log and skips to its end, so only new lines are reported.
pub fn build(path: impl Into<PathBuf>, patterns: RegexSet) -> Result<Reader, std::io::Error> {
    let path = path.into();
    let len = File::open(&path)?.metadata()?.len();
    Ok(Reader {
        path,
        patterns,
        byte_offset: len,
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

        std::fs::write(&path, "fresh\r\n").unwrap();
        reader.read_latest(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen.len(), 2, "truncation skips");

        std::fs::remove_dir_all(&dir).ok();
    }
}
