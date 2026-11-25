//! The Mac's screen, mouse and keyboard, driven the way macOS lets one app drive another: CoreGraphics events. After a
//! screenshot of one app's window they go to that app alone (posted to its process, naming its window), so the owner keeps
//! their pointer and keyboard; after a screenshot of the whole screen they go through the Mac's own event stream, which
//! reaches everything (Dock, menu bar, cmd+space) and moves the pointer. Hive needs the Accessibility permission for both.
use crate::common::pause;
use hive_protocol::b64;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

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

type Ref = *const c_void;
#[repr(C)] #[derive(Clone, Copy)] struct Point { x: f64, y: f64 }
#[repr(C)] #[derive(Clone, Copy)] struct Rect { origin: Point, size: Point }
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetLocation(event: Ref) -> Point;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsAsleep(display: u32) -> u32;
    fn CGSessionCopyCurrentDictionary() -> Ref;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn CGEventSourceCreate(state: i32) -> Ref;
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, at: Point, button: u32) -> Ref;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventCreateScrollWheelEvent2(source: Ref, units: u32, count: u32, w1: i32, w2: i32, w3: i32) -> Ref;
    fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    fn CGEventSetFlags(event: Ref, flags: u64);
    #[cfg(test)] fn CGEventGetFlags(event: Ref) -> u64;
    fn CGEventSetLocation(event: Ref, at: Point);
    fn CGEventKeyboardSetUnicodeString(event: Ref, len: usize, text: *const u16);
    fn CGEventPostToPid(pid: i32, event: Ref);
    fn CGEventPost(tap: u32, event: Ref);
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> Ref;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGSMainConnectionID() -> i32;
    fn CGSCopySpacesForWindows(connection: i32, mask: i32, windows: Ref) -> Ref;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(options: Ref) -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" { fn CFRelease(cf: Ref); }

/// Where input goes: one app's window (its process, its window number, where it is on the screen), or the whole Mac.
#[derive(Clone, Copy)]
enum Target { App { pid: i32, window: u32, at: Point, size: Point }, Mac }
static TARGET: Mutex<Target> = Mutex::new(Target::Mac);

/// What the last screenshot showed, once macOS lets Hive send events.
fn target() -> Result<Target, String> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("macOS isn't letting Hive control this Mac yet: the owner turns on Hive in System Settings > Privacy & Security > Accessibility.".into());
    }
    let t = *TARGET.lock().unwrap();
    if matches!(t, Target::Mac) && HANDED.lock().unwrap().is_none_or(|end| Instant::now() > end) {
        return Err("Input on the whole screen uses the owner's own pointer and keyboard: ask for them first with mac_take_over \
            (why, and about how many minutes), or work in one app's window (mac_screenshot with its name).".into());
    }
    Ok(t)
}

/// Until when the owner has handed the Mac's own pointer and keyboard over to the agents.
static HANDED: Mutex<Option<Instant>> = Mutex::new(None);

/// Asks the owner in a floating window for the Mac's own pointer and keyboard, for about `minutes`: once they hand it over, a
/// floating window shows the asking task's log as it happens, and closing it takes the Mac back.
pub fn take_over(a: &Value) -> Result<Value, String> {
    let minutes = a["minutes"].as_u64().unwrap_or(10).clamp(1, 120);
    let (task, title) = (a["task"]["id"].as_i64().unwrap_or(0), a["task"]["title"].as_str().unwrap_or("A task").to_string());
    if away() {
        return Err("The owner isn't at the Mac (its screen is asleep or locked), so nobody can hand it over now. Go on with what works \
            without it, or end saying exactly what you need the Mac for.".into());
    }
    crate::bar::hand_over(&format!("#{task} {title}"), a["why"].as_str().unwrap_or(""), minutes)?;
    let until = Instant::now() + std::time::Duration::from_secs(minutes * 60);
    *HANDED.lock().unwrap() = Some(until);
    crate::bar::follow(task, &title);
    let mut shot = screenshot("")?;
    shot["text"] = json!(format!("The owner handed the Mac over for {minutes} minutes, and sees your log as you go. This is the whole \
        screen now: clicks, keys and typing use the Mac's own pointer and keyboard, which reach everything (menus, the Dock, system dialogs). \
        Use them now, and call mac_hand_back as soon as you're done. {}", shot["text"].as_str().unwrap_or("")));
    Ok(shot)
}

