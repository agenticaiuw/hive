//! Control this Mac the way a person does, through agent-vhid-helper (python/agent_vhid.py).
//!
//! The helper drives Karabiner's virtual HID keyboard and mouse, so macOS sees real hardware
//! input. The moment you touch a real key, the trackpad or a mouse, the helper takes the agent's
//! hands off: every call here fails with [`VhidError::Disengaged`] until it asks again
//! ([`AgentVHID::engage`], for something you told it to do) and your hands are off.
//!
//! The helper speaks one line per request on a Unix socket (`src/server.hpp`): `status`,
//! `engage`, `disengage`, `release`, `move DX DY`, `buttons MASK`, `scroll V H`,
//! `keys MODS [USAGE...]`, and `watch`, which streams `event state=.. reason=..` and
//! `event fn=down|tap|up|other` lines.

use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::system::{RealMac, System};

/// The helper's socket: `AGENT_VHID_SOCKET`, else /tmp/agent-vhid.sock.
pub fn default_socket() -> PathBuf {
    std::env::var_os("AGENT_VHID_SOCKET")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/agent-vhid.sock"))
}

/// `<repo>/build/agent-vhid-ocr`, Apple's on-device text recognition.
pub fn ocr_tool() -> PathBuf {
    hive_common::build_dir().join("agent-vhid-ocr")
}

/// What a reason for losing control means: the human touched these.
pub const HUMAN_SOURCES: [&str; 4] = ["keyboard", "trackpad", "mouse", "mouse_button"];

/// You took the mouse and keyboard: by touching them while the agent had control, or just as it
/// was taking control ("engage_cancelled_by_trackpad"). Either way fn hands control back.
pub fn took_over(reason: Option<&str>) -> bool {
    let reason = reason.unwrap_or("");
    HUMAN_SOURCES.contains(&reason) || reason.starts_with("engage_cancelled")
}

/// Why a call to the helper failed. `Display` is the message alone, as Python's `str(e)`.
#[derive(Clone, Debug, PartialEq)]
pub enum VhidError {
    /// agent-vhid-helper isn't running (or closed the connection).
    HelperUnavailable(String),
    /// The human has control. Wait for [`AgentVHID::wait_engaged`], then look at the screen again.
    Disengaged(String),
    /// Karabiner's virtual devices aren't up yet (is the daemon running?).
    NotReady(String),
    /// The cursor didn't reach the target.
    MoveFailed(String),
    /// The helper refused, e.g. engage() while its safety watcher isn't working.
    NotAllowed(String),
    /// Any other refusal from the helper (Python's plain AgentVHIDError), e.g. `err bad_request ...`.
    Helper(String),
    /// A bad argument: an unknown key, a point that's on no display (Python's ValueError).
    Invalid(String),
    /// The connection timed out or a tool couldn't run (Python's OSError and friends).
    Io(String),
}

