//! Path of Building's calculations for the guide's Stats tab.
//!
//! The build bundles PoB's Lua code and game data (fetch-pob.ps1). On first use it is
//! unpacked to `%LOCALAPPDATA%\exile-leveling\pob\<version>` and run with LuaJIT on its
//! own thread, through PoB's headless mode. Unloaded again after a while unused.

use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

use mlua::{Function, Lua, LuaOptions, StdLib};
use tokio::sync::oneshot;
use tracing::{debug, error, info, warn};

static ARCHIVE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/pob/pob.zip"));
const VERSION: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/pob/version.txt"));
const HOST: &str = include_str!("pob-host.lua");
/// Frees PoB's memory (a few hundred MB) when the guide hasn't asked for stats in this long.
const IDLE: Duration = Duration::from_secs(10 * 60);

pub enum StatsError {
    /// A newer request came in; this one was dropped unanswered.
    Superseded,
    Failed(String),
}

struct Job {
    xml: String,
    loadout: Option<String>,
    reply: oneshot::Sender<Result<String, StatsError>>,
}

/// Handle to the PoB thread. PoB loads on the first request.
#[derive(Clone)]
pub struct Engine {
    jobs: mpsc::Sender<Job>,
}

impl Engine {
    pub fn start() -> Engine {
        let (jobs, rx) = mpsc::channel();
        if let Err(err) = thread::Builder::new().name("pob".into()).spawn(move || run(rx)) {
            error!("Couldn't start the PoB thread: {err}");
        }
        Engine { jobs }
    }

    /// PoB's sidebar stats for `loadout` (None: the loadout the build was saved on), as JSON.
    pub async fn stats(&self, xml: String, loadout: Option<String>) -> Result<String, StatsError> {
        let stopped = || StatsError::Failed("PoB isn't running".into());
        let (reply, answer) = oneshot::channel();
        self.jobs.send(Job { xml, loadout, reply }).map_err(|_| stopped())?;
        answer.await.map_err(|_| stopped())?
    }
}

fn run(jobs: mpsc::Receiver<Job>) {
    let mut pob: Option<Pob> = None;
    loop {
        let mut job = match jobs.recv_timeout(IDLE) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                if pob.take().is_some() {
                    info!("PoB unloaded (idle)");
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // Clicking through loadouts queues requests; only the newest matters.
        while let Ok(newer) = jobs.try_recv() {
            let _ = job.reply.send(Err(StatsError::Superseded));
            job = newer;
        }

        if pob.is_none() {
            match Pob::load() {
                Ok(loaded) => pob = Some(loaded),
                Err(msg) => {
                    error!("PoB didn't load: {msg}");
                    let _ = job.reply.send(Err(StatsError::Failed(msg)));
                    continue;
                }
            }
        }
        let Some(loaded) = pob.as_ref() else { continue };

        let started = Instant::now();
        let result = loaded.stats(&job.xml, job.loadout.as_deref());
        match &result {
            Ok(_) => debug!("PoB stats in {:.2}s", started.elapsed().as_secs_f32()),
            Err(msg) => {
                warn!("PoB stats failed: {msg}");
                // Start clean next time in case the error left PoB half-way through a load.
                pob = None;
            }
        }
        let _ = job.reply.send(result.map_err(StatsError::Failed));
    }
}

struct Pob {
    // Declared first so it drops before the Lua state it belongs to.
    stats: Function,
    _lua: Lua,
}

impl Pob {
    fn load() -> Result<Pob, String> {
        let started = Instant::now();
        let dir = unpack()?;
        // PoB is our own bundled code and needs the full standard library (debug, jit, bit).
        let lua = unsafe { Lua::unsafe_new_with(StdLib::ALL, LuaOptions::new()) };
        let setup = || -> mlua::Result<Function> {
            let globals = lua.globals();
            globals.set("host_dir", dir.to_string_lossy().replace('\\', "/"))?;
            globals.set(
                "host_log",
                lua.create_function(|_, line: String| {
                    debug!(target: "pob", "{line}");
                    Ok(())
                })?,
            )?;
            lua.load(HOST).set_name("pob-host").exec()?;
            globals.get::<Function>("host_stats")
        };
        let stats = setup().map_err(|err| err.to_string())?;
        info!("PoB {} loaded in {:.1}s", version(), started.elapsed().as_secs_f32());
        Ok(Pob { stats, _lua: lua })
    }

    fn stats(&self, xml: &str, loadout: Option<&str>) -> Result<String, String> {
        self.stats
            .call::<String>((xml, loadout))
            .map_err(|err| err.to_string())
    }
}

fn version() -> &'static str {
    VERSION.trim()
}

/// Unpacks the bundled PoB once per version and removes older copies.
fn unpack() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("exile-leveling")
        .join("pob");
    let dir = root.join(version());
    if dir.join(".complete").exists() {
        return Ok(dir);
    }

    let fail = |what: &str, err: &dyn std::fmt::Display| format!("Couldn't {what}: {err}");
    let partial = root.join(format!("{}.partial", version()));
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|err| fail("create the PoB folder", &err))?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(ARCHIVE)).map_err(|err| fail("read the bundled PoB", &err))?;
    archive
        .extract(&partial)
        .map_err(|err| fail("unpack PoB", &err))?;
    fs::write(partial.join(".complete"), version()).map_err(|err| fail("unpack PoB", &err))?;
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&partial, &dir).map_err(|err| fail("unpack PoB", &err))?;
    info!("PoB {} unpacked to {}", version(), dir.display());

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.path() != dir {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(dir)
}
