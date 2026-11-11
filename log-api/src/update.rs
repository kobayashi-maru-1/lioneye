//! Self-update: finds a newer release on GitHub, and on request (the tray's Update item or
//! the footer's install icon) downloads it, checks it against GitHub's checksum and the
//! release key's signature, swaps the exe and restarts.
//!
//! The signature (`lioneye.zip.minisig`, made by tools/sign-release on the publisher's PC)
//! is what makes an update trusted: the secret key never reaches GitHub, so a taken-over
//! GitHub account can't ship one. A release without it isn't offered.
//!
//! Windows won't overwrite a running exe but lets it be renamed: the running copy becomes
//! `lioneye.exe.old`, the new one takes its name, and is started with `--after-update <pid>`
//! so it waits for this copy to let go of the port. The new copy signals a named event as
//! soon as it runs; without that signal within a minute, this copy stops it and puts the old exe
//! back. The new copy deletes the `.old` file.
//! Files this exe downloads itself carry no mark of the web, so SmartScreen doesn't ask.

use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

const REPO: &str = "kobayashi-maru-1/lioneye";
const ASSET: &str = "lioneye.zip";
/// lioneye.zip's minisign signature, uploaded with each release.
const SIGNATURE: &str = "lioneye.zip.minisig";
/// The release key's public half (minisign's format). An update installs only when signed
/// with its secret half, and only for the tag the signature names.
const RELEASE_KEY: &str = include_str!("../release-key.pub");
const EXE_IN_ZIP: &str = "lioneye.exe";
/// How often the exe asks GitHub by itself.
pub const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// The first check, once the app is up.
const FIRST_CHECK: Duration = Duration::from_secs(5);
/// Larger than any real release; a bad answer can't fill memory.
const MAX_DOWNLOAD: usize = 200 * 1024 * 1024;
/// A download still running after this is given up (a trickle never times out on its own).
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(5 * 60);
/// How long the new copy gets to show it runs: a first run of a new unsigned exe can be
/// held by antivirus a while. A copy that runs signals at once, so this costs nothing then.
const START_LIMIT: Duration = Duration::from_secs(60);
/// How long the new copy runs before the old exe is deleted: kept until then as a fallback.
const KEEP_OLD: Duration = Duration::from_secs(60);

/// Held while the exe is being swapped, so Quit doesn't end the process halfway.
static SWAP: Mutex<()> = Mutex::new(());
/// Set once this copy is quitting: no swap starts after that.
static CLOSING: AtomicBool = AtomicBool::new(false);

/// Stops any new swap and waits for one under way to finish (it puts the old exe back);
/// called before the process ends.
pub fn wait_for_swap() {
    CLOSING.store(true, Ordering::SeqCst);
    drop(SWAP.lock().unwrap_or_else(|e| e.into_inner()));
}

/// The command-line flag the new copy is started with: the old copy's process id.
pub const AFTER_UPDATE: &str = "--after-update";

#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    /// "v0.4.36"
    pub tag: String,
    /// The release's page.
    pub url: String,
    /// lioneye.zip's SHA-256, lowercase hex, from GitHub.
    pub sha256: Option<String>,
    /// Has lioneye.zip.minisig: only a signed release is offered.
    pub signed: bool,
}

impl Release {
    /// One this exe would install: newer, and signed.
    fn installable(&self, version: &str) -> bool {
        self.signed && newer(&self.tag, version)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Installing,
    Failed,
}

/// What the footer and the tray show.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    /// A signed release newer than this exe, if GitHub has one.
    pub latest: Option<LatestView>,
    pub state: Phase,
    /// Why the last install failed, a short phrase ("GitHub not reached").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LatestView {
    pub tag: String,
    pub url: String,
}

struct Inner {
    /// The newest release seen, newer than this exe or not.
    latest: Option<Release>,
    checked: Option<Instant>,
    checking: bool,
    phase: Phase,
    error: Option<String>,
    /// Raised on every change, so the tray redraws only then.
    generation: u64,
}

