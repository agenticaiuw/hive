//! Hive.exe (lib.rs says what Hive for Windows is). Opened from Downloads it sets itself up; opened
//! again it says what it runs; Windows opens it with `--open <link>` for a Connect this PC link and
//! with `--background` when the member signs in.
//!
//!   Hive.exe                         set up (from anywhere but its own folder), or say what it runs
//!   Hive.exe --install               set up without a dialog
//!   Hive.exe --open <hive:// link>   connect this PC to the club, after the member says yes
//!   Hive.exe --join-club <board> <code>   the same without asking (the Windows check in CI)
//!   Hive.exe --background            look for the club's newer release now and then, put it in
//!   Hive.exe --update-now            one look, now
//!   Hive.exe --version               this build's release
//!
//! HIVE_TEST_ANSWER=yes|no answers its dialogs (printed instead) for the Windows check in CI;
//! HIVE_UPDATE_FIRST_LOOK_S and HIVE_UPDATE_EVERY_S say when it looks (60 s after it starts, then
//! every 10 minutes, and whenever the member connects).
#![cfg_attr(windows, windows_subsystem = "windows")]

use hive_windows::*;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const USAGE: &str = "Hive.exe [--install | --open <link> | --join-club <board> <code> | --background | --update-now | --version]";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let places = match Places::here() {
        Ok(p) => p,
        Err(why) => {
            tell(&why, true);
            std::process::exit(1);
        }
    };
    let code = match (args.first().map(String::as_str), args.len()) {
        (Some("--version"), 1) => {
            println!("{VERSION}");
            0
        }
        (None, _) => opened(&places),
        (Some("--install"), 1) => match install(&places) {
            Ok(at) => {
                println!("Hive for Windows is set up in {}", at.display());
                0
            }
            Err(why) => {
                eprintln!("{why}");
                1
            }
        },
        (Some("--open"), 2) => open_link(&places, &args[1]),
        (Some("--join-club"), 3) => match join(&places.config(), &args[1], &args[2], &machine_name()) {
            Ok(j) => {
                println!("connected as {}'s PC; Hive's releases come from {}", j.member, j.board);
                0
            }
            Err(why) => {
                eprintln!("{why}");
                1
            }
        },
        (Some("--background"), 1) => background(&places),
        (Some("--update-now"), 1) => match look(&places, VERSION, &says) {
            Ok(outcome) => {
                println!("{outcome:?}");
                0
            }
            Err(why) => {
                eprintln!("{why}");
                1
            }
        },
        _ => {
            eprintln!("usage: {USAGE}");
            64
        }
    };
    std::process::exit(code);
}

/// Opened by the member: set up when it's the download, else say what it runs.
fn opened(places: &Places) -> i32 {
    if !same_file(&std::env::current_exe().unwrap_or_default(), &places.exe()) {
        return match install(places) {
            Ok(_) => {
                tell("Hive for Windows is set up. It starts with Windows and takes the club's updates by itself.\n\nTo connect this PC, open the club page and choose Connect this PC.", false);
                0
            }
            Err(why) => {
                tell(&format!("Hive for Windows couldn't set itself up: {why}"), true);
                1
            }
        };
    }
    start_background(&places.exe());
    tell(&status(places), false);
    0
}

/// Puts this program in the member's own programs folder, registers Connect this PC's `hive://`
/// links and starting with Windows, and starts it in the background.
fn install(places: &Places) -> Result<PathBuf, String> {
    let here = std::env::current_exe().map_err(|e| format!("couldn't tell where it is ({e})"))?;
    let at = places.exe();
    std::fs::create_dir_all(&places.install).map_err(|e| format!("couldn't make {} ({e})", places.install.display()))?;
    if !same_file(&here, &at) {
        // A Hive.exe already there may be running: it moves aside (and stops when it sees it has).
        if at.exists() {
            clean_old(&places.install);
            std::fs::rename(&at, places.install.join(OLD_EXE)).map_err(|e| format!("couldn't move the Hive.exe already there aside ({e})"))?;
        }
        std::fs::copy(&here, &at).map_err(|e| format!("couldn't copy itself to {} ({e})", at.display()))?;
    }
    register(&at)?;
    places.log(&format!("set up {VERSION} in {}", at.display()));
    start_background(&at);
    Ok(at)
}

/// A Connect this PC link: connects after the member says yes.
fn open_link(places: &Places, link: &str) -> i32 {
    let (board, code) = match parse_link(link).and_then(|(b, c)| Ok((board_url(&b)?, c))) {
        Ok(it) => it,
        Err(why) => {
            tell(&why, true);
            return 1;
        }
    };
    let question = format!(
        "Take Hive's updates from the club's board at {board}?\n\nChoose Yes only if you just chose Connect this PC on your club page."
    );
    if !ask(&question) {
        return 0;
    }
    match join(&places.config(), &board, &code, &machine_name()) {
        Ok(j) => {
            places.log(&format!("connected as {}'s PC to {}", j.member, j.board));
            start_background(&places.exe());
            tell(&format!("This PC is connected as {}'s. It shows on the club page now and takes the club's updates by itself.", j.member), false);
            0
        }
        Err(why) => {
            tell(&why, true);
            1
        }
    }
}