/// The owner took the Mac back (closed the window that follows the agent).
/// Whether nobody could answer on the Mac now: its screen is asleep or locked.
fn away() -> bool {
    unsafe {
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { return true; }
        let Some(session) = Retained::from_raw(CGSessionCopyCurrentDictionary() as *mut NSDictionary<NSString, AnyObject>) else { return true };
        session.objectForKey(&NSString::from_str("CGSSessionScreenIsLocked")).and_then(|v| v.downcast::<NSNumber>().ok()).is_some_and(|v| v.boolValue())
    }
}

pub fn give_back() { *HANDED.lock().unwrap() = None; }

/// Whether the agents have the Mac's own pointer and keyboard now.
pub fn handed() -> bool { HANDED.lock().unwrap().is_some_and(|end| Instant::now() <= end) }

/// (x, y) in the last screenshot as a point on the screen.
fn point(t: Target, x: f64, y: f64) -> Result<Point, String> {
    let (at, size) = match t { Target::App { at, size, .. } => (at, size), Target::Mac => { let (w, h) = screen_size(); (Point { x: 0.0, y: 0.0 }, Point { x: w, y: h }) } };
    if x < 0.0 || y < 0.0 || x >= size.x || y >= size.y { return Err(format!("({x:.0}, {y:.0}) is outside the screenshot ({:.0}x{:.0})", size.x, size.y)); }
    Ok(Point { x: at.x + x, y: at.y + y })
}

/// Sends an event where `t` says and frees it. An app's own events carry their source's private key state, so keys the
/// owner holds down don't mix in; mouse events name the window, which is how an app that isn't in front knows which is meant.
fn post(t: Target, make: impl FnOnce(Ref) -> Ref) -> Result<(), String> {
    static PRIVATE: OnceLock<usize> = OnceLock::new();
    unsafe {
        let source = match t { Target::App { .. } => *PRIVATE.get_or_init(|| CGEventSourceCreate(-1) as usize) as Ref, Target::Mac => std::ptr::null() };
        let e = make(source);
        if e.is_null() { return Err("macOS didn't make the event".into()); }
        match t {
            Target::App { pid, window, .. } => { for field in [91, 92] { CGEventSetIntegerValueField(e, field, window as i64); } CGEventPostToPid(pid, e) }
            Target::Mac => CGEventPost(0, e),
        }
        CFRelease(e);
    }
    Ok(())
}

fn mouse(t: Target, kind: u32, at: Point, button: u32, clicks: i64) -> Result<(), String> {
    post(t, |s| unsafe { let e = CGEventCreateMouseEvent(s, kind, at, button); if !e.is_null() { CGEventSetFlags(e, 0); CGEventSetIntegerValueField(e, 1, clicks); } e })
}

const MOVED: u32 = 5;

pub fn click(x: f64, y: f64, right: bool, count: i64) -> Result<(), String> {
    let t = target()?;
    let at = point(t, x, y)?;
    let (down, up, button) = if right { (3, 4, 1) } else { (1, 2, 0) };
    mouse(t, MOVED, at, 0, 0)?;
    pause(30);
    for n in 1..=count {
        mouse(t, down, at, button, n)?;
        pause(30);
        mouse(t, up, at, button, n)?;
        pause(40);
    }
    Ok(())
}

pub fn drag(x: f64, y: f64, to_x: f64, to_y: f64) -> Result<(), String> {
    let t = target()?;
    let (from, to) = (point(t, x, y)?, point(t, to_x, to_y)?);
    mouse(t, MOVED, from, 0, 0)?;
    pause(30);
    mouse(t, 1, from, 0, 1)?;
    pause(80);
    for i in 1..=12 {
        let f = i as f64 / 12.0;
        mouse(t, 6, Point { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }, 0, 1)?;
        pause(16);
    }
    mouse(t, 2, to, 0, 1)
}

