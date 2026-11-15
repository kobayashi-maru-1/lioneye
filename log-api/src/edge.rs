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

/// A web page from the guide (trade search, wiki) in your default browser, where you're
/// signed in to the trade site, not in the guide's own profile. The browser Windows has for
/// https is started with the address, so a long trade search arrives whole; when that
/// can't be read, the shell opens it.
pub fn open_default(url: &str) -> std::io::Result<()> {
    if let Some((exe, args)) = default_browser_command(url)
        && spawn(&exe, &args).is_ok()
    {
        return Ok(());
    }
    shell_open(url)
}

/// The program and arguments Windows' https association runs for `url` (your default
/// browser), from its open command, e.g. `"…\chrome.exe" --single-argument %1`.
fn default_browser_command(url: &str) -> Option<(PathBuf, Vec<String>)> {
    use windows_sys::Win32::UI::Shell::{ASSOCF_IS_PROTOCOL, ASSOCSTR_COMMAND, AssocQueryStringW};
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (scheme, verb) = (wide("https"), wide("open"));
    let mut buf = [0u16; 2048];
    let mut len = buf.len() as u32;
    let status = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_COMMAND,
            scheme.as_ptr(),
            verb.as_ptr(),
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    if status != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    browser_command(&String::from_utf16_lossy(&buf[..end]), url)
}

/// An open command split into its program (a full path to an .exe that exists) and its
/// arguments, with the address in place of `%1` or `%L` (also inside an argument, as in
/// `-url=%1`), or added at the end when the command has neither. `%*` is dropped.
fn browser_command(command: &str, url: &str) -> Option<(PathBuf, Vec<String>)> {
    let command = command.trim();
    let (exe, rest) = if let Some(quoted) = command.strip_prefix('"') {
        let close = quoted.find('"')?;
        (&quoted[..close], &quoted[close + 1..])
    } else {
        // Unquoted: up to ".exe", since the path may hold spaces.
        let end = command.to_ascii_lowercase().find(".exe")? + 4;
        (&command[..end], &command[end..])
    };
    let exe = PathBuf::from(exe);
    let is_exe = exe
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
    if !is_exe || !exe.is_absolute() || !exe.is_file() {
        return None;
    }
    // One pass, so a `%1` inside the address is never replaced in turn.
    let mut line = String::new();
    let mut placed = false;
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('%', Some('1' | 'L' | 'l')) => {
                chars.next();
                line.push_str(url);
                placed = true;
            }
            ('%', Some('*')) => {
                chars.next();
            }
            _ => line.push(c),
        }
    }
    // Split as the program will read it (quotes, `"Profile 1"`); the address has no
    // spaces, quotes or backslashes (is_web_link), so it stays one piece.
    let mut args = split_args(&line)?;
    if !placed {
        args.push(url.to_string());
    }
    Some((exe, args))
}

/// Command-line arguments split by Windows' own rules (CommandLineToArgvW).
fn split_args(line: &str) -> Option<Vec<String>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
    if line.trim().is_empty() {
        return Some(Vec::new());
    }
    // A stand-in program name first: the first argument follows different rules.
    let wide: Vec<u16> = "x "
        .encode_utf16()
        .chain(line.encode_utf16())
        .chain(Some(0))
        .collect();
    let mut count = 0i32;
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() {
        return None;
    }
    let args = (1..count.max(0) as usize)
        .map(|i| unsafe {
            let arg = *argv.add(i);
            let len = (0..).take_while(|&j| *arg.add(j) != 0).count();
            String::from_utf16_lossy(std::slice::from_raw_parts(arg, len))
        })
        .collect();
    unsafe { LocalFree(argv.cast()) };
    Some(args)
}

/// The shell's own open for `url`: no error dialogs (it runs beside the guide's socket),
/// and finished before COM is released on this thread.
fn shell_open(url: &str) -> std::io::Result<()> {
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(url));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    // Some handlers want COM on the calling thread; released again after (NOASYNC).
    let com = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    let ok = unsafe { ShellExecuteExW(&mut info) } != 0;
    let err = std::io::Error::last_os_error();
    if com >= 0 {
        unsafe { CoUninitialize() };
    }
    if ok { Ok(()) } else { Err(err) }
}

/// True for an http(s) address with nothing a browser could read as a switch or a second
/// address (it's passed to the browser as an argument), and no backslash, which Windows'
/// argument rules could pair with a quote. (Pages send backslashes as %5C or /.)
pub fn is_web_link(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 8192
        && !url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\')
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
    use super::{browser_command, is_web_link};

    #[test]
    fn default_browser_commands() {
        // A program that exists on every Windows PC, standing in for a browser.
        let exe = r"C:\Windows\System32\cmd.exe";
        let url = "https://www.pathofexile.com/trade/search/Mirage?q=%7B%7D";
        let (path, args) =
            browser_command(&format!("\"{exe}\" --single-argument %1"), url).unwrap();
        assert_eq!(path.to_str(), Some(exe));
        assert_eq!(args, ["--single-argument", url]);
        let (_, args) = browser_command(&format!("\"{exe}\" -osint -url \"%1\""), url).unwrap();
        assert_eq!(args, ["-osint", "-url", url]);
        let (_, args) = browser_command(&format!("{exe} %*"), url).unwrap();
        assert_eq!(args, [url]);
        let (_, args) = browser_command(
            &format!("\"{exe}\" --profile-directory=\"Profile 1\" -url=%1"),
            url,
        )
        .unwrap();
        assert_eq!(
            args,
            ["--profile-directory=Profile 1".to_string(), format!("-url={url}")]
        );
        // A `%1` in the address itself stays as it is.
        let tricky = "https://example.com/?a=%1%L";
        let (_, args) = browser_command(&format!("\"{exe}\" %1"), tricky).unwrap();
        assert_eq!(args, [tricky]);
        assert!(browser_command(r#""C:\nowhere\browser.exe" %1"#, url).is_none());
        assert!(browser_command("rundll32 url.dll,FileProtocolHandler %1", url).is_none());
        assert!(browser_command("cmd.exe %1", url).is_none());
        assert!(!is_web_link(r"https://a.com/x\"));
    }

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
