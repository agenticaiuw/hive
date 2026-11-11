//! Hive's virtual monitor: a second display the agent works on with the real mouse and keyboard
//! (python/virtual_monitor.py).
//!
//! macOS treats it as an ordinary screen (tools/hive_monitor.m creates it), so the Mac tools need
//! nothing special: screenshots are taken of it, clicks land on it, and the app that is clicked
//! there gets the real keyboard focus. When it is off, the tools work on the main display as before.
//!
//! Where Hive works is the user's choice, asked when the app starts and kept in the state folder's
//! `work-screen` file: "real" (their own screen, the default) or "virtual". HIVE_VIRTUAL_MONITOR=1
//! or =0 overrides the file.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::ffi::{self, Bounds, CGDirectDisplayID};
use crate::process;

/// The identity tools/hive_monitor.m gives the display.
pub const VENDOR: u32 = 0x4856;
pub const PRODUCT: u32 = 0x0001;

/// `<repo>/build/hive-monitor`, which creates the display and places windows on it.
pub fn helper() -> PathBuf {
    hive_common::build_dir().join("hive-monitor")
}

/// HIVE_VIRTUAL_MONITOR_SIZE, else 1440x900.
pub fn size() -> String {
    std::env::var("HIVE_VIRTUAL_MONITOR_SIZE").unwrap_or_else(|_| "1440x900".into())
}

fn choice_file() -> PathBuf {
    hive_common::state_dir().join("work-screen")
}

/// "real" (the user's own screen) or "virtual".
pub fn choice() -> &'static str {
    match std::fs::read_to_string(choice_file()) {
        Ok(text) if text.trim() == "virtual" => "virtual",
        _ => "real",
    }
}

/// Saves the choice and turns the virtual monitor on or off to match.
pub fn choose(choice: &str) -> std::io::Result<()> {
    let choice = if choice == "virtual" {
        "virtual"
    } else {
        "real"
    };
    let path = choice_file();
    if let Some(parent) = path.parent() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    std::fs::write(&path, format!("{choice}\n"))?;
    if choice == "virtual" {
        ensure(Duration::from_secs(10));
    } else {
        off();
    }
    Ok(())
}

/// Asks where Hive should work. No answer within `timeout` seconds keeps the last choice.
pub fn ask(timeout: u64) -> &'static str {
    let current = choice();
    let default = if current == "virtual" {
        "Virtual monitor"
    } else {
        "This screen"
    };
    let script = format!(
        "display dialog \"Where should Hive work?\n\nThis screen: it uses your real mouse and keyboard here, and you \
         can watch it.\nVirtual monitor: it works on a second, hidden screen.\" with title \"Hive\" buttons \
         {{\"Virtual monitor\", \"This screen\"}} default button \"{default}\" giving up after {timeout}"
    );
    let done = match process::run(
        "osascript",
        ["-e", "activate", "-e", &script],
        None,
        Some(Duration::from_secs(timeout + 10)),
    ) {
        Ok(done) => done,
        Err(_) => return current,
    };
    let out = done.stdout_text();
    if out.contains("gave up:true") || !done.success() {
        return current;
    }
    let picked = if out.contains("Virtual monitor") {
        "virtual"
    } else {
        "real"
    };
    let _ = choose(picked);
    picked
}

/// Turns the virtual monitor off; macOS moves its windows to the user's screen.
pub fn off() {
    let pattern = format!("{} serve", helper().display());
    let _ = process::run("pkill", ["-TERM", "-f", &pattern], None, None);
}

/// The virtual monitor is wanted: HIVE_VIRTUAL_MONITOR=1/0, else the saved choice.
pub fn enabled() -> bool {
    match std::env::var("HIVE_VIRTUAL_MONITOR").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => choice() == "virtual",
    }
}

/// The virtual monitor's display id and (x, y, width, height) in screen points, or None while it
/// is off.
pub fn display() -> Option<(CGDirectDisplayID, Bounds)> {
    if !enabled() {
        return None;
    }
    ffi::online_displays()?.into_iter().find_map(|id| {
        if ffi::display_identity(id) != (VENDOR, PRODUCT) {
            return None;
        }
        let frame = ffi::display_frame(id);
        (frame.2 > 0.0 && frame.3 > 0.0).then_some((id, frame))
    })
}

/// (x, y, width, height) of the virtual monitor in screen points, or None while it is off.
pub fn bounds() -> Option<Bounds> {
    display().map(|(_, b)| b)
}

/// Turns the virtual monitor on if it is off. Its helper keeps running after this process ends,
/// so the windows on it survive a restart of the app. None if it could not be turned on.
pub fn ensure(timeout: Duration) -> Option<Bounds> {
    if !enabled() {
        return None;
    }
    let found = bounds();
    let helper = helper();
    if found.is_some() || !executable(&helper) {
        return found;
    }
    {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let mut command = Command::new(&helper);
        command
            .args(["serve", &size()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        if let Ok(mut child) = command.spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(found) = bounds() {
            return Some(found);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

fn executable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// (x, y) is on `b`.
pub fn inside(b: Bounds, x: f64, y: f64) -> bool {
    b.0 <= x && x < b.0 + b.2 && b.1 <= y && y < b.1 + b.3
}

pub fn contains(x: f64, y: f64) -> bool {
    bounds().is_some_and(|b| inside(b, x, y))
}

/// Puts the cursor on the virtual monitor if it is elsewhere, so the mouse moves that follow
/// start there instead of crossing the user's screen. True if it moved the cursor.
pub fn bring_cursor(position: (f64, f64)) -> bool {
    match bounds() {
        Some(b) if !inside(b, position.0, position.1) => {
            ffi::warp(b.0 + b.2 / 2.0, b.1 + b.3 / 2.0);
            true
        }
        _ => false,
    }
}

pub fn warp(x: f64, y: f64) {
    ffi::warp(x, y)
}

/// Moves that app's front window onto the virtual monitor. Returns "" or why it could not.
pub fn place(pid: i32) -> String {
    if bounds().is_none() {
        return "the virtual monitor is off".into();
    }
    let helper = helper();
    let pid = pid.to_string();
    match process::run(
        &helper,
        ["place", pid.as_str()],
        None,
        Some(Duration::from_secs(15)),
    ) {
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            format!(
                "Command '['{}', 'place', '{pid}']' timed out after 15 seconds",
                helper.display()
            )
        }
        Err(e) => {
            let code = e.raw_os_error().unwrap_or(0);
            format!(
                "[Errno {code}] {}: '{}'",
                process::strerror(&e),
                helper.display()
            )
        }
        Ok(done) if done.success() => String::new(),
        Ok(done) => {
            let why = done.stderr_text().trim().to_string();
            if why.is_empty() {
                format!("exit status {}", done.code.unwrap_or(-1))
            } else {
                why
            }
        }
    }
}
