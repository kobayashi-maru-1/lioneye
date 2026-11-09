//! poe.ninja sign-in, for the live character (ninja-character.rs): poe.ninja re-reads a
//! character from the game on its own schedule, which can be an hour or more apart, but a
//! signed-in owner can ask it to re-read now (its profile page's refresh, `POST
//! /poe1/api/account/refresh-character/<league>/<name>`). That needs your poe.ninja login,
//! so it runs in a WebView2 window of its own, on poe.ninja, with its own profile
//! (`%LOCALAPPDATA%\exile-leveling\ninja-webview2`): you sign in there once (poe.ninja's
//! own sign-in with your Path of Exile account), and its login stays for later runs.
//!
//! The window is hidden except while you sign in (closing it only hides it). Requests run
//! as poe.ninja's own page does them (a plain `fetch` with its login cookie), one page
//! script each, and answer with the HTTP status.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

/// What the guide may ask of the window.
pub enum Command {
    /// Show the window on poe.ninja's account page, to sign in (false: WebView2 couldn't
    /// start).
    SignIn(oneshot::Sender<bool>),
    /// Whether you're signed in: the status of poe.ninja's account settings (200 signed
    /// in, 401 not; 0 when it couldn't be asked).
    Status(oneshot::Sender<u16>),
    /// Ask poe.ninja to re-read a character: the status (200/204 asked, 401 signed out,
    /// 429 too soon; 0 when it couldn't be asked).
    Refresh {
        league: String,
        name: String,
        reply: oneshot::Sender<u16>,
    },
}

/// Sends commands to the window on the tray's thread (it's driven by the tray loop).
#[derive(Clone)]
pub struct Handle(mpsc::Sender<Command>);

impl Handle {
    pub fn new() -> (Self, mpsc::Receiver<Command>) {
        let (tx, rx) = mpsc::channel();
        (Self(tx), rx)
    }

    /// True once the window shows; false when it can't (no WebView2, no tray loop).
    pub async fn sign_in(&self) -> bool {
        let (reply, answer) = oneshot::channel();
        if self.0.send(Command::SignIn(reply)).is_err() {
            return false;
        }
        tokio::time::timeout(TIMEOUT, answer)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false)
    }

    /// The status, or 0 when the window couldn't answer in time.
    pub async fn status(&self) -> u16 {
        let (reply, answer) = oneshot::channel();
        if self.0.send(Command::Status(reply)).is_err() {
            return 0;
        }
        wait(answer).await
    }

    pub async fn refresh(&self, league: String, name: String) -> u16 {
        let (reply, answer) = oneshot::channel();
        if self.0.send(Command::Refresh { league, name, reply }).is_err() {
            return 0;
        }
        wait(answer).await
    }
}

/// How long a request may take (the window may have to start and load first).
const TIMEOUT: Duration = Duration::from_secs(30);

async fn wait(answer: oneshot::Receiver<u16>) -> u16 {
    tokio::time::timeout(TIMEOUT, answer)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0)
}

/// A request waiting to run in the page, or its answer.
struct Job {
    id: u64,
    method: &'static str,
    path: String,
}

/// The page script for a job: the request on poe.ninja (only from a poe.ninja page, never
/// from another site the window may be on mid sign-in), its status posted back.
fn script(job: &Job) -> String {
    format!(
        "(async () => {{ let s = 0; try {{ if (location.origin === 'https://poe.ninja') {{ \
         const r = await fetch({path}, {{ method: '{method}', credentials: 'include' }}); \
         s = r.status; }} }} catch (e) {{}} \
         try {{ window.ipc.postMessage('result:{id}:' + s); }} catch (e) {{}} }})();",
        path = serde_json::to_string(&job.path).unwrap_or_else(|_| "''".into()),
        method = job.method,
        id = job.id,
    )
}

