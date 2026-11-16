//! Path of Building's calculations for the guide's Stats tab.
//!
//! The build bundles PoB's Lua code and game data (fetch-pob.ps1). On first use it is
//! unpacked to `%LOCALAPPDATA%\exile-leveling\pob\<version>-<bundle hash>` (`pob-dev` for dev
//! and test builds), unpacked again if that copy goes missing, and run with LuaJIT on its own
//! thread, through PoB's headless mode. Unloaded again after a while unused.
//! Timeless jewel data is too big to bundle; it's downloaded from the same PoB release the
//! first time a build needs it, and kept with the unpacked copy.

use std::{
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        OnceLock,
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use mlua::{Function, Lua, LuaOptions, StdLib};
use tokio::sync::oneshot;
use tracing::{debug, error, info, warn};

static ARCHIVE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/pob/pob.zip"));
const VERSION: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/pob/version.txt"));
const REPO: &str = "PathOfBuildingCommunity/PathOfBuilding";
const HOST: &str = include_str!("pob-host.lua");
/// Path to a pob-host.lua to use instead of the built-in one (development only).
const HOST_OVERRIDE: &str = "EXILE_LEVELING_POB_HOST";
/// Frees PoB's memory (about 500 MB) when no guide has been open and asking for stats for
/// this long. While a guide is open PoB stays loaded: loading it again costs a loadout
/// switch 5-10 s (PoB, the build and its timeless jewel data).
const IDLE: Duration = Duration::from_secs(10 * 60);
/// pob-host.lua starts errors that leave PoB usable with this, so PoB stays loaded.
const KEEP: &str = "[keep] ";

/// The guide's remembered main skill: matched by skill gem in each loadout (see pob-host.lua).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    /// PoB's granted effect id of the active skill, e.g. `SummonRagingSpirit`.
    pub id: String,
    /// Socket group label, group position and skill position it was picked from; they
    /// break ties when a loadout has the gem in more than one place.
    pub label: Option<String>,
    pub group: Option<i64>,
    pub skill: Option<i64>,
    pub part: Option<String>,
    pub minion: Option<String>,
    pub minion_skill: Option<String>,
}

/// What a job asks PoB for.
#[derive(Clone, Copy)]
enum Kind {
    /// The guide's stats answer (host_stats).
    Stats,
    /// Compare's numbers (host_compare); `full` adds the source tables and the stats answer.
    Compare { full: bool },
}

struct Job {
    kind: Kind,
    xml: String,
    loadout: Option<String>,
    pick: Option<Pick>,
    reply: oneshot::Sender<Result<String, String>>,
}

/// Handle to the PoB thread. PoB loads on the first request.
#[derive(Clone)]
pub struct Engine {
    jobs: mpsc::Sender<Job>,
}

impl Engine {
    /// `keep`: whether PoB should stay loaded though idle (a guide page is open).
    pub fn start(keep: impl Fn() -> bool + Send + 'static) -> Engine {
        let (jobs, rx) = mpsc::channel();
        if let Err(err) = thread::Builder::new().name("pob".into()).spawn(move || run(rx, keep)) {
            error!("Couldn't start the PoB thread: {err}");
        }
        Engine { jobs }
    }

    /// PoB's sidebar stats for `loadout` as JSON. None: the loadout the build was saved on
    /// when the build is new to PoB, else the loadout picked last. No pick: PoB's own main skill.
    pub async fn stats(
        &self,
        xml: String,
        loadout: Option<String>,
        pick: Option<Pick>,
    ) -> Result<String, String> {
        self.ask(Kind::Stats, xml, loadout, pick).await
    }

    /// Compare's numbers for a build (see host_compare in pob-host.lua) as JSON. Jobs share
    /// the guide's queue, so Compare sends one at a time and the guide never waits long.
    pub async fn compare(
        &self,
        xml: String,
        loadout: Option<String>,
        pick: Option<Pick>,
        full: bool,
    ) -> Result<String, String> {
        self.ask(Kind::Compare { full }, xml, loadout, pick).await
    }

    async fn ask(
        &self,
        kind: Kind,
        xml: String,
        loadout: Option<String>,
        pick: Option<Pick>,
    ) -> Result<String, String> {
        let stopped = || "PoB isn't running. Restart the app.".to_string();
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Job { kind, xml, loadout, pick, reply })
            .map_err(|_| stopped())?;
        answer.await.map_err(|_| stopped())?
    }
}

