//! Opens the guide in Edge (part of every Windows 10 and 11 PC) in a browser profile of
//! its own, so its window place and saved data never depend on the profiles you browse
//! with. Also opens it, once, in old Edge or Chrome profiles to move the guide's data from
//! the old setup (guide-move.rs).

use std::path::{Path, PathBuf};

use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
};

/// The guide's own browser profile: one per address, so a test run on another port never
/// shares the real guide's.
pub fn own_profile_dir(url: &str) -> PathBuf {
    let port = url.trim_end_matches('/').rsplit(':').next().unwrap_or("");
    let dir = crate::data_dir();
    if port == "6754" {
        dir.join("browser")
    } else {
        dir.join(format!("browser-{port}"))
    }
}

/// The guide in its own profile: a borderless app window that remembers its place.
/// "?own" tells the page it's this window (it keeps the exe's copy of its data current).
/// `place`: where it was last (Edge saves an app window's place but doesn't restore it).
pub fn open_own(url: &str, place: Option<crate::guide_window::Placement>) -> std::io::Result<()> {
    let mut args = vec![
        format!("--user-data-dir={}", own_profile_dir(url).display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ];
    if let Some(place) = place.map(|p| p.for_edge()) {
        args.push(format!("--window-position={},{}", place.x, place.y));
        args.push(format!("--window-size={},{}", place.width, place.height));
        if place.maximized {
            args.push("--start-maximized".into());
        }
    }
    args.push(format!("--app={url}?own"));
    spawn(&msedge_or_default(), &args)
}

/// The guide at `url` in one profile of an old setup's browser (guide-move.rs).
pub fn open_profile_window(browser: &Path, profile: &str, url: &str) -> std::io::Result<()> {
    spawn(
        browser,
        &[
            format!("--profile-directory={profile}"),
            format!("--app={url}"),
        ],
    )
}

/// The guide in your last-used Edge profile (`--browser edge`, as before 0.3).
pub fn open_last_profile(url: &str) -> std::io::Result<()> {
    spawn(&msedge_or_default(), &[format!("--app={url}")])
}

/// A web page from the guide (trade search, wiki) in a normal tab of your last-used Edge
/// profile, where you're signed in to the trade site, not in the guide's own profile.
pub fn open_link(url: &str) -> std::io::Result<()> {
    spawn(&msedge_or_default(), &[url.to_string()])
}

/// True for an http(s) address with nothing Edge could read as a switch or a second
/// address (it's passed to msedge.exe as an argument).
pub fn is_web_link(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 8192
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"')
}

fn spawn(browser: &Path, args: &[String]) -> std::io::Result<()> {
    std::process::Command::new(browser)
        .args(args)
        .spawn()
        .map(|_| ())
}

/// msedge.exe, from its App Paths registration.
pub fn msedge() -> Option<PathBuf> {
    app_path("msedge.exe")
}

/// chrome.exe, when Chrome is installed.
pub fn chrome() -> Option<PathBuf> {
    app_path("chrome.exe")
}

fn msedge_or_default() -> PathBuf {
    msedge().unwrap_or_else(|| {
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    })
}

/// A program's App Paths registration (per user, then per machine), when the file exists.
fn app_path(exe: &str) -> Option<PathBuf> {
    let key = format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|root| registry_string(root, &key, None))
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// A registry string value (`name` None: the key's default value).
pub(crate) fn registry_string(root: HKEY, key: &str, name: Option<&str>) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::is_web_link;

    #[test]
    fn web_links_only() {
        assert!(is_web_link("https://www.pathofexile.com/trade/search/Mirage?q=%7B%7D"));
        assert!(is_web_link("http://example.com/"));
        assert!(!is_web_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_link("--app=https://example.com"));
        assert!(!is_web_link("https://a.com/ --flag"));
        assert!(!is_web_link("https://a.com/\"x"));
        assert!(!is_web_link("https://a.com/\nx"));
    }
}
