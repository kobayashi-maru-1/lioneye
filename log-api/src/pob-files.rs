//! Path of Building on this PC (PoB Community or PoB Redux, the guide's Editor setting),
//! for the guide's Open and Edit buttons, and the build file the guide is linked to.
//!
//! - `find()`: the installed PoB (its uninstall entry, else the installer's default folder)
//!   and the folder it saves builds to. PoB's own rules (Launch.lua, Main.lua): an installed
//!   copy (`installed.cfg` beside the exe) keeps its data in `Documents\Path of Building`, a
//!   portable one in its own folder; builds go to `Builds` there unless "Build save path" is
//!   set (`buildPath` on `<Misc>` in its `Settings.xml`).
//! - `find_redux()`: PoB Redux (its uninstall entry, else `%LOCALAPPDATA%\PoB Redux`). It
//!   opens a build file named on its command line, in a new window, and saves builds to
//!   `Documents\Path of Building\Builds` unless its `settings.json` names another folder.
//! - `open_dialog()`: Windows' Open dialog for a build file, in that folder (else Downloads).
//! - `read_build()`, `save_build()`: a build file read, or a new one written (never over an
//!   existing file), checked to be PoB's XML.
//! - `edit()`: PoB opened on a build. PoB reopens the build its `Settings.xml` names as the
//!   last one open, so that entry is set first. A PoB already running stays as it is; a
//!   second PoB window opens on the build.
//! - `watch()`: the linked file, polled; pages hear "pob-file:changed" after PoB saves it.

use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use tokio::sync::{broadcast, watch};
use tracing::{info, warn};

/// The largest build file read or written (a big build's XML is a few MB).
pub const MAX_BUILD: u64 = 32 * 1024 * 1024;
/// What a missing file reads as (the guide tells it apart: the linked file moved).
pub const NOT_FOUND: &str = "File not found";
/// How often the linked file is checked for a save.
const POLL: Duration = Duration::from_secs(1);

/// An installed Path of Building Community.
#[derive(Debug, Clone)]
pub struct Pob {
    pub exe: PathBuf,
    /// Where it keeps `Settings.xml` (and, by default, `Builds`).
    pub data: PathBuf,
}

impl Pob {
    pub fn settings_file(&self) -> PathBuf {
        self.data.join("Settings.xml")
    }

    /// The folder PoB saves builds to: "Build save path" from its settings, else `Builds`.
    pub fn builds_dir(&self) -> PathBuf {
        std::fs::read_to_string(self.settings_file())
            .ok()
            .and_then(|settings| custom_build_path(&settings))
            .unwrap_or_else(|| self.data.join("Builds"))
    }
}

/// The installed PoB Community, if any (PoE 1; the PoE 2 version is a separate program).
#[cfg(windows)]
pub fn find() -> Option<Pob> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    const KEYS: [&str; 2] = [
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Path of Building Community",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Path of Building Community",
    ];
    let listed = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .flat_map(|root| KEYS.iter().map(move |key| (root, *key)))
        .filter_map(|(root, key)| crate::edge::registry_string(root, key, Some("InstallLocation")))
        .map(|dir| PathBuf::from(dir.trim().trim_matches('"')));
    // The installer's default, in case the entry is missing.
    let default = std::env::var_os("APPDATA")
        .map(|appdata| PathBuf::from(appdata).join("Path of Building Community"));
    let dir = listed
        .chain(default)
        .find(|dir| dir.join("Path of Building.exe").is_file())?;
    let data = if dir.join("installed.cfg").is_file() {
        known_folder(Folder::Documents)?.join("Path of Building")
    } else {
        dir.clone()
    };
    Some(Pob {
        exe: dir.join("Path of Building.exe"),
        data,
    })
}

#[cfg(not(windows))]
pub fn find() -> Option<Pob> {
    None
}

/// Which PoB the guide's Edit opens (its Editor setting).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    #[default]
    Community,
    Redux,
}

pub const NO_POB: &str = "PoB not found. Install PoB Community";
pub const NO_REDUX: &str = "PoB Redux not found. Install it or change Editor";

