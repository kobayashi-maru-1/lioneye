//! Finds the guide's Edge app window, so the tray can bring it back or close it with the app.
//!
//! An `--app` window is titled with the page title alone ("Exile Leveling",
//! "Exile Leveling - Build"). Normal browser windows add a suffix ("- Microsoft Edge",
//! "- Google Chrome"), so an exact title match plus an msedge.exe check finds only ours.
//! chrome.exe windows count too: the move from 0.2 opens the guide in Chrome profiles.

use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetClassNameW, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId, HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindowVisible,
    PostMessageW, SW_RESTORE, SW_SHOWNOACTIVATE, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetForegroundWindow, SetWindowPos, ShowWindowAsync, WM_CLOSE, WS_EX_TOPMOST,
};

/// The page titles set in web/src/containers/index.tsx; keep in sync. The app was called
/// Exile Leveling before 0.4: a window from an older copy is still ours.
const TITLES: [&str; 9] = [
    "Lioneye",
    "Lioneye - Settings",
    "Lioneye - Edit Route",
    "Lioneye - League",
    // Before 0.4.48 the League page was Strats (a window from an older copy).
    "Lioneye - Strats",
    "Exile Leveling",
    "Exile Leveling - Settings",
    // Before the Build page became Settings.
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

/// True when the window belongs to msedge.exe (or chrome.exe, for the move from 0.2).
fn is_edge(hwnd: HWND) -> bool {
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
    if is_edge(hwnd) {
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
///
/// Windows ignores a plain move to the top (HWND_TOP) unless Edge may take the foreground,
/// which it can't while the game is in front. So the window is made topmost and then
/// normal again: that leaves it above every normal window.
pub fn raise() {
    let Some(&hwnd) = find().first() else {
        return;
    };
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
        }
        // Already topmost (set so, or an earlier click's pair still running): it's above
        // every normal window, and adding only half a pair could leave it stuck topmost.
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST) != 0 {
            return;
        }
        // Async: posted to the window's own thread (a hung Edge can't stall the bar), and
        // run there in this order.
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
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

/// Where the guide window sits, so it reopens there: Edge saves an `--app` window's place
/// but doesn't put it back, so the exe keeps it and passes it to Edge (edge::open_own).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

impl Placement {
    /// In the scaled pixels Edge's --window-position and --window-size take: this exe is
    /// DPI aware and sees physical pixels, so at 150% a 1500-pixel window is 1000 for Edge.
    pub fn for_edge(&self) -> Placement {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromRect};
        use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
        let rect = RECT {
            left: self.x,
            top: self.y,
            right: self.x + self.width,
            bottom: self.y + self.height,
        };
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        unsafe {
            let monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
            if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) != 0 {
                dpi_x = 96;
            }
        }
        let scale = |v: i32| (f64::from(v) * 96.0 / f64::from(dpi_x.max(1))).round() as i32;
        Placement {
            x: scale(self.x),
            y: scale(self.y),
            width: scale(self.width),
            height: scale(self.height),
            maximized: self.maximized,
        }
    }

    /// False when its spot is on no connected monitor (a screen unplugged since).
    pub fn on_screen(&self) -> bool {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONULL, MonitorFromRect};
        let rect = RECT {
            left: self.x,
            top: self.y,
            right: self.x + self.width,
            bottom: self.y + self.height,
        };
        self.width >= 200
            && self.height >= 150
            && !unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONULL) }.is_null()
    }
}

/// The open guide window's place; None when none is open or it's minimized.
fn placement() -> Option<Placement> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, GetWindowRect, IsZoomed, WINDOWPLACEMENT,
    };
    let &hwnd = find().first()?;
    unsafe {
        if IsIconic(hwnd) != 0 {
            return None;
        }
        let maximized = IsZoomed(hwnd) != 0;
        let rect = if maximized {
            // The size it returns to. Work-area coordinates, the same as the screen's with
            // the taskbar at the bottom (the usual place).
            let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
            wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            if GetWindowPlacement(hwnd, &mut wp) == 0 {
                return None;
            }
            wp.rcNormalPosition
        } else {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return None;
            }
            rect
        };
        Some(Placement {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            maximized,
        })
    }
}

/// Watches the guide window's place (from the tray loop) and keeps the last one on disk.
pub struct PlacementKeeper {
    path: std::path::PathBuf,
    last: Option<Placement>,
    checked: std::time::Instant,
}

impl PlacementKeeper {
    pub fn load(path: std::path::PathBuf) -> Self {
        let last = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        Self {
            path,
            last,
            checked: std::time::Instant::now(),
        }
    }

    /// The last place, when it's still on a connected monitor.
    pub fn last(&self) -> Option<Placement> {
        self.last.filter(Placement::on_screen)
    }

    /// Every 2 s: notes where the open window is, and saves it when it moved.
    pub fn tick(&mut self) {
        if self.checked.elapsed() < std::time::Duration::from_secs(2) {
            return;
        }
        self.checked = std::time::Instant::now();
        let Some(now) = placement() else { return };
        if self.last == Some(now) || !now.on_screen() {
            return;
        }
        self.last = Some(now);
        if let Ok(text) = serde_json::to_string(&now) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_guide_title;

    #[test]
    fn matches_app_windows_only() {
        assert!(is_guide_title("Lioneye"));
        assert!(is_guide_title("Lioneye - Settings"));
        assert!(is_guide_title("Lioneye - League"));
        assert!(is_guide_title("Lioneye - Strats"));
        assert!(!is_guide_title("Lioneye - Personal - Microsoft\u{200b} Edge"));
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
