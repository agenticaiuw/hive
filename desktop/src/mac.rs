//! The Mac's screen, mouse and keyboard. Input goes through the owner's input helper (/tmp/agent-vhid.sock: a virtual keyboard
//! and mouse that hands control back the moment the owner touches theirs); screenshots through screencapture. x/y are screen
//! points, which are also the screenshot's pixels.
use crate::common::pause;
use hive_protocol::b64;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const KIND: &str = "mac";
pub const NAME: &str = "Mac";
pub const SHELL: &str = "zsh";
pub const KEYS: &str = "cmd+space, return, cmd+shift+t, escape, down";

pub fn host() -> String {
    Command::new("scutil").args(["--get", "ComputerName"]).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Mac".into())
}

pub fn shell(cmd: &str) -> Command {
    let mut c = Command::new("zsh");
    c.args(["-lc", cmd]);
    c
}

pub fn click(x: f64, y: f64, right: bool, count: i64) -> Result<(), String> {
    let bit = if right { 2 } else { 1 };
    move_to(x, y)?;
    pause(60);
    for i in 0..count {
        send(&format!("buttons {bit}"))?;
        pause(50);
        send("buttons 0")?;
        if i + 1 < count { pause(90); }
    }
    Ok(())
}

pub fn drag(x: f64, y: f64, to_x: f64, to_y: f64) -> Result<(), String> {
    move_to(x, y)?;
    pause(80);
    send("buttons 1")?;
    pause(100);
    let moved = move_to(to_x, to_y);
    pause(80);
    send("buttons 0").ok();
    moved
}

pub fn scroll(x: f64, y: f64, dx: i64, dy: i64) -> Result<(), String> {
    move_to(x, y)?;
    // Rolling a wheel away from you is +1; natural scrolling flips what that does.
    let natural = Command::new("defaults").args(["read", "-g", "com.apple.swipescrolldirection"]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() != "0").unwrap_or(true);
    let sign = if natural { 1 } else { -1 };
    for (amount, fmt) in [(dy, "{} 0"), (dx, "0 {}")] {
        for _ in 0..amount.abs() {
            send(&format!("scroll {}", fmt.replace("{}", &(sign * amount.signum()).to_string())))?;
            pause(30);
        }
    }
    Ok(())
}

// ---- the screen: CoreGraphics for the cursor and display size ----

#[repr(C)] #[derive(Clone, Copy)] struct Point { x: f64, y: f64 }
#[repr(C)] #[derive(Clone, Copy)] struct Rect { origin: Point, size: Point }
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> Point;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" { fn CFRelease(cf: *const std::ffi::c_void); }

fn cursor() -> (f64, f64) {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() { return (0.0, 0.0); }
        let p = CGEventGetLocation(e);
        CFRelease(e);
        (p.x, p.y)
    }
}

fn screen_size() -> (f64, f64) {
    let r = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    (r.size.x, r.size.y)
}

