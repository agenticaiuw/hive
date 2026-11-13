//! What's open on the Mac: every window, front to back, with its app and title, and the tabs open
//! in Safari and Chrome (python/desktop.py). The agent gets this with its first look at each task,
//! so when you name a document or a page ("the GSSF presentation") it can find it even when it's
//! behind the window in front, and switch to it instead of opening it again.
//!
//! Window titles come from CoreGraphics. macOS only shows other apps' titles to an app allowed to
//! record the screen, which the agent's screenshots need anyway. Browser tabs come from
//! AppleScript: macOS asks once per browser whether the app the agent runs in may control it
//! (Privacy & Security › Automation). Addresses are cut to the page, without the ?query or
//! #fragment, which can hold sign-in codes.
//!
//! Also here: the app in front (lsappinfo) and notifications, which python/mac_mcp.py had.

use std::time::Duration;

use serde_json::Value;

use crate::ffi::{self, Cf};
use crate::process;

/// Owners whose windows aren't windows.
pub const NOT_WINDOWS: [&str; 9] = [
    "Window Server",
    "Dock",
    "Control Center",
    "Notification Center",
    "Spotlight",
    "SystemUIServer",
    "WindowManager",
    "agent-vhid-captions",
    "Wallpaper",
];
pub const BROWSERS: [&str; 2] = ["Safari", "Google Chrome"];
pub const MOST_TABS: usize = 60;

const ALL: u32 = 0;
const EXCLUDE_DESKTOP: u32 = 1 << 4;
const ON_SCREEN_ONLY: u32 = 1 << 0;

/// One window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub app: String,
    pub title: String,
    /// false: minimized, hidden, or on another desktop
    pub on_screen: bool,
    pub pid: i32,
}

impl Window {
    pub fn new(app: &str, title: &str, on_screen: bool, pid: i32) -> Window {
        Window {
            app: app.into(),
            title: title.into(),
            on_screen,
            pid,
        }
    }
}

/// The apps' windows, front to back: the ones on screen first, then the rest. Windows without a
/// title are left out unless they're on screen and big enough to be a real window.
pub fn windows() -> Vec<Window> {
    let mut found = Vec::new();
    let keys: Vec<Cf> = [
        "kCGWindowOwnerName",
        "kCGWindowName",
        "kCGWindowLayer",
        "kCGWindowIsOnscreen",
        "kCGWindowOwnerPID",
        "kCGWindowBounds",
        "Width",
        "Height",
    ]
    .iter()
    .map(|k| Cf::string(k))
    .collect();
    let [owner, name, layer, onscreen, pid, bounds, width, height] =
        [0, 1, 2, 3, 4, 5, 6, 7].map(|i| keys[i].0);
    unsafe {
        let listed = ffi::CGWindowListCopyWindowInfo(ALL | EXCLUDE_DESKTOP, 0); // front to back
        if listed.is_null() {
            return found;
        }
        let listed = Cf(listed);
        for i in 0..ffi::CFArrayGetCount(listed.0) {
            let info = ffi::CFArrayGetValueAtIndex(listed.0, i);
            let get = |key| ffi::CFDictionaryGetValue(info, key);
            let app = ffi::cf_string(get(owner));
            if ffi::cf_number(get(layer)) != 0.0
                || app.is_empty()
                || NOT_WINDOWS.contains(&app.as_str())
            {
                continue;
            }
            let title = ffi::cf_string(get(name));
            let shown = get(onscreen);
            let on_screen = !shown.is_null() && ffi::CFBooleanGetValue(shown);
            let frame = get(bounds);
            let (w, h) = if frame.is_null() {
                (0.0, 0.0)
            } else {
                (
                    ffi::cf_number(ffi::CFDictionaryGetValue(frame, width)),
                    ffi::cf_number(ffi::CFDictionaryGetValue(frame, height)),
                )
            };
            if title.is_empty() && (!on_screen || w < 200.0 || h < 100.0) {
                continue;
            }
            found.push(Window {
                app,
                title,
                on_screen,
                pid: ffi::cf_number(get(pid)) as i32,
            });
        }
    }
    found.sort_by_key(|w| !w.on_screen); // stable: each group stays front to back
    found
}