pub fn scroll(x: f64, y: f64, dx: i64, dy: i64) -> Result<(), String> {
    let t = target()?;
    let at = point(t, x, y)?;
    mouse(t, MOVED, at, 0, 0)?;
    // A notch at a time; wheel lines are positive up and left, the tool's are positive down and right.
    for i in 0..dy.abs().max(dx.abs()) {
        let (wy, wx) = (if i < dy.abs() { -dy.signum() } else { 0 }, if i < dx.abs() { -dx.signum() } else { 0 });
        post(t, |s| unsafe { let e = CGEventCreateScrollWheelEvent2(s, 1, 2, wy as i32, wx as i32, 0); if !e.is_null() { CGEventSetFlags(e, 0); CGEventSetLocation(e, at); } e })?;
        pause(20);
    }
    Ok(())
}

fn press(t: Target, code: u16, flags: u64) -> Result<(), String> {
    for down in [true, false] {
        post(t, |s| unsafe { let e = CGEventCreateKeyboardEvent(s, code, down); if !e.is_null() { CGEventSetFlags(e, flags); } e })?;
        pause(12);
    }
    Ok(())
}

pub fn key(combo: &str) -> Result<(), String> {
    let t = target()?;
    let (code, flags) = chord(combo)?;
    press(t, code, flags)
}


/// Types the characters themselves, whatever the keyboard layout; a new line is the return key.
pub fn type_text(text: &str) -> Result<(), String> {
    let t = target()?;
    for c in text.chars() {
        if c == '\n' { press(t, 36, 0)?; continue; }
        let mut units = [0u16; 2];
        let units = c.encode_utf16(&mut units);
        for down in [true, false] {
            post(t, |s| unsafe { unicode_event(CGEventCreateKeyboardEvent(s, 0, down), units) })?;
        }
        pause(4);
    }
    Ok(())
}

/// Reuse the credential saved by Hive's original Authentication sheet. It stays
/// inside this process: never a tool argument/result, clipboard value or log.
pub fn authenticate() -> Result<(), String> {
    if !matches!(target()?, Target::Mac) { return Err("Mac authentication needs a whole-Mac handover.".into()); }
    let mut secret = read_device_credential("mac")?;
    let result = std::str::from_utf8(&secret).map_err(|_| "Saved Mac credential isn't UTF-8.".to_string())
        .and_then(|s| if s.is_empty() { Err("Saved Mac credential is empty.".into()) } else { type_text(s) });
    erase(&mut secret);
    result
}

fn erase(secret: &mut [u8]) {
    for byte in secret { unsafe { std::ptr::write_volatile(byte, 0); } }
}

fn read_device_credential(account: &str) -> Result<Vec<u8>, String> {
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: Ref; static kSecClassGenericPassword: Ref;
        static kSecAttrService: Ref; static kSecAttrAccount: Ref; static kSecReturnData: Ref;
        fn SecKeychainSetUserInteractionAllowed(allowed: bool) -> i32;
        fn SecItemCopyMatching(query: Ref, result: *mut Ref) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: Ref;
        fn CFDictionaryCreate(allocator: Ref, keys: *const Ref, values: *const Ref, count: isize, key_callbacks: Ref, value_callbacks: Ref) -> Ref;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
    }
    let account_name = account;
    let service = NSString::from_str("local.personal-agent.authentication");
    let account = NSString::from_str(account);
    unsafe {
        let keys = [kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData];
        let values = [kSecClassGenericPassword, Retained::as_ptr(&service).cast(), Retained::as_ptr(&account).cast(), kCFBooleanTrue];
        let q = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 4, std::ptr::null(), std::ptr::null());
        if q.is_null() { return Err("Couldn't prepare Mac authentication.".into()); }
        SecKeychainSetUserInteractionAllowed(false);
        let mut data = std::ptr::null();
        let status = SecItemCopyMatching(q, &mut data);
        SecKeychainSetUserInteractionAllowed(true);
        CFRelease(q);
        if status != 0 || data.is_null() {
            // The original Agent may have trusted the system Keychain helper
            // rather than this executable. Its output stays private here.
            let saved = Command::new("/usr/bin/security").args(["find-generic-password", "-s", "local.personal-agent.authentication", "-a", account_name, "-w"]).output()
                .map_err(|_| format!("Saved credential unavailable (Keychain status {status})."))?;
            if !saved.status.success() { return Err(format!("Saved credential unavailable (Keychain status {status}).")); }
            let mut bytes = saved.stdout;
            if bytes.last() == Some(&b'\n') { bytes.pop(); }
            return Ok(bytes);
        }
        let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize).to_vec();
        CFRelease(data);
        Ok(bytes)
    }
}

