//! The VM's saved logins: one JSON list encrypted with systemd-creds under the VM's machine key, in a folder only root can
//! open. Nothing here prints a password. The `hive-cred` command (sudo hive-server cred) manages them:
//!   hive-cred list | add <site> [username] (asks for the password) | remove <site> [username]
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

const DIR: &str = "/var/lib/hive-credentials";
const NAME: &str = "hive-logins";
fn store() -> String { format!("{DIR}/store.cred") }
fn s(v: &Value) -> &str { v.as_str().unwrap_or("").trim() }

/// "https://login.wisc.edu/idp/..." or "login.wisc.edu" → "login.wisc.edu".
fn host(url: &str) -> String {
    let t = url.trim().to_lowercase();
    let rest = t.split_once("://").map(|(_, r)| r).unwrap_or(&t);
    let h = rest.split(['/', '?', '#']).next().unwrap_or("");
    let h = h.rsplit('@').next().unwrap_or(h).split(':').next().unwrap_or("");
    h.strip_prefix("www.").unwrap_or(h).to_string()
}

fn load() -> Result<Vec<Value>, String> {
    if !std::path::Path::new(&store()).exists() { return Ok(vec![]); }
    let out = Command::new("systemd-creds").args(["decrypt", &format!("--name={NAME}"), &store(), "-"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(format!("couldn't open the saved logins (root only): {}", String::from_utf8_lossy(&out.stderr).trim())); }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

fn save(logins: &[Value]) -> Result<(), String> {
    std::fs::create_dir_all(DIR).and_then(|_| private(DIR, 0o700)).map_err(|e| e.to_string())?;
    let part = format!("{}.part", store());
    let mut c = Command::new("systemd-creds").args(["encrypt", &format!("--name={NAME}"), "-", &part]).stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    c.stdin.take().unwrap().write_all(serde_json::to_string(logins).unwrap().as_bytes()).map_err(|e| e.to_string())?;
    if !c.wait().map(|st| st.success()).unwrap_or(false) { return Err("systemd-creds couldn't encrypt the logins".into()); }
    std::fs::rename(&part, store()).map_err(|e| e.to_string())?;
    private(&store(), 0o600).map_err(|e| e.to_string())
}

/// The one login to use for a site: the same host first, then a parent or child domain (wisc.edu ↔ login.wisc.edu).
pub fn pick(site: &str, username: &str) -> Result<Value, String> {
    let (logins, h) = (load()?, host(site));
    let found: Vec<&Value> = logins.iter().filter(|l| {
        let lh = host(s(&l["url"]));
        (lh == h || lh.ends_with(&format!(".{h}")) || h.ends_with(&format!(".{lh}"))) && (username.is_empty() || s(&l["username"]) == username)
    }).collect();
    let exact: Vec<&&Value> = found.iter().filter(|l| host(s(&l["url"])) == h).collect();
    match (exact.len(), found.len()) {
        (1, _) => Ok((*exact[0]).clone()),
        (0, 1) => Ok(found[0].clone()),
        (0, 0) => Err(format!("No saved login for {site}")),
        _ => Err(format!("{site} has several logins; give username, one of: {}",
            found.iter().map(|l| s(&l["username"])).collect::<Vec<_>>().join(", "))),
    }
}

pub fn main(args: &[String]) -> Result<(), String> {
    let arg = |i: usize| args.get(i).map(|a| a.trim()).unwrap_or("");
    let same = |l: &Value| host(s(&l["url"])) == host(arg(1)) && (arg(2).is_empty() || s(&l["username"]) == arg(2));
    match arg(0) {
        "list" => {
            let mut logins: Vec<(String, String)> = load()?.iter().map(|l| (host(s(&l["url"])), s(&l["username"]).to_string())).collect();
            logins.sort();
            for (h, u) in &logins { println!("{h}\t{u}"); }
            eprintln!("{} logins", logins.len());
        }
        "add" if !arg(1).is_empty() => {
            eprint!("Password for {} at {}: ", if arg(2).is_empty() { "(no username)" } else { arg(2) }, host(arg(1)));
            let echo = |on: &str| { Command::new("stty").arg(on).stdin(Stdio::inherit()).stderr(Stdio::null()).status().ok(); };
            echo("-echo");
            let mut password = String::new();
            std::io::stdin().lock().read_line(&mut password).ok();
            echo("echo");
            eprintln!();
            let password = password.trim_end_matches(['\r', '\n']);
            if password.is_empty() { return Err("no password given".into()); }
            let mut logins: Vec<Value> = load()?.into_iter().filter(|l| !(host(s(&l["url"])) == host(arg(1)) && s(&l["username"]) == arg(2))).collect();
            logins.push(json!({ "title": host(arg(1)), "url": arg(1), "username": arg(2), "password": password }));
            save(&logins)?;
            println!("Saved the login for {}.", host(arg(1)));
        }
        "remove" if !arg(1).is_empty() => {
            let logins = load()?;
            let kept: Vec<Value> = logins.iter().filter(|l| !same(l)).cloned().collect();
            save(&kept)?;
            println!("Removed {} login(s).", logins.len() - kept.len());
        }
        _ => return Err("usage: hive-cred list | add <site> [username] | remove <site> [username]".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn hosts() {
        assert_eq!(super::host("https://www.Login.wisc.edu:443/idp/x?y"), "login.wisc.edu");
        assert_eq!(super::host("wisc.edu"), "wisc.edu");
        assert_eq!(super::host(" user@x.com/a "), "x.com");
    }
}

#[cfg(unix)]
fn private(path: &str, mode: u32) -> std::io::Result<()> { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) }
#[cfg(not(unix))]
fn private(_: &str, _: u32) -> std::io::Result<()> { Ok(()) }
