//! The one-time move from the old setup, where the guide opened in your last-used Edge
//! profile and its data (imported build, progress, layout) was saved there. Your profiles
//! may each hold some, so the guide is opened briefly in each; each sends what it has
//! ("state-offer:"), and the most complete becomes the exe's copy (saved_state.rs), which
//! the guide's own window then loads.

use std::time::{Duration, Instant};

use tracing::{info, warn};

use crate::saved_state::SavedState;
use crate::{edge, guide_window};

/// How long a profile's window gets to answer.
const ANSWER: Duration = Duration::from_secs(20);
/// Time for windows to close before the next one opens.
const SETTLE: Duration = Duration::from_millis(1500);

enum Phase {
    /// Old windows closing; then the next profile opens (or the move finishes).
    Closing(Instant),
    /// A profile's window is open, waiting for its answer.
    Waiting(Instant),
}

pub struct GuideMove {
    url: String,
    profiles: Vec<String>,
    next: usize,
    answers: usize,
    phase: Phase,
}

impl GuideMove {
    /// Needed when this exe ran before (its PoB or web caches exist) but has no copy of the
    /// guide's data yet: the data is still in your Edge profiles.
    pub fn needed(saved: &SavedState) -> bool {
        let dir = crate::data_dir();
        !saved.exists()
            && ["pob", "cache", "overlay.json"]
                .iter()
                .any(|name| dir.join(name).exists())
    }

    /// Closes the guide windows open from the old setup and starts with the first profile.
    pub fn start(url: &str) -> Self {
        let profiles = edge::profiles();
        info!(
            "Moving the guide's data from Edge profiles: {}",
            profiles.join(", ")
        );
        guide_window::close_all();
        Self {
            url: url.to_string(),
            profiles,
            next: 0,
            answers: 0,
            phase: Phase::Closing(Instant::now()),
        }
    }

    /// Steps the move along (from the tray loop). True once it's done and the exe's copy
    /// is saved; the caller then opens the guide's own window.
    pub fn tick(&mut self, saved: &SavedState) -> bool {
        match self.phase {
            Phase::Waiting(since) => {
                let answered = saved.offer_count() > self.answers;
                if answered || since.elapsed() >= ANSWER {
                    if !answered {
                        warn!(
                            "No answer from Edge profile {}",
                            self.profiles[self.next - 1]
                        );
                    }
                    self.answers = saved.offer_count();
                    guide_window::close_all();
                    self.phase = Phase::Closing(Instant::now());
                }
                false
            }
            Phase::Closing(since) if since.elapsed() >= SETTLE => {
                if let Some(profile) = self.profiles.get(self.next) {
                    self.next += 1;
                    if let Err(err) = edge::open_in_profile(profile, &self.url) {
                        warn!("Couldn't open Edge profile {profile}: {err}");
                    }
                    self.phase = Phase::Waiting(Instant::now());
                    return false;
                }
                // Done: the most complete profile's data, or nothing to move ("{}"), which
                // also marks the move done so it doesn't run again.
                match saved.best_offer() {
                    Some(best) => {
                        info!("Moved the guide's data ({} bytes)", best.len());
                        saved.save(&best);
                    }
                    None => {
                        info!("No guide data in Edge profiles to move");
                        saved.save("{}");
                    }
                }
                true
            }
            Phase::Closing(_) => false,
        }
    }
}
