//! voice_agent.py's module-level pieces: the words it listens for, the floating window's one-line
//! text, what is read aloud, notifications, typing dictation, and the workspace viewer check.

use regex::Regex;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub use hive_mac::vhid::took_over;

pub const CANCEL: [&str; 8] = [
    "stop",
    "cancel",
    "never mind",
    "nevermind",
    "abort",
    "stop it",
    "stop that",
    "quit",
];
pub const CONTINUE: [&str; 7] = [
    "continue",
    "go on",
    "keep going",
    "resume",
    "carry on",
    "go ahead",
    "you can continue",
];
/// Seconds after its voice stops that what's heard may still be its echo.
pub const JUST_SPOKE: f64 = 3.0;
/// Nothing to do.
pub const FILLERS: [&str; 11] = [
    "yeah", "okay", "oh", "uh", "um", "hmm", "mm", "mmhmm", "mm-hmm", "uh-huh", "ah",
];
/// Seconds: saying more this soon after a request adds to it rather than replacing it.
pub const FOLLOW_UP: f64 = 8.0;
/// The captions while you have the mouse and keyboard during a task.
pub const TOOK_OVER: &str =
    "You have the mouse and keyboard. The agent keeps working without the screen; press fn to hand them back.";
pub const CANT_HEAR_THE_MAC: &str = "   It can't hear what the Mac is playing ({}), so it stops listening while it \
     talks, and a video playing out loud could be taken for you. Allow {} under System Settings › Privacy & \
     Security › Screen & System Audio Recording, then restart it.";
pub const MIC_SILENT: &str =
    "   The microphone only gives silence. Allow microphone access for {} (System \
     Settings › Privacy & Security › Microphone), then restart it.";

/// Python's `str.format` for the two messages above: each `{}` in turn.
pub fn fill(template: &str, values: &[&str]) -> String {
    let mut out = String::new();
    let mut values = values.iter();
    let mut rest = template;
    while let Some(at) = rest.find("{}") {
        out.push_str(&rest[..at]);
        out.push_str(values.next().copied().unwrap_or(""));
        rest = &rest[at + 2..];
    }
    out.push_str(rest);
    out
}

/// A mutex that carries on after a panic elsewhere poisoned it.
pub struct Slot<T>(Mutex<T>);

impl<T> Slot<T> {
    pub fn new(value: T) -> Slot<T> {
        Slot(Mutex::new(value))
    }
    pub fn lock(&self) -> MutexGuard<'_, T> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Puts `value` in, returning what was there.
    pub fn set(&self, value: T) -> T {
        std::mem::replace(&mut *self.lock(), value)
    }
}

impl<T: Clone> Slot<T> {
    pub fn get(&self) -> T {
        self.lock().clone()
    }
}

impl<T: Default> Slot<T> {
    pub fn take(&self) -> T {
        std::mem::take(&mut *self.lock())
    }
}

impl<T: Default> Default for Slot<T> {
    fn default() -> Self {
        Slot::new(T::default())
    }
}

/// Python's `time.time()`.
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Python's `time.monotonic()`: hive-codex's clock, which tasks measure their times on.
pub fn monotonic() -> f64 {
    hive_codex::monotonic()
}

/// An `Instant` on [`monotonic`]'s clock.
pub fn monotonic_of(at: Instant) -> f64 {
    monotonic() - at.elapsed().as_secs_f64()
}

/// `os.environ.get(key)` as a truth value: set and not empty.
pub fn env_set(key: &str) -> bool {
    std::env::var_os(key).is_some_and(|v| !v.is_empty())
}

/// Python's `round(x, digits)` for the journal's numbers.
pub fn round(x: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (x * scale).round() / scale
}

/// Python's `text[:n]`: the first `n` characters.
pub fn head(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// One line of at most `limit` characters, for the floating window.
pub fn shortened(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        line
    } else {
        format!("{}…", head(&line, limit).trim_end())
    }
}