/// An installed PoB Redux.
#[derive(Debug, Clone)]
pub struct Redux {
    pub exe: PathBuf,
}

impl Redux {
    /// Its builds folder: the PoE 1 folder its settings name, else
    /// `Documents\Path of Building\Builds` (as PoB Community's installed copy).
    pub fn builds_dir(&self) -> Option<PathBuf> {
        std::env::var_os("APPDATA")
            .map(|appdata| {
                PathBuf::from(appdata)
                    .join("dev.pobredux.desktop")
                    .join("settings.json")
            })
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|settings| redux_build_path(&settings))
            .or_else(|| {
                known_folder(Folder::Documents).map(|docs| docs.join("Path of Building").join("Builds"))
            })
    }
}

/// The PoE 1 builds folder PoB Redux's `settings.json` names, when set.
fn redux_build_path(settings: &str) -> Option<PathBuf> {
    let settings: serde_json::Value = serde_json::from_str(settings).ok()?;
    let path = settings.get("builds_dirs")?.get("poe1")?.as_str()?.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The installed PoB Redux, if any.
#[cfg(windows)]
pub fn find_redux() -> Option<Redux> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    const KEYS: [&str; 2] = [
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PoB Redux",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\PoB Redux",
    ];
    let listed = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .flat_map(|root| KEYS.iter().map(move |key| (root, *key)))
        .filter_map(|(root, key)| crate::edge::registry_string(root, key, Some("InstallLocation")))
        .map(|dir| PathBuf::from(dir.trim().trim_matches('"')));
    // The installer's default, in case the entry is missing.
    let default = std::env::var_os("LOCALAPPDATA")
        .map(|local| PathBuf::from(local).join("PoB Redux"));
    let exe = listed
        .chain(default)
        .map(|dir| dir.join("pob-redux.exe"))
        .find(|exe| exe.is_file())?;
    Some(Redux { exe })
}

#[cfg(not(windows))]
pub fn find_redux() -> Option<Redux> {
    None
}

/// The builds folder of the chosen editor (where "Save to PoB?" writes).
pub fn builds_dir(editor: Editor) -> Result<PathBuf, String> {
    match editor {
        Editor::Community => find().map(|pob| pob.builds_dir()).ok_or_else(|| NO_POB.into()),
        Editor::Redux => find_redux()
            .ok_or_else(|| NO_REDUX.to_string())?
            .builds_dir()
            .ok_or_else(|| "Builds folder not found. Change Editor".into()),
    }
}

/// Opens the chosen editor on `build`.
pub fn edit_with(editor: Editor, build: &Path) -> Result<(), String> {
    match editor {
        Editor::Community => edit(&find().ok_or_else(|| NO_POB.to_string())?, build),
        Editor::Redux => edit_redux(&find_redux().ok_or_else(|| NO_REDUX.to_string())?, build),
    }
}

/// Opens PoB Redux on `build` (a new Redux window; one already open stays as it is).
pub fn edit_redux(redux: &Redux, build: &Path) -> Result<(), String> {
    if !is_xml(build) || !build.is_file() {
        return Err(NOT_FOUND.into());
    }
    let dir = redux.exe.parent().unwrap_or(Path::new("."));
    std::process::Command::new(&redux.exe)
        .arg(build)
        .current_dir(dir)
        .spawn()
        .map_err(|err| {
            warn!("Couldn't start {}: {err}", redux.exe.display());
            "PoB Redux not started. Reinstall it".to_string()
        })?;
    info!("Opened {} in PoB Redux", build.display());
    Ok(())
}

/// Where the Open dialog starts: PoB Community's builds folder when it exists, else PoB
/// Redux's, else Downloads.
pub fn open_dir(pob: Option<&Pob>) -> Option<PathBuf> {
    pob.map(Pob::builds_dir)
        .filter(|dir| dir.is_dir())
        .or_else(|| {
            find_redux()
                .and_then(|redux| redux.builds_dir())
                .filter(|dir| dir.is_dir())
        })
        .or_else(|| known_folder(Folder::Downloads))
}