impl Inner {
    /// A new answer from GitHub; a failure to install another release no longer applies.
    fn set_latest(&mut self, release: Release) {
        let other_tag = self.latest.as_ref().is_some_and(|r| r.tag != release.tag);
        if other_tag && self.phase == Phase::Failed {
            self.phase = Phase::Idle;
            self.error = None;
        }
        self.latest = Some(release);
        self.generation += 1;
    }
}

pub struct Updater {
    version: &'static str,
    inner: Mutex<Inner>,
    /// Quits this copy once the new one is started (the tray loop's restart).
    restart: fn(),
}

impl Updater {
    pub fn new(version: &'static str, restart: fn()) -> Arc<Updater> {
        Arc::new(Updater {
            version,
            inner: Mutex::new(Inner {
                latest: None,
                checked: None,
                checking: false,
                phase: Phase::Idle,
                error: None,
                generation: 0,
            }),
            restart,
        })
    }

    /// Checks shortly after start, then every 6 hours, on a thread of its own.
    pub fn start_checks(self: &Arc<Self>) {
        let updater = self.clone();
        let _ = std::thread::Builder::new()
            .name("update-check".into())
            .spawn(move || {
                std::thread::sleep(FIRST_CHECK);
                loop {
                    updater.check(Duration::from_secs(60));
                    std::thread::sleep(RECHECK);
                }
            });
    }

