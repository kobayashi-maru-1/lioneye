//! Windows tray icon: the app runs without a console window, so this is how it's opened and stopped.

use std::{
    sync::mpsc::{Receiver, TryRecvError},
    time::Duration,
};

use tokio::sync::watch;
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
};

use crate::watcher::Status;

/// 32x32 RGBA pixels of web/public/favicon-32x32.png.
const ICON: &[u8] = include_bytes!("../assets/tray-icon.rgba");

pub enum Exit {
    /// Quit was picked from the menu.
    Quit,
    /// The server or watcher stopped on its own.
    Stopped,
}

fn tooltip(status: &Status) -> &'static str {
    match status {
        Status::Waiting => "Exile Leveling · Waiting",
        Status::Watching(_) => "Exile Leveling · Auto",
    }
}

/// Shows the icon and runs the window message loop on this thread until Quit or `stopped` fires.
/// Left-click or Open calls `open`.
pub fn run(
    mut status: watch::Receiver<Status>,
    stopped: Receiver<()>,
    open: impl Fn(),
) -> anyhow::Result<Exit> {
    let open_item = MenuItem::new("Open", true, None);
    let quit_item = MenuItem::new("Quit", true, None);
    let menu = Menu::new();
    menu.append_items(&[&open_item, &quit_item])?;

    let icon = Icon::from_rgba(ICON.to_vec(), 32, 32)?;
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_tooltip(tooltip(&status.borrow_and_update()))
        .with_icon(icon)
        .build()?;

    loop {
        // The tray's hidden window receives its clicks through this thread's message queue.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id == *quit_item.id() {
                return Ok(Exit::Quit);
            }
            if event.id == *open_item.id() {
                open();
            }
        }

        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open();
            }
        }

        if status.has_changed().unwrap_or(false) {
            let _ = tray.set_tooltip(Some(tooltip(&status.borrow_and_update())));
        }

        match stopped.try_recv() {
            Ok(()) | Err(TryRecvError::Disconnected) => return Ok(Exit::Stopped),
            Err(TryRecvError::Empty) => {}
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}
