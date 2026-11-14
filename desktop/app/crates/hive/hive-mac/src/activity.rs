//! The activity log: what the owner does on the Mac all the time, not only while Hive works on a
//! task. One JSON line in `<state>/activity/<YYYY-MM-DD>.jsonl` (local date) each time the app in
//! front, its front window or the page it shows changes; nothing while nothing changes. The
//! nightly dream reads it to learn about the owner, and to see how they did by hand what Hive
//! couldn't. No screenshots, video or keystrokes. A password manager or a bank is logged by its
//! app name only.

use crate::desktop::{self, Front};
use crate::process;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Apps whose windows are never logged, only that the app was in front.
pub const PRIVATE_APPS: [&str; 8] = [
    "Passwords",
    "1Password",
    "1Password 7",
    "Bitwarden",
    "Keychain Access",
    "LastPass",
    "Dashlane",
    "Wallet",
];

/// Words in a window's title or a page's address that make the entry private: banks, payments,
/// brokers, and password pages.
const PRIVATE_WORDS: [&str; 17] = [
    "bank",
    "chase.com",
    "wellsfargo",
    "paypal",
    "venmo",
    "zelle",
    "schwab",
    "fidelity",
    "vanguard",
    "robinhood",
    "coinbase",
    "creditkarma",
    "americanexpress",
    "capitalone",
    "discover.com",
    "password",
    "passkey",
];

/// How often the front is checked.
pub const EVERY: Duration = Duration::from_secs(3);

/// Whether what `front` shows is private (logged by app name only).
pub fn private(front: &Front) -> bool {
    if PRIVATE_APPS.contains(&front.app.as_str()) {
        return true;
    }
    let text = format!(
        "{} {}",
        front.window.as_deref().unwrap_or(""),
        front.page.as_deref().unwrap_or("")
    )
    .to_lowercase();
    PRIVATE_WORDS.iter().any(|w| text.contains(w))
}

/// The log line for `front` at `at` (Unix seconds); `hive` says whether Hive was working on a
/// task then (so its own steps can be told from the owner's). None when the app isn't known.
pub fn entry(front: &Front, at: u64, hive: bool) -> Option<Value> {
    if front.app.is_empty() {
        return None;
    }
    let mut line = json!({"at": at, "app": front.app, "hive": hive});
    if private(front) {
        line["private"] = json!(true);
    } else {
        if let Some(window) = &front.window {
            line["window"] = json!(window);
        }
        if let Some(page) = &front.page {
            line["page"] = json!(page);
        }
    }
    Some(line)
}

/// Writes a line when the front changes.
pub struct Activity {
    dir: PathBuf,
    last: Option<Value>,
}

impl Activity {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Activity {
            dir: dir.into(),
            last: None,
        }
    }

    /// Notes `front` at `at`, on the local date `day` (YYYY-MM-DD). True when a line was written.
    pub fn note(&mut self, front: &Front, at: u64, day: &str, hive: bool) -> std::io::Result<bool> {
        let Some(line) = entry(front, at, hive) else {
            return Ok(false);
        };
        let same = |a: &Value, b: &Value| {
            ["app", "window", "page", "private", "hive"]
                .iter()
                .all(|k| a.get(k) == b.get(k))
        };
        if self.last.as_ref().is_some_and(|last| same(last, &line)) {
            return Ok(false);
        }
        std::fs::create_dir_all(&self.dir)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(format!("{day}.jsonl")))?;
        writeln!(file, "{line}")?;
        self.last = Some(line);
        Ok(true)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// The local date of `at` (Unix seconds), as YYYY-MM-DD.
pub fn local_day(at: u64) -> String {
    let seconds = at as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call; localtime_r fills `tm`.
    unsafe { libc::localtime_r(&seconds, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday
    )
}

/// Keeps the log in `dir` while `alive` says so, checking every [`EVERY`]. `hive` says whether
/// Hive is working on a task. The browser is asked for its page only when the app or window
/// changed, so a page that changes without its window title is missed until the next change.
pub fn start(
    dir: PathBuf,
    hive: impl Fn() -> bool + Send + 'static,
    alive: impl Fn() -> bool + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut log = Activity::new(dir);
        let mut seen: Option<(String, Option<String>)> = None;
        let mut said = false;
        while alive() {
            let app = desktop::frontmost_app();
            let shown = desktop::windows();
            let quick = desktop::front_with(&app, &shown, &|_| None);
            let key = (quick.app.clone(), quick.window.clone());
            if seen.as_ref() != Some(&key) {
                seen = Some(key);
                let front = if desktop::BROWSERS.contains(&app.as_str()) {
                    desktop::front_with(&app, &shown, &|browser: &str| {
                        let args = ["-l", "JavaScript", "-e", desktop::FRONT_TAB_SCRIPT, browser];
                        process::run("osascript", args, None, Some(Duration::from_secs(2)))
                            .ok()
                            .map(|o| o.stdout_text())
                    })
                } else {
                    quick
                };
                let at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                if let Err(e) = log.note(&front, at, &local_day(at), hive()) {
                    if !said {
                        said = true;
                        eprintln!("activity log: {}: {e}", log.dir().display());
                    }
                }
            }
            std::thread::sleep(EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn front(app: &str, window: Option<&str>, page: Option<&str>) -> Front {
        Front {
            app: app.into(),
            window: window.map(str::to_string),
            page: page.map(str::to_string),
        }
    }

    #[test]
    fn private_apps_and_pages_are_logged_by_app_only() {
        let bank = front(
            "Safari",
            Some("Chase Online"),
            Some("https://secure.chase.com/web/auth"),
        );
        let line = entry(&bank, 1, false).unwrap();
        assert_eq!(line["private"], true);
        assert!(line.get("window").is_none() && line.get("page").is_none());
        let vault = entry(&front("Passwords", Some("All Passwords"), None), 1, false).unwrap();
        assert_eq!(
            vault,
            json!({"at": 1, "app": "Passwords", "hive": false, "private": true})
        );
        let doc = entry(&front("Pages", Some("Essay draft"), None), 1, true).unwrap();
        assert_eq!(
            doc,
            json!({"at": 1, "app": "Pages", "hive": true, "window": "Essay draft"})
        );
        assert!(entry(&front("", None, None), 1, false).is_none());
    }

    #[test]
    fn a_line_only_when_the_front_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Activity::new(dir.path().join("activity"));
        let page = front(
            "Safari",
            Some("Course Search"),
            Some("https://enroll.wisc.edu/search"),
        );
        assert!(log.note(&page, 10, "2026-11-14", false).unwrap());
        assert!(
            !log.note(&page, 13, "2026-11-14", false).unwrap(),
            "same front"
        );
        assert!(
            log.note(&page, 16, "2026-11-14", true).unwrap(),
            "Hive took over"
        );
        let other = front("Terminal", Some("zsh"), None);
        assert!(log.note(&other, 19, "2026-11-15", false).unwrap());
        let day1 = std::fs::read_to_string(dir.path().join("activity/2026-11-14.jsonl")).unwrap();
        let day2 = std::fs::read_to_string(dir.path().join("activity/2026-11-15.jsonl")).unwrap();
        assert_eq!(day1.lines().count(), 2);
        assert_eq!(day2.lines().count(), 1);
        let first: Value = serde_json::from_str(day1.lines().next().unwrap()).unwrap();
        assert_eq!(first["page"], "https://enroll.wisc.edu/search");
    }

    #[test]
    fn local_day_is_a_date() {
        let day = local_day(1_794_648_000);
        assert_eq!(day.len(), 10);
        assert!(day.starts_with("2026-11-1"));
    }
}