#[derive(Clone, Copy)]
enum Folder {
    #[cfg_attr(not(windows), allow(dead_code))]
    Documents,
    Downloads,
}

/// A folder as Windows reports it (Documents may be moved, e.g. into OneDrive).
#[cfg(windows)]
fn known_folder(folder: Folder) -> Option<PathBuf> {
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Documents, FOLDERID_Downloads, SHGetKnownFolderPath},
    };
    let id = match folder {
        Folder::Documents => &FOLDERID_Documents,
        Folder::Downloads => &FOLDERID_Downloads,
    };
    let mut path: *mut u16 = std::ptr::null_mut();
    let status = unsafe { SHGetKnownFolderPath(id, 0 as _, std::ptr::null_mut(), &mut path) };
    let result = (status == 0 && !path.is_null()).then(|| {
        let len = (0..).take_while(|&i| unsafe { *path.add(i) } != 0).count();
        PathBuf::from(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(path, len)
        }))
    });
    unsafe { CoTaskMemFree(path as *const _) };
    result
}

#[cfg(not(windows))]
fn known_folder(_folder: Folder) -> Option<PathBuf> {
    None
}

/// "Build save path" from PoB's `Settings.xml`, when set.
fn custom_build_path(settings: &str) -> Option<PathBuf> {
    let misc = regex::Regex::new(r#"<Misc\b[^>]*\bbuildPath="([^"]*)""#).ok()?;
    let path = unescape(misc.captures(settings)?.get(1)?.as_str());
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// PoB's `Settings.xml` with the last open build set to `path` (named `name`), as PoB
/// writes it. `settings` None (no file yet): a new file with only that. None when the
/// file has content but no place for it (not PoB's settings): it's never replaced.
fn with_last_build(settings: Option<&str>, path: &Path, name: &str) -> Option<String> {
    let path = path.to_string_lossy().replace('\\', "/");
    let mode = format!(
        "<Mode mode=\"BUILD\">\n\t\t<Arg string=\"{}\"/>\n\t\t<Arg string=\"{}\"/>\n\t</Mode>",
        escape(&path),
        escape(name)
    );
    let existing = regex::Regex::new(r"(?s)<Mode\b[^>]*?(?:/>|>.*?</Mode>)").expect("valid regex");
    let root = regex::Regex::new(r"<PathOfBuilding\b[^>]*>").expect("valid regex");
    match settings {
        Some(settings) if existing.is_match(settings) => {
            Some(existing.replace(settings, regex::NoExpand(&mode)).into_owned())
        }
        Some(settings) if root.is_match(settings) => {
            let at = root.find(settings)?.end();
            Some(format!("{}\n\t{mode}{}", &settings[..at], &settings[at..]))
        }
        Some(settings) if !settings.trim().is_empty() => None,
        _ => Some(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<PathOfBuilding>\n\t{mode}\n</PathOfBuilding>\n"
        )),
    }
}

/// Looks like a build PoB saved (or exported): its root and its Build element.
pub fn is_build(xml: &str) -> bool {
    xml.contains("<PathOfBuilding") && xml.contains("<Build")
}

fn is_xml(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
}

const NOT_A_BUILD: &str = "Not a PoB build. Open another file";

/// A build file's XML (without a byte-order mark). Retries briefly while PoB is still
/// writing it.
pub fn read_build(path: &Path) -> Result<String, String> {
    if !is_xml(path) {
        return Err(NOT_A_BUILD.into());
    }
    let mut last = String::new();
    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        match std::fs::metadata(path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(NOT_FOUND.into());
            }
            Ok(meta) if meta.len() > MAX_BUILD => {
                return Err("File too big. Open another file".into());
            }
            _ => {}
        }
        match std::fs::read(path) {
            Ok(bytes) => {
                let xml = String::from_utf8_lossy(&bytes);
                let xml = xml.strip_prefix('\u{feff}').unwrap_or(&xml);
                if is_build(xml) {
                    return Ok(xml.to_string());
                }
                // Empty or cut short: PoB may be mid-save.
                last = NOT_A_BUILD.into();
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(NOT_FOUND.into());
            }
            Err(err) => {
                warn!("Couldn't read {}: {err}", path.display());
                last = "File not read. Retry".into();
            }
        }
    }
    Err(last)
}

