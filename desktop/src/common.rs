//! The tools every computer has, and what they do the same way everywhere (the shell's time limit, files to and from the VM).
//! The screen, mouse and keyboard are the operating system's: mac.rs and windows.rs. x/y everywhere are pixels in the latest
//! screenshot.
use crate::os;
use hive_protocol::{b64, n, s, tool};
use serde_json::{json, Value};
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

pub fn tools() -> Vec<Value> {
    let (k, on) = (os::KIND, os::NAME);
    let xy = || json!({ "x": n("x in the latest screenshot"), "y": n("y in the latest screenshot") });
    let mut input = vec![
        tool(&format!("{k}_click"), &format!("Click on the {on} at (x, y). count 2 = double click; button left|right."),
            { let mut p = xy(); p["button"] = s("left or right"); p["count"] = n("1 or 2"); p }, &["x", "y", "button", "count"]),
        tool(&format!("{k}_drag"), &format!("Drag on the {on} from (x, y) to (to_x, to_y)."),
            { let mut p = xy(); p["to_x"] = n("end x"); p["to_y"] = n("end y"); p }, &["x", "y", "to_x", "to_y"]),
        tool(&format!("{k}_scroll"), &format!("Scroll on the {on} at (x, y): dy > 0 scrolls down, dx > 0 right (in wheel notches)."),
            { let mut p = xy(); p["dy"] = n("notches down"); p["dx"] = n("notches right"); p }, &["x", "y", "dy", "dx"]),
        tool(&format!("{k}_type"), &format!("Type text on the {on} into whatever has focus."), json!({ "text": s("Text to type") }), &["text"]),
        tool(&format!("{k}_type_password"), &format!("Type a Hive saved password into the focused field on the {on} without revealing it."),
            json!({ "site": s("The login site"), "username": s("Which login; empty for the only one") }), &["site", "username"]),
        tool(&format!("{k}_key"), &format!("Press keys on the {on}, e.g. {}.", os::KEYS), json!({ "keys": s("Keys joined with +") }), &["keys"]),
    ];
    for t in &mut input { t["lock"] = json!("input"); }
    let shot = if cfg!(target_os = "macos") {
        tool("mac_screenshot", "See the owner's Mac: the whole screen, or with app (e.g. \"Safari\") only that app's front window, even under \
            other windows. The other mac tools then act in what it showed, x/y being its pixels: in an app's window they go to that app alone, \
            in the background, and the owner keeps their pointer and keyboard (clicks, scrolling, typing and keys like return work there; \
            shortcuts through the app's menus, like cmd+s, don't); on the whole screen they use the Mac's own pointer and keyboard, \
            which reach everything (Dock, menu bar, cmd+space, system dialogs), once the owner has handed them over with mac_take_over.",
            json!({ "app": s("An app's name for only its window, or \"\" for the whole screen") }), &["app"])
    } else {
        tool(&format!("{k}_screenshot"), &format!("See the owner's {on} screen. x/y in the other {k} tools are pixels in this image."), json!({}), &[])
    };
    let mut all = vec![shot];
    if cfg!(target_os = "macos") {
        let mut t = tool("mac_take_over", "When working in one app's window can't do it (a menu shortcut, a system dialog, a page that won't \
            respond): ask the owner, in a floating window on their Mac, to hand over its own pointer and keyboard, saying why and about how \
            long. Waits for their answer; once they hand it over, it returns a screenshot of the whole screen, and its input works for that long \
            (or until the owner takes it back). Ask when your next steps are ready, and act at once: the owner is watching your log.",
            json!({ "why": s("What you're doing and why you need the whole Mac, in a sentence or two for the owner"), "minutes": n("About how many minutes you need") }),
            &["why", "minutes"]);
        t["timeout"] = json!(660);
        all.push(t);
    }
    all.append(&mut input);
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
    match tool.strip_prefix(os::KIND).and_then(|t| t.strip_prefix('_')).unwrap_or("") {
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
        assert_eq!(tools().len(), 10 + cfg!(target_os = "macos") as usize);
    }
}