    pub fn view(&self) -> View {
        let inner = self.inner.lock().unwrap();
        View {
            latest: inner
                .latest
                .as_ref()
                .filter(|r| r.installable(self.version))
                .map(|r| LatestView {
                    tag: r.tag.clone(),
                    url: r.url.clone(),
                }),
            state: inner.phase.clone(),
            error: inner.error.clone(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    /// Asks GitHub unless it was asked within `max_age`. Blocks; when the answer is too old
    /// and a check is already under way, that one is waited for (up to its timeouts), so a
    /// page loading meanwhile gets its answer.
    pub fn check(&self, max_age: Duration) -> View {
        let waited = Instant::now();
        loop {
            let mut inner = self.inner.lock().unwrap();
            let fresh = inner.checked.is_some_and(|t| t.elapsed() < max_age);
            if inner.checking && !fresh && waited.elapsed() < Duration::from_secs(60) {
                drop(inner);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            if inner.checking || fresh {
                drop(inner);
                return self.view();
            }
            inner.checking = true;
            break;
        }
        let found = latest_release();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.checking = false;
            inner.checked = Some(Instant::now());
            match found {
                Ok(release) => {
                    if inner.latest.as_ref() != Some(&release) {
                        info!("Latest release: {}", release.tag);
                        if newer(&release.tag, self.version) && !release.signed {
                            warn!("Release {} not signed; not offered", release.tag);
                        }
                        inner.set_latest(release);
                    }
                }
                Err(err) => warn!("Update check failed: {err}"),
            }
        }
        self.view()
    }

    /// Starts installing the newer release, if there is one and nothing is installing.
    /// Returns false when there's nothing to install.
    pub fn install(self: &Arc<Self>) -> bool {
        let release = {
            let mut inner = self.inner.lock().unwrap();
            let Some(release) = inner.latest.clone().filter(|r| r.installable(self.version)) else {
                return false;
            };
            if inner.phase == Phase::Installing {
                return true;
            }
            inner.phase = Phase::Installing;
            inner.error = None;
            inner.generation += 1;
            release
        };
        let updater = self.clone();
        let spawned = std::thread::Builder::new()
            .name("update-install".into())
            .spawn(move || {
                // Asked again: the cached answer can be hours old, or from before the zip
                // was attached (no checksum yet).
                let release = match latest_release() {
                    Ok(fresh) => {
                        let mut inner = updater.inner.lock().unwrap();
                        if inner.latest.as_ref() != Some(&fresh) {
                            inner.set_latest(fresh.clone());
                        }
                        fresh
                    }
                    Err(err) => {
                        warn!("Update check failed: {err}");
                        release
                    }
                };
                info!("Updating to {}", release.tag);
                let result = if !newer(&release.tag, updater.version) {
                    Err("No update".to_string())
                } else if !release.signed {
                    Err("Release not signed".to_string())
                } else {
                    install(&release)
                };
                match result {
                    Ok(()) => {
                        info!("Updated to {}; restarting", release.tag);
                        (updater.restart)();
                    }
                    Err(err) => {
                        warn!("Update to {} failed: {err}", release.tag);
                        let mut inner = updater.inner.lock().unwrap();
                        inner.phase = Phase::Failed;
                        inner.error = Some(err);
                        inner.generation += 1;
                    }
                }
            });
        if spawned.is_err() {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = Phase::Failed;
            inner.error = Some("Install not started".into());
            inner.generation += 1;
        }
        true
    }
}

/// "v0.4.36" is newer than "0.4.35".
pub fn newer(tag: &str, version: &str) -> bool {
    let parts = |v: &str| -> [u64; 3] {
        let mut out = [0; 3];
        for (i, part) in v
            .trim_start_matches('v')
            .split(['.', '-'])
            .take(3)
            .enumerate()
        {
            out[i] = part.parse().unwrap_or(0);
        }
        out
    };
    parts(tag) > parts(version)
}

/// A tag safe to put in a download path.
fn plain_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 32
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// GitHub's latest release, with lioneye.zip's checksum.
fn latest_release() -> Result<Release, String> {
    let body = http_get(
        "api.github.com",
        &format!("/repos/{REPO}/releases/latest"),
        Some("Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28"),
    )?;
    parse_release(&body)
}

fn parse_release(body: &[u8]) -> Result<Release, String> {
    let json: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "GitHub answer unreadable".to_string())?;
    let tag = json["tag_name"]
        .as_str()
        .filter(|t| plain_tag(t))
        .ok_or("No release tag")?
        .to_string();
    let url = json["html_url"]
        .as_str()
        .filter(|u| u.starts_with(&format!("https://github.com/{REPO}/")))
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/tag/{tag}"));
    let sha256 = json["assets"]
        .as_array()
        .and_then(|assets| assets.iter().find(|a| a["name"] == ASSET))
        .and_then(|asset| asset["digest"].as_str())
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|d| d.len() == 64 && d.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    let signed = json["assets"]
        .as_array()
        .is_some_and(|assets| assets.iter().any(|a| a["name"] == SIGNATURE));
    Ok(Release {
        tag,
        url,
        sha256,
        signed,
    })
}

fn install(release: &Release) -> Result<(), String> {
    let sha256 = release.sha256.as_deref().ok_or("No checksum on GitHub")?;
    let download = |name: &str| {
        http_get(
            "github.com",
            &format!("/{REPO}/releases/download/{}/{name}", release.tag),
            None,
        )
    };
    let signature = download(SIGNATURE)?;
    let zip = download(ASSET)?;
    // A damaged download says so; then the signature, before the zip is even opened (a
    // zip GitHub vouches for isn't enough).
    if hex(&Sha256::digest(&zip)) != sha256 {
        return Err("Download corrupt".into());
    }
    check_signature(RELEASE_KEY, &zip, &signature, &release.tag)?;
    let new_exe = exe_from_zip(&zip, sha256)?;
    let exe = std::env::current_exe().map_err(|err| denied("Exe not found", err))?;
    let pid = std::process::id();
    let args = restart_args(std::env::args_os().skip(1), pid);
    let signal = StartSignal::create(pid)?;
    swap_and_start(&exe, &new_exe, &args, |child| {
        signal.wait(child, START_LIMIT)
    })
}

/// The exe from the zip, once the zip matches GitHub's checksum.
fn exe_from_zip(zip: &[u8], sha256: &str) -> Result<Vec<u8>, String> {
    let got = hex(&Sha256::digest(zip));
    if got != sha256 {
        return Err("Download corrupt".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip))
        .map_err(|_| "Download not a zip".to_string())?;
    let mut file = archive
        .by_name(EXE_IN_ZIP)
        .map_err(|_| "No exe in the zip".to_string())?;
    if file.size() > MAX_DOWNLOAD as u64 {
        return Err("Exe in the zip damaged".into());
    }
    let mut exe = Vec::with_capacity(file.size() as usize);
    file.by_ref()
        .take(MAX_DOWNLOAD as u64 + 1)
        .read_to_end(&mut exe)
        .map_err(|_| "Zip not read".to_string())?;
    if exe.len() > MAX_DOWNLOAD {
        return Err("Exe in the zip damaged".into());
    }
    // "MZ": a Windows program, not a stray file of that name.
    if !exe.starts_with(b"MZ") {
        return Err("Exe in the zip damaged".into());
    }
    Ok(exe)
}

/// Ok when `signature` is the release key's (`key`) over `zip`, made for release `tag`.
/// The tag is in the signed comment, so an old signed zip can't pass as a newer release.
fn check_signature(key: &str, zip: &[u8], signature: &[u8], tag: &str) -> Result<(), String> {
    let invalid = |why: &dyn std::fmt::Display| {
        warn!("Signature of {tag} rejected: {why}");
        "Signature invalid".to_string()
    };
    let key = minisign_verify::PublicKey::decode(key).map_err(|e| invalid(&e))?;
    let text = std::str::from_utf8(signature).map_err(|e| invalid(&e))?;
    let signature = minisign_verify::Signature::decode(text).map_err(|e| invalid(&e))?;
    key.verify(zip, &signature, false)
        .map_err(|e| invalid(&e))?;
    let expected = format!("{ASSET} {tag}");
    if signature.trusted_comment() != expected {
        return Err(invalid(&format_args!(
            "signed for {:?}, not {expected:?}",
            signature.trusted_comment()
        )));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `path` with `suffix` added to its file name: lioneye.exe → lioneye.exe.old.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// This copy's arguments for the new one, less an earlier `--after-update`, plus this one's.
fn restart_args(args: impl Iterator<Item = OsString>, pid: u32) -> Vec<OsString> {
    let mut out = Vec::new();
    let mut skip_value = false;
    for arg in args {
        if skip_value {
            skip_value = false;
            continue;
        }
        let text = arg.to_string_lossy();
        if text == AFTER_UPDATE {
            skip_value = true;
            continue;
        }
        if text.starts_with(&format!("{AFTER_UPDATE}=")) {
            continue;
        }
        out.push(arg);
    }
    out.push(AFTER_UPDATE.into());
    out.push(pid.to_string().into());
    out
}

/// Writes the new exe beside `exe`, swaps the two by renaming, starts it with `args`, and
/// lets `confirm` wait for it to show it runs. Anything that fails puts the old exe back.
pub fn swap_and_start(
    exe: &Path,
    new_exe: &[u8],
    args: &[OsString],
    confirm: impl FnOnce(&mut std::process::Child) -> Result<(), String>,
) -> Result<(), String> {
    let _swap = SWAP.lock().unwrap_or_else(|e| e.into_inner());
    if CLOSING.load(Ordering::SeqCst) {
        return Err("Quitting".into());
    }
    let new = sibling(exe, ".new");
    let old = sibling(exe, ".old");
    // Puts the old exe back; a failure here leaves only lioneye.exe.old, so say so loudly.
    let restore = || {
        if let Err(err) = rename(&old, exe) {
            tracing::error!(
                "Old exe not put back ({err}): rename {} to {}",
                old.display(),
                exe.display()
            );
        }
    };
    std::fs::write(&new, new_exe).map_err(|err| denied("Exe folder not writable", err))?;
    // Left from the last update when it couldn't be deleted then.
    let _ = std::fs::remove_file(&old);
    if let Err(err) = rename(exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(denied("Exe not replaced", err));
    }
    if let Err(err) = rename(&new, exe) {
        restore();
        let _ = std::fs::remove_file(&new);
        return Err(denied("Exe not replaced", err));
    }
    // Same folder as now, so a relative --log-path still means the same file.
    let dir = std::env::current_dir()
        .ok()
        .or_else(|| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let confirmed = match spawn(exe, args, &dir) {
        // Quit while the new copy was starting: Quit wins, the old exe goes back.
        Ok(mut child) => confirm(&mut child).and_then(|()| {
            if CLOSING.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Quitting".into());
            }
            Ok(())
        }),
        Err(err) => Err(denied("New exe didn't start", err)),
    };
    if let Err(err) = confirmed {
        let _ = rename(exe, &new);
        restore();
        let _ = std::fs::remove_file(&new);
        return Err(err);
    }
    Ok(())
}

/// A rename, tried again for 2 s while another program (antivirus, OneDrive, the search
/// indexer) briefly holds the file.
fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(from, to) {
            Err(err) if tries < 10 && matches!(err.raw_os_error(), Some(5 | 32)) => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(200));
            }
            result => return result,
        }
    }
}

