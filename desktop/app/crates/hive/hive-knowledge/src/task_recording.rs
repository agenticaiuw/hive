//! Screen recordings of the agent's tasks, paired with a timeline of what Hive and the Mac were
//! doing (python/task_recording.py).
//!
//! While any task runs, the whole screen is recorded (macOS screencapture, with the cursor and
//! clicks) into ~/Movies/Hive/<date time> <request>/screen.mov. Next to it:
//!
//!   timeline.jsonl  one line per event, each with the wall-clock time ("t") and the seconds into
//!                   the video ("video"): Hive's own lines, its status line, who has the mouse and
//!                   keyboard, and the Mac's state (front app and window, cursor, whether someone is
//!                   touching it) whenever that changes
//!   screen.srt      the same as subtitles, in time with the video
//!   meta.json       when the video started, its length, and how its clock lines up with the timeline
//!
//! `HIVE_RECORD=0` turns recording off; `HIVE_RECORDINGS` sets another folder.

use crate::pyjson;
use crate::util::{self, Local};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]|\r").expect("valid pattern"));
static NOT_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\w\- ]+").expect("valid pattern"));

/// Where recordings go: `HIVE_RECORDINGS`, else ~/Movies/Hive.
pub fn folder() -> PathBuf {
    match std::env::var_os("HIVE_RECORDINGS").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => hive_common::paths::home().join("Movies").join("Hive"),
    }
}

/// The request as a folder name: words only, at most 48 characters.
pub fn slug(text: &str) -> String {
    let words = NOT_WORD.replace_all(text, " ");
    let joined = words.split_whitespace().collect::<Vec<_>>().join(" ");
    pyjson::head(&joined, 48).trim().to_string()
}

/// `HH:MM:SS.mmm` on this Mac's clock.
pub fn clock(t: f64) -> String {
    let at = Local::at(t);
    format!("{}.{:03}", at.time(), at.micros / 1000)
}

// --- the Mac's state, read without extra permissions beyond Hive's own screen recording ---------

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CString};
    type Ref = *const c_void;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
        fn CFStringCreateWithCString(alloc: Ref, text: *const c_char, encoding: u32) -> Ref;
        fn CFStringGetCString(text: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFNumberGetValue(number: Ref, kind: isize, out: *mut c_void) -> u8;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFRelease(value: Ref);
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> Ref;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> Ref;
        fn IOServiceGetMatchingService(main_port: u32, matching: Ref) -> u32;
        fn IORegistryEntryCreateCFProperty(entry: u32, key: Ref, alloc: Ref, options: u32) -> Ref;
        fn IOObjectRelease(object: u32) -> i32;
    }

    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: we own this reference (a Create/Copy result).
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn cfstr(text: &str) -> Owned {
        let c = CString::new(text).unwrap_or_default();
        // SAFETY: c is a valid C string for the call.
        Owned(unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) })
    }

    fn string(value: Ref) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut buffer = vec![0 as c_char; 2048];
        // SAFETY: the buffer is 2048 bytes; the string is a CFString from the window list.
        if unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), 2048, UTF8) } == 0 {
            return String::new();
        }
        // SAFETY: CFStringGetCString wrote a NUL-terminated string into the buffer.
        unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    /// (app, window title) of the frontmost ordinary window.
    pub fn front_window() -> (String, String) {
        // On screen only, no desktop elements.
        // SAFETY: plain CoreGraphics call; the result is released by Owned.
        let windows = Owned(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) });
        if windows.0.is_null() {
            return (String::new(), String::new());
        }
        let (owner, name, layer_key) = (
            cfstr("kCGWindowOwnerName"),
            cfstr("kCGWindowName"),
            cfstr("kCGWindowLayer"),
        );
        // SAFETY: windows is a CFArray of CFDictionaries; values are borrowed (Get rule).
        unsafe {
            for i in 0..CFArrayGetCount(windows.0) {
                let info = CFArrayGetValueAtIndex(windows.0, i);
                let mut layer: i32 = 0;
                let number = CFDictionaryGetValue(info, layer_key.0);
                if !number.is_null() {
                    CFNumberGetValue(number, 3, (&mut layer as *mut i32).cast());
                    // kCFNumberSInt32Type
                }
                if layer == 0 {
                    return (
                        string(CFDictionaryGetValue(info, owner.0)),
                        string(CFDictionaryGetValue(info, name.0)),
                    );
                }
            }
        }
        (String::new(), String::new())
    }

    /// Seconds since the last keyboard, mouse or trackpad input (IOHIDSystem's HIDIdleTime), or
    /// -1 when it can't be read.
    pub fn idle_seconds() -> f64 {
        let class = CString::new("IOHIDSystem").unwrap_or_default();
        // SAFETY: IOServiceGetMatchingService consumes the matching dictionary; the service and
        // the property are released below.
        unsafe {
            let service = IOServiceGetMatchingService(0, IOServiceMatching(class.as_ptr()));
            if service == 0 {
                return -1.0;
            }
            let key = cfstr("HIDIdleTime");
            let value = Owned(IORegistryEntryCreateCFProperty(
                service,
                key.0,
                std::ptr::null(),
                0,
            ));
            IOObjectRelease(service);
            if value.0.is_null() || CFGetTypeID(value.0) != CFNumberGetTypeID() {
                return -1.0;
            }
            let mut nanos: i64 = 0;
            if CFNumberGetValue(value.0, 4, (&mut nanos as *mut i64).cast()) == 0 {
                // kCFNumberSInt64Type
                return -1.0;
            }
            nanos as f64 / 1e9
        }
    }
}