/// A file name from a build's name: no characters or names Windows refuses, not empty.
fn file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !r#"<>:"/\|?*"#.contains(*c))
        .collect();
    let cleaned: String = cleaned.trim().trim_end_matches('.').chars().take(80).collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    let upper = cleaned.to_ascii_uppercase();
    let device = |prefix: &str| {
        upper.strip_prefix(prefix).is_some_and(|n| {
            n.chars().count() == 1 && n.chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c))
        })
    };
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || device("COM")
        || device("LPT");
    if cleaned.is_empty() || reserved {
        "Lioneye build".into()
    } else {
        cleaned.into()
    }
}

/// Writes `xml` as a new build in `dir`, named after `name` ("name (2)" if that's taken).
pub fn save_build(dir: &Path, name: &str, xml: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    if !is_build(xml) {
        return Err("Build not saved. Import it again".into());
    }
    let failed = |err: std::io::Error| {
        warn!("Couldn't save a build in {}: {err}", dir.display());
        "Not saved. Retry".to_string()
    };
    std::fs::create_dir_all(dir).map_err(failed)?;
    let stem = file_stem(name);
    for n in 1..100 {
        let file = if n == 1 {
            format!("{stem}.xml")
        } else {
            format!("{stem} ({n}).xml")
        };
        let path = dir.join(file);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut out) => {
                if let Err(err) = out.write_all(xml.as_bytes()) {
                    drop(out);
                    // No half-written build left in PoB's list.
                    let _ = std::fs::remove_file(&path);
                    return Err(failed(err));
                }
                info!("Saved build to {}", path.display());
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(failed(err)),
        }
    }
    Err("Name in use. Try another name".into())
}

