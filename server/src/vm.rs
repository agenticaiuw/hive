//! The VM's own things: its screen, typing a saved login (cred.rs keeps them), and rebuilding Hive from its git checkout.
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn x_env() -> [(&'static str, &'static str); 2] { [("DISPLAY", ":99"), ("XAUTHORITY", "/home/ubuntu/.Xauthority-99")] }

pub fn screen() -> Option<Vec<u8>> {
    let out = Command::new("vm-shot").output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn type_password(site: &str, username: &str) -> Result<String, String> {
    let login = crate::cred::pick(site, username)?;
    let password = login["password"].as_str().ok_or(format!("No saved password for {site}"))?;
    let mut child = Command::new("xdotool").args(["type", "--delay", "40", "--file", "-"]).envs(x_env())
        .stdin(Stdio::piped()).spawn().map_err(|e| format!("couldn't run xdotool: {e}"))?;
    child.stdin.take().unwrap().write_all(password.as_bytes()).ok();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok { return Err("xdotool couldn't type on the VM's screen".into()); }
    Ok(format!("Typed the password for {} ({}) into the focused field.", login["url"].as_str().unwrap_or(site), login["username"].as_str().unwrap_or("")))
}

fn sh(cmd: &str, dir: &Path) -> (bool, String) {
    match Command::new("bash").args(["-c", cmd]).current_dir(dir).output() {
        Ok(o) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (false, e.to_string()),
    }
}

/// Take in GitHub's main (keeping this checkout's own commits on top), build, push to GitHub, which builds and signs what every
/// device downloads, and restart Hive's server; the restart comes after this answer is sent.
pub fn reinstall(repo: &Path) -> Result<Value, String> {
    let (ok, out) = sh("(git pull -q --rebase --autostash origin main || git rebase --abort); CARGO_TARGET_DIR=target cargo build --release -p hive-server 2>&1 | tail -30", repo);
    let tail: String = out.chars().rev().take(4000).collect::<String>().chars().rev().collect();
    if !ok || tail.contains("error[") || tail.contains("error:") { return Err(format!("The build failed:\n{tail}")); }
    let (pushed, why) = sh("git push -q origin HEAD:main 2>&1", repo);
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        Command::new("systemctl").args(["--no-block", "restart", "hive-server"]).status().ok();
    });
    let pushed = if pushed { "pushed to GitHub, whose build the devices update to".to_string() } else { format!("not pushed to GitHub: {why}") };
    Ok(json!(format!("Built and {pushed}. Hive's server restarts in a moment; your turn continues after it's back.")))
}
