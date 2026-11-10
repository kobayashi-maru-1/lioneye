//! The in-game bar: a small always-on-top window over Path of Exile that shows the guide's
//! `/overlay.html` page in WebView2 (the engine Edge uses). Its buttons tell the guide page to
//! jump to a panel (see server.rs). It shows while the game is the window in front and the
//! game's log has you in a zone (not on the login or character select screens).
//!
//! The window never takes focus: clicking it leaves the game focused. If WebView2 takes focus
//! anyway, it's handed straight back to the game.
//!
//! While it shows, it also watches for the game's passive tree (tree-screen.rs), and tells
//! the page so its Tree tooltip opens with the tree (Settings → Auto tree).

use std::{
    num::NonZeroIsize,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
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
        Shell::{DefSubclassProc, SetWindowSubclass},
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, GetClassNameW, GetCursorPos, GetForegroundWindow,
            GetSystemMetrics, GetWindowRect, HTCAPTION, HWND_TOPMOST, IDC_ARROW, IsWindow,
            LoadCursorW, MA_NOACTIVATE, PostMessageW, RegisterClassExW, SM_CXSCREEN, SW_HIDE,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
            SetForegroundWindow, SetWindowDisplayAffinity, SetWindowPos, ShowWindow, WM_DPICHANGED, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE, WM_MOUSEACTIVATE, WM_NCLBUTTONDOWN, WNDCLASSEXW, WS_EX_NOACTIVATE,
            WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
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

/// How often the bar looks for the game's passive tree: every tick (about 250 ms), with room
/// for a tick that wakes a little early.
const TREE_EVERY: Duration = Duration::from_millis(200);
/// How long after a failed WebView2 start the bar tries again.
const WEBVIEW_RETRY: Duration = Duration::from_secs(10);
/// Checks in a row without the tree before it counts as closed: one of its node tooltips
/// can cover the header for a moment.
const TREE_MISSES: u8 = 3;

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
    /// The page's size in CSS pixels; `up`: it grew upwards (a tooltip open above the bar),
    /// so the bottom edge stays put; `bar`: the bar's own height, when the page sends it.
    Size { width: f64, height: f64, up: bool, bar: Option<f64> },
    /// The page (re)loaded: it doesn't know whether the game's tree is open.
    Loaded,
}

struct Window {
    hwnd: HWND,
    // Dropped before the context it was built with.
    webview: WebView,
    _context: WebContext,
    /// Shown once the page has reported its size, so it never shows at the wrong size.
    sized: bool,
    visible: bool,
}

pub struct Overlay {
    url: String,
    config: watch::Receiver<OverlayConfig>,
    /// From the game's log: in a zone (true), or at login or character select (false);
    /// None when the log doesn't say. The bar hides only on false.
    zone: watch::Receiver<Option<bool>>,
    position: Option<(i32, i32)>,
    always: bool,
    window: Option<Window>,
    /// When WebView2 last couldn't start, and the wait before the next try (doubling from
    /// `WEBVIEW_RETRY` up to 5 minutes), not every tick.
    failed: Option<(Instant, Duration)>,
    /// The game window last seen in front, to hand focus back to.
    game: HWND,
    /// The window in front at the last tick: focus goes back to the game only if it was there.
    last_front: HWND,
    ipc_tx: mpsc::Sender<Ipc>,
    ipc_rx: mpsc::Receiver<Ipc>,
    /// The bar's height (CSS pixels) while a tooltip is open above it: the window's top is
    /// then the tooltip's, and the bar's place is that far above the bottom.
    above: Option<f64>,
    /// The game's passive tree is open, as last seen.
    tree_open: bool,
    /// Checks in a row that didn't see the tree while it was open.
    tree_misses: u8,
    /// When the bar last looked.
    tree_checked: Option<Instant>,
    /// What the page was last told; None until its first size (the page is loaded), and
    /// again whenever the page (re)loads.
    tree_sent: Option<bool>,
    /// The bar is left out of screen reads (it's over the tree's header).
    read_hidden: bool,
}