/// Opens PoB on `build`: sets it as PoB's last open build, then starts PoB. PoB's settings
/// are only changed when they read cleanly; otherwise nothing is written.
pub fn edit(pob: &Pob, build: &Path) -> Result<(), String> {
    if !is_xml(build) || !build.is_file() {
        return Err(NOT_FOUND.into());
    }
    let name = build
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = pob.settings_file();
    let unreadable = |why: String| {
        warn!("Left PoB's settings alone ({}): {why}", file.display());
        "PoB settings not read. Open the build in PoB".to_string()
    };
    let current = match std::fs::read(&file) {
        Ok(bytes) => Some(String::from_utf8(bytes).map_err(|err| unreadable(err.to_string()))?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(unreadable(err.to_string())),
    };
    let updated = with_last_build(current.as_deref(), build, &name)
        .ok_or_else(|| unreadable("no PathOfBuilding element".into()))?;
    if current.as_deref() != Some(updated.as_str()) {
        let not_saved = |err: std::io::Error| {
            warn!("Couldn't write {}: {err}", file.display());
            "PoB settings not saved. Close PoB and retry".to_string()
        };
        std::fs::create_dir_all(&pob.data).map_err(not_saved)?;
        // Written beside and moved over, so PoB never reads half a file.
        let temp = pob.data.join("Settings.xml.lioneye");
        std::fs::write(&temp, &updated).map_err(not_saved)?;
        std::fs::rename(&temp, &file).map_err(|err| {
            let _ = std::fs::remove_file(&temp);
            not_saved(err)
        })?;
    }
    // PoB finds its files from the folder it starts in.
    let dir = pob.exe.parent().unwrap_or(Path::new("."));
    std::process::Command::new(&pob.exe)
        .current_dir(dir)
        .spawn()
        .map_err(|err| {
            warn!("Couldn't start {}: {err}", pob.exe.display());
            "PoB not started. Reinstall PoB Community".to_string()
        })?;
    info!("Opened {} in PoB", build.display());
    Ok(())
}

/// A path the guide may link: a local `.xml` file named by a full path with a drive letter.
/// Never a network path (`\\server\share`): checking one would contact that server.
pub fn linkable(path: &str) -> Option<PathBuf> {
    let bytes = path.as_bytes();
    let drive = bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let short = path.len() <= 1024;
    let path = PathBuf::from(path);
    (drive && short && is_xml(&path)).then_some(path)
}

/// The build file each guide page is linked to. The watched file is the one a page named
/// most recently; a page that closes, or has none, never stops another page's watch.
pub struct Links {
    pages: std::sync::Mutex<Vec<(u64, PathBuf)>>,
    next: std::sync::atomic::AtomicU64,
    pub watched: watch::Sender<Option<PathBuf>>,
}

impl Links {
    pub fn new() -> Self {
        Self {
            pages: Default::default(),
            next: Default::default(),
            watched: watch::channel(None).0,
        }
    }

    /// An id for a newly connected page.
    pub fn page(&self) -> u64 {
        self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// The page's linked file (None: none).
    pub fn set(&self, page: u64, path: Option<PathBuf>) {
        let mut pages = self.pages.lock().unwrap_or_else(|e| e.into_inner());
        pages.retain(|(id, _)| *id != page);
        if let Some(path) = path {
            pages.push((page, path));
        }
        self.update(&pages);
    }

    pub fn closed(&self, page: u64) {
        self.set(page, None);
    }

    fn update(&self, pages: &[(u64, PathBuf)]) {
        let latest = pages.last().map(|(_, path)| path.clone());
        self.watched.send_if_modified(|watched| {
            let changed = *watched != latest;
            *watched = latest;
            changed
        });
    }
}

/// Windows' Open dialog for a PoB build, starting in `dir`; None when cancelled.
/// Blocks until it closes: run it off the async runtime.
#[cfg(windows)]
pub fn open_dialog(dir: Option<&Path>) -> Option<PathBuf> {
    use windows_sys::Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::{
            Controls::Dialogs::{
                GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
                OFN_PATHMUSTEXIST, OPENFILENAMEW,
            },
            WindowsAndMessaging::GetForegroundWindow,
        },
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    // Each entry: label, pattern; the list ends with an extra 0.
    let filter: Vec<u16> = "PoB builds (*.xml)\0*.xml\0All files\0*.*\0\0".encode_utf16().collect();
    let title = wide("Open build");
    let initial = dir.map(|dir| wide(&dir.to_string_lossy()));
    let mut file = vec![0u16; 4096];

    // The dialog needs COM on its thread (single-threaded apartment).
    let com = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    // Over the guide's window (the one you clicked Open in).
    ofn.hwndOwner = unsafe { GetForegroundWindow() };
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file.as_mut_ptr();
    ofn.nMaxFile = file.len() as u32;
    ofn.lpstrInitialDir = initial.as_ref().map_or(std::ptr::null(), |dir| dir.as_ptr());
    ofn.lpstrTitle = title.as_ptr();
    ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    let chosen = unsafe { GetOpenFileNameW(&mut ofn) } != 0;
    if com >= 0 {
        unsafe { CoUninitialize() };
    }
    if !chosen {
        return None;
    }
    let len = file.iter().position(|&c| c == 0).unwrap_or(file.len());
    Some(PathBuf::from(String::from_utf16_lossy(&file[..len])))
}

#[cfg(not(windows))]
pub fn open_dialog(_dir: Option<&Path>) -> Option<PathBuf> {
    None
}

/// What a save looks like from outside: modified time and size. Checked off the async
/// runtime, so a slow disk never holds up the guide's other messages.
async fn stamp(path: Option<PathBuf>) -> Option<(SystemTime, u64)> {
    let path = path?;
    tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(path).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    })
    .await
    .ok()
    .flatten()
}