/// Starts the new exe outside any job this one runs in (a job that ends its processes
/// with this one would end it too); without, when the job doesn't allow that.
fn spawn(exe: &Path, args: &[OsString], dir: &Path) -> std::io::Result<std::process::Child> {
    let command = || {
        let mut command = std::process::Command::new(exe);
        command.args(args).current_dir(dir);
        command
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        if let Ok(child) = command().creation_flags(CREATE_BREAKAWAY_FROM_JOB).spawn() {
            return Ok(child);
        }
    }
    command().spawn()
}

/// The named event the new copy sets once it runs: `Local\lioneye-updated-<old pid>`.
#[cfg(windows)]
fn signal_name(pid: u32) -> Vec<u16> {
    format!("Local\\lioneye-updated-{pid}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// The old copy's side of the start handshake.
struct StartSignal {
    #[cfg(windows)]
    event: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl StartSignal {
    fn create(pid: u32) -> Result<StartSignal, String> {
        use windows_sys::Win32::System::Threading::CreateEventW;
        let name = signal_name(pid);
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        if event.is_null() {
            return Err(denied(
                "Install not started",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(StartSignal { event })
    }

    /// Ok once the new copy signals; else stops it.
    fn wait(&self, child: &mut std::process::Child, limit: Duration) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0, System::Threading::WaitForMultipleObjects,
        };
        let handles = [self.event, child.as_raw_handle() as _];
        let ms = limit.as_millis().min(u32::MAX as u128) as u32;
        let woke = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, ms) };
        if woke == WAIT_OBJECT_0 {
            return Ok(());
        }
        warn!("New exe didn't signal (wait result {woke}); stopping it");
        let _ = child.kill();
        let _ = child.wait();
        Err("New exe didn't start".into())
    }
}

#[cfg(windows)]
impl Drop for StartSignal {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.event) };
    }
}