/// Looks for the club's newer release now and then and puts it in. One runs at a time; it stops when
/// Hive.exe is replaced under it (set up again, or updated), and the new one carries on.
fn background(places: &Places) -> i32 {
    let Some(_lock) = lock(places, Duration::from_secs(60)) else { return 0 };
    clean_old(&places.install);
    places.log(&format!("{VERSION} running in the background"));
    let seconds = |name: &str, default: u64| std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default);
    let (first, every) = (seconds("HIVE_UPDATE_FIRST_LOOK_S", 60), seconds("HIVE_UPDATE_EVERY_S", 600));
    let exe = places.exe();
    let stamp = |p: &Path| std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok()));
    let ours = stamp(&exe);
    let mut config = stamp(&places.config());
    let mut next = Instant::now() + Duration::from_secs(first);
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if stamp(&exe) != ours {
            places.log("Hive.exe was replaced; the new one carries on");
            start_background(&exe);
            return 0;
        }
        // Connecting (or connecting again) looks at once.
        let now = stamp(&places.config());
        if now != config {
            config = now;
            next = Instant::now();
        }
        if Instant::now() < next {
            continue;
        }
        next = Instant::now() + Duration::from_secs(every);
        match look(places, VERSION, &says) {
            Ok(Outcome::PutIn { from, to }) => {
                places.log(&format!("updated from {from} to {to}; starting it"));
                start_background(&exe);
                return 0;
            }
            Ok(_) => {}
            Err(why) => places.log(&format!("update: {why}")),
        }
    }
}

/// What the program at `path` says it is (`--version`), within 30 seconds.
fn says(path: &Path) -> Result<String, String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("the download didn't start ({e})"))?;
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&out.stdout).to_string());
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            return Err("the download didn't say which release it is within 30 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase(),
        _ => false,
    }
}

/// Answers a dialog for the Windows check in CI, printing it instead.
fn test_answer(text: &str) -> Option<bool> {
    let answer = std::env::var("HIVE_TEST_ANSWER").ok()?;
    println!("dialog: {text}");
    Some(answer == "yes")
}

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt as _;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(window: *mut core::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A message box: `kind` is MB_* flags; the button chosen.
    pub fn message(text: &str, kind: u32) -> i32 {
        let (text, caption) = (wide(text), wide("Hive"));
        // MB_SETFOREGROUND
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), kind | 0x0001_0000) }
    }

    pub fn detached(exe: &Path, arg: &str) {
        let _ = Command::new(exe)
            .arg(arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn();
    }

    /// `reg add <key> ...`, without a window.
    pub fn reg_add(args: &[&str]) -> Result<(), String> {
        let out = Command::new("reg")
            .arg("add")
            .args(args)
            .arg("/f")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("couldn't run reg ({e})"))?;
        if !out.status.success() {
            return Err(format!("Windows didn't take the setting {} ({})", args[0], String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn tell(text: &str, wrong: bool) {
    if test_answer(text).is_none() {
        // MB_OK with MB_ICONWARNING or MB_ICONINFORMATION
        windows::message(text, if wrong { 0x30 } else { 0x40 });
    }
}

#[cfg(windows)]
fn ask(text: &str) -> bool {
    // MB_YESNO | MB_ICONQUESTION; IDYES
    test_answer(text).unwrap_or_else(|| windows::message(text, 0x04 | 0x20) == 6)
}

#[cfg(windows)]
fn start_background(exe: &Path) {
    windows::detached(exe, "--background");
}

/// `hive://` links open Hive.exe --open, and Hive.exe --background starts when the member signs in;
/// both the member's own settings (HKCU), so no administrator.
#[cfg(windows)]
fn register(exe: &Path) -> Result<(), String> {
    let exe = exe.display().to_string();
    let open = format!("\"{exe}\" --open \"%1\"");
    let run = format!("\"{exe}\" --background");
    windows::reg_add(&[r"HKCU\Software\Classes\hive", "/ve", "/d", "URL:Hive"])?;
    windows::reg_add(&[r"HKCU\Software\Classes\hive", "/v", "URL Protocol", "/d", ""])?;
    windows::reg_add(&[r"HKCU\Software\Classes\hive\DefaultIcon", "/ve", "/d", &format!("\"{exe}\",0")])?;
    windows::reg_add(&[r"HKCU\Software\Classes\hive\shell\open\command", "/ve", "/d", &open])?;
    windows::reg_add(&[r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "Hive", "/d", &run])
}

/// One background Hive at a time: a file only one can hold open (released when it stops). A new one
/// waits up to `wait` for the one it replaces to stop.
#[cfg(windows)]
fn lock(places: &Places, wait: Duration) -> Option<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    let _ = std::fs::create_dir_all(&places.home);
    let start = Instant::now();
    loop {
        let held = std::fs::OpenOptions::new().write(true).create(true).truncate(false).share_mode(0).open(places.home.join("background.lock"));
        if let Ok(file) = held {
            return Some(file);
        }
        if start.elapsed() > wait {
            return None;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// Elsewhere (the tests on a Mac) there are no dialogs, links or background programs.
#[cfg(not(windows))]
fn tell(text: &str, _wrong: bool) {
    if test_answer(text).is_none() {
        println!("{text}");
    }
}
#[cfg(not(windows))]
fn ask(text: &str) -> bool {
    test_answer(text).unwrap_or(false)
}
#[cfg(not(windows))]
fn start_background(_exe: &Path) {}
#[cfg(not(windows))]
fn register(_exe: &Path) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn lock(_places: &Places, _wait: Duration) -> Option<std::fs::File> {
    None
}
