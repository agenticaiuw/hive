//! The tools every computer has, and what they do the same way everywhere (the shell's time limit, files to and from the VM).
//! The screen, mouse and keyboard are the operating system's: mac/mac.rs and windows/windows.rs. x/y everywhere are pixels in the latest
//! screenshot.
use crate::os;
use hive_protocol::{b64, n, s, tool};
use serde_json::{json, Value};
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

pub fn tools() -> Vec<Value> {
    let (k, on) = (os::KIND, os::NAME);
    let mut shot = if cfg!(target_os = "macos") {
        tool("mac_screenshot", "See the owner's Mac: whole screen (app=\"\"), or one app's front window in the background (owner keeps pointer/keyboard; menu shortcuts need mac_take_over). x/y in mac_input are pixels in this image.",
            json!({ "app": s("App name for one window, or \"\" for whole screen") }), &["app"])
    } else {
        tool(&format!("{k}_screenshot"), &format!("See the owner's {on} screen. x/y in {k}_input are pixels in this image."), json!({}), &[])
    };
    shot["lock"] = json!("input");

    let actions = if cfg!(target_os = "macos") { "click|drag|scroll|type|key|authenticate|hand_back" } else { "click|drag|scroll|type|key" };
    let mut input = tool(&format!("{k}_input"),
        &format!("Drive pointer/keyboard on the {on}. action: {actions}. click(x,y,button?,count?), drag(x,y,to_x,to_y), scroll(x,y,dx?,dy?), type(text), key(keys e.g. {}){}.",
            os::KEYS, if cfg!(target_os = "macos") { ", authenticate (types saved Mac login password into focused field after takeover), hand_back (returns pointer/keyboard)" } else { "" }),
        json!({
            "action": s(actions),
            "x": n("x in latest screenshot"), "y": n("y in latest screenshot"),
            "to_x": n("drag end x"), "to_y": n("drag end y"),
            "dx": n("scroll notches right"), "dy": n("scroll notches down"),
            "button": s("left or right"), "count": n("1 or 2"),
            "text": s("text to type"), "keys": s("keys joined with +")
        }), &["action"]);
    input["lock"] = json!("input");

    let mut all = vec![shot, input];
    if cfg!(target_os = "macos") {
        let mut t = tool("mac_take_over", "Ask the owner to hand over the Mac's pointer/keyboard when a single app window can't do it (menu shortcuts, Dock, system dialogs). Returns a whole-screen shot; call mac_input(action=\"hand_back\") when done.",
            json!({ "why": s("Why you need the whole Mac"), "minutes": n("About how many minutes") }), &["why", "minutes"]);
        t["lock"] = json!("input");
        t["timeout"] = json!(660);
        all.push(t);
        all.push(tool("mac_apple", "Direct read-through / write-through access to Apple Reminders & Apple Calendar (Single Source of Truth via EventKit — never mirror in Hive). \
            Actions: list_reminders (optional list, include_completed, limit), create_reminder (title, optional list, due ISO-8601, notes, priority), \
            complete_reminder (external_id or exact title, optional completed bool), delete_reminder (external_id), \
            list_events (optional start/end ISO-8601, calendar, limit), create_event (title, start, end ISO-8601, optional calendar, location, notes, all_day), delete_event (external_id).",
            json!({
                "action": s("list_reminders | create_reminder | complete_reminder | delete_reminder | list_events | create_event | delete_event"),
                "external_id": s("Stable Apple EventKit external_id returned by list/create"),
                "title": s("Reminder or event title"),
                "list": s("Apple Reminders list name; empty for default/all"),
                "calendar": s("Apple Calendar name; empty for default/all"),
                "due": s("ISO-8601 due date for reminder, e.g. 2026-11-28T17:00:00Z"),
                "start": s("ISO-8601 start timestamp for event/window"),
                "end": s("ISO-8601 end timestamp for event/window"),
                "location": s("Event location"),
                "notes": s("Concise notes"),
                "priority": n("Reminder priority (0=none, 1=high, 5=medium, 9=low)"),
                "completed": { "type": "boolean", "description": "Target completed state for complete_reminder (default true)" },
                "include_completed": { "type": "boolean", "description": "Include completed items in list_reminders" },
                "all_day": { "type": "boolean", "description": "All-day event flag for create_event" },
                "limit": n("Max items to return (default 50)")
            }), &["action"]));
    }
    all.extend([
        tool(&format!("{k}_shell"), &format!("Run a command on the owner's {on} ({}, as the owner) and get its output.", os::SHELL),
            json!({ "command": s("The command"), "timeout": n("Seconds, default 120") }), &["command", "timeout"]),
        tool(&format!("{k}_get_file"), &format!("Copy a file from the {on} into Hive's files on the VM; returns its VM path."), json!({ "path": s("Path on this computer") }), &["path"]),
        tool(&format!("{k}_put_file"), &format!("Copy a file from the VM to the {on}."), json!({ "vm_path": s("Path on the VM"), "path": s("Path on this computer") }), &["vm_path", "path"]),
    ]);
    for t in all.iter_mut().rev().take(2) { t["timeout"] = json!(600); }
    all
}

