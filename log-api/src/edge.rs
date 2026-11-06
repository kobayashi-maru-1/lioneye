//! Opens the guide in Edge (part of every Windows 10 and 11 PC): in a browser profile of
//! its own, so its window place and saved data never depend on the profiles you browse
//! with; and, once, in each of your Edge profiles to move the guide's data from the old
//! setup (guide_move.rs).

use std::path::PathBuf;

use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
};

/// The guide's own browser profile.
pub fn own_profile_dir() -> PathBuf {
    crate::data_dir().join("browser")
}

/// The guide in its own profile: a borderless app window that remembers its place.
/// "?own" tells the page it's this window (it keeps the exe's copy of its data current).
pub fn open_own(url: &str) -> std::io::Result<()> {
    spawn(&[
        format!("--user-data-dir={}", own_profile_dir().display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        format!("--app={url}?own"),
    ])
}

/// The guide in one of your Edge profiles ("Default", "Profile 1"), which sends the exe
/// what that profile had saved ("?migrate").
pub fn open_in_profile(profile: &str, url: &str) -> std::io::Result<()> {
    spawn(&[
        format!("--profile-directory={profile}"),
        format!("--app={url}?migrate"),
    ])
}

/// The guide in your last-used Edge profile (`--browser edge`, as before 0.3).
pub fn open_last_profile(url: &str) -> std::io::Result<()> {
    spawn(&[format!("--app={url}")])
}

fn spawn(args: &[String]) -> std::io::Result<()> {
    std::process::Command::new(msedge())
        .args(args)
        .spawn()
        .map(|_| ())
}

/// msedge.exe, from its App Paths registration, else where Edge installs.
fn msedge() -> PathBuf {
    let app_path = r"Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|root| registry_string(root, app_path, None))
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        })
}

/// Your Edge profiles' folder names, the last used first.
pub fn profiles() -> Vec<String> {
    let path = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(r"Microsoft\Edge\User Data\Local State");
    let state: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let last = state["profile"]["last_used"].as_str().map(str::to_string);
    let mut names: Vec<String> = state["profile"]["info_cache"]
        .as_object()
        .map(|cache| cache.keys().cloned().collect())
        .unwrap_or_default();
    if names.is_empty() {
        names.push("Default".into());
    }
    if let Some(last) = last {
        names.sort_by_key(|name| *name != last);
    }
    names
}

/// A registry string value (`name` None: the key's default value).
fn registry_string(root: HKEY, key: &str, name: Option<&str>) -> Option<String> {
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let key = wide(key);
    let name = name.map(wide);
    let mut buf = [0u16; 1024];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}