pub fn screenshot() -> Result<Value, String> {
    let file = std::env::temp_dir().join(format!("hive-shot-{}.jpg", std::process::id()));
    let p = file.to_string_lossy().into_owned();
    let (w, _) = screen_size();
    let ok = Command::new("screencapture").args(["-x", "-m", "-t", "jpg", &p]).status().map(|s| s.success()).unwrap_or(false);
    if !ok { return Err("screencapture failed (Hive needs Screen Recording permission)".into()); }
    // Retina captures are 2x; shrink to points so the image's pixels are the click coordinates.
    Command::new("sips").args(["--resampleWidth", &(w as i64).to_string(), &p]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok();
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    std::fs::remove_file(&file).ok();
    let (x, y) = cursor();
    Ok(json!({ "text": format!("The Mac's screen; the pointer is at ({x:.0}, {y:.0})."), "images": [format!("data:image/jpeg;base64,{}", b64::encode(&data))] }))
}

// ---- the input helper ----

static HELPER: Mutex<Option<BufReader<UnixStream>>> = Mutex::new(None);
static PPC: Mutex<f64> = Mutex::new(1.0);

/// The helper chimes when it takes or gives back the keyboard unless its sound switch says off; the owner wants no tone.
fn quiet() {
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support");
    std::fs::create_dir_all(dir.join("Hive")).ok(); // "Personal Agent" links to it on Macs set up before
    std::fs::create_dir_all(dir.join("Personal Agent")).ok();
    std::fs::write(dir.join("Personal Agent/speak-aloud"), "off\n").ok();
}

fn request(line: &str) -> Result<String, String> {
    let mut slot = HELPER.lock().unwrap();
    for attempt in 0..2 {
        if slot.is_none() {
            let st = UnixStream::connect("/tmp/agent-vhid.sock").map_err(|_| "The Mac's input helper isn't running.".to_string())?;
            quiet();
            st.set_read_timeout(Some(Duration::from_secs(30))).ok();
            *slot = Some(BufReader::new(st));
        }
        let r = slot.as_mut().unwrap();
        let mut reply = String::new();
        let ok = r.get_mut().write_all(format!("{line}\n").as_bytes()).is_ok() && r.read_line(&mut reply).map(|n| n > 0).unwrap_or(false);
        if ok { return Ok(reply.trim().to_string()); }
        *slot = None;
        if attempt == 1 { break; }
    }
    Err("Lost the connection to the Mac's input helper.".into())
}

fn send(line: &str) -> Result<String, String> {
    let mut reply = request(line)?;
    if !reply.starts_with("ok") && reply.contains("disengaged") {
        // The owner touched their keyboard or mouse earlier; ask for control again (it's given once their hands are off).
        request("engage")?;
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if request("status")?.contains("state=engaged") { break; }
            pause(200);
        }
        reply = request(line)?;
    }
    if reply.starts_with("ok") { return Ok(reply); }
    Err(if reply.contains("disengaged") {
        "The owner is using the Mac's keyboard or mouse right now, so Hive let go. Wait a little and try again.".into()
    } else { format!("The input helper refused: {reply}") })
}

/// Moves the pointer to (x, y): the virtual mouse only moves relatively, so nudge, look, and learn how far a count goes.
fn move_to(x: f64, y: f64) -> Result<(), String> {
    let (w, h) = screen_size();
    if x < 0.0 || y < 0.0 || x >= w || y >= h { return Err(format!("({x:.0}, {y:.0}) is off the screen ({w:.0}x{h:.0})")); }
    let mut stalled = 0;
    for _ in 0..200 {
        let before = cursor();
        let (ex, ey) = (x - before.0, y - before.1);
        if ex.abs() <= 0.75 && ey.abs() <= 0.75 { return Ok(()); }
        let ppc = *PPC.lock().unwrap();
        let count = |e: f64| { let c = (e / ppc * 0.8).round() as i64; (if c == 0 && e.abs() > 0.5 { e.signum() as i64 } else { c }).clamp(-127, 127) };
        let (cx, cy) = (count(ex), count(ey));
        send(&format!("move {cx} {cy}"))?;
        pause(12);
        let after = cursor();
        let (sent, moved) = ((cx as f64).hypot(cy as f64), (after.0 - before.0).hypot(after.1 - before.1));
        if sent >= 3.0 { let mut p = PPC.lock().unwrap(); *p = 0.7 * *p + 0.3 * (moved / sent).clamp(0.05, 10.0); }
        stalled = if moved < 0.01 { stalled + 1 } else { 0 };
        if stalled >= 15 { return Err("The pointer stopped moving; is the virtual mouse ready?".into()); }
    }
    Err(format!("The pointer didn't reach ({x:.0}, {y:.0})."))
}

fn modifier(name: &str) -> Option<u8> {
    Some(match name { "ctrl" | "control" => 1, "shift" => 2, "alt" | "opt" | "option" => 4, "cmd" | "command" | "meta" => 8, _ => return None })
}

fn named(name: &str) -> Option<u8> {
    Some(match name {
        "return" | "enter" => 0x28, "esc" | "escape" => 0x29, "backspace" | "delete" => 0x2A, "tab" => 0x2B, "space" => 0x2C,
        "forwarddelete" => 0x4C, "home" => 0x4A, "pageup" => 0x4B, "end" => 0x4D, "pagedown" => 0x4E,
        "right" => 0x4F, "left" => 0x50, "down" => 0x51, "up" => 0x52,
        _ => match name.strip_prefix('f')?.parse::<u8>().ok()? { n @ 1..=12 => 0x3A + n - 1, _ => return None },
    })
}

