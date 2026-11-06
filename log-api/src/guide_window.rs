//! Finds the guide's app window (Edge, or Chrome when it's the default browser), so the tray
//! can bring it back or close it with the app.
//!
//! An `--app` window is titled with the page title alone ("Exile Leveling",
//! "Exile Leveling - Build"). Normal browser windows add a suffix ("- Microsoft Edge",
//! "- Google Chrome"), so an exact title match plus an msedge.exe/chrome.exe check finds
//! only ours.

use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, HWND_TOP, IsIconic,
    IsWindowVisible, PostMessageW, SW_RESTORE, SW_SHOWNOACTIVATE, SWP_ASYNCWINDOWPOS,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetForegroundWindow, SetWindowPos, ShowWindowAsync,
    WM_CLOSE,
};

/// The page titles set in web/src/containers/index.tsx; keep in sync.
const TITLES: [&str; 4] = [
    "Exile Leveling",
    "Exile Leveling - Settings",
    // Before the Build page became Settings; a window from an older copy is still ours.
    "Exile Leveling - Build",
    "Exile Leveling - Edit Route",
];
const CHROMIUM_CLASS: &str = "Chrome_WidgetWin_1";

fn is_guide_title(title: &str) -> bool {
    TITLES.contains(&title)
}

fn text(buf: &[u16], len: usize) -> String {
    String::from_utf16_lossy(&buf[..len.min(buf.len())])
}

/// True when the window belongs to msedge.exe or chrome.exe.
fn is_app_browser(hwnd: HWND) -> bool {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return false;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        ok != 0
            && text(&buf, len as usize)
                .rsplit('\\')
                .next()
                .is_some_and(|exe| {
                    exe.eq_ignore_ascii_case("msedge.exe") || exe.eq_ignore_ascii_case("chrome.exe")
                })
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    let found = unsafe { &mut *(lparam as *mut Vec<HWND>) };
    let mut buf = [0u16; 256];
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if text(&buf, len.max(0) as usize) != CHROMIUM_CLASS {
            return 1;
        }
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if !is_guide_title(&text(&buf, len.max(0) as usize)) {
            return 1;
        }
    }
    if is_app_browser(hwnd) {
        found.push(hwnd);
    }
    1
}

/// Visible guide windows, front-most first.
fn find() -> Vec<HWND> {
    let mut found: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut found as *mut Vec<HWND> as LPARAM);
    }
    found
}

/// Brings an open guide window to the front (restoring it if minimized).
/// Returns false when none is open.
pub fn show() -> bool {
    let Some(&hwnd) = find().first() else {
        return false;
    };
    unsafe {
        // Async, so a hung Edge can't stall the tray.
        if IsIconic(hwnd) != 0 {
            ShowWindowAsync(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) == 0 {
            tracing::warn!("Couldn't bring the guide window to the front");
        }
    }
    true
}

/// Brings the open guide window above other windows without focusing it, so the game
/// keeps focus when a bar button is clicked. Restores it if minimized.
pub fn raise() {
    let Some(&hwnd) = find().first() else {
        return;
    };
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
        }
        SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

/// Asks every guide window to close.
pub fn close_all() {
    for hwnd in find() {
        unsafe {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_guide_title;

    #[test]
    fn matches_app_windows_only() {
        assert!(is_guide_title("Exile Leveling"));
        assert!(is_guide_title("Exile Leveling - Settings"));
        assert!(is_guide_title("Exile Leveling - Build"));
        assert!(is_guide_title("Exile Leveling - Edit Route"));
        assert!(!is_guide_title("Exile Leveling - Personal - Microsoft\u{200b} Edge"));
        assert!(!is_guide_title("Exile Leveling - Google Chrome"));
        assert!(!is_guide_title("Exile Leveling - Build - Brave"));
        assert!(!is_guide_title("Exile Leveling and 2 more pages - Personal - Microsoft Edge"));
        assert!(!is_guide_title("Path of Exile"));
    }
}