/// One-time migration from the original Keychain store to the current server.
/// Only the saved phone credential is sent, privately, to the authenticated Hive
/// endpoint that binds it to the connected iPhone. Nothing is returned to agents.
pub fn restore_phone_passcode() -> Result<(), String> {
    let c = crate::tailnet::load().ok_or("This Mac isn't connected to Hive.")?;
    let status = ureq::get(&format!("{}/api/phone", c.server)).set("Authorization", &format!("Bearer {}", c.token))
        .timeout(std::time::Duration::from_secs(20)).call().map_err(|_| "Couldn't check Hive's phone credentials.")?
        .into_string().map_err(|_| "Couldn't read Hive's phone status.")?;
    let status: Value = serde_json::from_str(&status).map_err(|_| "Couldn't read Hive's phone status.")?;
    if status["passcode"] == true || status["paused"] == true { return Err("Hive already has a phone credential or a paused unlock attempt; migration left it unchanged.".into()); }
    if status["connected"] != true { return Err("The iPhone must be connected before its saved passcode can be migrated.".into()); }
    let accounts = Command::new("/usr/bin/security").arg("dump-keychain").output().map_err(|_| "Couldn't inspect saved credential metadata.")?;
    if !accounts.status.success() { return Err("Couldn't inspect saved credential metadata.".into()); }
    let metadata = String::from_utf8_lossy(&accounts.stdout);
    let account = legacy_phone_account(&metadata)?;
    let mut secret = read_device_credential(&account)?;
    let result = (|| {
        let passcode = std::str::from_utf8(&secret).map_err(|_| "Saved phone credential isn't UTF-8.")?;
        if !(4..=32).contains(&passcode.len()) || !passcode.bytes().all(|b| (b'!'..=b'~').contains(&b)) { return Err("Saved phone credential isn't a supported passcode.".into()); }
        let response = ureq::post(&format!("{}/api/phone/passcode", c.server)).set("Authorization", &format!("Bearer {}", c.token))
            .set("Content-Type", "application/json").timeout(std::time::Duration::from_secs(45))
            .send_string(&json!({ "passcode": passcode }).to_string());
        match response {
            Ok(_) => Ok(()),
            Err(_) => Err("Hive couldn't bind the saved passcode to the connected iPhone. No passcode was typed; inspect the phone connection.".into()),
        }
    })();
    erase(&mut secret);
    result
}

fn legacy_phone_account(metadata: &str) -> Result<String, String> {
    let mut phones = Vec::new();
    for block in metadata.split("keychain:") {
        if !block.contains("\"svce\"<blob>=\"local.personal-agent.authentication\"") { continue; }
        for line in block.lines() {
            if let Some(account) = line.trim().strip_prefix("\"acct\"<blob>=\"").and_then(|s| s.strip_suffix('"')) {
                if account.starts_with("phone:") { phones.push(account.to_string()); }
            }
        }
    }
    phones.sort(); phones.dedup();
    if phones.len() != 1 { return Err("Migration needs exactly one saved phone credential; none was transferred.".into()); }
    Ok(phones.remove(0))
}