/// Hive's own windows: the floating window (the card with what the agent is doing, and its x that
/// stops the task). The agent must never click them.
pub const HIVE_OWN_WINDOWS: [&str; 1] = ["agent-vhid-captions"];

/// Whether (x, y), in global screen points, is on one of Hive's own windows that's on screen.
pub fn own_window_at(x: f64, y: f64) -> bool {
    let keys: Vec<Cf> = [
        "kCGWindowOwnerName",
        "kCGWindowBounds",
        "X",
        "Y",
        "Width",
        "Height",
    ]
    .iter()
    .map(|k| Cf::string(k))
    .collect();
    let [owner, bounds, kx, ky, kw, kh] = [0, 1, 2, 3, 4, 5].map(|i| keys[i].0);
    unsafe {
        let listed = ffi::CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if listed.is_null() {
            return false;
        }
        let listed = Cf(listed);
        for i in 0..ffi::CFArrayGetCount(listed.0) {
            let info = ffi::CFArrayGetValueAtIndex(listed.0, i);
            let app = ffi::cf_string(ffi::CFDictionaryGetValue(info, owner));
            if !HIVE_OWN_WINDOWS.contains(&app.as_str()) {
                continue;
            }
            let frame = ffi::CFDictionaryGetValue(info, bounds);
            if frame.is_null() {
                continue;
            }
            let n = |k| ffi::cf_number(ffi::CFDictionaryGetValue(frame, k));
            if inside((n(kx), n(ky), n(kw), n(kh)), x, y) {
                return true;
            }
        }
    }
    false
}

/// How many apps' windows are on screen with their middle inside the frame (x, y, width,
/// height): ordinary windows only, not Hive's own.
pub fn windows_inside(frame: (f64, f64, f64, f64)) -> usize {
    let keys: Vec<Cf> = [
        "kCGWindowOwnerName",
        "kCGWindowLayer",
        "kCGWindowBounds",
        "X",
        "Y",
        "Width",
        "Height",
    ]
    .iter()
    .map(|k| Cf::string(k))
    .collect();
    let [owner, layer, bounds, kx, ky, kw, kh] = [0, 1, 2, 3, 4, 5, 6].map(|i| keys[i].0);
    let mut count = 0;
    unsafe {
        let listed = ffi::CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if listed.is_null() {
            return 0;
        }
        let listed = Cf(listed);
        for i in 0..ffi::CFArrayGetCount(listed.0) {
            let info = ffi::CFArrayGetValueAtIndex(listed.0, i);
            let app = ffi::cf_string(ffi::CFDictionaryGetValue(info, owner));
            if HIVE_OWN_WINDOWS.contains(&app.as_str()) || app.starts_with("hive-monitor") {
                continue;
            }
            if ffi::cf_number(ffi::CFDictionaryGetValue(info, layer)) != 0.0 {
                continue; // the menu bar, the Dock, panels
            }
            let frame_info = ffi::CFDictionaryGetValue(info, bounds);
            if frame_info.is_null() {
                continue;
            }
            let n = |k| ffi::cf_number(ffi::CFDictionaryGetValue(frame_info, k));
            let (x, y, w, h) = (n(kx), n(ky), n(kw), n(kh));
            if w >= 100.0 && h >= 100.0 && inside(frame, x + w / 2.0, y + h / 2.0) {
                count += 1;
            }
        }
    }
    count
}

/// Whether (x, y) is within the frame (x, y, width, height).
pub fn inside(frame: (f64, f64, f64, f64), x: f64, y: f64) -> bool {
    let (fx, fy, w, h) = frame;
    w > 0.0 && h > 0.0 && x >= fx && x < fx + w && y >= fy && y < fy + h
}