fn run(jobs: mpsc::Receiver<Job>, keep: impl Fn() -> bool) {
    let mut pob: Option<Pob> = None;
    loop {
        let job = match jobs.recv_timeout(IDLE) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                if keep() {
                    continue;
                }
                if pob.take().is_some() {
                    info!("PoB unloaded (idle)");
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // The guide stopped waiting (it moved on to another loadout, or closed).
        if job.reply.is_closed() {
            continue;
        }

        // Something removed the unpacked copy under a loaded PoB (another copy of the app
        // unpacking a different bundle clears the others): PoB would fail on every module it
        // hasn't loaded yet. Load it again, which unpacks it again.
        if pob.as_ref().is_some_and(|loaded| !loaded.dir.join(".complete").exists()) {
            warn!("PoB's unpacked copy is gone; loading it again");
            pob = None;
        }
        let cold = pob.is_none();
        let started = Instant::now();
        if cold {
            match Pob::load() {
                Ok(loaded) => pob = Some(loaded),
                Err(msg) => {
                    error!("PoB didn't load: {msg}");
                    let _ = job.reply.send(Err(msg));
                    continue;
                }
            }
        }
        let Some(loaded) = pob.as_ref() else { continue };

        let answer = match job.kind {
            Kind::Stats => loaded.stats(&job.xml, job.loadout.as_deref(), job.pick.as_ref()),
            Kind::Compare { full } => loaded.compare(&job.xml, job.loadout.as_deref(), job.pick.as_ref(), full),
        };
        let what = match job.kind {
            Kind::Stats => "stats",
            Kind::Compare { full: true } => "compare (full)",
            Kind::Compare { full: false } => "compare",
        };
        let result = match answer {
            Ok(json) => {
                // Logged so a slow loadout switch can be told apart from a slow page.
                info!(
                    "PoB {what} for {} in {:.1}s{}",
                    job.loadout.as_deref().unwrap_or("the saved loadout"),
                    started.elapsed().as_secs_f32(),
                    if cold { " (PoB loaded first)" } else { "" }
                );
                Ok(json)
            }
            Err(msg) => match msg.strip_prefix(KEEP) {
                Some(msg) => {
                    warn!("PoB stats failed: {msg}");
                    Err(msg.to_string())
                }
                None => {
                    warn!("PoB stats failed, reloading next time: {msg}");
                    pob = None;
                    Err(msg)
                }
            },
        };
        let _ = job.reply.send(result);
    }
}

struct Pob {
    // Declared first so they drop before the Lua state they belong to.
    stats: Function,
    compare: Function,
    _lua: Lua,
    /// The unpacked copy this PoB runs from.
    dir: PathBuf,
    /// `.complete`, held open while PoB is loaded (see `hold`).
    _hold: fs::File,
}

impl Pob {
    fn load() -> Result<Pob, String> {
        let started = Instant::now();
        let dir = unpack()?;
        let hold = hold(&dir).map_err(|err| format!("Couldn't open the unpacked PoB: {err}"))?;
        // For working on pob-host.lua without rebuilding the exe.
        let host = match std::env::var_os(HOST_OVERRIDE) {
            Some(path) => {
                info!("Using {} from {}", HOST_OVERRIDE, Path::new(&path).display());
                fs::read_to_string(&path).map_err(|err| format!("Couldn't read {HOST_OVERRIDE}: {err}"))?
            }
            None => HOST.to_string(),
        };
        // PoB is our own bundled code and needs the full standard library (debug, jit, bit).
        let lua = unsafe { Lua::unsafe_new_with(StdLib::ALL, LuaOptions::new()) };
        let setup = || -> mlua::Result<(Function, Function)> {
            let globals = lua.globals();
            globals.set("host_dir", dir.to_string_lossy().replace('\\', "/"))?;
            globals.set(
                "host_log",
                lua.create_function(|_, line: mlua::String| {
                    debug!(target: "pob", "{}", line.to_string_lossy());
                    Ok(())
                })?,
            )?;
            globals.set(
                "host_inflate",
                lua.create_function(|lua, data: mlua::String| {
                    let mut out = Vec::new();
                    flate2::read::ZlibDecoder::new(&data.as_bytes()[..])
                        .read_to_end(&mut out)
                        .map_err(|err| mlua::Error::runtime(format!("Couldn't unpack PoB data: {err}")))?;
                    lua.create_string(out)
                })?,
            )?;
            let fetch_dir = dir.clone();
            globals.set(
                "host_fetch",
                lua.create_function(move |_, path: String| Ok(fetch(&fetch_dir, &path)))?,
            )?;
            lua.load(host.as_str()).set_name("pob-host").exec()?;
            Ok((globals.get::<Function>("host_stats")?, globals.get::<Function>("host_compare")?))
        };
        let (stats, compare) = setup().map_err(|err| message(&err))?;
        info!("PoB {} loaded in {:.1}s", version(), started.elapsed().as_secs_f32());
        Ok(Pob { stats, compare, _lua: lua, dir, _hold: hold })
    }

    fn stats(&self, xml: &str, loadout: Option<&str>, pick: Option<&Pick>) -> Result<String, String> {
        let (id, label, group, skill, part, minion, minion_skill) = pick_args(pick);
        self.stats
            .call::<mlua::String>((xml, loadout, id, label, group, skill, part, minion, minion_skill))
            .map(|json| json.to_string_lossy())
            .map_err(|err| message(&err))
    }

    fn compare(&self, xml: &str, loadout: Option<&str>, pick: Option<&Pick>, full: bool) -> Result<String, String> {
        let (id, label, group, skill, part, minion, minion_skill) = pick_args(pick);
        self.compare
            .call::<mlua::String>((xml, loadout, full, id, label, group, skill, part, minion, minion_skill))
            .map(|json| json.to_string_lossy())
            .map_err(|err| message(&err))
    }
}

/// A pick as host_stats' and host_compare's arguments (all nil without one).
#[allow(clippy::type_complexity)]
fn pick_args(
    pick: Option<&Pick>,
) -> (
    Option<&str>,
    Option<&str>,
    Option<i64>,
    Option<i64>,
    Option<&str>,
    Option<&str>,
    Option<&str>,
) {
    pick.map(|p| {
            (
                Some(p.id.as_str()),
                p.label.as_deref(),
                p.group,
                p.skill,
                p.part.as_deref(),
                p.minion.as_deref(),
                p.minion_skill.as_deref(),
            )
    })
    .unwrap_or_default()
}

/// One line for the guide: the error itself, without Lua's "runtime error:" or the traceback.
fn message(err: &mlua::Error) -> String {
    let text = match err {
        mlua::Error::CallbackError { cause, .. } => return message(cause),
        mlua::Error::RuntimeError(msg) => msg.clone(),
        other => other.to_string(),
    };
    let first = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("PoB failed");
    first.strip_prefix("runtime error: ").unwrap_or(first).to_string()
}

/// The bundled PoB release, e.g. "v2.67.2".
pub fn version() -> &'static str {
    VERSION.trim()
}

