//! A fake agent-vhid-helper and a fake Mac for the tests. Nothing here talks to the real helper
//! (which moves the real mouse and keyboard), reads the real screen or warps the real cursor.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hive_mac::desktop::{Tabs, Window};
use hive_mac::screen::Format;
use hive_mac::{AgentVHID, Bounds, System};

/// How long the human's hands must be off before control passes (the helper's --quiet-ms 100).
pub const QUIET: Duration = Duration::from_millis(100);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Gate {
    state: &'static str,
    reason: String,
    arming_since: Option<Instant>,
    watchers: Vec<UnixStream>,
}

impl Gate {
    fn describe(&self) -> String {
        format!("state={} reason={}", self.state, self.reason)
    }

    fn notify(&mut self, line: &str) {
        self.watchers
            .retain_mut(|w| w.write_all(format!("{line}\n").as_bytes()).is_ok());
    }

    fn transition(&mut self, next: &'static str, reason: &str, released: &AtomicUsize) {
        if self.state == "engaged" && next == "disengaged" {
            released.fetch_add(1, Ordering::SeqCst); // the helper lets go of everything
        }
        self.state = next;
        self.reason = reason.to_string();
        let line = format!("event {}", self.describe());
        self.notify(&line);
    }
}

/// What the fake helper saw: the input requests it carried out, in order.
pub struct Shared {
    gate: Mutex<Gate>,
    lines: Mutex<Vec<String>>,
    /// Times everything was let go: `release`, a takeover, or a client with input going away.
    pub released: AtomicUsize,
    /// Caps Lock, toggled by `keys M 57` like a real keyboard.
    pub caps: AtomicBool,
    stop: AtomicBool,
}

impl Shared {
    pub fn watcher_unavailable(&self) {
        lock(&self.gate).transition("disengaged", "watcher_unavailable", &self.released);
    }

    pub fn lines(&self) -> Vec<String> {
        lock(&self.lines).clone()
    }

    pub fn pressed(&self, line: &str) -> bool {
        lock(&self.lines).iter().any(|l| l == line)
    }

    fn execute(&self, line: &str, sent_input: &mut bool) -> String {
        let mut words = line.split_whitespace();
        let Some(command) = words.next() else {
            return "err bad_request empty".into();
        };
        let args: Vec<&str> = words.collect();
        let mut gate = lock(&self.gate);
        match command {
            "ping" => return "ok pong".into(),
            "status" => {
                return format!(
                    "ok {} vhid=dry_run watch=ok dry_run=1 fn=1",
                    gate.describe()
                )
            }
            "release" => {
                self.released.fetch_add(1, Ordering::SeqCst);
                return "ok".into();
            }
            "disengage" => {
                if gate.state != "disengaged" {
                    gate.transition("disengaged", "released_by_agent", &self.released);
                }
                return "ok".into();
            }
            "engage" => {
                if gate.state == "disengaged" {
                    gate.arming_since = Some(Instant::now());
                    gate.transition("arming", "engage_requested", &self.released);
                }
                return "ok".into();
            }
            "human" => {
                let source = args.first().copied().unwrap_or("simulated");
                match gate.state {
                    "engaged" => gate.transition("disengaged", source, &self.released),
                    "arming" => gate.transition(
                        "disengaged",
                        &format!("engage_cancelled_by_{source}"),
                        &self.released,
                    ),
                    _ => {}
                }
                return "ok".into();
            }
            "fn" => {
                let what = args.first().copied().unwrap_or("tap");
                if !["down", "tap", "up", "other"].contains(&what) {
                    return format!("err bad fn {what}");
                }
                gate.notify(&format!("event fn={what}"));
                return "ok".into();
            }
            "move" | "scroll" => {
                if args.len() < 2 || args[..2].iter().any(|a| a.parse::<i32>().is_err()) {
                    return format!("err bad_request usage: {command} A B");
                }
            }
            "buttons" => {
                if args.first().and_then(|a| a.parse::<u32>().ok()).is_none() {
                    return "err bad_request usage: buttons MASK".into();
                }
            }
            "keys" => {
                match args.first().and_then(|a| a.parse::<i32>().ok()) {
                    Some(m) if (0..=255).contains(&m) => {}
                    _ => return "err bad_request usage: keys MODS [USAGE ...]".into(),
                }
                for usage in &args[1..] {
                    match usage.parse::<i32>() {
                        Ok(u) if u > 0 && u <= 0xffff => {}
                        _ => return "err bad_request bad usage".into(),
                    }
                }
                if args.len() - 1 > 32 {
                    return "err bad_request at most 32 keys".into();
                }
            }
            _ => return format!("err bad_request unknown command: {command}"),
        }
        if gate.state != "engaged" {
            return format!("err disengaged {}", gate.describe());
        }
        if command == "keys" && args[1..].contains(&"57") {
            self.caps.fetch_xor(true, Ordering::SeqCst);
        }
        lock(&self.lines).push(line.to_string());
        *sent_input = true;
        "ok".into()
    }