/// Watches the build file the guide is linked to (`linked`: `Links::watched`) and tells
/// pages "pob-file:changed" once a save has settled (unchanged for one more check).
pub async fn watch(mut linked: watch::Receiver<Option<PathBuf>>, saved: broadcast::Sender<String>) {
    let mut path = linked.borrow_and_update().clone();
    let mut last = stamp(path.clone()).await;
    let mut pending: Option<(SystemTime, u64)> = None;
    let mut timer = tokio::time::interval(POLL);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            changed = linked.changed() => {
                if changed.is_err() { return; }
                let next = linked.borrow_and_update().clone();
                if next != path {
                    path = next;
                    if let Some(path) = &path {
                        info!("Watching {} for PoB saves", path.display());
                    }
                    last = stamp(path.clone()).await;
                    pending = None;
                }
            }
            _ = timer.tick() => {
                if path.is_none() { continue; }
                let now = stamp(path.clone()).await;
                if now.is_none() || now == last {
                    pending = None;
                    continue;
                }
                if pending == now {
                    // Settled: tell the pages.
                    last = now;
                    pending = None;
                    if saved.send("pob-file:changed".into()).is_err() {
                        warn!("No page heard the PoB save");
                    }
                } else {
                    pending = now;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<PathOfBuilding>\n\t<Mode mode=\"BUILD\">\n\t\t<Arg string=\"C:/Builds/old.xml\"/>\n\t\t<Arg string=\"old\"/>\n\t</Mode>\n\t<Misc buildSortMode=\"NAME\" buildPath=\"D:/My &amp; Builds/\"/>\n</PathOfBuilding>\n";

    #[test]
    fn last_build_replaces_the_mode_only() {
        let out =
            with_last_build(Some(SETTINGS), Path::new(r#"C:\B\new & "x".xml"#), "new").unwrap();
        assert!(out.contains("<Arg string=\"C:/B/new &amp; &quot;x&quot;.xml\"/>"));
        assert!(out.contains("<Arg string=\"new\"/>"));
        assert!(!out.contains("old.xml"));
        assert!(out.contains("<Misc buildSortMode=\"NAME\""));
        assert_eq!(out.matches("<Mode").count(), 1);
    }

    #[test]
    fn last_build_added_when_missing() {
        let no_mode = "<PathOfBuilding>\n\t<Misc/>\n</PathOfBuilding>";
        let out = with_last_build(Some(no_mode), Path::new("C:/a.xml"), "a").unwrap();
        assert!(out.starts_with("<PathOfBuilding>\n\t<Mode mode=\"BUILD\">"));
        assert!(out.contains("<Misc/>"));
        let empty = with_last_build(Some(""), Path::new("C:/a.xml"), "a").unwrap();
        assert!(empty.starts_with("<?xml"));
        let fresh = with_last_build(None, Path::new("C:/a.xml"), "a").unwrap();
        assert!(fresh.contains("<Mode mode=\"BUILD\">") && fresh.ends_with("</PathOfBuilding>\n"));
        let self_closed = "<PathOfBuilding><Mode mode=\"LIST\"/></PathOfBuilding>";
        let out = with_last_build(Some(self_closed), Path::new("C:/a.xml"), "a").unwrap();
        assert!(!out.contains("LIST") && out.contains("<Arg string=\"a\"/>"));
        let attributed = "<PathOfBuilding version=\"2\">\n</PathOfBuilding>";
        let out = with_last_build(Some(attributed), Path::new("C:/a.xml"), "a").unwrap();
        assert!(out.starts_with("<PathOfBuilding version=\"2\">\n\t<Mode"));
    }

    #[test]
    fn other_files_never_replaced() {
        let not_pob = with_last_build(Some("<html>not PoB</html>"), Path::new("C:/a.xml"), "a");
        assert_eq!(not_pob, None);
        assert_eq!(with_last_build(Some("garbage"), Path::new("C:/a.xml"), "a"), None);
    }

    #[test]
    fn only_local_xml_files_are_linked() {
        assert!(linkable(r"C:\Users\me\Builds\a.xml").is_some());
        assert!(linkable("D:/Builds/a.XML").is_some());
        assert!(linkable(r"\\server\share\a.xml").is_none());
        assert!(linkable("//server/share/a.xml").is_none());
        assert!(linkable(r"C:\Windows\win.ini").is_none());
        assert!(linkable("a.xml").is_none());
        assert!(linkable("").is_none());
    }

    #[test]
    fn a_page_without_a_file_never_stops_the_watch() {
        let links = Links::new();
        let (own, other) = (links.page(), links.page());
        links.set(own, Some(PathBuf::from("C:/a.xml")));
        links.set(other, None);
        assert_eq!(*links.watched.borrow(), Some(PathBuf::from("C:/a.xml")));
        links.set(other, Some(PathBuf::from("C:/b.xml")));
        assert_eq!(*links.watched.borrow(), Some(PathBuf::from("C:/b.xml")));
        links.closed(other);
        assert_eq!(*links.watched.borrow(), Some(PathBuf::from("C:/a.xml")));
        links.closed(own);
        assert_eq!(*links.watched.borrow(), None);
    }

    #[test]
    fn custom_build_path_read() {
        assert_eq!(custom_build_path(SETTINGS), Some(PathBuf::from("D:/My & Builds/")));
        assert_eq!(custom_build_path("<Misc buildSortMode=\"NAME\"/>"), None);
        assert_eq!(custom_build_path("<Misc buildPath=\"  \"/>"), None);
    }

    #[test]
    fn redux_build_path_read() {
        let set = r#"{"game":"poe1","builds_dirs":{"poe1":"D:\\PoB\\Builds","poe2":"E:\\x"}}"#;
        assert_eq!(redux_build_path(set), Some(PathBuf::from(r"D:\PoB\Builds")));
        assert_eq!(redux_build_path(r#"{"game":"poe1","builds_dirs":{}}"#), None);
        assert_eq!(redux_build_path(r#"{"builds_dirs":{"poe1":"  "}}"#), None);
        assert_eq!(redux_build_path(r#"{"builds_dirs":{"poe2":"E:\\x"}}"#), None);
        assert_eq!(redux_build_path("not json"), None);
    }

    #[test]
    fn editor_names_read() {
        let read = |json: &str| serde_json::from_str::<Editor>(json).ok();
        assert_eq!(read(r#""community""#), Some(Editor::Community));
        assert_eq!(read(r#""redux""#), Some(Editor::Redux));
        assert_eq!(read(r#""other""#), None);
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_stem("Necro: SRS/HRoC?"), "Necro SRSHRoC");
        assert_eq!(file_stem("  ..  "), "Lioneye build");
        assert_eq!(file_stem("con"), "Lioneye build");
        assert_eq!(file_stem("COM1"), "Lioneye build");
        assert_eq!(file_stem("lpt9"), "Lioneye build");
        assert_eq!(file_stem("COM10"), "COM10");
        assert_eq!(file_stem("COM¹"), "Lioneye build");
        assert_eq!(file_stem("Build."), "Build");
        assert_eq!(file_stem(&"x".repeat(200)).len(), 80);
    }

    /// This PC's PoB, as the guide would see it: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn finds_this_pcs_pob() {
        let pob = find();
        println!("PoB: {pob:?}");
        println!("Builds: {:?}", pob.as_ref().map(Pob::builds_dir));
        println!("Open starts in: {:?}", open_dir(pob.as_ref()));
        let redux = find_redux();
        println!("Redux: {redux:?}");
        println!("Redux builds: {:?}", redux.as_ref().and_then(Redux::builds_dir));
        println!("Downloads: {:?}", known_folder(Folder::Downloads));
    }

    #[test]
    fn saves_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("lioneye-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let xml = "<PathOfBuilding><Build/></PathOfBuilding>";
        let first = save_build(&dir, "Necro", xml).unwrap();
        let second = save_build(&dir, "Necro", xml).unwrap();
        assert_eq!(first.file_name().unwrap(), "Necro.xml");
        assert_eq!(second.file_name().unwrap(), "Necro (2).xml");
        assert_eq!(read_build(&second).unwrap(), xml);
        assert!(save_build(&dir, "Bad", "<html/>").is_err());
        let bom = dir.join("bom.xml");
        std::fs::write(&bom, format!("\u{feff}{xml}")).unwrap();
        assert_eq!(read_build(&bom).unwrap(), xml);
        assert!(read_build(&dir.join("missing.xml")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