#[cfg(not(windows))]
impl StartSignal {
    fn create(_pid: u32) -> Result<StartSignal, String> {
        Ok(StartSignal {})
    }
    fn wait(&self, _child: &mut std::process::Child, _limit: Duration) -> Result<(), String> {
        Ok(())
    }
}

/// The new copy's side: tells the old copy (by its process id) that this one runs.
#[cfg(windows)]
pub fn signal_started(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{EVENT_MODIFY_STATE, OpenEventW, SetEvent},
    };
    let name = signal_name(pid);
    unsafe {
        let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if !event.is_null() {
            SetEvent(event);
            CloseHandle(event);
        }
    }
}

#[cfg(not(windows))]
pub fn signal_started(_pid: u32) {}

/// The short reason for the footer; Windows' own message goes to the log.
fn denied(what: &str, err: std::io::Error) -> String {
    warn!("{what}: {err}");
    what.to_string()
}

/// After an update: deletes the old exe once this copy has run a minute (retried for a
/// few seconds while it's still held).
pub fn remove_old_exe() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let old = sibling(&exe, ".old");
    if !old.exists() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("update-cleanup".into())
        .spawn(move || {
            std::thread::sleep(KEEP_OLD);
            for _ in 0..40 {
                if std::fs::remove_file(&old).is_ok() || !old.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            warn!("Old exe not deleted: {}", old.display());
        });
}