    fn serve(self: &Arc<Self>, stream: UnixStream) {
        let Ok(reader) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(reader);
        let mut writer = stream;
        let mut sent_input = false;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = line.trim_end_matches(['\n', '\r']);
            if line == "watch" {
                let mut gate = lock(&self.gate);
                let hello = format!("ok watching\nevent {}\n", gate.describe());
                if writer.write_all(hello.as_bytes()).is_ok() {
                    if let Ok(w) = writer.try_clone() {
                        gate.watchers.push(w);
                    }
                }
                drop(gate);
                let mut sink = String::new();
                while matches!(reader.read_line(&mut sink), Ok(n) if n > 0) {
                    sink.clear();
                }
                return;
            }
            let reply = self.execute(line, &mut sent_input);
            if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
                break;
            }
        }
        if sent_input {
            self.released.fetch_add(1, Ordering::SeqCst); // never leave a key held by a client that went away
        }
    }
}

/// A fake agent-vhid-helper on a temporary socket, with the real one's protocol and hand-over gate
/// (src/server.hpp, src/gate.hpp) in dry-run mode.
pub struct FakeHelper {
    _dir: tempfile::TempDir,
    pub socket: PathBuf,
    pub shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl FakeHelper {
    /// `engaged`: like `--start-engaged`.
    pub fn start(engaged: bool) -> FakeHelper {
        let dir = tempfile::Builder::new()
            .prefix("avh-")
            .tempdir()
            .expect("temp dir");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind fake helper");
        let shared = Arc::new(Shared {
            gate: Mutex::new(Gate {
                state: if engaged { "engaged" } else { "disengaged" },
                reason: if engaged { "start_engaged" } else { "startup" }.into(),
                arming_since: None,
                watchers: Vec::new(),
            }),
            lines: Mutex::new(Vec::new()),
            released: AtomicUsize::new(0),
            caps: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        let accepting = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if shared.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(stream) = stream {
                        let shared = shared.clone();
                        std::thread::spawn(move || shared.serve(stream));
                    }
                }
            })
        };
        let ticking = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                while !shared.stop.load(Ordering::SeqCst) {
                    {
                        let mut gate = lock(&shared.gate);
                        if gate.state == "arming"
                            && gate.arming_since.is_some_and(|t| t.elapsed() >= QUIET)
                        {
                            gate.transition("engaged", "engaged", &shared.released);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            })
        };
        FakeHelper {
            _dir: dir,
            socket,
            shared,
            threads: vec![accepting, ticking],
        }
    }

    /// One request on its own connection, closed right after (like test_dry_run.py's `raw`).
    pub fn raw(&self, line: &str) -> String {
        let mut s = UnixStream::connect(&self.socket).expect("connect fake helper");
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(s).read_line(&mut reply).unwrap();
        reply.trim().to_string()
    }

    pub fn lines(&self) -> Vec<String> {
        self.shared.lines()
    }

    /// The input requests since the first `since`.
    pub fn since(&self, since: usize) -> Vec<String> {
        self.lines()[since..].to_vec()
    }

    pub fn count(&self) -> usize {
        self.lines().len()
    }

    /// A client of this helper that moves and types fast and straight (human=false), on a fake Mac.
    pub fn client(&self, system: Arc<FakeSystem>) -> AgentVHID {
        AgentVHID::new(&self.socket, 1.0, false).with_system(system)
    }
}