/// A name or league part as poe.ninja's addresses have them (ninja-character.rs checks
/// them the same way).
fn safe(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 64
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn refresh_path(league: &str, name: &str) -> Option<String> {
    (safe(league) && safe(name))
        .then(|| format!("/poe1/api/account/refresh-character/{league}/{name}"))
}

#[cfg(windows)]
pub use imp::NinjaWindow;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    use tracing::{info, warn};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::{
            Com::{COINIT_APARTMENTTHREADED, CoInitializeEx},
            LibraryLoader::GetModuleHandleW,
        },
        UI::WindowsAndMessaging::{
            CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, HWND_NOTOPMOST, HWND_TOPMOST,
            IDC_ARROW, IsWindowVisible, LoadCursorW, RegisterClassExW, SW_HIDE, SW_SHOWNORMAL,
            SWP_NOMOVE, SWP_NOSIZE, SetForegroundWindow, SetWindowPos, ShowWindow, WM_CLOSE,
            WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
        },
    };
    use wry::{NewWindowResponse, PageLoadEvent, WebContext, WebView, WebViewBuilder};

    const CLASS: &str = "LioneyeNinjaSignIn";
    /// Where the hidden window waits: a small poe.ninja page, for requests from its origin.
    const HOME: &str = "https://poe.ninja/robots.txt";
    const ACCOUNT: &str = "https://poe.ninja/account";

    enum Event {
        /// A page started (false) or finished (true) loading, and its address.
        Loaded(bool, String),
        Result { id: u64, status: u16 },
        /// A page asked for a new window (a sign-in popup): opened here instead.
        Open(String),
    }

    struct Window {
        hwnd: HWND,
        webview: WebView,
        _context: WebContext,
    }

    pub struct NinjaWindow {
        commands: mpsc::Receiver<Command>,
        events_tx: mpsc::Sender<Event>,
        events_rx: mpsc::Receiver<Event>,
        window: Option<Window>,
        /// WebView2 couldn't start; requests answer 0 from then on.
        failed: bool,
        /// A page has finished loading (requests wait until then).
        loaded: bool,
        /// The address the window is on.
        url: String,
        queue: VecDeque<Job>,
        waiting: HashMap<u64, (oneshot::Sender<u16>, Instant)>,
        next_id: u64,
    }

    impl NinjaWindow {
        pub fn new(commands: mpsc::Receiver<Command>) -> Self {
            let (events_tx, events_rx) = mpsc::channel();
            Self {
                commands,
                events_tx,
                events_rx,
                window: None,
                failed: false,
                loaded: false,
                url: String::new(),
                queue: VecDeque::new(),
                waiting: HashMap::new(),
                next_id: 1,
            }
        }

        /// Called from the tray loop, as the overlay's tick is.
        pub fn tick(&mut self) {
            while let Ok(command) = self.commands.try_recv() {
                match command {
                    Command::SignIn(reply) => {
                        let _ = reply.send(self.show_sign_in());
                    }
                    Command::Status(reply) => {
                        self.request("GET", "/poe1/api/account/settings-status".into(), reply)
                    }
                    Command::Refresh {
                        league,
                        name,
                        reply,
                    } => match refresh_path(&league, &name) {
                        Some(path) => self.request("POST", path, reply),
                        None => {
                            let _ = reply.send(0);
                        }
                    },
                }
            }
            while let Ok(event) = self.events_rx.try_recv() {
                match event {
                    Event::Loaded(done, url) => {
                        self.loaded = done;
                        self.url = url;
                    }
                    Event::Open(url) => {
                        if let Some(window) = &self.window {
                            self.loaded = false;
                            if let Err(err) = window.webview.load_url(&url) {
                                warn!("poe.ninja sign-in page didn't load: {err}");
                            }
                        }
                    }
                    Event::Result { id, status } => {
                        if let Some((reply, _)) = self.waiting.remove(&id) {
                            let _ = reply.send(status);
                        }
                    }
                }
            }
            // Closed while off poe.ninja (mid sign-in, on pathofexile.com): back home, or
            // requests could never run.
            if self.loaded
                && let Some(window) = &self.window
                && unsafe { IsWindowVisible(window.hwnd) } == 0
                && !self.url.starts_with("https://poe.ninja/")
            {
                self.loaded = false;
                if let Err(err) = window.webview.load_url(HOME) {
                    warn!("poe.ninja page didn't load: {err}");
                }
            }
            if self.loaded
                && let Some(window) = &self.window
            {
                while let Some(job) = self.queue.pop_front() {
                    // Given up on already (it waited too long): never sent late.
                    if !self.waiting.contains_key(&job.id) {
                        continue;
                    }
                    if let Err(err) = window.webview.evaluate_script(&script(&job)) {
                        warn!("poe.ninja request didn't run: {err}");
                        if let Some((reply, _)) = self.waiting.remove(&job.id) {
                            let _ = reply.send(0);
                        }
                    }
                }
            }
            // Requests that never answered (the page went away mid-request).
            self.waiting
                .retain(|_, (_, since)| since.elapsed() < TIMEOUT + Duration::from_secs(5));
        }

        fn request(&mut self, method: &'static str, path: String, reply: oneshot::Sender<u16>) {
            if !self.ensure() {
                let _ = reply.send(0);
                return;
            }
            let id = self.next_id;
            self.next_id += 1;
            self.waiting.insert(id, (reply, Instant::now()));
            self.queue.push_back(Job { id, method, path });
        }

        fn show_sign_in(&mut self) -> bool {
            if !self.ensure() {
                return false;
            }
            if let Some(window) = &self.window {
                self.loaded = false;
                if let Err(err) = window.webview.load_url(ACCOUNT) {
                    warn!("poe.ninja sign-in page didn't load: {err}");
                }
                unsafe {
                    ShowWindow(window.hwnd, SW_SHOWNORMAL);
                    // Above the guide (focus can't be taken from it), then back to normal.
                    let flags = SWP_NOMOVE | SWP_NOSIZE;
                    SetWindowPos(window.hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
                    SetWindowPos(window.hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
                    SetForegroundWindow(window.hwnd);
                }
            }
            true
        }

        /// The window, created hidden on first use; false when WebView2 can't start.
        fn ensure(&mut self) -> bool {
            if self.window.is_some() {
                return true;
            }
            if self.failed {
                return false;
            }
            match self.create() {
                Ok(window) => {
                    self.window = Some(window);
                    true
                }
                Err(err) => {
                    warn!("poe.ninja sign-in unavailable: {err}");
                    self.failed = true;
                    false
                }
            }
        }

        fn create(&self) -> Result<Window, String> {
            unsafe {
                // WebView2 needs a single-threaded COM apartment on this (the tray's) thread.
                CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            }
            let hwnd = create_window()?;
            let folder = crate::data_dir().join("ninja-webview2");
            let mut context = WebContext::new(Some(folder));
            let ipc = self.events_tx.clone();
            let loads = self.events_tx.clone();
            let navigations = self.events_tx.clone();
            let popups = self.events_tx.clone();
            let webview = WebViewBuilder::new_with_web_context(&mut context)
                .with_url(HOME)
                .with_devtools(false)
                .with_on_page_load_handler(move |event, url| {
                    let _ =
                        loads.send(Event::Loaded(matches!(event, PageLoadEvent::Finished), url));
                })
                // Leaving the page: no request runs until the next one has loaded.
                .with_navigation_handler(move |url| {
                    let _ = navigations.send(Event::Loaded(false, url));
                    true
                })
                // A sign-in popup opens in this window instead (no second window).
                .with_new_window_req_handler(move |url, _features| {
                    let _ = popups.send(Event::Open(url));
                    NewWindowResponse::Deny
                })
                .with_ipc_handler(move |request| {
                    // "result:<id>:<status>"
                    let body = request.body();
                    if let Some(rest) = body.strip_prefix("result:")
                        && let Some((id, status)) = rest.split_once(':')
                        && let (Ok(id), Ok(status)) = (id.parse(), status.parse())
                    {
                        let _ = ipc.send(Event::Result { id, status });
                    }
                })
                .build(&crate::overlay::Handle(hwnd))
                .map_err(|err| {
                    format!("WebView2 didn't start ({err}). Install the WebView2 runtime.")
                })?;
            info!("poe.ninja window ready");
            Ok(Window {
                hwnd,
                webview,
                _context: context,
            })
        }
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
            // Closing only hides it: its login stays, and requests keep working.
            WM_CLOSE => {
                unsafe { ShowWindow(hwnd, SW_HIDE) };
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    fn create_window() -> Result<HWND, String> {
        let class = wide(CLASS);
        let title = wide("Lioneye - poe.ninja sign-in");
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassExW(&wc);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                1000,
                800,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err("Couldn't create the poe.ninja window".into());
            }
            Ok(hwnd)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_paths_are_checked() {
        assert_eq!(
            refresh_path("allflame", "KobayashiSRS").as_deref(),
            Some("/poe1/api/account/refresh-character/allflame/KobayashiSRS")
        );
        assert!(refresh_path("all/flame", "x").is_none());
        assert!(refresh_path("allflame", "a b").is_none());
        assert!(refresh_path("", "x").is_none());
    }

    #[test]
    fn scripts_only_ask_poe_ninja() {
        let js = script(&Job {
            id: 7,
            method: "POST",
            path: "/poe1/api/account/refresh-character/allflame/Kob".into(),
        });
        assert!(js.contains("location.origin === 'https://poe.ninja'"));
        assert!(js.contains("\"/poe1/api/account/refresh-character/allflame/Kob\""));
        assert!(js.contains("method: 'POST'"));
        assert!(js.contains("'result:7:'"));
    }
}
