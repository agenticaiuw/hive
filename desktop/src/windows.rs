//! A Windows computer's screen, mouse and keyboard: screenshots through PowerShell's System.Drawing, input through SendInput.
//! x/y are pixels in the latest screenshot (the primary screen, at most 1600 wide), whatever the display scaling.
use crate::common::pause;
use hive_protocol::b64;
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::{Mutex, Once};

pub const KIND: &str = "windows";
pub const NAME: &str = "PC";
pub const SHELL: &str = "PowerShell";
pub const KEYS: &str = "win+r, ctrl+c, alt+tab, enter, escape, down";
const NO_WINDOW: u32 = 0x0800_0000;

pub fn host() -> String { std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "PC".into()) }

fn powershell(script: &str) -> Command {
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).creation_flags(NO_WINDOW);
    c
}

pub fn shell(cmd: &str) -> Command { powershell(cmd) }

// ---- Win32 ----

#[repr(C)] #[derive(Clone, Copy)] struct MouseInput { dx: i32, dy: i32, data: u32, flags: u32, time: u32, extra: usize }
#[repr(C)] #[derive(Clone, Copy)] struct KeyInput { vk: u16, scan: u16, flags: u32, time: u32, extra: usize }
#[repr(C)] #[derive(Clone, Copy)] union InputData { mi: MouseInput, ki: KeyInput }
#[repr(C)] #[derive(Clone, Copy)] struct Input { kind: u32, data: InputData }
#[repr(C)] struct Pt { x: i32, y: i32 }

#[link(name = "user32")]
extern "system" {
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetCursorPos(p: *mut Pt) -> i32;
    fn SetProcessDPIAware() -> i32;
    fn VkKeyScanW(ch: u16) -> i16;
}

const MOVE: u32 = 0x0001; const LEFT_DOWN: u32 = 0x0002; const LEFT_UP: u32 = 0x0004; const RIGHT_DOWN: u32 = 0x0008;
const RIGHT_UP: u32 = 0x0010; const WHEEL: u32 = 0x0800; const HWHEEL: u32 = 0x1000; const ABSOLUTE: u32 = 0x8000;
const KEY_UP: u32 = 0x0002; const UNICODE: u32 = 0x0004; const EXTENDED: u32 = 0x0001;

fn mouse(dx: i32, dy: i32, data: i32, flags: u32) -> Input {
    Input { kind: 0, data: InputData { mi: MouseInput { dx, dy, data: data as u32, flags, time: 0, extra: 0 } } }
}
fn keyboard(vk: u16, scan: u16, flags: u32) -> Input {
    Input { kind: 1, data: InputData { ki: KeyInput { vk, scan, flags, time: 0, extra: 0 } } }
}
fn send(inputs: &[Input]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) };
    if sent as usize == inputs.len() { Ok(()) } else { Err("Windows blocked the input (a program running as administrator may be in front).".into()) }
}

/// Real pixels, not scaled ones, for this process.
fn screen() -> (f64, f64) {
    static AWARE: Once = Once::new();
    AWARE.call_once(|| unsafe { SetProcessDPIAware(); });
    unsafe { (GetSystemMetrics(0) as f64, GetSystemMetrics(1) as f64) }
}

/// The latest screenshot's size: what x/y are measured in.
static SHOT: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
fn shot_size() -> (f64, f64) {
    let s = *SHOT.lock().unwrap();
    if s.0 > 0.0 { s } else { screen() }
}

/// (x, y) in the screenshot as SendInput's 0–65535 across the primary screen.
fn absolute(x: f64, y: f64) -> Result<(i32, i32), String> {
    let (w, h) = shot_size();
    if x < 0.0 || y < 0.0 || x >= w || y >= h { return Err(format!("({x:.0}, {y:.0}) is off the screen ({w:.0}x{h:.0})")); }
    Ok((((x + 0.5) * 65536.0 / w) as i32, ((y + 0.5) * 65536.0 / h) as i32))
}

fn move_to(x: f64, y: f64) -> Result<(), String> {
    let (dx, dy) = absolute(x, y)?;
    send(&[mouse(dx, dy, 0, MOVE | ABSOLUTE)])
}