#[test]
fn legacy_phone_migration_requires_one_unambiguous_saved_account() {
    let entry = |service: &str, account: &str| format!("keychain: test\n\"svce\"<blob>=\"{service}\"\n\"acct\"<blob>=\"{account}\"\n");
    let old = "local.personal-agent.authentication";
    let one = entry(old, "phone:one");
    assert_eq!(legacy_phone_account(&(entry("other", "phone:unrelated") + &entry(old, "mac") + &entry(old, "attempt:mac") + &one)).unwrap(), "phone:one");
    assert!(legacy_phone_account("").is_err());
    assert!(legacy_phone_account(&(one + &entry(old, "phone:two"))).is_err());
}

// CoreGraphics inherits the source's modifier state, including Command left by a
// shortcut. Every text event must explicitly clear it, on both down and up.
unsafe fn unicode_event(e: Ref, units: &[u16]) -> Ref {
    if !e.is_null() {
        CGEventSetFlags(e, 0);
        CGEventKeyboardSetUnicodeString(e, units.len(), units.as_ptr());
    }
    e
}

/// "shift+cmd+t": the key's code and the modifiers' flags.
fn chord(combo: &str) -> Result<(u16, u64), String> {
    let low = combo.to_lowercase().replace(' ', "");
    let parts: Vec<&str> = low.split('+').collect();
    let (last, mods) = parts.split_last().filter(|(l, _)| !l.is_empty()).ok_or_else(|| format!("no key in {combo}"))?;
    let mut flags = 0;
    for m in mods {
        flags |= match *m {
            "cmd" | "command" | "meta" | "super" => 0x100000, "shift" => 0x20000, "alt" | "opt" | "option" => 0x80000,
            "ctrl" | "control" => 0x40000, "fn" => 0x800000, _ => return Err(format!("unknown modifier {m} in {combo}")),
        };
    }
    Ok((keycode(last).ok_or_else(|| format!("unknown key {last} in {combo}"))?, flags))
}

fn keycode(name: &str) -> Option<u16> {
    Some(match name {
        "return" | "enter" => 36, "tab" => 48, "space" => 49, "delete" | "backspace" => 51, "escape" | "esc" => 53,
        "forwarddelete" | "forward_delete" => 117, "home" => 115, "end" => 119, "pageup" | "page_up" => 116,
        "pagedown" | "page_down" => 121, "left" => 123, "right" => 124, "down" => 125, "up" => 126,
        _ => {
            if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<usize>().ok()).filter(|n| (1..=12).contains(n)) {
                return Some([122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][n - 1]);
            }
            // The US layout's keys in key-code order (\0 where a key has no character).
            const KEYS: &str = "asdfhgzxcv\0bqweryt123465=97-80]ou[ip\0lj'k;\\,/nm.\0\0`";
            let mut cs = name.chars();
            let c = cs.next().filter(|&c| c != '\0' && cs.next().is_none())?;
            KEYS.find(c)? as u16
        }
    })
}

// ---- the screen ----

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

