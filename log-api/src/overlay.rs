//! The in-game bar: a small always-on-top window over Path of Exile that shows the guide's
//! `/overlay.html` page in WebView2 (the engine Edge uses). Its buttons tell the guide page to
//! jump to a panel (see server.rs). It shows while the game is the window in front.
//!
//! The window never takes focus: clicking it leaves the game focused. If WebView2 takes focus
//! anyway, it's handed straight back to the game.

use std::{
    num::NonZeroIsize,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::{
        Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute},
        Gdi::{CreateSolidBrush, MONITOR_DEFAULTTONULL, MonitorFromPoint},
    },
    System::{
        Com::{COINIT_APARTMENTTHREADED, CoInitializeEx},
        LibraryLoader::GetModuleHandleW,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::ReleaseCapture,
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, GetClassNameW, GetCursorPos, GetForegroundWindow,
            GetSystemMetrics, GetWindowRect, HTCAPTION, HWND_TOPMOST, IDC_ARROW, IsWindow,
            LoadCursorW, MA_NOACTIVATE, PostMessageW, RegisterClassExW, SM_CXSCREEN, SW_HIDE,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
            SetForegroundWindow, SetWindowPos, ShowWindow, WM_EXITSIZEMOVE, WM_MOUSEACTIVATE,
            WM_NCLBUTTONDOWN, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
            WS_POPUP,
        },
    },
};
use wry::{WebContext, WebView, WebViewBuilder};

use crate::server::OverlayConfig;

/// The game's window class (Path of Exile 1 and 2).
const GAME_CLASS: &str = "POEWindowClass";
const CLASS: &str = "ExileLevelingOverlay";
/// Shows the bar over any window, to try it without the game.
const ALWAYS_ENV: &str = "EXILE_LEVELING_OVERLAY_ALWAYS";
/// Before the page reports its size (CSS pixels).
const START_SIZE: (f64, f64) = (420.0, 52.0);
/// The bar page's background (web/src/overlay/styles.css), so the window doesn't flash white while it loads.
const NAVY: (u8, u8, u8) = (22, 22, 22);

/// Set by the window procedure when a drag ends, so the new position is saved.
static MOVED: AtomicBool = AtomicBool::new(false);

/// What's kept between runs: the bar's place and the guide's last settings for it.
#[derive(Serialize, Deserialize, Default)]
pub struct Saved {
    /// Top-left corner in screen pixels; unset until you move the bar.
    pub position: Option<(i32, i32)>,
    #[serde(default)]
    pub config: OverlayConfig,
}

fn saved_path() -> PathBuf {
    crate::data_dir().join("overlay.json")
}