/// (app, window title) of the frontmost ordinary window.
pub fn front_window() -> (String, String) {
    #[cfg(target_os = "macos")]
    return mac::front_window();
    #[cfg(not(target_os = "macos"))]
    (String::new(), String::new())
}

/// Seconds since someone last touched the keyboard, mouse or trackpad; -1 when unknown.
pub fn idle_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    return mac::idle_seconds();
    #[cfg(not(target_os = "macos"))]
    -1.0
}

/// A video's length in seconds (ffprobe), or None.
pub fn video_length(path: &Path) -> Option<f64> {
    let mut probe = Command::new("ffprobe");
    probe
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path);
    let out = util::run(&mut probe, None, Some(Duration::from_secs(20))).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        text.parse().ok()
    }
}

/// A running screen recording (screencapture), or a test's stand-in.
pub trait Capture: Send {
    /// The exit code once it has ended (negative: the signal that ended it).
    fn poll(&mut self) -> Option<i32>;
    /// Asks it to finish the file (SIGINT for screencapture).
    fn interrupt(&mut self);
    /// Waits up to `timeout`; whether it ended.
    fn wait(&mut self, timeout: Duration) -> bool;
    fn kill(&mut self);
}

/// What the recorder reads from the Mac and how it records; tests replace it.
pub trait Probe: Send + Sync {
    /// (app, window) in front; None when it couldn't be read.
    fn front_window(&self) -> Option<(String, String)> {
        Some(front_window())
    }
    fn idle_seconds(&self) -> f64 {
        idle_seconds()
    }
    fn video_length(&self, path: &Path) -> Option<f64> {
        video_length(path)
    }
    /// Starts recording the screen into `movie`, its output going to `log`.
    fn start_capture(&self, movie: &Path, log: File) -> std::io::Result<Box<dyn Capture>> {
        let err = log.try_clone()?;
        let child = Command::new("screencapture")
            .args(["-v", "-C", "-k", "-x"])
            .arg(movie)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(err)
            .spawn()?;
        Ok(Box::new(ScreenCapture(child)))
    }
}

/// The real Mac.
pub struct SystemProbe;
impl Probe for SystemProbe {}

struct ScreenCapture(Child);