impl Overlay {
    /// `url` is the guide's address ("http://127.0.0.1:6754/"). Nothing is created until the
    /// bar is first needed.
    pub fn new(
        url: &str,
        config: watch::Receiver<OverlayConfig>,
        zone: watch::Receiver<Option<bool>>,
        saved: &Saved,
    ) -> Self {
        let (ipc_tx, ipc_rx) = mpsc::channel();
        let always = std::env::var_os(ALWAYS_ENV).is_some_and(|v| v != "0");
        if always {
            info!("{ALWAYS_ENV} is set: the overlay shows over any window");
        }
        Self {
            url: format!("{url}overlay.html"),
            config,
            zone,
            // A spot on a monitor that's gone: start over at the default place.
            position: saved.position.filter(|&(x, y)| on_screen(x, y)),
            always,
            window: None,
            failed: None,
            game: std::ptr::null_mut(),
            last_front: std::ptr::null_mut(),
            ipc_tx,
            ipc_rx,
            above: None,
            tree_open: false,
            tree_misses: 0,
            tree_checked: None,
            tree_sent: None,
            read_hidden: false,
        }
    }

    /// Called from the tray loop (every 250 ms or so, and after window messages).
    pub fn tick(&mut self) {
        let front = unsafe { GetForegroundWindow() };
        let own = self.window.as_ref().is_some_and(|w| w.hwnd == front);
        if is_game(front) {
            self.game = front;
        } else if own && is_game(self.last_front) && unsafe { IsWindow(self.game) } != 0 {
            // WebView2 took focus on a click while you were in the game: give it back.
            unsafe { SetForegroundWindow(self.game) };
        }
        self.last_front = front;

        if self.config.has_changed().unwrap_or(false) {
            self.config.borrow_and_update();
            self.persist();
        }
        if MOVED.swap(false, Ordering::SeqCst) {
            if let Some(window) = &self.window {
                let mut rect = unsafe { std::mem::zeroed() };
                if unsafe { GetWindowRect(window.hwnd, &mut rect) } != 0 {
                    // The bar's top, also with a (pinned) tooltip open above it: the page
                    // starts with the bar alone, at the saved place.
                    let top = match self.above {
                        Some(bar) => {
                            let scale = unsafe { GetDpiForWindow(window.hwnd) }.max(96) as f64 / 96.0;
                            rect.bottom - (bar * scale).ceil() as i32
                        }
                        None => rect.top,
                    };
                    self.position = Some((rect.left, top));
                    self.persist();
                }
            }
        }

        let on = self.config.borrow().on;
        // Over the game only while you're playing a character: not on its login or
        // character select screens.
        let playing = *self.zone.borrow() != Some(false);
        let wanted = on && (self.always || ((own || is_game(front)) && playing));
        // A failure is tried again later: right after an update, the old copy's WebView2 can
        // still be closing on the same folder.
        let retry = self.failed.is_none_or(|(at, wait)| at.elapsed() >= wait);
        if wanted && self.window.is_none() && retry {
            match self.create() {
                Ok(window) => {
                    self.window = Some(window);
                    self.failed = None;
                }
                Err(err) => {
                    let wait = self.failed.map_or(WEBVIEW_RETRY, |(_, wait)| {
                        (wait * 2).min(Duration::from_secs(5 * 60))
                    });
                    warn!("Overlay unavailable: {err} (next try in {}s)", wait.as_secs());
                    self.failed = Some((Instant::now(), wait));
                }
            }
        }

        while let Ok(message) = self.ipc_rx.try_recv() {
            match message {
                Ipc::Size { width, height, up, bar } => {
                    self.above = if up { bar } else { None };
                    if let Some(window) = &mut self.window {
                        resize(window.hwnd, width, height, up);
                        if !window.sized {
                            window.sized = true;
                            // The page is up: it hears the tree's state from now on.
                            self.tree_sent = None;
                            if self.position.is_none() {
                                place_default(window.hwnd);
                            }
                        }
                    }
                }
                Ipc::Loaded => self.tree_sent = None,
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
        self.watch_tree();
    }

    /// The Tree tooltip follows the game's passive tree: looked for a few times a second
    /// while the bar shows over the game, with Auto tree on. Hidden, it counts as closed.
    fn watch_tree(&mut self) {
        let Some(window) = &self.window else { return };
        let watching = {
            let config = self.config.borrow();
            config.auto_tree && config.buttons.iter().any(|b| b.id == "tree")
        } && window.visible
            && unsafe { IsWindow(self.game) } != 0;
        let open = if !watching {
            self.tree_misses = 0;
            self.tree_checked = None;
            set_read_hidden(window.hwnd, &mut self.read_hidden, false);
            false
        } else if self.tree_checked.is_some_and(|at| at.elapsed() < TREE_EVERY) {
            self.tree_open
        } else {
            self.tree_checked = Some(Instant::now());
            let mut rect: RECT = unsafe { std::mem::zeroed() };
            let bar = (unsafe { GetWindowRect(window.hwnd, &mut rect) } != 0).then_some(rect);
            match crate::tree_screen::screen_spot(self.game) {
                // Minimized or too small: as it was.
                None => {
                    set_read_hidden(window.hwnd, &mut self.read_hidden, false);
                    self.tree_open
                }
                Some(spot) => {
                    // Covering too much of the header to read around (a tooltip over it,
                    // say), the bar leaves screen reads while it's there, so the check sees
                    // the game under it. Otherwise it stays in screenshots and recordings.
                    let blocks = bar.is_some_and(|b| {
                        overlaps(&b, &spot) && !crate::tree_screen::can_answer(spot, b)
                    });
                    if set_read_hidden(window.hwnd, &mut self.read_hidden, blocks) {
                        // Windows takes a moment to redraw reads without it: next check.
                        self.tree_checked = Some(Instant::now());
                        self.tree_open
                    } else {
                        let cover = if self.read_hidden { None } else { bar };
                        match crate::tree_screen::tree_open(spot, cover) {
                            Some(true) => {
                                self.tree_misses = 0;
                                true
                            }
                            Some(false) if self.tree_open => {
                                self.tree_misses = self.tree_misses.saturating_add(1);
                                self.tree_misses < TREE_MISSES
                            }
                            Some(false) => false,
                            // Can't tell (the bar covers the header and couldn't leave
                            // screen reads): as it was.
                            None => self.tree_open,
                        }
                    }
                }
            }
        };
        self.tree_open = open;
        if window.sized && self.tree_sent != Some(open) {
            let script = format!("window.lioneyeTree?.({open})");
            match window.webview.evaluate_script(&script) {
                Ok(()) => self.tree_sent = Some(open),
                // Tried again next tick: debug, not warn, so a broken page doesn't fill the log.
                Err(err) => tracing::debug!("Couldn't tell the bar about the tree: {err}"),
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
                } else if body == "loaded" {
                    let _ = tx.send(Ipc::Loaded);
                } else if let Some(text) = body.strip_prefix("copy:") {
                    // The Gems tooltip's search. The page can't use its own clipboard:
                    // this window never has focus.
                    if !text.is_empty() && text.len() <= MAX_COPY && !copy_text(target as HWND, text) {
                        warn!("Couldn't copy to the clipboard");
                    }
                } else if let Some(size) = body.strip_prefix("size:") {
                    // "width,height", "width,height,up", or either with the bar's height
                    // after ("width,height,,22", "width,height,up,22").
                    let parts: Vec<&str> = size.split(',').map(str::trim).collect();
                    let number = |i: usize| parts.get(i).and_then(|n| n.parse::<f64>().ok());
                    if let (Some(width), Some(height)) = (number(0), number(1)) {
                        if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 {
                            let _ = tx.send(Ipc::Size {
                                width: width.min(2000.0),
                                height: height.min(1200.0),
                                up: parts.get(2) == Some(&"up"),
                                bar: number(3).filter(|b| b.is_finite() && *b > 0.0 && *b <= height),
                            });
                        }
                    }
                }
            })
            .build(&Handle(hwnd))
            .map_err(|err| {
                // Tried again later: don't leave this window behind each time.
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd) };
                format!("WebView2 didn't start ({err}). Install the WebView2 runtime.")
            })?;
        // wry focuses WebView2 when a drag starts, which would take focus from the game. A
        // subclass added after wry's runs first and keeps that message from reaching it.
        unsafe { SetWindowSubclass(hwnd, Some(keep_focus_on_drag), 1, 0) };
        info!("Overlay ready");
        Ok(Window {
            hwnd,
            webview,
            _context: context,
            sized: false,
            visible: false,
        })
    }
}

