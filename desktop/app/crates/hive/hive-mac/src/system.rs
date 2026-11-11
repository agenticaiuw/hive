//! What the Mac tools read from, or do to, the Mac outside agent-vhid-helper: the cursor and
//! the displays, screenshots, the window list, the app in front, the clipboard. [`RealMac`] is
//! this Mac; tests give [`crate::AgentVHID`] and [`crate::MacTools`] a fake one, so nothing reads
//! the real screen, warps the real cursor or posts a notification.

use std::time::Duration;

use crate::desktop::{self, Tabs, Window};
use crate::ffi::{self, Bounds};
use crate::screen::{self, Format};
use crate::virtual_monitor;

pub trait System: Send + Sync {
    /// Cursor position in global screen points (origin at the main display's top-left).
    fn cursor(&self) -> (f64, f64);
    /// (x, y, width, height) of every display, in points.
    fn displays(&self) -> Vec<Bounds>;
    /// The main display's frame, in points.
    fn main_display(&self) -> Bounds;
    /// Hive's virtual monitor's frame while it is on (virtual_monitor.bounds()).
    fn virtual_monitor(&self) -> Option<Bounds>;
    /// Puts the cursor at (x, y) without a mouse event (CGWarpMouseCursorPosition).
    fn warp(&self, x: f64, y: f64);
    /// Moves the app's front window onto the virtual monitor; "" or why it could not.
    fn place_on_virtual_monitor(&self, pid: i32) -> String;
    /// The size in pixels of the display the agent works on.
    fn work_display_pixels(&self) -> (usize, usize);
    /// The display the agent works on, scaled to width x height pixels and encoded.
    fn capture(
        &self,
        width: usize,
        height: usize,
        cursor: bool,
        format: Format,
    ) -> Result<Vec<u8>, String>;
    /// Every window, front to back (desktop.windows()).
    fn windows(&self) -> Vec<Window>;
    /// The tabs open in the browsers that have a window in `shown` (desktop.browser_tabs()).
    fn browser_tabs(&self, shown: &[Window]) -> Tabs;
    /// The name of the app in front, or "unknown".
    fn frontmost_app(&self) -> String;
    /// The pid of the app in front.
    fn frontmost_pid(&self) -> Option<i32>;
    /// Shows a notification titled "Agent".
    fn notify(&self, message: &str);
    /// The clipboard's text, as bytes (pbpaste).
    fn clipboard(&self) -> Vec<u8>;
    /// Puts bytes on the clipboard as text (pbcopy).
    fn set_clipboard(&self, data: &[u8]) -> Result<(), String>;
    /// Natural scrolling is on (the macOS default).
    fn natural_scrolling(&self) -> bool;

    /// The display the agent works on: the virtual monitor while it is on, else the main display.
    fn work_display(&self) -> Bounds {
        self.virtual_monitor()
            .unwrap_or_else(|| self.main_display())
    }
}

/// This Mac.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealMac;

impl System for RealMac {
    fn cursor(&self) -> (f64, f64) {
        ffi::cursor_position()
    }
    fn displays(&self) -> Vec<Bounds> {
        ffi::display_bounds()
    }
    fn main_display(&self) -> Bounds {
        ffi::main_display_bounds()
    }
    fn virtual_monitor(&self) -> Option<Bounds> {
        virtual_monitor::bounds()
    }
    fn warp(&self, x: f64, y: f64) {
        ffi::warp(x, y)
    }
    fn place_on_virtual_monitor(&self, pid: i32) -> String {
        virtual_monitor::place(pid)
    }
    fn work_display_pixels(&self) -> (usize, usize) {
        screen::work_display_pixels()
    }
    fn capture(
        &self,
        width: usize,
        height: usize,
        cursor: bool,
        format: Format,
    ) -> Result<Vec<u8>, String> {
        screen::capture_work_display(width, height, cursor, format)
    }
    fn windows(&self) -> Vec<Window> {
        desktop::windows()
    }
    fn browser_tabs(&self, shown: &[Window]) -> Tabs {
        desktop::browser_tabs(Some(shown), Duration::from_secs_f64(1.5))
    }
    fn frontmost_app(&self) -> String {
        desktop::frontmost_app()
    }
    fn frontmost_pid(&self) -> Option<i32> {
        desktop::frontmost_pid()
    }
    fn notify(&self, message: &str) {
        desktop::notify(message)
    }
    fn clipboard(&self) -> Vec<u8> {
        crate::process::run("pbpaste", Vec::<&str>::new(), None, None)
            .map(|o| o.stdout)
            .unwrap_or_default()
    }
    fn set_clipboard(&self, data: &[u8]) -> Result<(), String> {
        let out = crate::process::run("pbcopy", Vec::<&str>::new(), Some(data), None)
            .map_err(|e| e.to_string())?;
        if out.success() {
            Ok(())
        } else {
            Err(format!(
                "Command '['pbcopy']' returned non-zero exit status {}.",
                out.code.unwrap_or(-1)
            ))
        }
    }
    fn natural_scrolling(&self) -> bool {
        let out = crate::process::run(
            "defaults",
            ["read", "-g", "com.apple.swipescrolldirection"],
            None,
            None,
        )
        .map(|o| o.stdout_text())
        .unwrap_or_default();
        !matches!(out.trim(), "0" | "false") // macOS default is on
    }
}