impl Drop for FakeHelper {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&self.socket); // wakes the accept loop
        for w in lock(&self.shared.gate).watchers.drain(..) {
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// `keys MODS USAGE...` as the client sends it.
pub fn keys(mods: u8, usages: &[u8]) -> String {
    let mut line = format!("keys {mods}");
    for u in usages {
        line.push_str(&format!(" {u}"));
    }
    line
}

type WindowList = Box<dyn Fn() -> Vec<Window> + Send + Sync>;

/// A Mac that is only pretend: a fixed main display, a cursor that never moves (as in a dry run),
/// and whatever windows the test gives it.
pub struct FakeSystem {
    pub cursor: Mutex<(f64, f64)>,
    pub main: Bounds,
    pub virtual_monitor: Option<Bounds>,
    pub windows: Mutex<WindowList>,
    pub front_app: Mutex<String>,
    pub clipboard: Mutex<Vec<u8>>,
    pub clipboard_writes: Mutex<Vec<Vec<u8>>>,
    pub notifications: Mutex<Vec<String>>,
    pub captures: AtomicUsize,
    pub natural: bool,
    /// Where Hive's own floating window is, if it's up.
    pub own_window: Mutex<Option<Bounds>>,
    /// How many apps' windows are on the virtual monitor (while it's on).
    pub monitor_windows: Mutex<Option<usize>>,
    /// The pids whose front window was moved onto the virtual monitor.
    pub placed: Mutex<Vec<i32>>,
    /// Seconds since the user last touched the mouse or keyboard.
    pub idle: Mutex<f64>,
    /// The app in front's pid.
    pub front_pid: Mutex<Option<i32>>,
    /// The pids brought to the front, in order.
    pub activated: Mutex<Vec<i32>>,
}

impl Default for FakeSystem {
    fn default() -> Self {
        FakeSystem {
            cursor: Mutex::new((500.0, 400.0)),
            main: (0.0, 0.0, 1440.0, 900.0),
            virtual_monitor: None,
            windows: Mutex::new(Box::new(Vec::new)),
            front_app: Mutex::new("Finder".into()),
            clipboard: Mutex::new(b"what was there".to_vec()),
            clipboard_writes: Mutex::new(Vec::new()),
            notifications: Mutex::new(Vec::new()),
            captures: AtomicUsize::new(0),
            natural: true,
            own_window: Mutex::new(None),
            monitor_windows: Mutex::new(None),
            placed: Mutex::new(Vec::new()),
            idle: Mutex::new(f64::INFINITY),
            front_pid: Mutex::new(Some(1)),
            activated: Mutex::new(Vec::new()),
        }
    }
}

impl FakeSystem {
    pub fn new() -> Arc<FakeSystem> {
        Arc::new(FakeSystem::default())
    }

    pub fn set_windows(&self, list: impl Fn() -> Vec<Window> + Send + Sync + 'static) {
        *lock(&self.windows) = Box::new(list);
    }
}

pub const FAKE_JPEG: &[u8] = b"\xff\xd8fake jpeg\xff\xd9";

impl System for FakeSystem {
    fn own_window_at(&self, x: f64, y: f64) -> bool {
        lock(&self.own_window).is_some_and(|f| hive_mac::desktop::inside(f, x, y))
    }
    fn cursor(&self) -> (f64, f64) {
        *lock(&self.cursor)
    }
    fn displays(&self) -> Vec<Bounds> {
        vec![self.main]
    }
    fn main_display(&self) -> Bounds {
        self.main
    }
    fn virtual_monitor(&self) -> Option<Bounds> {
        self.virtual_monitor
    }
    fn warp(&self, x: f64, y: f64) {
        *lock(&self.cursor) = (x, y);
    }
    fn place_on_virtual_monitor(&self, pid: i32) -> String {
        lock(&self.placed).push(pid);
        String::new()
    }
    fn windows_on_virtual_monitor(&self) -> Option<usize> {
        self.virtual_monitor.and(*lock(&self.monitor_windows))
    }
    fn work_display_pixels(&self) -> (usize, usize) {
        (2880, 1800)
    }
    fn capture(
        &self,
        _width: usize,
        _height: usize,
        _cursor: bool,
        _format: Format,
    ) -> Result<Vec<u8>, String> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        Ok(FAKE_JPEG.to_vec())
    }
    fn windows(&self) -> Vec<Window> {
        (lock(&self.windows))()
    }
    fn browser_tabs(&self, _shown: &[Window]) -> Tabs {
        Vec::new()
    }
    fn frontmost_app(&self) -> String {
        lock(&self.front_app).clone()
    }
    fn frontmost_pid(&self) -> Option<i32> {
        *lock(&self.front_pid)
    }
    fn seconds_since_input(&self) -> f64 {
        *lock(&self.idle)
    }
    fn activate(&self, pid: i32) {
        lock(&self.activated).push(pid);
        *lock(&self.front_pid) = Some(pid);
    }
    fn notify(&self, message: &str) {
        lock(&self.notifications).push(message.to_string());
    }
    fn clipboard(&self) -> Vec<u8> {
        lock(&self.clipboard).clone()
    }
    fn set_clipboard(&self, data: &[u8]) -> Result<(), String> {
        lock(&self.clipboard_writes).push(data.to_vec());
        *lock(&self.clipboard) = data.to_vec();
        Ok(())
    }
    fn natural_scrolling(&self) -> bool {
        self.natural
    }
}