/// `<version>-<hash of the bundle>`: a rebuilt bundle of the same release unpacks fresh.
fn bundle_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let mut hasher = DefaultHasher::new();
        ARCHIVE.hash(&mut hasher);
        format!("{}-{:08x}", version(), hasher.finish() as u32)
    })
}

/// Unpacks the bundled PoB once and removes copies from other bundles that aren't in use.
/// Debug builds (cargo test, dev runs) use their own folder, apart from the installed app's.
fn unpack() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("exile-leveling")
        .join(if cfg!(debug_assertions) { "pob-dev" } else { "pob" });
    let dir = root.join(bundle_name());
    if dir.join(".complete").exists() {
        return Ok(dir);
    }

    let fail = |what: &str, err: &dyn std::fmt::Display| format!("Couldn't {what}: {err}");
    let partial = root.join(format!("{}.partial", bundle_name()));
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|err| fail("create the PoB folder", &err))?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(ARCHIVE)).map_err(|err| fail("read the bundled PoB", &err))?;
    archive
        .extract(&partial)
        .map_err(|err| fail("unpack PoB", &err))?;
    fs::write(partial.join(".complete"), bundle_name()).map_err(|err| fail("unpack PoB", &err))?;
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&partial, &dir).map_err(|err| fail("unpack PoB", &err))?;
    info!("PoB unpacked to {}", dir.display());

    // Copies another running copy of the app has loaded are held (see `hold`) and stay; so do
    // folders another copy is still unpacking into, unless they were left behind long ago.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path == dir {
                continue;
            }
            let unpacking = path.extension().is_some_and(|ext| ext == "partial")
                && entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_none_or(|age| age < Duration::from_secs(60 * 60));
            if !unpacking {
                let _ = fs::remove_dir_all(&path);
            }
        }
    }
    Ok(dir)
}

/// Opens `dir`'s `.complete` for as long as PoB runs from `dir`. On Windows it is opened
/// without delete sharing, so another copy of the app clearing old unpacked copies fails on
/// it (the first entry it meets) and leaves this one whole.
fn hold(dir: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(dir.join(".complete"))
}

/// True for the timeless jewel files PoB may ask for: `Data/TimelessJewelData/<Name>.zip`
/// or `<Name>.zip.part<N>`.
fn is_jewel_file(path: &str) -> bool {
    let Some(name) = path.strip_prefix("Data/TimelessJewelData/") else {
        return false;
    };
    let Some((stem, rest)) = name.split_once(".zip") else {
        return false;
    };
    !stem.is_empty()
        && stem.chars().all(|c| c.is_ascii_alphanumeric())
        && (rest.is_empty()
            || rest
                .strip_prefix(".part")
                .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())))
}