/// The front window of the app called `app` (or whose name has it in it): one on this desktop if it has one, else one on
/// another desktop.
/// An app's windows, best first. Some can't be captured (one full screen on another desktop, a tab bar), so the caller tries each.
fn windows(app: &str) -> Result<Vec<(Target, String)>, String> {
    let list = unsafe { Retained::from_raw(CGWindowListCopyWindowInfo(16, 0) as *mut NSArray<NSDictionary<NSString, AnyObject>>) }
        .ok_or("macOS didn't list the windows")?;
    let get = |d: &NSDictionary<NSString, AnyObject>, k: &str| d.objectForKey(&NSString::from_str(k));
    let num = |v: Option<Retained<AnyObject>>| v.and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.doubleValue()).unwrap_or(0.0);
    let text = |v: Option<Retained<AnyObject>>| v.and_then(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string()).unwrap_or_default();
    let want = app.trim().to_lowercase();
    let mut windows: Vec<_> = list.iter().filter_map(|d| {
        let b = get(&d, "kCGWindowBounds")?.downcast::<NSDictionary>().ok()?;
        let f = |k: &str| num(b.objectForKey(&NSString::from_str(k)));
        let size = Point { x: f("Width"), y: f("Height") };
        let id = num(get(&d, "kCGWindowNumber")) as u32;
        // A window that's on no desktop is one the app closed but keeps.
        let shown = || unsafe {
            let ids = NSArray::from_retained_slice(&[NSNumber::numberWithUnsignedInt(id)]);
            Retained::from_raw(CGSCopySpacesForWindows(CGSMainConnectionID(), 7, Retained::as_ptr(&ids).cast()) as *mut NSArray).is_some_and(|s| s.count() > 0)
        };
        (num(get(&d, "kCGWindowLayer")) == 0.0 && num(get(&d, "kCGWindowAlpha")) > 0.0 && size.x >= 50.0 && size.y >= 50.0 && shown()).then(|| {
            let t = Target::App { pid: num(get(&d, "kCGWindowOwnerPID")) as i32, window: id, at: Point { x: f("X"), y: f("Y") }, size };
            (text(get(&d, "kCGWindowOwnerName")), text(get(&d, "kCGWindowName")), t, get(&d, "kCGWindowIsOnscreen").is_none())
        })
    }).collect();
    // An app's real windows have titles; its untitled ones are overlays (popovers, previews) that would hide the page behind them.
    windows.sort_by_key(|w| (w.1.is_empty(), w.3));
    let exact = windows.iter().any(|w| w.0.to_lowercase() == want);
    let found: Vec<_> = windows.iter().filter(|w| if exact { w.0.to_lowercase() == want } else { w.0.to_lowercase().contains(&want) })
        .map(|(owner, title, t, _)| (*t, if title.is_empty() { owner.clone() } else { format!("{owner}'s window \"{title}\"") })).collect();
    if found.is_empty() { return Err(format!("{app} has no window (it isn't open, or its windows are minimized)")); }
    Ok(found)
}