/// The key that types `c` on a US keyboard, and whether it needs shift.
fn char_key(c: char) -> Option<(u8, bool)> {
    const PLAIN: &str = "-=[]\\;'`,./";
    const SHIFTED: &str = "_+{}|:\"~<>?";
    const PLAIN_USAGE: [u8; 11] = [0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];
    match c {
        'a'..='z' => Some((0x04 + (c as u8 - b'a'), false)),
        'A'..='Z' => Some((0x04 + (c as u8 - b'A'), true)),
        ' ' => Some((0x2C, false)), '\n' => Some((0x28, false)), '\t' => Some((0x2B, false)),
        _ => "1234567890".find(c).map(|i| (0x1E + i as u8, false))
            .or_else(|| "!@#$%^&*()".find(c).map(|i| (0x1E + i as u8, true)))
            .or_else(|| PLAIN.find(c).map(|i| (PLAIN_USAGE[i], false)))
            .or_else(|| SHIFTED.chars().position(|x| x == c).map(|i| (PLAIN_USAGE[i], true))),
    }
}

pub fn key(combo: &str) -> Result<(), String> {
    let parts: Vec<String> = combo.replace(' ', "").split('+').filter(|p| !p.is_empty()).map(String::from).collect();
    let (mut mods, mut usage) = (0u8, None);
    for (i, p) in parts.iter().enumerate() {
        let low = p.to_lowercase();
        if let Some(b) = modifier(&low) { mods |= b; continue; }
        if i + 1 != parts.len() { return Err(format!("unknown modifier {p} in {combo}")); }
        let single = if p.chars().count() == 1 { char_key(p.chars().next().unwrap()) } else { None };
        match (named(&low), single) {
            (Some(u), _) => usage = Some(u),
            (None, Some((u, shifted))) => { usage = Some(u); if shifted { mods |= 2; } }
            _ => return Err(format!("unknown key {p} in {combo}")),
        }
    }
    if mods != 0 { send(&format!("keys {mods}"))?; pause(30); }
    let pressed = match usage {
        Some(u) => send(&format!("keys {mods} {u}")).and_then(|_| { pause(50); send(&format!("keys {mods}")) }),
        None => Ok(String::new()),
    };
    send("keys 0").ok();
    pressed.map(|_| ())
}

pub fn type_text(text: &str) -> Result<(), String> {
    let mut other = String::new();
    for c in text.chars() {
        let Some((u, shifted)) = char_key(c) else { other.push(c); continue };
        if !other.is_empty() { paste(&other)?; other.clear(); }
        let m = if shifted { 2 } else { 0 };
        send(&format!("keys {m} {u}"))?;
        pause(30);
        send(&format!("keys {m}"))?;
        if shifted { send("keys 0")?; }
        pause(35);
    }
    if !other.is_empty() { paste(&other)?; }
    Ok(())
}

/// Characters a US keyboard can't type go in through the clipboard (which is put back afterwards).
fn paste(text: &str) -> Result<(), String> {
    let before = Command::new("pbpaste").output().map(|o| o.stdout).unwrap_or_default();
    let put = |b: &[u8]| { if let Ok(mut c) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() { c.stdin.take().unwrap().write_all(b).ok(); c.wait().ok(); } };
    put(text.as_bytes());
    let r = key("cmd+v");
    pause(300);
    put(&before);
    r
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys() {
        assert_eq!(super::char_key('a'), Some((0x04, false)));
        assert_eq!(super::char_key('?'), Some((0x38, true)));
        assert_eq!(super::char_key('"'), Some((0x34, true)));
        assert_eq!(super::char_key('é'), None);
        assert_eq!(super::named("f12"), Some(0x45));
    }
}

/// A home Hive stays up: the Mac doesn't idle-sleep while the app runs, and the app opens at login.
pub fn stay_on() {
    Command::new("caffeinate").args(["-i", "-w", &std::process::id().to_string()]).spawn().ok();
    let exe = std::env::current_exe().unwrap_or_default();
    let run = match exe.ancestors().find(|d| d.extension().is_some_and(|e| e == "app")) {
        Some(app) => format!("<string>/usr/bin/open</string><string>-g</string><string>{}</string>", app.display()),
        None => format!("<string>{}</string>", exe.display()),
    };
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/LaunchAgents");
    std::fs::create_dir_all(&dir).ok();
    std::fs::write(dir.join("app.hive.mac.plist"), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
        <key>Label</key><string>app.hive.mac</string><key>ProgramArguments</key><array>{run}</array><key>RunAtLoad</key><true/></dict></plist>\n")).ok();
}