impl Capture for ScreenCapture {
    fn poll(&mut self) -> Option<i32> {
        self.0
            .try_wait()
            .ok()
            .flatten()
            .map(|s| util::returncode(&s))
    }
    fn interrupt(&mut self) {
        // SAFETY: plain kill(2) on our own child's pid.
        unsafe {
            libc::kill(self.0.id() as libc::pid_t, libc::SIGINT);
        }
    }
    fn wait(&mut self, timeout: Duration) -> bool {
        matches!(util::wait(&mut self.0, Some(timeout)), Ok(Some(_)))
    }
    fn kill(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

type Callback<T> = Box<dyn Fn() -> T + Send + Sync>;

/// What the recorder asks the app (Python's constructor arguments).
pub struct RecorderOptions {
    /// Whether any task is running.
    pub running: Callback<bool>,
    /// Whether the agent has the mouse and keyboard.
    pub engaged: Option<Callback<bool>>,
    /// Names the recording (the running task's request).
    pub title: Option<Callback<String>>,
    /// The cursor's position; None when it couldn't be read.
    pub cursor: Option<Callback<Option<(f64, f64)>>>,
    /// Called with the folder after a recording's files are written.
    pub on_finished: Option<Box<dyn Fn(&Path) + Send + Sync>>,
    pub poll: Duration,
    /// How long after the last task ends the recording stops.
    pub grace: Duration,
    /// Start the thread that starts and stops recordings (off in tests).
    pub start_thread: bool,
}

impl RecorderOptions {
    pub fn new(running: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        RecorderOptions {
            running: Box::new(running),
            engaged: None,
            title: None,
            cursor: None,
            on_finished: None,
            poll: Duration::from_millis(250),
            grace: Duration::from_secs(3),
            start_thread: true,
        }
    }
}

/// One timeline line: its fields as written, and the exact time (Python's `_at`).
#[derive(Debug, Clone)]
pub struct Line {
    pub at: f64,
    pub fields: Map<String, Value>,
}

impl Line {
    fn json(&self) -> String {
        pyjson::dumps_utf8(&Value::Object(self.fields.clone()))
    }
    fn video(&self) -> f64 {
        self.fields
            .get("video")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    }
}

#[derive(Default)]
struct State {
    recent: VecDeque<(f64, String, String, Map<String, Value>)>,
    capture: Option<Box<dyn Capture>>,
    dir: Option<PathBuf>,
    started: f64,
    events: Vec<Line>,
    file: Option<File>,
}

/// Starts a recording when a task starts and stops it a few seconds after the last one ends.
///
/// `event()` adds a line to the timeline; lines from shortly before a recording starts (the
/// request itself) are kept and added when it starts.
pub struct Recorder {
    options: RecorderOptions,
    probe: Arc<dyn Probe>,
    pub enabled: bool,
    state: Mutex<State>,
    mac_state: Mutex<Map<String, Value>>,
    gave_up: AtomicBool, // screencapture quit on its own: don't restart until the tasks end
}

impl Recorder {
    /// A recorder of the real screen (python's `Recorder(...)`).
    pub fn new(options: RecorderOptions) -> Arc<Recorder> {
        Recorder::with_probe(options, Arc::new(SystemProbe))
    }

    pub fn with_probe(options: RecorderOptions, probe: Arc<dyn Probe>) -> Arc<Recorder> {
        let start = options.start_thread;
        let recorder = Arc::new(Recorder {
            options,
            probe,
            enabled: std::env::var("HIVE_RECORD")
                .map(|v| v != "0")
                .unwrap_or(true),
            state: Mutex::new(State::default()),
            mac_state: Mutex::new(Map::new()),
            gave_up: AtomicBool::new(false),
        });
        if start {
            let weak = Arc::downgrade(&recorder);
            std::thread::Builder::new()
                .name("task-recording".into())
                .spawn(move || watch(weak))
                .expect("spawn task-recording");
        }
        recorder
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether screencapture is running now.
    pub fn recording(&self) -> bool {
        self.lock().capture.is_some()
    }

    /// The current (or last) recording's folder.
    pub fn dir(&self) -> Option<PathBuf> {
        self.lock().dir.clone()
    }

    // --- the timeline ---------------------------------------------------------------------------

    /// Adds a line to the timeline: `kind` and text (Python's `event(kind, text)`).
    pub fn event(&self, kind: &str, text: &str) {
        self.event_with(kind, text, Map::new())
    }

    /// `event(kind, text, **extra)`.
    pub fn event_with(&self, kind: &str, text: &str, extra: Map<String, Value>) {
        let text = ANSI.replace_all(text, "").trim().to_string();
        if text.is_empty() && extra.is_empty() {
            return;
        }
        let now = util::now();
        let mut state = self.lock();
        if state.capture.is_none() {
            if state.recent.len() == 60 {
                state.recent.pop_front();
            }
            state.recent.push_back((now, kind.into(), text, extra));
            return;
        }
        write_line(&mut state, now, kind, &text, extra);
    }

    // --- starting and stopping ------------------------------------------------------------------

    pub fn start(&self) -> std::io::Result<()> {
        let title = self.options.title.as_ref().map(|t| t()).unwrap_or_default();
        let stamp = Local::now();
        let name = format!(
            "{} {:02}.{:02}.{:02} {}",
            stamp.date(),
            stamp.hour,
            stamp.minute,
            stamp.second,
            slug(&title)
        );
        let target = folder().join(name.trim());
        std::fs::create_dir_all(&target)?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(target.join("screencapture.log"))?;
        let mut state = self.lock();
        state.dir = Some(target.clone());
        state.events.clear();
        self.mac_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        state.started = util::now();
        state.capture = Some(self.probe.start_capture(&target.join("screen.mov"), log)?);
        state.file = Some(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(target.join("timeline.jsonl"))?,
        );
        let started = state.started;
        let mut extra = Map::new();
        extra.insert("video_file".into(), json!("screen.mov"));
        write_line(&mut state, started, "recording", "started", extra);
        let recent: Vec<_> = state.recent.drain(..).collect();
        for (at, kind, text, extra) in recent {
            if started - at <= 60.0 {
                write_line(&mut state, at, &kind, &text, extra);
            }
        }
        drop(state);
        self.sample(true);
        Ok(())
    }

    pub fn stop(&self) {
        let (mut capture, stopped) = {
            let mut state = self.lock();
            if state.capture.is_none() {
                return;
            }
            let stopped = util::now();
            write_line(&mut state, stopped, "recording", "stopped", Map::new()); // still recording while this goes in
            (state.capture.take().expect("checked above"), stopped)
        };
        if capture.poll().is_none() {
            capture.interrupt(); // screencapture finishes the file on SIGINT
            if !capture.wait(Duration::from_secs(20)) {
                capture.kill();
            }
        }
        self.finish(stopped);
    }

    fn finish(&self, stopped: f64) {
        let (target, mut events, started) = {
            let mut state = self.lock();
            state.file = None;
            (state.dir.clone(), state.events.clone(), state.started)
        };
        let Some(target) = target else { return };
        let length = self.probe.video_length(&target.join("screen.mov"));
        // screencapture starts writing a moment after it is launched; line the clock up with the video.
        let lag = match length {
            Some(l) if l != 0.0 => (stopped - started - l).max(0.0),
            _ => 0.0,
        };
        for line in &mut events {
            line.fields
                .insert("video".into(), json!(round3(line.at - started - lag)));
        }
        let timeline: String = events.iter().map(|l| l.json() + "\n").collect();
        let _ = std::fs::write(target.join("timeline.jsonl"), timeline);
        let _ = std::fs::write(target.join("screen.srt"), subtitles(&events, length));
        let meta = json!({
            "video": "screen.mov",
            "videoStarted": Local::at(started + lag).iso_millis(),
            "videoSeconds": length,
            "startLagSeconds": round3(lag),
            "note": "timeline.jsonl 'video' = seconds into screen.mov; 't' = wall-clock time on this Mac",
        });
        let _ = std::fs::write(
            target.join("meta.json"),
            pyjson::dumps_with(&meta, true, Some(1)),
        );
        if let Some(done) = &self.options.on_finished {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| done(&target)));
        }
    }

    // --- the Mac's state ------------------------------------------------------------------------

    /// Adds a "mac" line with what changed (everything when `force`).
    pub fn sample(&self, force: bool) {
        let mut state = Map::new();
        if let Some((app, window)) = self.probe.front_window() {
            state.insert("front_app".into(), json!(app));
            state.insert("window".into(), json!(window));
        }
        if let Some(engaged) = &self.options.engaged {
            state.insert(
                "control".into(),
                json!(if engaged() { "agent" } else { "you" }),
            );
        }
        if let Some((x, y)) = self.options.cursor.as_ref().and_then(|c| c()) {
            state.insert("cursor".into(), json!([x.trunc() as i64, y.trunc() as i64]));
        }
        let idle = self.probe.idle_seconds();
        if idle >= 0.0 {
            state.insert("someone_touching".into(), json!(idle < 1.5));
        }
        let changed: Map<String, Value> = {
            let mut known = self.mac_state.lock().unwrap_or_else(|e| e.into_inner());
            let changed: Map<String, Value> = state
                .into_iter()
                .filter(|(k, v)| force || known.get(k) != Some(v))
                .collect();
            for (k, v) in &changed {
                known.insert(k.clone(), v.clone());
            }
            changed
        };
        if !changed.is_empty() {
            self.event_with("mac", "", changed);
        }
    }
}

fn write_line(state: &mut State, now: f64, kind: &str, text: &str, extra: Map<String, Value>) {
    let mut fields = Map::new();
    fields.insert("t".into(), json!(Local::at(now).iso_millis()));
    fields.insert("video".into(), json!(round3(now - state.started)));
    fields.insert("kind".into(), json!(kind));
    if !text.is_empty() {
        fields.insert("text".into(), json!(text));
    }
    for (k, v) in extra {
        fields.insert(k, v);
    }
    let line = Line { at: now, fields };
    if let Some(file) = state.file.as_mut() {
        let _ = file.write_all((line.json() + "\n").as_bytes());
        let _ = file.flush();
    }
    state.events.push(line);
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round_ties_even() / 1000.0
}

fn watch(weak: Weak<Recorder>) {
    let (mut idle_since, mut last_sample): (Option<f64>, f64) = (None, 0.0);
    loop {
        let Some(r) = weak.upgrade() else { return };
        let poll = r.options.poll;
        let busy = (r.options.running)();
        if !busy {
            r.gave_up.store(false, Ordering::SeqCst);
        }
        let recording = r.recording();
        if busy && !recording && r.enabled && !r.gave_up.load(Ordering::SeqCst) {
            let _ = r.start();
            idle_since = None;
        } else if !busy && recording {
            let since = *idle_since.get_or_insert_with(util::now);
            if util::now() - since >= r.options.grace.as_secs_f64() {
                r.stop();
                idle_since = None;
            }
        } else {
            idle_since = None;
        }
        let quit = {
            let mut state = r.lock();
            state.capture.as_mut().and_then(|c| c.poll())
        };
        if let Some(code) = quit {
            r.event(
                "recording",
                &format!("screencapture quit by itself (exit {code}); see screencapture.log"),
            );
            r.lock().capture = None;
            r.gave_up.store(true, Ordering::SeqCst);
            r.finish(util::now());
        } else if r.recording() && util::now() - last_sample >= 1.0 {
            last_sample = util::now();
            r.sample(false);
        }
        drop(r);
        std::thread::sleep(poll);
    }
}

/// SRT cues: at every event, what Hive was last doing and the Mac's state, with the exact time.
pub fn subtitles(events: &[Line], length: Option<f64>) -> String {
    let (mut hive, mut mac, mut cues) = (String::new(), Map::new(), Vec::<(f64, String)>::new());
    for line in events {
        let kind = line.fields.get("kind").and_then(Value::as_str);
        let text = line.fields.get("text").filter(|t| pyjson::truthy(Some(t)));
        if kind == Some("mac") {
            for (k, v) in &line.fields {
                if !["t", "video", "kind"].contains(&k.as_str()) {
                    mac.insert(k.clone(), v.clone());
                }
            }
        } else if let Some(text) = text {
            let text = pyjson::str_of(text);
            hive = if kind != Some("status") {
                text
            } else {
                format!("[{text}]")
            };
        } else {
            continue;
        }
        let shown = |k: &str| {
            mac.get(k)
                .filter(|v| pyjson::truthy(Some(v)))
                .map(pyjson::str_of)
        };
        let place: Vec<String> = [shown("front_app"), shown("window")]
            .into_iter()
            .flatten()
            .collect();
        let place = place.join(" — ");
        let hands = match mac.get("control").and_then(Value::as_str) {
            Some("agent") => "agent has mouse & keyboard",
            Some("you") => "you have control",
            _ => "",
        };
        let bottom: Vec<&str> = [place.as_str(), hands]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect();
        let bottom = bottom.join(" · ");
        let mut cue = format!("{}  Hive: {}", clock(line.at), pyjson::head(&hive, 160));
        if !bottom.is_empty() {
            cue.push_str(&format!("\nMac: {bottom}"));
        }
        cues.push((line.video().max(0.0), cue));
    }
    let mut out = Vec::new();
    for (i, (at, text)) in cues.iter().enumerate() {
        let end = match cues.get(i + 1) {
            Some((next, _)) => *next,
            None => length.filter(|l| *l != 0.0).unwrap_or(at + 5.0),
        };
        let end = end.max(at + 0.5);
        out.push(format!(
            "{}\n{} --> {}\n{text}\n",
            i + 1,
            srt_time(*at),
            srt_time(end)
        ));
    }
    out.join("\n")
}

/// `HH:MM:SS,mmm`.
pub fn srt_time(seconds: f64) -> String {
    let ms = (seconds * 1000.0).round_ties_even() as i64;
    let (h, ms) = (ms / 3_600_000, ms % 3_600_000);
    let (m, ms) = (ms / 60_000, ms % 60_000);
    let (s, ms) = (ms / 1000, ms % 1000);
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_words() {
        assert_eq!(slug("Fill the form!"), "Fill the form");
        assert_eq!(slug("a/b: c"), "a b c");
    }

    #[test]
    fn reads_the_mac_without_failing() {
        let (_app, _window) = front_window();
        let idle = idle_seconds();
        assert!(idle >= 0.0 || idle == -1.0);
    }
}