pub fn screenshot() -> Result<Value, String> {
    screen();
    let file = std::env::temp_dir().join(format!("hive-shot-{}.jpg", std::process::id()));
    let script = format!(r#"Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name D -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][W.D]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($full).CopyFromScreen($b.Left, $b.Top, 0, 0, $full.Size)
$w = [Math]::Min($b.Width, 1600); $h = [int]($b.Height * $w / $b.Width)
(New-Object System.Drawing.Bitmap $full, $w, $h).Save('{}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
"$w $h""#, file.display());
    let out = powershell(&script).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut size = text.split_whitespace().filter_map(|v| v.parse::<f64>().ok());
    let (Some(w), Some(h)) = (size.next(), size.next()) else {
        return Err(format!("couldn't take a screenshot: {}", String::from_utf8_lossy(&out.stderr).trim()));
    };
    *SHOT.lock().unwrap() = (w, h);
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    std::fs::remove_file(&file).ok();
    let mut p = Pt { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p); }
    let (sw, sh) = screen();
    Ok(json!({ "text": format!("The PC's screen; the pointer is at ({:.0}, {:.0}).", p.x as f64 * w / sw, p.y as f64 * h / sh),
        "images": [format!("data:image/jpeg;base64,{}", b64::encode(&data))] }))
}

pub fn click(x: f64, y: f64, right: bool, count: i64) -> Result<(), String> {
    let (down, up) = if right { (RIGHT_DOWN, RIGHT_UP) } else { (LEFT_DOWN, LEFT_UP) };
    move_to(x, y)?;
    pause(60);
    for i in 0..count {
        send(&[mouse(0, 0, 0, down)])?;
        pause(50);
        send(&[mouse(0, 0, 0, up)])?;
        if i + 1 < count { pause(90); }
    }
    Ok(())
}

pub fn drag(x: f64, y: f64, to_x: f64, to_y: f64) -> Result<(), String> {
    absolute(to_x, to_y)?;
    move_to(x, y)?;
    pause(80);
    send(&[mouse(0, 0, 0, LEFT_DOWN)])?;
    pause(100);
    for i in 1..=12 {
        let t = i as f64 / 12.0;
        move_to(x + (to_x - x) * t, y + (to_y - y) * t)?;
        pause(15);
    }
    pause(80);
    send(&[mouse(0, 0, 0, LEFT_UP)])
}

pub fn scroll(x: f64, y: f64, dx: i64, dy: i64) -> Result<(), String> {
    move_to(x, y)?;
    for _ in 0..dy.abs() { send(&[mouse(0, 0, -120 * dy.signum() as i32, WHEEL)])?; pause(30); }
    for _ in 0..dx.abs() { send(&[mouse(0, 0, 120 * dx.signum() as i32, HWHEEL)])?; pause(30); }
    Ok(())
}

/// Any text, typed as Unicode characters (no keyboard layout involved).
pub fn type_text(text: &str) -> Result<(), String> {
    for c in text.chars() {
        if c == '\n' { tap(0x0D, &[])?; continue; }
        let mut units = [0u16; 2];
        for &u in c.encode_utf16(&mut units).iter() { send(&[keyboard(0, u, UNICODE), keyboard(0, u, UNICODE | KEY_UP)])?; }
        pause(8);
    }
    Ok(())
}

fn modifier(name: &str) -> Option<u16> {
    Some(match name { "ctrl" | "control" => 0x11, "shift" => 0x10, "alt" | "opt" | "option" => 0x12, "win" | "cmd" | "command" | "meta" => 0x5B, _ => return None })
}

fn named(name: &str) -> Option<u16> {
    Some(match name {
        "return" | "enter" => 0x0D, "esc" | "escape" => 0x1B, "backspace" => 0x08, "tab" => 0x09, "space" => 0x20,
        "delete" | "forwarddelete" => 0x2E, "insert" => 0x2D, "home" => 0x24, "end" => 0x23, "pageup" => 0x21, "pagedown" => 0x22,
        "left" => 0x25, "up" => 0x26, "right" => 0x27, "down" => 0x28, "printscreen" => 0x2C,
        _ => match name.strip_prefix('f')?.parse::<u16>().ok()? { n @ 1..=24 => 0x70 + n - 1, _ => return None },
    })
}

fn flags(vk: u16) -> u32 { if matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B) { EXTENDED } else { 0 } }

/// Press `vk` with `mods` held.
fn tap(vk: u16, mods: &[u16]) -> Result<(), String> {
    let mut seq: Vec<Input> = mods.iter().map(|&m| keyboard(m, 0, flags(m))).collect();
    seq.push(keyboard(vk, 0, flags(vk)));
    seq.push(keyboard(vk, 0, flags(vk) | KEY_UP));
    seq.extend(mods.iter().rev().map(|&m| keyboard(m, 0, flags(m) | KEY_UP)));
    send(&seq)
}

pub fn key(combo: &str) -> Result<(), String> {
    let parts: Vec<String> = combo.replace(' ', "").split('+').filter(|p| !p.is_empty()).map(String::from).collect();
    let (mut mods, mut vk) = (Vec::new(), None);
    for (i, p) in parts.iter().enumerate() {
        let low = p.to_lowercase();
        if let Some(m) = modifier(&low) { if !mods.contains(&m) { mods.push(m); } continue; }
        if i + 1 != parts.len() { return Err(format!("unknown modifier {p} in {combo}")); }
        if let Some(v) = named(&low) { vk = Some(v); continue; }
        let mut chars = p.chars();
        let (Some(c), None) = (chars.next(), chars.next()) else { return Err(format!("unknown key {p} in {combo}")) };
        let scan = unsafe { VkKeyScanW(c as u16) };
        if scan == -1 { return Err(format!("this keyboard has no key for {c}")); }
        vk = Some((scan & 0xFF) as u16);
        for (bit, m) in [(1, 0x10), (2, 0x11), (4, 0x12)] { if (scan >> 8) & bit != 0 && !mods.contains(&m) { mods.push(m); } }
    }
    match vk {
        Some(v) => tap(v, &mods),
        None if !mods.is_empty() => tap(mods[mods.len() - 1], &mods[..mods.len() - 1]),
        None => Err("say which keys".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_and_layout() {
        assert_eq!(std::mem::size_of::<super::Input>(), if cfg!(target_pointer_width = "64") { 40 } else { 28 });
        assert_eq!(super::named("f12"), Some(0x7B));
        assert_eq!(super::modifier("cmd"), Some(0x5B));
    }
}