pub fn run(tool: &str, a: &Value) -> Result<Value, String> {
    let f = |k: &str| a[k].as_f64().unwrap_or(0.0);
    let done = |t: &str| Ok(json!({ "text": t }));
    let op = tool.strip_prefix(os::KIND).and_then(|t| t.strip_prefix('_')).unwrap_or("");
    let op = if op == "input" { a["action"].as_str().unwrap_or("") } else { op };
    match op {
        "screenshot" => os::screenshot(a["app"].as_str().unwrap_or("")),
        "click" => { os::click(f("x"), f("y"), a["button"] == "right", a["count"].as_i64().unwrap_or(1).clamp(1, 3))?; done("Clicked.") }
        "drag" => { os::drag(f("x"), f("y"), f("to_x"), f("to_y"))?; done("Dragged.") }
        "scroll" => { os::scroll(f("x"), f("y"), f("dx") as i64, f("dy") as i64)?; done("Scrolled.") }
        "type" => { os::type_text(a["text"].as_str().unwrap_or(""))?; done("Typed.") }
        "type_password" => {
            if let Some(e) = a["credential_error"].as_str() { return Err(e.into()); }
            let password = a["password"].as_str().ok_or("No saved password was delivered.")?;
            os::type_text(password)?; done("Typed the saved password.")
        }
        "key" => { os::key(a["keys"].as_str().unwrap_or(""))?; done("Pressed.") }
        #[cfg(target_os = "macos")]
        "take_over" => os::take_over(a),
        #[cfg(target_os = "macos")]
        "apple" => crate::apple::run(a),
        #[cfg(target_os = "macos")]
        "hand_back" => { os::give_back(); done("Handed the Mac's pointer and keyboard back to the owner.") }
        #[cfg(target_os = "macos")]
        "authenticate" => { os::authenticate()?; done("Typed the saved Mac password. Inspect the authentication result.") }
        "shell" => shell(os::shell(a["command"].as_str().unwrap_or("")), a["timeout"].as_u64().unwrap_or(120).clamp(1, 1800)),
        "get_file" => {
            let path = a["path"].as_str().unwrap_or("");
            let data = std::fs::read(path).map_err(|e| format!("couldn't read {path}: {e}"))?;
            let name = std::path::Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or("file".into());
            Ok(json!({ "data": b64::encode(&data), "name": name }))
        }
        "put_file" => {
            let path = a["path"].as_str().unwrap_or("");
            let data = b64::decode(a["data"].as_str().unwrap_or("")).ok_or("no file data came with the call")?;
            if let Some(dir) = std::path::Path::new(path).parent() { std::fs::create_dir_all(dir).ok(); }
            std::fs::write(path, &data).map_err(|e| format!("couldn't write {path}: {e}"))?;
            done(&format!("Wrote {} bytes to {path}.", data.len()))
        }
        _ => Err(format!("this {} has no tool {tool}", os::NAME)),
    }
}

pub fn pause(ms: u64) { std::thread::sleep(Duration::from_millis(ms)); }

fn shell(mut cmd: std::process::Command, secs: u64) -> Result<Value, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let o = std::thread::spawn(move || { let mut b = Vec::new(); out.read_to_end(&mut b).ok(); b });
    let e = std::thread::spawn(move || { let mut b = Vec::new(); err.read_to_end(&mut b).ok(); b });
    let end = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? { break Some(st); }
        if Instant::now() > end { child.kill().ok(); child.wait().ok(); break None; }
        pause(100);
    };
    let text = format!("{}{}", String::from_utf8_lossy(&o.join().unwrap_or_default()), String::from_utf8_lossy(&e.join().unwrap_or_default()));
    let tail: String = if text.chars().count() > 20000 { text.chars().skip(text.chars().count() - 20000).collect() } else { text };
    Ok(json!({ "text": match status {
        Some(st) => format!("exit {}\n{tail}", st.code().unwrap_or(-1)),
        None => format!("timed out after {secs}s\n{tail}"),
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_and_files() {
        let r = run(&format!("{}_shell", os::KIND), &json!({ "command": "echo hive", "timeout": 30 })).unwrap();
        assert!(r["text"].as_str().unwrap().starts_with("exit 0") && r["text"].as_str().unwrap().contains("hive"), "{r}");
        let path = std::env::temp_dir().join(format!("hive-test-{}.txt", std::process::id()));
        let p = path.to_string_lossy();
        run(&format!("{}_put_file", os::KIND), &json!({ "path": p, "data": b64::encode(b"hello") })).unwrap();
        let got = run(&format!("{}_get_file", os::KIND), &json!({ "path": p })).unwrap();
        assert_eq!(b64::decode(got["data"].as_str().unwrap()).unwrap(), b"hello");
        std::fs::remove_file(&path).ok();
        assert_eq!(tools().len(), 5 + (cfg!(target_os = "macos") as usize) * 2);
    }
}