/// Waits up to `limit` for the old copy (by process id) to exit.
#[cfg(windows)]
pub fn wait_for_exit(pid: u32, limit: Duration) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return; // already gone
        }
        WaitForSingleObject(process, limit.as_millis().min(u32::MAX as u128) as u32);
        CloseHandle(process);
    }
}

#[cfg(not(windows))]
pub fn wait_for_exit(_pid: u32, _limit: Duration) {}

/// An HTTPS GET with Windows' own client (WinHTTP): system proxy, redirects followed.
#[cfg(windows)]
fn http_get(host: &str, path: &str, headers: Option<&str>) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Networking::WinHttp::*;

    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { WinHttpCloseHandle(self.0) };
            }
        }
    }
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let agent = wide(concat!("Lioneye/", env!("CARGO_PKG_VERSION")));
    let host_w = wide(host);
    let path_w = wide(path);
    let verb = wide("GET");
    let offline = || "GitHub not reached".to_string();

    unsafe {
        let session = Handle(WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() {
            return Err(offline());
        }
        WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 30_000);
        let connect = Handle(WinHttpConnect(
            session.0,
            host_w.as_ptr(),
            INTERNET_DEFAULT_HTTPS_PORT,
            0,
        ));
        if connect.0.is_null() {
            return Err(offline());
        }
        let request = Handle(WinHttpOpenRequest(
            connect.0,
            verb.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        if request.0.is_null() {
            return Err(offline());
        }
        if let Some(headers) = headers {
            let headers_w = wide(headers);
            WinHttpAddRequestHeaders(
                request.0,
                headers_w.as_ptr(),
                u32::MAX,
                WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
            );
        }
        if WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0) == 0
            || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0
        {
            return Err(offline());
        }
        let mut status: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        if WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut size,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(offline());
        }
        if status != 200 {
            return Err(format!("GitHub error {status}"));
        }
        let mut body = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let began = Instant::now();
        loop {
            if began.elapsed() > DOWNLOAD_LIMIT {
                return Err("Download too slow".into());
            }
            let mut read: u32 = 0;
            if WinHttpReadData(
                request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            ) == 0
            {
                return Err("Download cut off".into());
            }
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read as usize]);
            if body.len() > MAX_DOWNLOAD {
                return Err("Download too large".into());
            }
        }
        Ok(body)
    }
}