/// The app's window that's in front of its others, if it has one on screen.
pub fn front_window(app: &str) -> Option<Window> {
    front_window_in(&windows(), app)
}

pub fn front_window_in(shown: &[Window], app: &str) -> Option<Window> {
    shown.iter().find(|w| w.app == app && w.on_screen).cloned()
}

/// JavaScript for Automation: a window's tab titles and addresses take one Apple event each. A
/// window without tabs (Settings, Downloads) is skipped.
pub const TABS_SCRIPT: &str = r#"
function run(argv) {
  const out = {};
  for (const name of argv) {
    try {
      const app = Application(name);
      if (!app.running()) continue;
      const safari = name === "Safari";
      out[name] = [];
      for (const w of app.windows()) {
        try {
          const titles = safari ? w.tabs.name() : w.tabs.title();
          const urls = w.tabs.url();
          let current = null;
          try { current = safari ? w.currentTab.index() : w.activeTabIndex(); } catch (e) {}
          out[name].push({current: current, tabs: titles.map((t, i) => [t, urls[i]])});
        } catch (e) {}
      }
    } catch (e) {
      out[name] = {error: String(e)};
    }
  }
  return JSON.stringify(out);
}
"#;

/// The address without its ?query and #fragment (urllib's urlsplit, then scheme://netloc/path).
pub fn page(url: Option<&str>) -> String {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return String::new();
    };
    let (scheme, rest) = split_scheme(url);
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let netloc = &after[..end];
        if !netloc.is_empty() {
            let tail = &after[end..];
            let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
            return format!("{scheme}://{netloc}{path}");
        }
    }
    let cut = url.split('?').next().unwrap_or("");
    cut.split('#').next().unwrap_or("").to_string()
}

/// urlsplit's scheme (lower-cased) and the rest; no scheme when what precedes ':' can't be one.
fn split_scheme(url: &str) -> (String, &str) {
    if let Some(colon) = url.find(':') {
        let scheme = &url[..colon];
        let valid = scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
        if valid {
            return (scheme.to_ascii_lowercase(), &url[colon + 1..]);
        }
    }
    (String::new(), url)
}

/// One browser window's tabs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BrowserWindow {
    /// The tab showing (1-based), if the browser said.
    pub current: Option<i64>,
    /// (title, address without query) of each tab.
    pub tabs: Vec<(String, String)>,
}

/// Each browser's windows, in the order the script answered.
pub type Tabs = Vec<(String, Vec<BrowserWindow>)>;

/// For the browsers with windows open (in `shown`, else now), their tabs. A browser macOS hasn't
/// let us control yet is left out; so is everything if macOS is still asking (the request carries
/// on without it).
pub fn browser_tabs(shown: Option<&[Window]>, timeout: Duration) -> Tabs {
    browser_tabs_with(shown, &|running: &[&str]| {
        let mut args = vec!["-l", "JavaScript", "-e", TABS_SCRIPT];
        args.extend_from_slice(running);
        process::run("osascript", &args, None, Some(timeout))
            .ok()
            .map(|o| o.stdout_text())
    })
}

/// [`browser_tabs`] with the AppleScript run by `run` (given the browsers to ask).
pub fn browser_tabs_with(
    shown: Option<&[Window]>,
    run: &dyn Fn(&[&str]) -> Option<String>,
) -> Tabs {
    let listed;
    let shown = match shown {
        Some(s) => s,
        None => {
            listed = windows();
            &listed
        }
    };
    let running: Vec<&str> = BROWSERS
        .iter()
        .copied()
        .filter(|b| shown.iter().any(|w| w.app == *b))
        .collect();
    if running.is_empty() {
        return Vec::new();
    }
    match run(&running) {
        Some(out) => parse_tabs(&out),
        None => Vec::new(),
    }
}

