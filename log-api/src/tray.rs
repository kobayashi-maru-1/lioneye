//! Windows tray icon: the app runs without a console window, so this is how it's opened and stopped.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, TryRecvError},
    },
    time::{Duration, Instant},
};

use tokio::sync::watch;
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, QS_ALLINPUT,
    TranslateMessage,
};

use crate::{update::Phase, update::Updater, watcher::Status};

/// 32x32 RGBA pixels of web/public/favicon-32x32.png.
const ICON: &[u8] = include_bytes!("../assets/tray-icon.rgba");

/// Set from the console Ctrl+C / close handler; the loop treats it like Quit.
static QUIT: AtomicBool = AtomicBool::new(false);

pub fn request_quit() {
    QUIT.store(true, Ordering::SeqCst);
}

/// Set once an update has started the new exe; the loop then ends as `Exit::Restart`.
static RESTART: AtomicBool = AtomicBool::new(false);

pub fn request_restart() {
    RESTART.store(true, Ordering::SeqCst);
}

/// A double-click sends two clicks; one guide window is enough.
const OPEN_GAP: Duration = Duration::from_secs(1);

pub enum Exit {
    /// Quit was picked from the menu.
    Quit,
    /// The server or watcher stopped on its own.
    Stopped,
    /// An update started the new exe, which takes over (the guide window stays open).
    Restart,
}

fn tooltip(status: &Status) -> &'static str {
    match status {
        Status::Waiting => "Lioneye · Waiting",
        Status::Watching(_) => "Lioneye · Auto",
    }
}

/// Shows the icon and runs the window message loop on this thread until Quit or `stopped` fires.
/// Left-click or Open calls `open`. `tick` runs after each round of window messages (at least
/// every 250 ms) for the in-game bar, whose window lives on this thread too. An Update item
/// shows at the top of the menu while GitHub has a newer release.
pub fn run(
    mut status: watch::Receiver<Status>,
    stopped: Receiver<()>,
    updater: &std::sync::Arc<Updater>,
    open: impl Fn(),
    mut tick: impl FnMut(),
) -> anyhow::Result<Exit> {
    let open_item = MenuItem::new("Open", true, None);
    let quit_item = MenuItem::new("Quit", true, None);
    let update_item = MenuItem::new("Update", true, None);
    let menu = Menu::new();
    menu.append_items(&[&open_item, &quit_item])?;
    // Generation of the updater last shown, and whether the Update item is in the menu.
    let mut update_seen = u64::MAX;
    let mut update_shown = false;

    let icon = Icon::from_rgba(ICON.to_vec(), 32, 32)?;
    // Copy the text out first so the watch lock isn't held while the icon is created.
    let tip = tooltip(&status.borrow_and_update());
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu.clone()))
        .with_menu_on_left_click(false)
        .with_tooltip(tip)
        .with_icon(icon)
        .build()?;

    let mut last_open: Option<Instant> = None;
    let mut open_once = || {
        if last_open.is_none_or(|t| t.elapsed() >= OPEN_GAP) {
            last_open = Some(Instant::now());
            open();
        }
    };

    loop {
        // The tray's hidden window receives its clicks through this thread's message queue.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        if QUIT.load(Ordering::SeqCst) {
            return Ok(Exit::Quit);
        }
        if RESTART.load(Ordering::SeqCst) {
            return Ok(Exit::Restart);
        }

        tick();

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id == *quit_item.id() {
                return Ok(Exit::Quit);
            }
            if event.id == *open_item.id() {
                open_once();
            }
            if event.id == *update_item.id() {
                updater.install();
            }
        }

        let generation = updater.generation();
        if generation != update_seen {
            update_seen = generation;
            let view = updater.view();
            match &view.latest {
                Some(latest) => {
                    let version = latest.tag.trim_start_matches('v');
                    match view.state {
                        Phase::Idle => update_item.set_text(format!("Update {version}")),
                        Phase::Installing => update_item.set_text("Updating…"),
                        Phase::Failed => update_item.set_text("Retry update"),
                    }
                    update_item.set_enabled(view.state != Phase::Installing);
                    if !update_shown {
                        update_shown = menu.prepend(&update_item).is_ok();
                    }
                }
                None => {
                    if update_shown {
                        update_shown = menu.remove(&update_item).is_err();
                    }
                }
            }
        }

        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_once();
            }
        }

        if status.has_changed().unwrap_or(false) {
            let tip = tooltip(&status.borrow_and_update());
            let _ = tray.set_tooltip(Some(tip));
        }

        match stopped.try_recv() {
            Ok(()) | Err(TryRecvError::Disconnected) => return Ok(Exit::Stopped),
            Err(TryRecvError::Empty) => {}
        }

        // Sleep until a window message arrives, or 250 ms for the status and stop checks.
        unsafe {
            MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 250, QS_ALLINPUT);
        }
    }
}