impl fmt::Display for VhidError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use VhidError::*;
        match self {
            HelperUnavailable(m) | Disengaged(m) | NotReady(m) | MoveFailed(m) | NotAllowed(m)
            | Helper(m) | Invalid(m) | Io(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for VhidError {}

impl VhidError {
    /// Python's `except AgentVHIDError`: everything but bad arguments and I/O trouble.
    pub fn is_helper_error(&self) -> bool {
        !matches!(self, VhidError::Invalid(_) | VhidError::Io(_))
    }
}

pub type Result<T> = std::result::Result<T, VhidError>;

// --- Keyboard map (US / ABC layout) ---

/// Modifier bits: ctrl/control, shift, alt/opt/option, cmd/command/super/meta/win, and the right
/// hand's rctrl, rshift, ropt/ralt, rcmd.
pub fn modifier(name: &str) -> Option<u8> {
    Some(match name {
        "ctrl" | "control" => 0x01,
        "shift" => 0x02,
        "alt" | "opt" | "option" => 0x04,
        "cmd" | "command" | "super" | "meta" | "win" => 0x08,
        "rctrl" => 0x10,
        "rshift" => 0x20,
        "ropt" | "ralt" => 0x40,
        "rcmd" => 0x80,
        _ => return None,
    })
}

pub const SHIFT: u8 = 0x02;

/// HID usages of named keys: return, escape, the arrows, f1..f24, ...
pub fn named_key(name: &str) -> Option<u8> {
    Some(match name {
        "return" | "enter" => 0x28,
        "esc" | "escape" => 0x29,
        "backspace" | "delete" => 0x2A,
        "tab" => 0x2B,
        "space" => 0x2C,
        "forwarddelete" => 0x4C,
        "capslock" => 0x39,
        "home" => 0x4A,
        "pageup" => 0x4B,
        "end" => 0x4D,
        "pagedown" => 0x4E,
        "right" => 0x4F,
        "left" => 0x50,
        "down" => 0x51,
        "up" => 0x52,
        "minus" => 0x2D,
        "equal" => 0x2E,
        "comma" => 0x36,
        "period" => 0x37,
        "slash" => 0x38,
        _ => {
            let n: u8 = name.strip_prefix('f')?.parse().ok()?;
            if name.len() > 1 && name.as_bytes()[1] == b'0' {
                return None; // "f05" isn't a key
            }
            match n {
                1..=12 => 0x3A + n - 1,
                13..=24 => 0x68 + n - 13,
                _ => return None,
            }
        }
    })
}

fn plain(c: char) -> Option<u8> {
    Some(match c {
        ' ' => 0x2C,
        '\n' => 0x28,
        '\t' => 0x2B,
        '-' => 0x2D,
        '=' => 0x2E,
        '[' => 0x2F,
        ']' => 0x30,
        '\\' => 0x31,
        ';' => 0x33,
        '\'' => 0x34,
        '`' => 0x35,
        ',' => 0x36,
        '.' => 0x37,
        '/' => 0x38,
        _ => return None,
    })
}

/// The key that types `c` on a US keyboard and whether it needs shift (Python's CHARS).
pub fn char_key(c: char) -> Option<(u8, bool)> {
    const SHIFTED: [(char, char); 11] = [
        ('_', '-'),
        ('+', '='),
        ('{', '['),
        ('}', ']'),
        ('|', '\\'),
        (':', ';'),
        ('"', '\''),
        ('~', '`'),
        ('<', ','),
        ('>', '.'),
        ('?', '/'),
    ];
    if c.is_ascii_lowercase() {
        return Some((0x04 + (c as u8 - b'a'), false));
    }
    if c.is_ascii_uppercase() {
        return Some((0x04 + (c as u8 - b'A'), true));
    }
    if let Some(i) = "1234567890".find(c) {
        return Some((0x1E + i as u8, false));
    }
    if let Some(i) = "!@#$%^&*()".find(c) {
        return Some((0x1E + i as u8, true));
    }
    if let Some(u) = plain(c) {
        return Some((u, false));
    }
    SHIFTED
        .iter()
        .find(|(s, _)| *s == c)
        .and_then(|(_, base)| plain(*base))
        .map(|u| (u, true))
}

/// 'cmd+shift+t' -> (modifier bits, usage). Accepts xdotool-style names like 'ctrl+Return'.
pub fn parse_combo(combo: &str) -> Result<(u8, Option<u8>)> {
    let squeezed = combo.replace(' ', "");
    let parts: Vec<&str> = squeezed.split('+').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(VhidError::Invalid("empty key combo".into()));
    }
    let shown = hive_common::mcp::py_repr;
    let mut mods = 0u8;
    let mut key = None;
    for (i, part) in parts.iter().enumerate() {
        let name = part.to_lowercase().replace('_', "");
        if let Some(bit) = modifier(&name) {
            mods |= bit;
            continue;
        }
        if i != parts.len() - 1 {
            return Err(VhidError::Invalid(format!(
                "unknown modifier {} in {}",
                shown(part),
                shown(combo)
            )));
        }
        let mut chars = part.chars();
        let single = match (chars.next(), chars.next()) {
            (Some(c), None) => char_key(c),
            _ => None,
        };
        if let Some(usage) = named_key(&name) {
            key = Some(usage);
        } else if let Some((usage, shifted)) = single {
            key = Some(usage);
            if shifted {
                mods |= SHIFT;
            }
        } else {
            return Err(VhidError::Invalid(format!(
                "unknown key {} in {}",
                shown(part),
                shown(combo)
            )));
        }
    }
    Ok((mods, key))
}

// --- Screenshots ---

/// A screenshot and how its pixels map to screen points.
#[derive(Clone, Debug, PartialEq)]
pub struct Screenshot {
    pub path: PathBuf,
    /// image pixels
    pub width: usize,
    pub height: usize,
    /// screen points per image pixel
    pub scale: f64,
    pub origin: (f64, f64),
}

impl Screenshot {
    /// Image pixel coordinates (what a model sees) -> screen points (what click() takes).
    pub fn to_screen(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.origin.0 + x * self.scale,
            self.origin.1 + y * self.scale,
        )
    }
    pub fn from_screen(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.origin.0) / self.scale,
            (y - self.origin.1) / self.scale,
        )
    }
}