/// The whole screen, or one app's front window (even under other windows); the other tools then act in what it showed.
pub fn screenshot(app: &str) -> Result<Value, String> {
    let file = std::env::temp_dir().join(format!("hive-shot-{}.jpg", std::process::id()));
    let p = file.to_string_lossy().into_owned();
    let tries = if app.trim().is_empty() { vec![(Target::Mac, String::new())] } else { windows(app)? };
    let mut failed = Vec::new();
    let (t, what, width) = tries.into_iter().find_map(|(t, what)| {
        let (args, width) = match t {
            Target::App { window, size, .. } => (vec!["-x".to_string(), "-o".into(), "-l".into(), window.to_string()], size.x),
            Target::Mac => (vec!["-x".to_string(), "-m".into()], screen_size().0),
        };
        std::fs::remove_file(&file).ok();
        let out = Command::new("screencapture").args(&args).args(["-t", "jpg", &p]).output().ok()?;
        if out.status.success() && file.exists() { return Some((t, what, width)) }
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        failed.push(format!("{} ({})", if what.is_empty() { "the screen" } else { &what }, if why.is_empty() { "it gave no reason" } else { &why }));
        None
    }).ok_or_else(|| {
        // Say what really went wrong: a missing permission is only one cause, and asking the owner for it otherwise sends them on a chase.
        if !unsafe { CGPreflightScreenCaptureAccess() } { return "Hive doesn't have the Screen Recording permission on this Mac".to_string() }
        format!("screencapture couldn't capture {}; Hive has the Screen Recording permission", failed.join(", "))
    })?;
    // Retina captures are 2x; shrink to points so the image's pixels are the coordinates the other tools take.
    Command::new("sips").args(["--resampleWidth", &(width as i64).to_string(), &p]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok();
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    std::fs::remove_file(&file).ok();
    *TARGET.lock().unwrap() = t;
    let text = match t {
        Target::App { .. } => format!("{what}. Clicks, keys and typing now go to this app alone, in the background; the owner's pointer and keyboard stay theirs."),
        Target::Mac => { let (x, y) = cursor(); format!("The Mac's screen; the pointer is at ({x:.0}, {y:.0}). Clicks, keys and typing now use the Mac's own pointer and keyboard.") }
    };
    Ok(json!({ "text": text, "images": [format!("data:image/jpeg;base64,{}", b64::encode(&data))] }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn text_clears_inherited_shortcut_modifiers() {
        unsafe {
            for down in [true, false] {
                let e = super::CGEventCreateKeyboardEvent(std::ptr::null(), 0, down);
                assert!(!e.is_null());
                super::CGEventSetFlags(e, 0x1e0000);
                let e = super::unicode_event(e, &[0x61]);
                assert_eq!(super::CGEventGetFlags(e), 0);
                super::CFRelease(e);
            }
        }
    }

    #[test]
    fn keys() {
        assert_eq!(super::keycode("a"), Some(0));
        assert_eq!(super::keycode("`"), Some(50));
        assert_eq!(super::keycode("/"), Some(44));
        assert_eq!(super::keycode("l"), Some(37));
        assert_eq!(super::keycode("f12"), Some(111));
        assert_eq!(super::keycode("é"), None);
        assert_eq!(super::chord("cmd+shift+T"), Ok((17, 0x120000)));
    }
}

/// Hive.app opened from anywhere else (Downloads, the zip) puts itself in Applications, in place of an older copy, and reopens
/// from there: that's where Spotlight finds it and Safari finds Hive for Safari.
pub fn install() {
    let dest = std::path::Path::new("/Applications/Hive.app");
    let app = std::env::current_exe().ok().and_then(|e| e.ancestors().nth(3).map(|a| a.to_path_buf()));
    if let Some(app) = app.filter(|a| a.extension().is_some_and(|e| e == "app") && a.as_path() != dest) {
        if copy_app(&app, dest) && Command::new("open").arg(dest).status().is_ok_and(|s| s.success()) {
            // Opened from its disk image ("Install Hive"): put the image away once this copy, which runs from it, has quit.
            if let Some(image) = app.parent().filter(|v| v.starts_with("/Volumes")) {
                Command::new("/bin/sh").args(["-c", "sleep 3; /usr/bin/hdiutil detach \"$0\" -quiet"]).arg(image).spawn().ok();
            }
            std::process::exit(0)
        }
    }
}

/// Copies the app to `dest` whole, or leaves `dest` as it was. No quarantine on the copy: the owner already opened this app.
fn copy_app(app: &std::path::Path, dest: &std::path::Path) -> bool {
    let new = dest.with_extension("app.new");
    std::fs::remove_dir_all(&new).ok();
    let done = Command::new("ditto").arg("--noqtn").arg(app).arg(&new).status().is_ok_and(|s| s.success())
        && (!dest.exists() || std::fs::remove_dir_all(dest).is_ok()) && std::fs::rename(&new, dest).is_ok();
    if !done { std::fs::remove_dir_all(&new).ok(); }
    done
}

#[cfg(test)]
#[test]
fn copy_app_replaces_an_older_copy() {
    let t = std::env::temp_dir().join(format!("hive-install-{}", std::process::id()));
    let (app, dest) = (t.join("Downloads/Hive.app"), t.join("Applications/Hive.app"));
    for (d, v) in [(&app, "new"), (&dest, "old")] {
        std::fs::create_dir_all(d.join("Contents/MacOS")).unwrap();
        std::fs::write(d.join("Contents/MacOS/hive"), v).unwrap();
    }
    std::fs::write(dest.join("Contents/stale"), "").unwrap();
    assert!(copy_app(&app, &dest));
    assert_eq!(std::fs::read_to_string(dest.join("Contents/MacOS/hive")).unwrap(), "new");
    assert!(!dest.join("Contents/stale").exists() && !dest.with_extension("app.new").exists() && app.exists());
    std::fs::remove_dir_all(&t).ok();
}