unsafe extern "system" fn keep_focus_on_drag(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_ENTERSIZEMOVE {
        return 0;
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// True when two screen rectangles share any pixels.
fn overlaps(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/// Leaves the bar out of screen reads (screenshots, recordings and the tree check) or puts
/// it back; `hidden` is its current state. True when that changed.
fn set_read_hidden(hwnd: HWND, hidden: &mut bool, hide: bool) -> bool {
    if *hidden == hide {
        return false;
    }
    let affinity = if hide { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    // Should it fail, the bar stays in reads and is left out of the comparison instead
    // (before Windows 10 2004 this reads it as black, which these Windows don't run).
    if unsafe { SetWindowDisplayAffinity(hwnd, affinity) } == 0 {
        return false;
    }
    *hidden = hide;
    true
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
        // Dragged to a monitor with another scale: take the size Windows suggests for it
        // (the page's bar is the same size in CSS pixels).
        WM_DPICHANGED => {
            let rect = unsafe { &*(lparam as *const RECT) };
            unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn create_window(position: Option<(i32, i32)>) -> Result<HWND, String> {
    let class = wide(CLASS);
    let title = wide("Lioneye Overlay");
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        // Once: a brush made for each try (after a failed start) would leak.
        static REGISTER: std::sync::Once = std::sync::Once::new();
        REGISTER.call_once(|| {
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
            RegisterClassExW(&wc);
        });

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

/// Sizes the window to the page (CSS pixels, scaled for the monitor). The top edge stays
/// put, or the bottom edge with `up`, so the bar itself never moves.
fn resize(hwnd: HWND, width: f64, height: f64, up: bool) {
    let scale = unsafe { GetDpiForWindow(hwnd) }.max(96) as f64 / 96.0;
    let width = (width * scale).ceil() as i32;
    let height = (height * scale).ceil() as i32;
    unsafe {
        let mut rect = std::mem::zeroed();
        GetWindowRect(hwnd, &mut rect);
        let top = if up { rect.bottom - height } else { rect.top };
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            rect.left,
            top,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
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

/// Text the bar may put on the clipboard, at most (a gem search is ~50 characters).
const MAX_COPY: usize = 1000;
/// Unicode text on the clipboard (CF_UNICODETEXT).
const CF_UNICODETEXT: u32 = 13;

/// Puts text on the clipboard, owned by the bar's window.
fn copy_text(owner: HWND, text: &str) -> bool {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
        if memory.is_null() {
            return false;
        }
        let target = GlobalLock(memory) as *mut u16;
        if target.is_null() {
            GlobalFree(memory);
            return false;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(memory);
        // Clipboard history or another app can hold it for a moment: try a few times.
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(owner) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            GlobalFree(memory);
            return false;
        }
        EmptyClipboard();
        // The clipboard owns the memory once this succeeds.
        let placed = !SetClipboardData(CF_UNICODETEXT, memory).is_null();
        if !placed {
            GlobalFree(memory);
        }
        CloseClipboard();
        placed
    }
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

/// Gives wry our window (also the poe.ninja sign-in window's, ninja-window.rs).
pub(crate) struct Handle(pub(crate) HWND);

impl HasWindowHandle for Handle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
        let raw = RawWindowHandle::Win32(Win32WindowHandle::new(hwnd));
        // The window outlives the WebView: both live in Overlay until the app quits.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}