#[cfg(not(windows))]
fn http_get(_host: &str, _path: &str, _headers: Option<&str>) -> Result<Vec<u8>, String> {
    Err("Updates need Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("v0.4.36", "0.4.35"));
        assert!(newer("v0.5.0", "0.4.35"));
        assert!(newer("v1.0.0", "0.99.99"));
        assert!(newer("v0.4.10", "0.4.9"));
        assert!(!newer("v0.4.35", "0.4.35"));
        assert!(!newer("v0.4.34", "0.4.35"));
        assert!(!newer("garbage", "0.4.35"));
    }

    #[test]
    fn reads_a_release() {
        let body = br#"{"tag_name":"v0.4.36","html_url":"https://github.com/kobayashi-maru-1/lioneye/releases/tag/v0.4.36",
            "assets":[{"name":"other.zip","digest":"sha256:00"},
                      {"name":"lioneye.zip","digest":"sha256:B78E0B1FC9972FFDB262F0530175A23ED2C58B55B20C22EDFFF8970DE78937BC"}]}"#;
        let release = parse_release(body).unwrap();
        assert_eq!(release.tag, "v0.4.36");
        assert!(!release.signed);
        assert!(!release.installable("0.4.35"));
        assert_eq!(
            release.sha256.as_deref(),
            Some("b78e0b1fc9972ffdb262f0530175a23ed2c58b55b20c22edfff8970de78937bc")
        );
        // A tag that could leave the download path is refused.
        assert!(parse_release(br#"{"tag_name":"../../x"}"#).is_err());
        // A page elsewhere falls back to the release's own page.
        let elsewhere =
            parse_release(br#"{"tag_name":"v1.0.0","html_url":"https://evil.example/"}"#).unwrap();
        assert_eq!(
            elsewhere.url,
            "https://github.com/kobayashi-maru-1/lioneye/releases/tag/v1.0.0"
        );
        assert_eq!(elsewhere.sha256, None);
        // With its signature: offered when newer.
        let signed = parse_release(
            br#"{"tag_name":"v0.4.37","assets":[{"name":"lioneye.zip"},{"name":"lioneye.zip.minisig"}]}"#,
        )
        .unwrap();
        assert!(signed.signed);
        assert!(signed.installable("0.4.36"));
        assert!(!signed.installable("0.4.37"));
    }

    /// The key built into the exe reads.
    #[test]
    fn reads_the_release_key() {
        minisign_verify::PublicKey::decode(RELEASE_KEY).unwrap();
        // Not a stand-in: an all-zero key would refuse every update.
        let line = RELEASE_KEY.lines().nth(1).unwrap();
        assert!(
            !line.starts_with("RWQAAAAAAAAAAAAA"),
            "placeholder release key"
        );
        assert!(
            !RELEASE_KEY.contains("placeholder"),
            "placeholder release key"
        );
    }

    #[test]
    fn checks_the_signature() {
        use minisign::{KeyPair, PublicKeyBox};
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
        let key = PublicKeyBox::to_string(&pk.to_box().unwrap());
        let sign = |data: &[u8], comment: &str| {
            minisign::sign(None, &sk, std::io::Cursor::new(data), Some(comment), None)
                .unwrap()
                .to_string()
        };
        let zip = b"zip bytes".as_slice();
        let good = sign(zip, "lioneye.zip v1.2.3");
        assert_eq!(
            check_signature(&key, zip, good.as_bytes(), "v1.2.3"),
            Ok(())
        );

        let invalid = Err("Signature invalid".to_string());
        // Another zip, another tag, or a signature made for another tag.
        assert_eq!(
            check_signature(&key, b"other", good.as_bytes(), "v1.2.3"),
            invalid
        );
        assert_eq!(
            check_signature(&key, zip, good.as_bytes(), "v1.2.4"),
            invalid
        );
        let old = sign(zip, "lioneye.zip v1.2.2");
        assert_eq!(
            check_signature(&key, zip, old.as_bytes(), "v1.2.3"),
            invalid
        );
        // Another key, or not a signature at all.
        let other = KeyPair::generate_unencrypted_keypair().unwrap().pk;
        let other = PublicKeyBox::to_string(&other.to_box().unwrap());
        assert_eq!(
            check_signature(&other, zip, good.as_bytes(), "v1.2.3"),
            invalid
        );
        assert_eq!(check_signature(&key, zip, b"Not Found", "v1.2.3"), invalid);
        // A signature edited to name a newer tag no longer verifies.
        let edited = good.replace("lioneye.zip v1.2.3", "lioneye.zip v9.9.9");
        assert_eq!(
            check_signature(&key, zip, edited.as_bytes(), "v9.9.9"),
            invalid
        );
    }

    #[test]
    fn passes_arguments_on() {
        let args = [
            "--browser",
            "edge",
            "--after-update",
            "12",
            "--after-update=13",
            "--heart-beat",
            "2",
        ]
        .map(OsString::from);
        let out = restart_args(args.into_iter(), 99);
        let out: Vec<_> = out
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            out,
            [
                "--browser",
                "edge",
                "--heart-beat",
                "2",
                "--after-update",
                "99"
            ]
        );
    }

    #[test]
    fn refuses_a_corrupt_download() {
        assert_eq!(
            exe_from_zip(b"not a zip", &"0".repeat(64)),
            Err("Download corrupt".to_string())
        );
        let sum = hex(&Sha256::digest(b"not a zip"));
        assert_eq!(
            exe_from_zip(b"not a zip", &sum),
            Err("Download not a zip".to_string())
        );
    }

    /// Swaps a copy of a small Windows program for another and starts it.
    #[cfg(windows)]
    #[test]
    fn swaps_and_starts() {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        let dir = std::env::temp_dir().join(format!("lioneye-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("app.exe");
        std::fs::copy(system.join("whoami.exe"), &exe).unwrap();
        let old_bytes = std::fs::read(&exe).unwrap();
        let new_bytes = std::fs::read(system.join("hostname.exe")).unwrap();
        // An .old from an earlier update is replaced.
        std::fs::write(sibling(&exe, ".old"), b"stale").unwrap();

        swap_and_start(&exe, &new_bytes, &[], |_| Ok(())).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), new_bytes);
        assert_eq!(std::fs::read(sibling(&exe, ".old")).unwrap(), old_bytes);
        assert!(!sibling(&exe, ".new").exists());

        // The new copy never signals: it's stopped and the exe before it comes back.
        std::fs::remove_file(sibling(&exe, ".old")).unwrap();
        let signal = StartSignal::create(u32::MAX - std::process::id()).unwrap();
        let failed = swap_and_start(&exe, &old_bytes, &[], |child| {
            signal.wait(child, Duration::from_millis(300))
        });
        assert_eq!(failed, Err("New exe didn't start".to_string()));
        assert_eq!(std::fs::read(&exe).unwrap(), new_bytes);
        assert!(!sibling(&exe, ".new").exists());
        assert!(!sibling(&exe, ".old").exists());

        // The new copy signals: the swap stands.
        let pid = u32::MAX - 1 - std::process::id();
        let signal = StartSignal::create(pid).unwrap();
        signal_started(pid);
        swap_and_start(&exe, &old_bytes, &[], |child| {
            signal.wait(child, Duration::from_secs(5))
        })
        .unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), old_bytes);

        // A folder that doesn't exist: nothing is touched, the error says why.
        let missing = dir.join("gone").join("app.exe");
        assert!(swap_and_start(&missing, &new_bytes, &[], |_| Ok(())).is_err());
        std::thread::sleep(Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real latest release: checksum, zip, exe and (once signed) signature.
    /// `cargo test -- --ignored live_release`
    #[test]
    #[ignore]
    fn live_release() {
        let release = latest_release().unwrap();
        println!("{release:?}");
        let download = |name: &str| {
            http_get(
                "github.com",
                &format!("/{REPO}/releases/download/{}/{name}", release.tag),
                None,
            )
            .unwrap()
        };
        let zip = download(ASSET);
        let exe = exe_from_zip(&zip, release.sha256.as_deref().unwrap()).unwrap();
        println!("zip {} bytes, exe {} bytes", zip.len(), exe.len());
        assert!(release.signed, "latest release has no signature");
        check_signature(RELEASE_KEY, &zip, &download(SIGNATURE), &release.tag).unwrap();
        println!("signature good");
    }

    #[test]
    fn names_siblings() {
        assert_eq!(
            sibling(Path::new(r"C:\x\lioneye.exe"), ".old"),
            PathBuf::from(r"C:\x\lioneye.exe.old")
        );
    }
}
