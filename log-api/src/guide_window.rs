//! Finds the guide's Edge app window, so the tray can bring it back or close it with the app.
//!
//! An Edge `--app` window is titled with the page title alone ("Exile Leveling",
//! "Exile Leveling - Build"); normal browser windows end in "Microsoft Edge", so they never match.

use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, IsIconic, IsWindowVisible, PostMessageW,
    SW_RESTORE, SetForegroundWindow, ShowWindow, WM_CLOSE,
};

const TITLE: &str = "Exile Leveling";
const CHROMIUM_CLASS: &str = "Chrome_WidgetWin_1";

fn is_guide_title(title: &str) -> bool {
    title == TITLE || (title.starts_with("Exile Leveling - ") && !title.contains("Microsoft"))
}

fn text(buf: &[u16], len: i32) -> String {
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    let found = unsafe { &mut *(lparam as *mut Vec<HWND>) };
    let mut buf = [0u16; 256];
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if text(&buf, len) != CHROMIUM_CLASS {
            return 1;
        }
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if is_guide_title(&text(&buf, len)) {
            found.push(hwnd);
        }
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
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
    }
    true
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
        assert!(is_guide_title("Exile Leveling - Build"));
        assert!(!is_guide_title("Exile Leveling - Personal - Microsoft\u{200b} Edge"));
        assert!(!is_guide_title("Exile Leveling and 2 more pages - Personal - Microsoft Edge"));
        assert!(!is_guide_title("Path of Exile"));
    }
}