static MARKDOWN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[`*_#>]|\[([^\]]*)\]\([^)]*\)").expect("valid pattern"));

/// What's read aloud: no markdown, links as their words, at most 600 characters.
pub fn spoken(text: &str) -> String {
    let text = MARKDOWN.replace_all(text, |c: &regex::Captures| {
        c.get(1).map(|m| m.as_str().to_owned()).unwrap_or_default()
    });
    if text.chars().count() < 600 {
        return text.into_owned();
    }
    let first = head(&text, 600);
    let cut = first.rfind(' ').map(|at| &first[..at]).unwrap_or(first);
    format!("{cut}...")
}

static NOT_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\w' ]").expect("valid pattern"));
static NOT_SAID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\w' -]").expect("valid pattern"));

/// "typed" and "type" match; numbers are said one way and written another.
pub fn stems(text: &str) -> Vec<String> {
    NOT_WORDS
        .replace_all(&text.to_lowercase(), " ")
        .split_whitespace()
        .filter(|w| !w.chars().all(char::is_numeric))
        .map(|w| head(w, 4).to_owned())
        .collect()
}

/// What was said, as on_transcript compares it: lower case, no punctuation.
pub fn said_words(text: &str) -> String {
    NOT_SAID
        .replace_all(&text.to_lowercase(), "")
        .trim()
        .to_owned()
}

/// A notification in the corner of the screen (osascript, in the background).
pub fn notify(message: &str, title: &str) {
    let dumps = |s: &str| hive_knowledge::pyjson::dumps(&serde_json::Value::from(s));
    let script = format!(
        "display notification {} with title {}",
        dumps(message),
        dumps(title)
    );
    std::thread::spawn(move || {
        let _ = Command::new("osascript")
            .args(["-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
}

/// `<repo>/build/agent-vhid-paste`.
pub fn paste_tool() -> std::path::PathBuf {
    hive_common::build_dir().join("agent-vhid-paste")
}

/// Types text into the app in front: build/agent-vhid-paste pastes it, then puts back what was
/// on the clipboard. None if it did; otherwise why not, and the text is left on the clipboard.
pub fn paste(text: &str) -> Option<String> {
    paste_with(&paste_tool(), Path::new("pbcopy"), text)
}

/// [`paste`] with this paste tool, and `clipboard` (pbcopy) for when it fails.
pub fn paste_with(tool: &Path, clipboard: &Path, text: &str) -> Option<String> {
    let failed = |why: String| {
        let _ = run_with_input(clipboard, text, None);
        Some(why)
    };
    match run_with_input(tool, text, Some(Duration::from_secs(10))) {
        Err(e) => failed(hive_knowledge::util::os_error(&e, tool)),
        Ok(None) => failed(format!(
            "Command '['{}']' timed out after 10 seconds",
            tool.display()
        )),
        Ok(Some((code, stderr))) if code != 0 => {
            let stderr = stderr.trim();
            Some(if stderr.is_empty() {
                format!("exit {code}")
            } else {
                stderr.to_owned()
            })
        }
        Ok(Some(_)) => None,
    }
}

/// Runs `program` with `input` on stdin: Some((exit code, stderr)), or None after `timeout`
/// (it is killed).
fn run_with_input(
    program: &Path,
    input: &str,
    timeout: Option<Duration>,
) -> std::io::Result<Option<(i32, String)>> {
    let mut child = Command::new(program)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take();
    let input = input.to_owned();
    let writer = std::thread::spawn(move || {
        if let Some(stdin) = stdin.as_mut() {
            let _ = stdin.write_all(input.as_bytes());
        }
    });
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = std::io::Read::read_to_string(stderr, &mut text);
        }
        text
    });
    let deadline = timeout.map(|t| Instant::now() + t);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = writer.join();
    let stderr = reader.join().unwrap_or_default();
    Ok(status.map(|s| (s.code().unwrap_or(-1), stderr)))
}

/// Only speak over the user's speakers while the workspace viewer is visible.
pub fn workspace_voice_allowed() -> bool {
    if !env_set("AGENT_SPACEO_COMMAND") {
        return true;
    }
    match std::fs::read_to_string(hive_common::state_dir().join("workspace-viewer-visible")) {
        Ok(text) => text.trim() == "1",
        Err(_) => false,
    }
}

/// Agent menu › Sound (Voice and Chimes), in the state folder (see [`setting`]). agent-vhid-helper
/// reads it too (src/main.cpp `sound_on`): off, no chime when the agent takes or gives back the screen.
pub const SPEAK_ALOUD: &str = "speak-aloud";
/// Agent menu › Show Floating Window, in the state folder (see [`setting`]).
pub const FLOATING_WINDOW: &str = "floating-window";

/// A switch in the Agent menu, kept for the next launch in a small file in the state folder
/// ("on" or "off", like input-mode): on unless the file says off.
pub fn setting(name: &str) -> bool {
    std::fs::read_to_string(hive_common::state_dir().join(name))
        .map_or(true, |text| text.trim() != "off")
}

pub fn set_setting(name: &str, on: bool) -> std::io::Result<()> {
    let path = hive_common::state_dir().join(name);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    hive_knowledge::util::atomic_write(&path, if on { "on\n" } else { "off\n" })
}

/// What you say while you hold fn, typed into the app in front when you let go.
pub struct Dictation {
    pub since: f64,
    state: Slot<DictationState>,
}

#[derive(Default, Clone)]
pub struct DictationState {
    /// Each thing you said, between pauses.
    pub words: Vec<String>,
    /// It was a tap of fn, or fn+key, after all.
    pub dropped: bool,
    /// Held long enough that the captions say it's dictating.
    pub shown: bool,
}

impl Default for Dictation {
    fn default() -> Self {
        Dictation::new()
    }
}

impl Dictation {
    pub fn new() -> Dictation {
        Dictation {
            since: now(),
            state: Slot::default(),
        }
    }
    pub fn state(&self) -> MutexGuard<'_, DictationState> {
        self.state.lock()
    }
    pub fn text(&self, partial: &str) -> String {
        let mut words = self.state().words.clone();
        words.push(partial.to_owned());
        words.join(" ").trim().to_owned()
    }
    pub fn dropped(&self) -> bool {
        self.state().dropped
    }
}

/// The phone, for the log: "connected", "not connected (...)", "off" or "unreachable (why)".
pub fn describe_phone() -> String {
    match hive_phone::Phone::new(None).and_then(|p| p.connected()) {
        Ok(true) => "connected".into(),
        Ok(false) => "not connected (open the WebDriverAgent relay app on it)".into(),
        Err(e) if !env_set("PHONE_RELAY") => {
            let _ = e;
            "off".into()
        }
        Err(e) => format!("unreachable ({e})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_for_the_window() {
        assert_eq!(shortened("  open\n the   door ", 160), "open the door");
        assert_eq!(shortened("abcdef ghij", 7), "abcdef…");
        assert_eq!(shortened("ab", 2), "ab");
    }

    #[test]
    fn what_is_read_aloud() {
        assert_eq!(
            spoken("**Done**: see [the page](https://x.y) `code` #1 > a_b"),
            "Done: see the page code 1  ab"
        );
        let long = "word ".repeat(200);
        let said = spoken(&long);
        assert!(said.ends_with("word..."), "{said}");
        assert!(said.chars().count() <= 603);
    }

    #[test]
    fn stems_and_words() {
        assert_eq!(
            stems("I typed 12 times, thirty-four!"),
            ["i", "type", "time", "thir", "four"]
        );
        assert_eq!(said_words("Stop."), "stop");
        assert_eq!(said_words("  Mm-hmm! "), "mm-hmm");
        assert_eq!(fill("a {} b {}", &["1", "2"]), "a 1 b 2");
    }

    #[test]
    fn dictation_text() {
        let d = Dictation::new();
        assert_eq!(d.text(""), "");
        d.state().words.push("Hello there.".into());
        assert_eq!(d.text("See you"), "Hello there. See you");
    }

    #[test]
    fn paste_reports_why_it_couldnt() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("agent-vhid-paste");
        let copied = dir.path().join("copied");
        let clipboard = dir.path().join("pbcopy");
        std::fs::write(
            &clipboard,
            format!("#!/bin/sh\ncat > '{}'\n", copied.display()),
        )
        .unwrap();
        std::fs::set_permissions(
            &clipboard,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let why = paste_with(&missing, &clipboard, "x").unwrap();
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "x"); // left on the clipboard
        assert!(
            why.starts_with("[Errno 2] No such file or directory: '"),
            "{why}"
        );
        let failing = dir.path().join("fails");
        std::fs::write(
            &failing,
            "#!/bin/sh\ncat >/dev/null\necho 'not allowed' >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &failing,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        assert_eq!(
            paste_with(&failing, &clipboard, "x").as_deref(),
            Some("not allowed")
        );
        let quiet = dir.path().join("quiet");
        std::fs::write(&quiet, "#!/bin/sh\ncat >/dev/null\nexit 4\n").unwrap();
        std::fs::set_permissions(&quiet, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        assert_eq!(
            paste_with(&quiet, &clipboard, "x").as_deref(),
            Some("exit 4")
        );
        let works = dir.path().join("works");
        std::fs::write(&works, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&works, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        assert_eq!(paste_with(&works, &clipboard, "x"), None);
    }
}