/// A word read off the screen. Coordinates are screen points, like click() takes.
#[derive(Clone, Debug, PartialEq)]
pub struct TextBox {
    pub text: String,
    /// the whole line of text the word sits in
    pub line: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl TextBox {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// Python's round(): halves go to the even neighbour.
pub fn py_round(x: f64) -> f64 {
    x.round_ties_even()
}

// --- Talking to the helper ---

const TIMEOUT: Duration = Duration::from_secs(5);

/// The `key=value` words of a helper line, in order (Python's dict of them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fields(pub Vec<(String, String)>);

impl Fields {
    pub fn parse(text: &str) -> Fields {
        let mut fields: Vec<(String, String)> = Vec::new();
        for item in text.split_whitespace() {
            if let Some((k, v)) = item.split_once('=') {
                match fields.iter_mut().find(|(key, _)| key == k) {
                    Some(slot) => slot.1 = v.to_string(),
                    None => fields.push((k.to_string(), v.to_string())),
                }
            }
        }
        Fields(fields)
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    pub fn to_json(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    }
}

/// A failure on the connection, and whether a new connection may fix it.
struct Broken(VhidError, bool);

impl From<Broken> for VhidError {
    fn from(b: Broken) -> VhidError {
        b.0
    }
}

struct Connection {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

fn io_broken(e: std::io::Error) -> Broken {
    use std::io::ErrorKind::*;
    match e.kind() {
        WouldBlock | TimedOut => Broken(VhidError::Io("timed out".into()), true),
        BrokenPipe | ConnectionReset | ConnectionAborted | NotConnected => {
            Broken(VhidError::Io(crate::process::strerror(&e)), true)
        }
        _ => Broken(VhidError::Io(crate::process::strerror(&e)), false),
    }
}

impl Connection {
    fn open(path: &Path, timeout: Option<Duration>) -> std::result::Result<Connection, Broken> {
        let stream = UnixStream::connect(path).map_err(|e| {
            use std::io::ErrorKind::*;
            let shown = path.display();
            match e.kind() {
                NotFound | ConnectionRefused => Broken(
                    VhidError::HelperUnavailable(format!(
                        "agent-vhid-helper isn't running on {shown} (./install.sh has the Mac start it; or start it \
                         with ./voice.sh)"
                    )),
                    true,
                ),
                PermissionDenied => Broken(
                    VhidError::HelperUnavailable(format!(
                        "no permission to use {shown}; start the helper with sudo as this user"
                    )),
                    true,
                ),
                _ => io_broken(e),
            }
        })?;
        no_sigpipe(&stream);
        let timeout = timeout
            .filter(|t| !t.is_zero())
            .or(timeout.map(|_| Duration::from_nanos(1)));
        stream.set_read_timeout(timeout).map_err(io_broken)?;
        stream.set_write_timeout(timeout).map_err(io_broken)?;
        let reader = BufReader::new(stream.try_clone().map_err(io_broken)?);
        Ok(Connection { stream, reader })
    }

    fn request(&mut self, line: &str) -> std::result::Result<String, Broken> {
        let mut data = line.as_bytes().to_vec();
        data.push(b'\n');
        self.stream.write_all(&data).map_err(io_broken)?;
        self.readline()
    }

    fn readline(&mut self) -> std::result::Result<String, Broken> {
        let mut raw = Vec::new();
        let n = self.reader.read_until(b'\n', &mut raw).map_err(io_broken)?;
        if n == 0 {
            return Err(Broken(
                VhidError::HelperUnavailable("agent-vhid-helper closed the connection".into()),
                true,
            ));
        }
        let mut line = String::from_utf8_lossy(&raw).into_owned();
        while line.ends_with('\n') {
            line.pop();
        }
        Ok(line)
    }

    fn set_timeout(&self, timeout: Duration) {
        let timeout = if timeout.is_zero() {
            Duration::from_nanos(1)
        } else {
            timeout
        };
        let _ = self.stream.set_read_timeout(Some(timeout));
    }

    fn close(&self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

fn no_sigpipe(stream: &UnixStream) {
    use std::os::fd::AsRawFd;
    let on: libc::c_int = 1;
    unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            &on as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

/// The helper's answer to a request: what follows "ok ", or the error it stands for.
pub fn parse_reply(reply: &str) -> Result<String> {
    if reply.starts_with("ok") {
        return Ok(reply.chars().skip(3).collect());
    }
    let rest = reply.split_once(' ').map(|(_, r)| r).unwrap_or("");
    let (code, detail) = rest.split_once(' ').unwrap_or((rest, ""));
    Err(match code {
        "disengaged" => VhidError::Disengaged(format!("the human has control ({detail})")),
        "forbidden" => VhidError::NotAllowed(detail.to_string()),
        "not_ready" => VhidError::NotReady(format!(
            "virtual devices not ready ({detail}); is Karabiner-VirtualHIDDevice-Daemon running?"
        )),
        _ => VhidError::Helper(reply.to_string()),
    })
}

/// A small xorshift generator for the human-looking jitter (no dependency for it).
struct Rng(u64);

impl Rng {
    fn new() -> Rng {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15);
        Rng(nanos ^ ((std::process::id() as u64) << 32) | 1)
    }
    fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
    fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next_f64()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Human-like mouse, keyboard and screen control. All coordinates are screen points.
pub struct AgentVHID {
    pub socket_path: PathBuf,
    /// >1 moves and types faster.
    pub speed: f64,
    /// false: straight, fast moves and no typing jitter.
    pub human: bool,
    system: Arc<dyn System>,
    ocr_tool: PathBuf,
    conn: Mutex<Option<Connection>>,
    points_per_count: Mutex<f64>,
    natural: Mutex<Option<bool>>,
    rng: Mutex<Rng>,
}

impl Default for AgentVHID {
    fn default() -> Self {
        AgentVHID::new(default_socket(), 1.0, true)
    }
}

impl AgentVHID {
    /// seconds between mouse reports (~125 Hz, like a USB mouse)
    pub const STEP: f64 = 0.008;

    pub fn new(socket_path: impl Into<PathBuf>, speed: f64, human: bool) -> AgentVHID {
        AgentVHID {
            socket_path: socket_path.into(),
            speed,
            human,
            system: Arc::new(RealMac),
            ocr_tool: ocr_tool(),
            conn: Mutex::new(None),
            points_per_count: Mutex::new(1.0),
            natural: Mutex::new(None),
            rng: Mutex::new(Rng::new()),
        }
    }

    /// Reads the cursor, displays, screen and clipboard through `system` instead of this Mac.
    pub fn with_system(mut self, system: Arc<dyn System>) -> AgentVHID {
        self.system = system;
        self
    }

    /// Uses this text-recognition tool instead of build/agent-vhid-ocr.
    pub fn with_ocr_tool(mut self, tool: impl Into<PathBuf>) -> AgentVHID {
        self.ocr_tool = tool.into();
        self
    }

    pub fn system(&self) -> &Arc<dyn System> {
        &self.system
    }

    /// Fixes the scroll direction instead of reading the natural-scrolling setting.
    pub fn set_natural_scrolling(&self, natural: Option<bool>) {
        *lock(&self.natural) = natural;
    }

    // -- plumbing --

    /// Sends one request line and returns what follows "ok ". Reconnects once if the
    /// connection broke or timed out.
    pub fn send(&self, line: &str) -> Result<String> {
        let reply = {
            let mut conn = lock(&self.conn);
            let mut attempt = 1;
            loop {
                let answer = match conn.as_mut() {
                    Some(c) => c.request(line),
                    None => Connection::open(&self.socket_path, Some(TIMEOUT)).and_then(|mut c| {
                        let answer = c.request(line);
                        *conn = Some(c);
                        answer
                    }),
                };
                match answer {
                    Ok(reply) => break reply,
                    Err(Broken(e, retry)) => {
                        if let Some(c) = conn.take() {
                            c.close();
                        }
                        if !retry || attempt == 2 {
                            return Err(e);
                        }
                        attempt += 1;
                    }
                }
            }
        };
        parse_reply(&reply)
    }

    /// Closes the connection to the helper (which lets go of any key or button still held).
    pub fn close(&self) {
        if let Some(c) = lock(&self.conn).take() {
            c.close();
        }
    }

    fn pause(&self, seconds: f64) {
        let s = (seconds / self.speed).max(0.0);
        if s > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(s));
        }
    }

    fn jitter(&self, base: f64, spread: f64) -> f64 {
        if !self.human {
            return base;
        }
        base * lock(&self.rng).uniform(1.0 - spread, 1.0 + spread)
    }

    // -- state --

    pub fn status(&self) -> Result<Fields> {
        Ok(Fields::parse(&self.send("status")?))
    }

    pub fn is_engaged(&self) -> Result<bool> {
        Ok(self.status()?.get("state") == Some("engaged"))
    }

    /// Every time control changes hands: `{state, reason}`; and what the human does with fn:
    /// `{fn: down}`, then `tap` (the voice agent's listening switch) or `up` (the end of a hold,
    /// which dictates), and `other` if they press another key with it. The first event is the
    /// state at the time. Blocks on each event; [`Watch::stopper`] ends it from another thread.
    pub fn watch(&self) -> Result<Watch> {
        let mut conn = Connection::open(&self.socket_path, None)?;
        if !conn.request("watch")?.starts_with("ok") {
            return Err(VhidError::Helper("helper refused watch".into()));
        }
        Ok(Watch { conn: Some(conn) })
    }

    /// Blocks until control has passed to the agent: after engage(), once the human's hands are
    /// off. Ok(false) on timeout. `None` waits as long as it takes.
    pub fn wait_engaged(&self, timeout: Option<Duration>, announce: bool) -> Result<bool> {
        if self.is_engaged()? {
            return Ok(true);
        }
        if announce {
            eprintln!("[agent-vhid] waiting for control: keep your hands off the keyboard, trackpad and mouse");
        }
        let deadline = timeout.map(|t| Instant::now() + t);
        let timed_out = |e: &VhidError| matches!(e, VhidError::Io(m) if m == "timed out");
        let mut conn = match Connection::open(&self.socket_path, timeout) {
            Ok(c) => c,
            Err(Broken(e, _)) if timed_out(&e) => return Ok(false),
            Err(Broken(e, _)) => return Err(e),
        };
        let mut first = true;
        let result = loop {
            if let Some(deadline) = deadline {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break Ok(false);
                }
                conn.set_timeout(left);
            }
            let line = if first {
                first = false;
                conn.request("watch")
            } else {
                conn.readline()
            };
            match line {
                Ok(line) => {
                    let fields = Fields::parse(line.strip_prefix("event ").unwrap_or(&line));
                    if fields.get("state") == Some("engaged") {
                        break Ok(true);
                    }
                }
                Err(Broken(e, _)) if timed_out(&e) => break Ok(false),
                Err(Broken(e, _)) => break Err(e),
            }
        };
        conn.close();
        result
    }

    /// Lets go of every key and button.
    pub fn release_all(&self) -> Result<()> {
        self.send("release").map(drop)
    }

    /// Starts taking control, for a task the human gave (said or typed) or after they said
    /// "continue". The helper waits for their hands to be off first, and any touch takes it back.
    /// Fails with NotAllowed if its safety watcher isn't working.
    pub fn engage(&self) -> Result<()> {
        self.send("engage").map(drop)
    }

    /// Hands control back to the human, e.g. when a task is done.
    pub fn disengage(&self) -> Result<()> {
        self.send("disengage").map(drop)
    }

    // -- mouse --

    pub fn cursor(&self) -> (f64, f64) {
        self.system.cursor()
    }

    fn target_on_screen(&self, x: f64, y: f64) -> Result<(f64, f64)> {
        for (dx, dy, w, h) in self.system.displays() {
            if dx <= x && x < dx + w && dy <= y && y < dy + h {
                return Ok((x, y));
            }
        }
        Err(VhidError::Invalid(format!(
            "({}, {}) is not on any display",
            fmt0(x),
            fmt0(y)
        )))
    }

    /// Sends one report that should move the cursor by (ex, ey) points. Returns the counts sent.
    fn nudge(&self, ex: f64, ey: f64, gain: f64, at_least_one: bool) -> Result<(i64, i64)> {
        let ppc = *lock(&self.points_per_count);
        let mut cx = py_round(ex / ppc * gain) as i64;
        let mut cy = py_round(ey / ppc * gain) as i64;
        if at_least_one {
            if cx == 0 && ex.abs() > 0.5 {
                cx = if ex > 0.0 { 1 } else { -1 };
            }
            if cy == 0 && ey.abs() > 0.5 {
                cy = if ey > 0.0 { 1 } else { -1 };
            }
        }
        let cx = cx.clamp(-127, 127);
        let cy = cy.clamp(-127, 127);
        if cx != 0 || cy != 0 {
            self.send(&format!("move {cx} {cy}"))?;
        }
        Ok((cx, cy))
    }

    fn learn(&self, counts: (i64, i64), before: (f64, f64), after: (f64, f64)) {
        // macOS accelerates the pointer, so points-per-count depends on speed; track it as we go.
        let sent = (counts.0 as f64).hypot(counts.1 as f64);
        if sent < 3.0 {
            return;
        }
        let moved = (after.0 - before.0).hypot(after.1 - before.1);
        let ratio = (moved / sent).clamp(0.05, 10.0);
        let mut ppc = lock(&self.points_per_count);
        *ppc = 0.7 * *ppc + 0.3 * ratio;
    }

    /// Moves the cursor to (x, y) in screen points along a human-looking path, then settles exactly.
    pub fn move_to(&self, x: f64, y: f64) -> Result<()> {
        self.move_to_with(x, y, None, 0.75)
    }

    pub fn move_to_with(
        &self,
        x: f64,
        y: f64,
        duration: Option<f64>,
        tolerance: f64,
    ) -> Result<()> {
        let (tx, ty) = self.target_on_screen(x, y)?;
        let (sx, sy) = self.cursor();
        let distance = (tx - sx).hypot(ty - sy);
        if distance <= tolerance {
            return Ok(());
        }
        if self.human {
            // Fitts's law: longer moves take longer, but not proportionally.
            let duration = duration.unwrap_or_else(|| 0.05 + 0.09 * (1.0 + distance / 10.0).log2())
                / self.speed;
            let steps = ((duration / Self::STEP) as i64).max(2);
            // A gentle curve: one control point pushed sideways from the straight line.
            let bend = lock(&self.rng).uniform(-0.12, 0.12) * distance;
            let (nx, ny) = (-(ty - sy) / distance, (tx - sx) / distance);
            let (cx, cy) = ((sx + tx) / 2.0 + nx * bend, (sy + ty) / 2.0 + ny * bend);
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                let s = 10.0 * t.powi(3) - 15.0 * t.powi(4) + 6.0 * t.powi(5); // minimum-jerk speed profile
                let wx = (1.0 - s).powi(2) * sx + 2.0 * (1.0 - s) * s * cx + s * s * tx;
                let wy = (1.0 - s).powi(2) * sy + 2.0 * (1.0 - s) * s * cy + s * s * ty;
                let before = self.cursor();
                let counts = self.nudge(wx - before.0, wy - before.1, 1.0, false)?;
                std::thread::sleep(Duration::from_secs_f64(Self::STEP));
                self.learn(counts, before, self.cursor());
            }
        }
        self.settle(tx, ty, tolerance)
    }

    fn settle(&self, tx: f64, ty: f64, tolerance: f64) -> Result<()> {
        let mut stalled = 0;
        for _ in 0..200 {
            let before = self.cursor();
            let (ex, ey) = (tx - before.0, ty - before.1);
            if ex.abs() <= tolerance && ey.abs() <= tolerance {
                return Ok(());
            }
            let counts = self.nudge(ex, ey, 0.8, true)?;
            std::thread::sleep(Duration::from_millis(12));
            let after = self.cursor();
            self.learn(counts, before, after);
            if (after.0 - before.0).hypot(after.1 - before.1) < 0.01 {
                stalled += 1;
                if stalled >= 15 {
                    return Err(VhidError::MoveFailed(format!(
                        "cursor stopped responding at ({:.1}, {:.1}); is the virtual mouse ready?",
                        after.0, after.1
                    )));
                }
            } else {
                stalled = 0;
            }
        }
        let (x, y) = self.cursor();
        Err(VhidError::MoveFailed(format!(
            "cursor ended at ({x:.1}, {y:.1}), wanted ({tx:.1}, {ty:.1})"
        )))
    }

    pub fn move_by(&self, dx: f64, dy: f64) -> Result<()> {
        let (x, y) = self.cursor();
        self.move_to(x + dx, y + dy)
    }

    fn button_bits(button: &str) -> Result<u8> {
        match button {
            "left" => Ok(1),
            "right" => Ok(2),
            "middle" => Ok(4),
            other => Err(VhidError::Invalid(format!(
                "unknown button {}",
                hive_common::mcp::py_repr(other)
            ))),
        }
    }

    pub fn mouse_down(&self, button: &str) -> Result<()> {
        self.send(&format!("buttons {}", Self::button_bits(button)?))
            .map(drop)
    }

    pub fn mouse_up(&self) -> Result<()> {
        self.send("buttons 0").map(drop)
    }

    /// Clicks at `at`, or where the cursor is. count=2 double-clicks, 3 triple-clicks.
    /// `modifiers` like 'cmd' or 'shift+alt' are held during the click.
    pub fn click(
        &self,
        at: Option<(f64, f64)>,
        button: &str,
        count: i64,
        modifiers: Option<&str>,
    ) -> Result<()> {
        let mods = match modifiers.filter(|m| !m.is_empty()) {
            Some(m) => parse_combo(m)?.0,
            None => 0,
        };
        if let Some((x, y)) = at {
            self.move_to(x, y)?;
            self.pause(self.jitter(0.06, 0.35));
        }
        if mods != 0 {
            self.keys(mods, &[])?;
            self.pause(self.jitter(0.04, 0.35));
        }
        let clicked = (|| {
            for i in 0..count {
                self.mouse_down(button)?;
                self.pause(self.jitter(0.05, 0.35));
                self.mouse_up()?;
                if i < count - 1 {
                    self.pause(self.jitter(0.09, 0.2)); // well inside the double-click interval
                }
            }
            Ok(())
        })();
        if mods != 0 {
            match self.keys(0, &[]) {
                Ok(_) | Err(VhidError::Disengaged(_)) => {}
                Err(e) => return Err(e),
            }
        }
        clicked
    }

    pub fn double_click(&self, at: Option<(f64, f64)>) -> Result<()> {
        self.click(at, "left", 2, None)
    }

    pub fn right_click(&self, at: Option<(f64, f64)>) -> Result<()> {
        self.click(at, "right", 1, None)
    }

    pub fn drag(&self, x1: f64, y1: f64, x2: f64, y2: f64, button: &str) -> Result<()> {
        self.move_to(x1, y1)?;
        self.pause(self.jitter(0.08, 0.35));
        self.mouse_down(button)?;
        let moved = (|| {
            self.pause(self.jitter(0.1, 0.35));
            self.move_to(x2, y2)?;
            self.pause(self.jitter(0.08, 0.35));
            Ok(())
        })();
        match self.mouse_up() {
            Ok(()) | Err(VhidError::Disengaged(_)) => {} // the helper already let go of everything
            Err(e) => return Err(e),
        }
        moved
    }

    /// Scrolls by wheel notches. down > 0 shows content further down; right > 0 further right.
    pub fn scroll(&self, down: i64, right: i64, at: Option<(f64, f64)>) -> Result<()> {
        if let Some((x, y)) = at {
            self.move_to(x, y)?;
        }
        let natural = {
            let mut natural = lock(&self.natural);
            *natural.get_or_insert_with(|| self.system.natural_scrolling())
        };
        // Rolling a wheel away from you is +1 in HID; natural scrolling flips what that does.
        let sign = if natural { 1 } else { -1 };
        for _ in 0..down.abs() {
            self.send(&format!("scroll {} 0", sign * down.signum()))?;
            self.pause(self.jitter(0.03, 0.35));
        }
        for _ in 0..right.abs() {
            self.send(&format!("scroll 0 {}", sign * right.signum()))?;
            self.pause(self.jitter(0.03, 0.35));
        }
        Ok(())
    }

    // -- keyboard --

    /// Holds exactly these modifiers and keys (`keys MODS USAGE...`); `keys(0, &[])` lets go.
    pub fn keys(&self, mods: u8, usages: &[u8]) -> Result<String> {
        let mut line = format!("keys {mods}");
        for u in usages {
            line.push_str(&format!(" {u}"));
        }
        self.send(&line)
    }

    /// Presses a shortcut like 'cmd+s', 'cmd+shift+t', 'return', 'ctrl+Page_Up'.
    pub fn key(&self, combo: &str) -> Result<()> {
        self.key_hold(combo, 0.05)
    }

    pub fn key_hold(&self, combo: &str, hold: f64) -> Result<()> {
        let (mods, usage) = parse_combo(combo)?;
        // Modifiers go down one at a time, like fingers, then the key, then everything lets go.
        let mut held = 0u8;
        let pressed = (|| -> Result<()> {
            for bit in [0x08u8, 0x01, 0x04, 0x02, 0x80, 0x10, 0x40, 0x20] {
                if mods & bit != 0 {
                    held |= bit;
                    self.keys(held, &[])?;
                    self.pause(self.jitter(0.025, 0.35));
                }
            }
            Ok(())
        })();
        pressed?;
        let typed = (|| {
            if let Some(usage) = usage {
                self.keys(mods, &[usage])?;
                self.pause(self.jitter(hold, 0.35));
                self.keys(mods, &[])?;
                self.pause(self.jitter(0.02, 0.35));
            }
            Ok(())
        })();
        if mods != 0 {
            match self.keys(0, &[]) {
                Ok(_) | Err(VhidError::Disengaged(_)) => {}
                Err(e) => return Err(e),
            }
        }
        typed
    }

    /// Types text key by key. Characters a US keyboard can't type are pasted instead.
    pub fn type_text(&self, text: &str) -> Result<()> {
        self.type_text_interval(text, 0.045)
    }

    pub fn type_text_interval(&self, text: &str, interval: f64) -> Result<()> {
        let mut run = String::new();
        for ch in text.chars() {
            let Some((usage, shifted)) = char_key(ch) else {
                run.push(ch);
                continue;
            };
            if !run.is_empty() {
                self.paste_text(&run)?;
                run.clear();
            }
            let mods = if shifted { SHIFT } else { 0 };
            if shifted {
                self.keys(mods, &[])?;
                self.pause(self.jitter(0.015, 0.35));
            }
            self.keys(mods, &[usage])?;
            self.pause(self.jitter(0.03, 0.35));
            self.keys(mods, &[])?;
            if shifted {
                self.keys(0, &[])?;
            }
            self.pause(self.jitter(interval, 0.5));
        }
        if !run.is_empty() {
            self.paste_text(&run)?;
        }
        Ok(())
    }

    /// Puts text on the clipboard, presses cmd+v, then restores the previous clipboard text.
    pub fn paste_text(&self, text: &str) -> Result<()> {
        let previous = self.system.clipboard();
        self.system
            .set_clipboard(text.as_bytes())
            .map_err(VhidError::Io)?;
        let pasted = self
            .key("cmd+v")
            .map(|()| std::thread::sleep(Duration::from_millis(300))); // let the app read it
        self.system
            .set_clipboard(&previous)
            .map_err(VhidError::Io)?;
        pasted
    }

    // -- screen --

    /// Captures the display the agent works on to a PNG at `path` (else a new temporary file).
    /// With `max_width`, scales it down (models see fewer, bigger pixels). Use
    /// [`Screenshot::to_screen`] to turn a point in the image into click() coordinates.
    pub fn screenshot(&self, path: Option<&Path>, max_width: Option<usize>) -> Result<Screenshot> {
        let (ox, oy, points_wide, _) = self.system.work_display();
        let (pw, ph) = self.system.work_display_pixels();
        let (width, height) = match max_width {
            Some(mw) if mw > 0 && pw > mw => {
                (mw, py_round(ph as f64 * mw as f64 / pw as f64) as usize)
            }
            _ => (pw, ph),
        };
        let png = self
            .system
            .capture(width, height, false, crate::screen::Format::Png)
            .map_err(VhidError::Io)?;
        let path = match path {
            Some(p) => {
                std::fs::write(p, &png).map_err(|e| VhidError::Io(crate::process::strerror(&e)))?;
                p.to_path_buf()
            }
            None => temp_file("agent-vhid-", ".png", &png)
                .map_err(|e| VhidError::Io(crate::process::strerror(&e)))?,
        };
        Ok(Screenshot {
            path,
            width,
            height,
            scale: points_wide / width as f64,
            origin: (ox, oy),
        })
    }

    /// Every word on the display the agent works on, top to bottom, via Apple's on-device Vision
    /// text recognition (build/agent-vhid-ocr).
    pub fn read_screen(&self, shot: Option<&Screenshot>) -> Result<Vec<TextBox>> {
        let own = match shot {
            Some(_) => None,
            None => Some(self.screenshot(None, None)?), // full resolution reads small text best
        };
        let shot = shot.or(own.as_ref()).expect("one or the other");
        let ran = crate::process::run(&self.ocr_tool, [&shot.path], None, None);
        if let Some(own) = &own {
            let _ = std::fs::remove_file(&own.path);
        }
        let out = match ran {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(VhidError::Helper(format!(
                    "{} is missing; run make",
                    self.ocr_tool.display()
                )))
            }
            Err(e) => return Err(VhidError::Io(crate::process::strerror(&e))),
            Ok(out) if !out.success() => {
                return Err(VhidError::Io(format!(
                    "{} failed (exit status {}): {}",
                    self.ocr_tool.display(),
                    out.code.unwrap_or(-1),
                    out.stderr_text().trim()
                )))
            }
            Ok(out) => out,
        };
        let mut boxes = Vec::new();
        for line in out.stdout_text().lines() {
            let d: Value = serde_json::from_str(line).map_err(|e| VhidError::Io(e.to_string()))?;
            let num = |k: &str| d.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let (x, y) = shot.to_screen(num("x"), num("y"));
            boxes.push(TextBox {
                text: d
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                line: d
                    .get("line")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                confidence: num("confidence"),
                x,
                y,
                w: num("w") * shot.scale,
                h: num("h") * shot.scale,
            });
        }
        boxes.sort_by(|a, b| {
            py_round(a.y / 4.0)
                .total_cmp(&py_round(b.y / 4.0))
                .then(a.x.total_cmp(&b.x))
        });
        Ok(boxes)
    }

    /// The first word on screen equal to `word` (ignoring case), optionally only in lines
    /// containing `line_contains`. None when it isn't visible.
    pub fn find_text(
        &self,
        word: &str,
        boxes: Option<&[TextBox]>,
        line_contains: Option<&str>,
    ) -> Result<Option<TextBox>> {
        let read;
        let boxes = match boxes {
            Some(b) => b,
            None => {
                read = self.read_screen(None)?;
                &read
            }
        };
        let word = word.to_lowercase();
        Ok(boxes
            .iter()
            .find(|b| {
                b.text.to_lowercase() == word
                    && line_contains
                        .is_none_or(|l| b.line.to_lowercase().contains(&l.to_lowercase()))
            })
            .cloned())
    }
}

impl Drop for AgentVHID {
    fn drop(&mut self) {
        self.close();
    }
}

/// Python's `f"{x:.0f}"`.
pub fn fmt0(x: f64) -> String {
    format!("{:.0}", x)
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A new file in the temporary folder holding `data` (Python's mkstemp, then a write).
pub fn temp_file(prefix: &str, suffix: &str, data: &[u8]) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = hive_common::paths::temp_dir();
    loop {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let path = dir.join(format!(
            "{prefix}{}-{n}-{nanos:x}{suffix}",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(data)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// The stream from [`AgentVHID::watch`]. Ends (after one error) when the helper goes away.
pub struct Watch {
    conn: Option<Connection>,
}

impl Watch {
    /// Something another thread can use to end the watch.
    pub fn stopper(&self) -> Option<WatchStopper> {
        self.conn
            .as_ref()
            .and_then(|c| c.stream.try_clone().ok())
            .map(WatchStopper)
    }
}

impl Iterator for Watch {
    type Item = Result<Fields>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let conn = self.conn.as_mut()?;
            match conn.readline() {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix("event ") {
                        return Some(Ok(Fields::parse(rest)));
                    }
                }
                Err(Broken(e, _)) => {
                    self.conn = None;
                    return Some(Err(e));
                }
            }
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            c.close();
        }
    }
}

/// Ends a [`Watch`] from another thread.
pub struct WatchStopper(UnixStream);

impl WatchStopper {
    pub fn stop(&self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

/// A thread that watches the helper for as long as it runs, reconnecting every 2 s while the
/// helper is down or restarting (voice_agent.py's `watch_helper`). Each event goes to `on_event`.
pub struct HelperWatcher {
    stop: Arc<AtomicBool>,
    current: Arc<Mutex<Option<WatchStopper>>>,
    thread: Option<JoinHandle<()>>,
}

impl HelperWatcher {
    pub fn start(
        socket_path: PathBuf,
        mut on_event: impl FnMut(Fields) + Send + 'static,
    ) -> HelperWatcher {
        let stop = Arc::new(AtomicBool::new(false));
        let current: Arc<Mutex<Option<WatchStopper>>> = Arc::new(Mutex::new(None));
        let (stop2, current2) = (stop.clone(), current.clone());
        let thread = std::thread::Builder::new()
            .name("helper-watch".into())
            .spawn(move || {
                while !stop2.load(Ordering::SeqCst) {
                    if let Ok(watch) = AgentVHID::new(socket_path.clone(), 1.0, true).watch() {
                        *lock(&current2) = watch.stopper();
                        if stop2.load(Ordering::SeqCst) {
                            break;
                        }
                        for event in watch {
                            match event {
                                Ok(fields) => on_event(fields),
                                Err(_) => break,
                            }
                        }
                        *lock(&current2) = None;
                    }
                    // helper restarted or not up yet
                    let until = Instant::now() + Duration::from_secs(2);
                    while Instant::now() < until && !stop2.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            })
            .expect("couldn't start the helper-watch thread");
        HelperWatcher {
            stop,
            current,
            thread: Some(thread),
        }
    }

    /// Ends the watch and waits for the thread.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(s) = lock(&self.current).as_ref() {
            s.stop();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for HelperWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Where agent-vhid-helper writes: the Mac's log once ./install.sh installed it, else ./voice.sh's.
pub fn helper_log() -> &'static str {
    if Path::new("/Library/LaunchDaemons/local.personal-agent.helper.plist").exists() {
        "/Library/Logs/agent-vhid-helper.log"
    } else {
        "/tmp/agent-vhid-helper.log"
    }
}

/// Waits for agent-vhid-helper (the Mac starts it once ./install.sh has installed it; ./voice.sh
/// starts it otherwise) and its virtual devices. `forever` (Agent.app): keeps waiting, saying why
/// on stdout (and as an `@@ status` line for the menu bar).
pub fn wait_for_helper(mac: &AgentVHID, forever: bool) -> bool {
    let mut told = String::new();
    let mut attempt = 0;
    loop {
        let status = mac.status().unwrap_or_default();
        let known = !status.0.is_empty();
        let ready = matches!(status.get("vhid"), Some("ready" | "dry_run"));
        let problem: (String, &str);
        if known && status.get("fn") != Some("1") {
            problem = (
                "The running agent-vhid-helper is an old one, without fn. Run ./install.sh again, or stop it (Ctrl-C \
                 in its window) and start ./voice.sh."
                    .into(),
                "agent-vhid-helper is out of date",
            );
        } else if ready || (known && attempt >= 60) {
            if !ready {
                hive_common::say(format!(
                    "warning: virtual keyboard/mouse not ready ({}); see {}",
                    status.get("vhid").unwrap_or("None"),
                    helper_log()
                ));
            }
            return true;
        } else if attempt >= 60 {
            // 30 s
            problem = (
                format!(
                    "agent-vhid-helper isn't running. Run ./install.sh to have the Mac start it, or start everything \
                     with ./voice.sh (helper log: {}).",
                    helper_log()
                ),
                "Waiting for agent-vhid-helper",
            );
        } else {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        if !forever {
            hive_common::say(&problem.0);
            return false;
        }
        if told != problem.0 {
            told = problem.0.clone();
            hive_common::say(&problem.0);
            hive_common::say(format!("@@ status {}", problem.1));
        }
        attempt += 1;
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos() {
        assert_eq!(parse_combo("cmd+s").unwrap(), (0x08, Some(0x16)));
        assert_eq!(parse_combo("cmd+shift+t").unwrap(), (0x0A, Some(0x17)));
        assert_eq!(parse_combo("ctrl+Page_Up").unwrap(), (0x01, Some(0x4B)));
        assert_eq!(parse_combo("cmd + `").unwrap(), (0x08, Some(0x35)));
        assert_eq!(parse_combo("cmd+?").unwrap(), (0x0A, Some(0x38)));
        assert_eq!(parse_combo("shift").unwrap(), (0x02, None));
        assert_eq!(parse_combo("F5").unwrap(), (0, Some(0x3E)));
        assert_eq!(parse_combo("f13").unwrap(), (0, Some(0x68)));
        assert_eq!(parse_combo("f24").unwrap(), (0, Some(0x73)));
        assert_eq!(parse_combo("A").unwrap(), (0x02, Some(0x04)));
        assert_eq!(
            parse_combo(" + ").unwrap_err().to_string(),
            "empty key combo"
        );
        assert_eq!(
            parse_combo("cmd+nosuchkey").unwrap_err().to_string(),
            "unknown key 'nosuchkey' in 'cmd+nosuchkey'"
        );
        assert_eq!(
            parse_combo("hyper+a").unwrap_err().to_string(),
            "unknown modifier 'hyper' in 'hyper+a'"
        );
        assert!(parse_combo("f25").is_err());
        assert!(parse_combo("f0").is_err());
    }

    #[test]
    fn chars() {
        assert_eq!(char_key('a'), Some((0x04, false)));
        assert_eq!(char_key('Z'), Some((0x1D, true)));
        assert_eq!(char_key('1'), Some((0x1E, false)));
        assert_eq!(char_key('0'), Some((0x27, false)));
        assert_eq!(char_key('!'), Some((0x1E, true)));
        assert_eq!(char_key(')'), Some((0x27, true)));
        assert_eq!(char_key('\n'), Some((0x28, false)));
        assert_eq!(char_key('"'), Some((0x34, true)));
        assert_eq!(char_key('~'), Some((0x35, true)));
        assert_eq!(char_key('中'), None);
        assert_eq!(char_key('é'), None);
    }

    #[test]
    fn replies() {
        assert_eq!(
            parse_reply("ok state=engaged reason=x").unwrap(),
            "state=engaged reason=x"
        );
        assert_eq!(parse_reply("ok").unwrap(), "");
        assert_eq!(
            parse_reply("err disengaged state=disengaged reason=trackpad").unwrap_err(),
            VhidError::Disengaged(
                "the human has control (state=disengaged reason=trackpad)".into()
            )
        );
        assert_eq!(
            parse_reply("err forbidden the safety watcher isn't working").unwrap_err(),
            VhidError::NotAllowed("the safety watcher isn't working".into())
        );
        assert!(
            matches!(parse_reply("err not_ready vhid=waiting"), Err(VhidError::NotReady(m))
            if m == "virtual devices not ready (vhid=waiting); is Karabiner-VirtualHIDDevice-Daemon running?")
        );
        assert_eq!(
            parse_reply("err bad_request x").unwrap_err(),
            VhidError::Helper("err bad_request x".into())
        );
        let f = Fields::parse("state=engaged reason=engaged vhid=dry_run junk x=1=2");
        assert_eq!(f.get("state"), Some("engaged"));
        assert_eq!(f.get("x"), Some("1=2"));
        assert_eq!(f.0.len(), 4);
    }

    #[test]
    fn screenshot_coordinates() {
        let shot = Screenshot {
            path: "x.png".into(),
            width: 1280,
            height: 800,
            scale: 1440.0 / 1280.0,
            origin: (0.0, 0.0),
        };
        assert_eq!(shot.to_screen(640.0, 400.0), (720.0, 450.0));
        assert_eq!(shot.from_screen(720.0, 450.0), (640.0, 400.0));
    }

    #[test]
    fn took_over_means_a_human_touched_something() {
        assert!(took_over(Some("trackpad")));
        assert!(took_over(Some("engage_cancelled_by_keyboard")));
        assert!(!took_over(Some("released_by_agent")));
        assert!(!took_over(None));
    }

    #[test]
    fn rounding_and_formatting_match_python() {
        assert_eq!(py_round(0.5), 0.0);
        assert_eq!(py_round(1.5), 2.0);
        assert_eq!(py_round(-2.5), -2.0);
        assert_eq!(fmt0(640.4), "640");
        assert_eq!(fmt0(2.5), "2");
        assert_eq!(fmt0(3.5), "4");
    }

    #[test]
    fn helper_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let mac = AgentVHID::new(dir.path().join("none.sock"), 1.0, false);
        let e = mac.status().unwrap_err();
        assert!(matches!(e, VhidError::HelperUnavailable(_)), "{e:?}");
        assert!(e
            .to_string()
            .starts_with("agent-vhid-helper isn't running on "));
    }
}