/// The script's answer as [`Tabs`] (nothing if it isn't JSON).
pub fn parse_tabs(out: &str) -> Tabs {
    let found: Value = match serde_json::from_str(if out.trim().is_empty() { "{}" } else { out }) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(found) = found.as_object() else {
        return Vec::new();
    };
    found
        .iter()
        .filter_map(|(browser, ws)| {
            let ws = ws.as_array()?;
            let windows = ws
                .iter()
                .map(|w| BrowserWindow {
                    current: w.get("current").and_then(Value::as_i64),
                    tabs: w
                        .get("tabs")
                        .and_then(Value::as_array)
                        .map(|tabs| {
                            tabs.iter()
                                .map(|pair| {
                                    let title = pair
                                        .get(0)
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    (title, page(pair.get(1).and_then(Value::as_str)))
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect();
            Some((browser.clone(), windows))
        })
        .collect()
}

/// A string as Python's `json.dumps(s, ensure_ascii=False)`.
pub fn json_quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn first_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((at, _)) => &s[..at],
        None => s,
    }
}

/// The windows and tabs as lines for the agent's request.
pub fn describe(shown: &[Window], tabs: &Tabs) -> String {
    if shown.is_empty() {
        return "Open windows: none found (or macOS hides their titles from this app).".into();
    }
    let mut lines = vec!["Open windows, front to back (app: title):".to_string()];
    for w in shown {
        let where_ = if w.on_screen {
            ""
        } else {
            "   [not on screen: minimized, hidden or on another desktop]"
        };
        let title = if w.title.is_empty() {
            "(no title)".to_string()
        } else {
            json_quote(&w.title)
        };
        lines.push(format!("  - {}: {title}{where_}", w.app));
    }
    let mut listed = 0;
    for (browser, browser_windows) in tabs {
        for (n, bw) in browser_windows.iter().enumerate() {
            if bw.tabs.is_empty() {
                continue;
            }
            lines.push(format!(
                "{browser} window {} tabs (* = the one showing):",
                n + 1
            ));
            for (i, (title, url)) in bw.tabs.iter().enumerate() {
                if listed == MOST_TABS {
                    lines.push("  ... (more tabs not listed)".into());
                    return lines.join("\n");
                }
                let mark = if Some(i as i64 + 1) == bw.current {
                    "*"
                } else {
                    " "
                };
                let line = format!(
                    "  {mark} {} {}",
                    json_quote(first_chars(title, 100)),
                    first_chars(url, 120)
                );
                lines.push(line.trim_end().to_string());
                listed += 1;
            }
        }
    }
    lines.join("\n")
}

pub fn summary() -> String {
    let shown = windows();
    describe(
        &shown,
        &browser_tabs(Some(&shown), Duration::from_secs_f64(1.5)),
    )
}

fn lsappinfo(field: &str) -> Option<String> {
    let two = Some(Duration::from_secs(2));
    let asn = process::run("lsappinfo", ["front"], None, two)
        .ok()?
        .stdout_text()
        .trim()
        .to_string();
    Some(
        process::run("lsappinfo", ["info", "-only", field, &asn], None, two)
            .ok()?
            .stdout_text(),
    )
}

/// The name of the app in front, or "unknown".
pub fn frontmost_app() -> String {
    lsappinfo("name")
        .and_then(|out| {
            let start = out.find("=\"")? + 2;
            let end = out[start..].find('"')?;
            Some(out[start..start + end].to_string())
        })
        .unwrap_or_else(|| "unknown".into())
}

/// The pid of the app in front.
pub fn frontmost_pid() -> Option<i32> {
    let out = lsappinfo("pid")?;
    out.match_indices('=').find_map(|(at, _)| {
        let digits: String = out[at + 1..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    })
}

/// Shows a notification titled "Agent" (without waiting for it).
pub fn notify(message: &str) {
    let script = format!(
        "display notification {} with title \"Agent\"",
        json_quote(message)
    );
    let _ = process::spawn_detached("osascript", ["-e", &script]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_and_tabs_read_front_to_back() {
        let shown = vec![
            Window::new("Microsoft PowerPoint", "10-29 Club-Wide Meeting", true, 1),
            Window::new("Microsoft PowerPoint", "GSSF_Presentation_styled", false, 1),
        ];
        let tabs: Tabs = vec![(
            "Safari".into(),
            vec![BrowserWindow {
                current: Some(2),
                tabs: vec![
                    ("Inbox".into(), "https://mail.example.com/".into()),
                    (
                        "Agentic AI UW Hub".into(),
                        "https://hub.example.com/meet".into(),
                    ),
                ],
            }],
        )];
        assert_eq!(
            describe(&shown, &tabs),
            [
                "Open windows, front to back (app: title):",
                "  - Microsoft PowerPoint: \"10-29 Club-Wide Meeting\"",
                "  - Microsoft PowerPoint: \"GSSF_Presentation_styled\"   [not on screen: minimized, hidden or on \
                 another desktop]",
                "Safari window 1 tabs (* = the one showing):",
                "    \"Inbox\" https://mail.example.com/",
                "  * \"Agentic AI UW Hub\" https://hub.example.com/meet",
            ]
            .join("\n")
        );
    }

    #[test]
    fn addresses_lose_their_query() {
        assert_eq!(
            page(Some("https://accounts.example.com/signin?code=secret#frag")),
            "https://accounts.example.com/signin"
        );
        assert_eq!(page(Some("about:blank")), "about:blank");
        assert_eq!(page(None), "");
        assert_eq!(page(Some("HTTPS://Example.com?x=1")), "https://Example.com");
        assert_eq!(page(Some("file:///tmp/a.html?x#y")), "file:///tmp/a.html");
    }

    #[test]
    fn no_browser_open_means_no_apple_events() {
        let asked = std::cell::Cell::new(false);
        let tabs = browser_tabs_with(Some(&[Window::new("Notes", "Notes", true, 1)]), &|_| {
            asked.set(true);
            None
        });
        assert!(tabs.is_empty());
        assert!(!asked.get());
    }

    #[test]
    fn tabs_from_the_script() {
        let out = r#"{"Safari":[{"current":1,"tabs":[["A","https://a.example/x?q=1"],[null,null]]}],"Google Chrome":{"error":"denied"}}"#;
        let tabs = parse_tabs(out);
        assert_eq!(tabs.len(), 1);
        assert_eq!(
            tabs[0].1[0].tabs,
            vec![
                ("A".to_string(), "https://a.example/x".to_string()),
                (String::new(), String::new())
            ]
        );
        assert!(parse_tabs("not json").is_empty());
        assert!(parse_tabs("").is_empty());
    }

    #[test]
    fn many_tabs_are_cut_off() {
        let shown = vec![Window::new("Safari", "x", true, 1)];
        let many: Vec<(String, String)> =
            (0..70).map(|i| (format!("t{i}"), String::new())).collect();
        let text = describe(
            &shown,
            &vec![(
                "Safari".into(),
                vec![BrowserWindow {
                    current: None,
                    tabs: many,
                }],
            )],
        );
        assert!(text.ends_with("  ... (more tabs not listed)"));
        assert_eq!(
            text.lines().filter(|l| l.starts_with("    \"t")).count(),
            MOST_TABS
        );
        assert!(text.contains("    \"t0\"\n")); // an empty address leaves no trailing space
    }

    #[test]
    fn window_list_reads() {
        // Reads the real window list (no screenshot, no Apple events).
        let shown = windows();
        assert!(shown.iter().all(|w| !w.app.is_empty()));
        let mut sorted = shown.clone();
        sorted.sort_by_key(|w| !w.on_screen);
        assert_eq!(shown, sorted); // on screen first
    }
}
