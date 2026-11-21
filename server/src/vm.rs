//! The VM's own things: its screen, saved logins, and rebuilding Hive from its git checkout.
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn x_env() -> Vec<(String, String)> {
    let ps = Command::new("ps").args(["-o", "args=", "-C", "Xvfb"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let auth = ps.lines().find(|l| l.contains(" :99")).and_then(|l| l.split_whitespace().skip_while(|w| *w != "-auth").nth(1)).unwrap_or("").to_string();
    vec![("DISPLAY".into(), ":99".into()), ("XAUTHORITY".into(), auth)]
}

pub fn screen() -> Option<Vec<u8>> {
    let out = Command::new("vm-shot").output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn type_password(site: &str, username: &str) -> Result<String, String> {
    let mut cmd = Command::new("hive-cred");
    cmd.arg("secret").arg(site);
    if !username.is_empty() { cmd.arg(username); }
    let out = cmd.stderr(Stdio::piped()).output().map_err(|e| format!("couldn't run hive-cred: {e}"))?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("No saved login for {site}: {}", String::from_utf8_lossy(&out.stderr).trim()))?;
    if let Some(choices) = v["choices"].as_array() {
        let names: Vec<String> = choices.iter().map(|c| c["username"].as_str().unwrap_or("?").to_string()).collect();
        return Err(format!("{site} has several logins; give username, one of: {}", names.join(", ")));
    }
    let password = v["login"]["password"].as_str().ok_or(format!("No saved password for {site}"))?;
    let mut child = Command::new("xdotool").args(["type", "--delay", "40", "--file", "-"]).envs(x_env())
        .stdin(Stdio::piped()).spawn().map_err(|e| format!("couldn't run xdotool: {e}"))?;
    child.stdin.take().unwrap().write_all(password.as_bytes()).ok();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok { return Err("xdotool couldn't type on the VM's screen".into()); }
    Ok(format!("Typed the password for {} ({}) into the focused field.", v["login"]["site"].as_str().unwrap_or(site), v["login"]["username"].as_str().unwrap_or("")))
}

fn sh(cmd: &str, dir: &Path) -> (bool, String) {
    match Command::new("bash").args(["-c", cmd]).current_dir(dir).output() {
        Ok(o) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (false, e.to_string()),
    }
}

/// Take in the changes the Mac pushed over SSH to the branch `incoming` (keeping this checkout's own commits on top), build,
/// and restart Hive's server and the VM's devices; the restart comes after this answer is sent. (Not from GitHub until the
/// org move: fetches there count as clones.)
pub fn reinstall(repo: &Path) -> Result<Value, String> {
    let (ok, out) = sh("(! git rev-parse -q --verify incoming >/dev/null || git rebase --autostash -q incoming || git rebase --abort); CARGO_TARGET_DIR=target cargo build --release -p hive-server -p hive-phone 2>&1 | tail -30", repo);
    let tail: String = out.chars().rev().take(4000).collect::<String>().chars().rev().collect();
    if !ok || tail.contains("error[") || tail.contains("error:") { return Err(format!("The build failed:\n{tail}")); }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        Command::new("systemctl").args(["--no-block", "restart", "hive-server", "hive-phone"]).status().ok();
    });
    Ok(json!("Built. Hive's server restarts in a moment; your turn continues after it's back."))
}