/// Downloads one timeless jewel file from the bundled PoB release into `dir`.
/// False when it doesn't exist there (PoB tries `.zip`, then `.zip.part0`, `.part1`, ...).
fn fetch(dir: &Path, path: &str) -> bool {
    if !is_jewel_file(path) {
        warn!("PoB asked to download {path}; only timeless jewel data is allowed");
        return false;
    }
    let target = dir.join(path);
    let partial = target.with_extension("download");
    let url = format!("https://raw.githubusercontent.com/{REPO}/{}/src/{path}", version());
    let started = Instant::now();

    let mut curl = Command::new("curl.exe");
    curl.args(["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--output"])
        .arg(&partial)
        .arg(&url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // curl is a console program; don't flash a console window from the tray app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        curl.creation_flags(CREATE_NO_WINDOW);
    }
    let ok = match curl.output() {
        Ok(out) if out.status.success() => fs::rename(&partial, &target).is_ok(),
        Ok(out) => {
            // 22: HTTP error, e.g. 404 for a part number past the last one.
            if out.status.code() != Some(22) {
                warn!("Downloading {url} failed: {}", String::from_utf8_lossy(&out.stderr).trim());
            }
            false
        }
        Err(err) => {
            warn!("Couldn't run curl.exe to download {url}: {err}");
            false
        }
    };
    if !ok {
        let _ = fs::remove_file(&partial);
    } else {
        info!("Downloaded {path} in {:.1}s", started.elapsed().as_secs_f32());
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::is_jewel_file;

    /// For working on pob-host.lua: runs the bundled PoB on a build and writes the guide's
    /// JSON. `POB_DUMP_XML=build.xml POB_DUMP_OUT=out.json cargo test dump_stats -- --ignored`
    /// (POB_DUMP_LOADOUT picks a loadout; POB_DUMP_COMPARE=1 writes Compare's full answer).
    #[test]
    #[ignore]
    fn dump_stats() {
        let xml = std::fs::read_to_string(std::env::var("POB_DUMP_XML").expect("POB_DUMP_XML")).unwrap();
        let loadout = std::env::var("POB_DUMP_LOADOUT").ok();
        let pob = super::Pob::load().unwrap();
        let json = if std::env::var("POB_DUMP_COMPARE").is_ok() {
            pob.compare(&xml, loadout.as_deref(), None, true).unwrap()
        } else {
            pob.stats(&xml, loadout.as_deref(), None).unwrap()
        };
        std::fs::write(std::env::var("POB_DUMP_OUT").expect("POB_DUMP_OUT"), json).unwrap();
    }

    /// Another copy of the app clearing old unpacked copies can't remove the one a loaded PoB
    /// runs from. Needs a build, and runs alone (it tries to remove `pob-dev`'s copy):
    /// `POB_DUMP_XML=build.xml cargo test loaded_copy_survives_cleanup -- --ignored --test-threads=1`
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn loaded_copy_survives_cleanup() {
        let xml = std::fs::read_to_string(std::env::var("POB_DUMP_XML").expect("POB_DUMP_XML")).unwrap();
        let engine = super::Engine::start(|| true);
        engine.stats(xml.clone(), None, None).await.unwrap();
        let dir = super::unpack().unwrap();
        assert!(std::fs::remove_dir_all(&dir).is_err());
        assert!(dir.join(".complete").exists());
        assert!(dir.join("Modules").join("CalcBreakdown.lua").exists());
        engine.stats(xml, None, None).await.unwrap();
    }

    #[test]
    fn only_timeless_jewel_files_download() {
        assert!(is_jewel_file("Data/TimelessJewelData/LethalPride.zip"));
        assert!(is_jewel_file("Data/TimelessJewelData/GloriousVanity.zip.part0"));
        assert!(is_jewel_file("Data/TimelessJewelData/AbyssKurgal.zip.part12"));
        assert!(!is_jewel_file("Data/TimelessJewelData/../../Launch.lua"));
        assert!(!is_jewel_file("Data/TimelessJewelData/x.zip.part"));
        assert!(!is_jewel_file("Data/TimelessJewelData/.zip"));
        assert!(!is_jewel_file("Data/TimelessJewelData/a/b.zip"));
        assert!(!is_jewel_file("Data/TimelessJewelData/LethalPride.zip.exe"));
        assert!(!is_jewel_file("Modules/Main.lua"));
    }
}