/// The saved place and settings, or the defaults.
pub fn load() -> Saved {
    std::fs::read_to_string(saved_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(saved: &Saved) {
    let path = saved_path();
    let result = serde_json::to_string_pretty(saved)
        .map_err(std::io::Error::other)
        .and_then(|text| std::fs::write(&path, text));
    if let Err(err) = result {
        warn!("Couldn't save {}: {}", path.display(), err);
    }
}

enum Ipc {
    /// The page's bar in CSS pixels.
    Size(f64, f64),
}

struct Window {
    hwnd: HWND,
    // Dropped before the context it was built with.
    _webview: WebView,
    _context: WebContext,
    /// Shown once the page has reported its size, so it never shows at the wrong size.
    sized: bool,
    visible: bool,
}

pub struct Overlay {
    url: String,
    config: watch::Receiver<OverlayConfig>,
    position: Option<(i32, i32)>,
    always: bool,
    window: Option<Window>,
    /// WebView2 couldn't start; don't retry every tick.
    failed: bool,
    /// The game window last seen in front, to hand focus back to.
    game: HWND,
    ipc_tx: mpsc::Sender<Ipc>,
    ipc_rx: mpsc::Receiver<Ipc>,
}

impl Overlay {
    /// `url` is the guide's address ("http://127.0.0.1:6754/"). Nothing is created until the
    /// bar is first needed.
    pub fn new(url: &str, config: watch::Receiver<OverlayConfig>, saved: &Saved) -> Self {
        let (ipc_tx, ipc_rx) = mpsc::channel();
        let always = std::env::var_os(ALWAYS_ENV).is_some_and(|v| v != "0");
        if always {
            info!("{ALWAYS_ENV} is set: the overlay shows over any window");
        }
        Self {
            url: format!("{url}overlay.html"),
            config,
            position: saved.position,
            always,
            window: None,
            failed: false,
            game: std::ptr::null_mut(),
            ipc_tx,
            ipc_rx,
        }
    }

    /// Called from the tray loop (every 250 ms or so, and after window messages).
    pub fn tick(&mut self) {
        let front = unsafe { GetForegroundWindow() };
        let own = self.window.as_ref().is_some_and(|w| w.hwnd == front);
        if is_game(front) {
            self.game = front;
        } else if own && !self.game.is_null() && unsafe { IsWindow(self.game) } != 0 {
            // WebView2 took focus on a click: give it back to the game.
            unsafe { SetForegroundWindow(self.game) };
        }

        if self.config.has_changed().unwrap_or(false) {
            self.config.borrow_and_update();
            self.persist();
        }
        if MOVED.swap(false, Ordering::SeqCst) {
            if let Some(window) = &self.window {
                let mut rect = unsafe { std::mem::zeroed() };
                if unsafe { GetWindowRect(window.hwnd, &mut rect) } != 0 {
                    self.position = Some((rect.left, rect.top));
                    self.persist();
                }
            }
        }

        let on = self.config.borrow().on;
        let wanted = on && (self.always || own || is_game(front));
        if wanted && self.window.is_none() && !self.failed {
            match self.create() {
                Ok(window) => self.window = Some(window),
                Err(err) => {
                    warn!("Overlay unavailable: {err}");
                    self.failed = true;
                }
            }
        }

        while let Ok(message) = self.ipc_rx.try_recv() {
            match message {
                Ipc::Size(width, height) => {
                    if let Some(window) = &mut self.window {
                        resize(window.hwnd, width, height);
                        if !window.sized {
                            window.sized = true;
                            if self.position.is_none() {
                                place_default(window.hwnd);
                            }
                        }
                    }
                }
            }
        }

        if let Some(window) = &mut self.window {
            let show = wanted && window.sized;
            if show != window.visible {
                window.visible = show;
                unsafe {
                    if show {
                        // Above the game, which can itself be topmost in borderless mode.
                        SetWindowPos(
                            window.hwnd,
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        );
                    } else {
                        ShowWindow(window.hwnd, SW_HIDE);
                    }
                }
            }
        }
    }

    fn persist(&self) {
        save(&Saved {
            position: self.position,
            config: self.config.borrow().clone(),
        });
    }

    fn create(&self) -> Result<Window, String> {
        unsafe {
            // WebView2 needs a single-threaded COM apartment on this (the tray's) thread.
            CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        }
        let hwnd = create_window(self.position)?;
        let folder = crate::data_dir().join("webview2");
        let mut context = WebContext::new(Some(folder));
        let tx = self.ipc_tx.clone();
        let target = hwnd as isize;
        let webview = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(&self.url)
            .with_focused(false)
            .with_devtools(false)
            .with_background_color((NAVY.0, NAVY.1, NAVY.2, 255))
            .with_ipc_handler(move |request| {
                let body = request.body();
                if body == "drag" {
                    start_drag(target as HWND);
                } else if let Some(size) = body.strip_prefix("size:") {
                    let mut parts = size.split(',').map(|n| n.trim().parse::<f64>());
                    if let (Some(Ok(width)), Some(Ok(height))) = (parts.next(), parts.next()) {
                        if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 {
                            let _ = tx.send(Ipc::Size(width.min(2000.0), height.min(400.0)));
                        }
                    }
                }
            })
            .build(&Handle(hwnd))
            .map_err(|err| {
                format!("WebView2 didn't start ({err}). Is the WebView2 runtime installed?")
            })?;
        info!("Overlay ready");
        Ok(Window {
            hwnd,
            _webview: webview,
            _context: context,
            sized: false,
            visible: false,
        })
    }
}

/// True for the game's window.
fn is_game(hwnd: HWND) -> bool {
    if hwnd.is_null() {
        return false;
    }
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    len > 0 && String::from_utf16_lossy(&buf[..len as usize]) == GAME_CLASS
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        // A click doesn't activate the bar, so the game keeps focus.
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_EXITSIZEMOVE => {
            MOVED.store(true, Ordering::SeqCst);
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn create_window(position: Option<(i32, i32)>) -> Result<HWND, String> {
    let class = wide(CLASS);
    let title = wide("Exile Leveling Overlay");
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: CreateSolidBrush(
                NAVY.0 as u32 | (NAVY.1 as u32) << 8 | (NAVY.2 as u32) << 16,
            ),
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        // Fails harmlessly if already registered.
        RegisterClassExW(&wc);

        // Off screen until the page reports its size; then moved to its saved place.
        let (x, y) = position
            .filter(|&(x, y)| on_screen(x, y))
            .unwrap_or((-32000, -32000));
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            x,
            y,
            START_SIZE.0 as i32,
            START_SIZE.1 as i32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err("couldn't create its window".into());
        }
        // Rounded corners on Windows 11 (ignored on Windows 10).
        let round = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &round as *const _ as *const _,
            std::mem::size_of_val(&round) as u32,
        );
        Ok(hwnd)
    }
}

/// True when the point is on one of the monitors (a monitor may have been unplugged).
fn on_screen(x: i32, y: i32) -> bool {
    let point = POINT {
        x: x + 16,
        y: y + 16,
    };
    !unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) }.is_null()
}

/// Sizes the window to the page's bar (CSS pixels, scaled for the monitor).
fn resize(hwnd: HWND, width: f64, height: f64) {
    let scale = unsafe { GetDpiForWindow(hwnd) }.max(96) as f64 / 96.0;
    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            (width * scale).ceil() as i32,
            (height * scale).ceil() as i32,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// First run: top middle of the main monitor.
fn place_default(hwnd: HWND) {
    unsafe {
        let mut rect = std::mem::zeroed();
        GetWindowRect(hwnd, &mut rect);
        let width = rect.right - rect.left;
        let x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x.max(0),
            8,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    MOVED.store(true, Ordering::SeqCst);
}

/// Drags the window by its grip: Windows' own move loop, as a title bar would.
fn start_drag(hwnd: HWND) {
    unsafe {
        let mut point = POINT { x: 0, y: 0 };
        GetCursorPos(&mut point);
        ReleaseCapture();
        let lparam = ((point.y as u16 as u32) << 16 | point.x as u16 as u32) as LPARAM;
        PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as WPARAM, lparam);
    }
}

/// Gives wry our window.
struct Handle(HWND);

impl HasWindowHandle for Handle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
        let raw = RawWindowHandle::Win32(Win32WindowHandle::new(hwnd));
        // The window outlives the WebView: both live in Overlay until the app quits.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}
