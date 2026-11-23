//! A Hive on a laptop at home lives on its owner's Tailscale network (server/src/tailnet.rs). This computer reaches it through
//! Hive's own Tailscale helper (tailnet/, `hive-tailnet dial`), which the app runs while it's open: a plain-HTTP door on this
//! computer (127.0.0.1:8791) that goes across the tailnet, HTTPS end to end. The first time, the owner signs in to the same
//! Tailscale account in the browser. Claude Code's hook goes through the app's door too.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const DOOR: &str = "127.0.0.1:8791";

/// Whether a Hive server is on a tailnet.
pub fn on(server: &str) -> bool {
    server.split("://").nth(1).unwrap_or(server).split(['/', ':']).next().is_some_and(|h| h.ends_with(".ts.net"))
}

/// This computer's pairing, with the server swapped for the door when the Hive is on a tailnet.
pub fn load() -> Option<hive_protocol::Conf> {
    let mut c = hive_protocol::load("node")?;
    if on(&c.server) { c.server = format!("http://{DOOR}") }
    Some(c)
}

fn dir() -> PathBuf { hive_protocol::conf_path("node").with_file_name("") }

/// Opens the door to `server` (once per app run) and returns it, after the owner has signed in to Tailscale if they need to.
/// `login` is told Tailscale's sign-in link.
pub fn open(server: &str, label: &str, login: &dyn Fn(&str)) -> Result<String, String> {
    let door = format!("http://{DOOR}");
    if std::net::TcpStream::connect_timeout(&DOOR.parse().unwrap(), Duration::from_millis(300)).is_ok() { return Ok(door) }
    let exe = helper()?;
    let name: String = format!("hive-{label}").to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let mut c = Command::new(&exe);
    c.args(["dial", "--name", &name, "--to", server, "--listen", DOOR]).arg("--state").arg(dir().join("tailscale"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    let mut child = c.spawn().map_err(|e| format!("Couldn't start Tailscale: {e}"))?;
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let out = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        // The helper lives as long as this app: its stdin stays open until the app quits.
        let _keep = child.stdin.take();
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str(&line) { tx.send(v).ok(); }
        }
        child.wait().ok();
    });
    loop {
        let v = rx.recv_timeout(Duration::from_secs(600)).map_err(|_| "Tailscale sign-in didn't finish.".to_string())?;
        if let Some(u) = v["login"].as_str() { login(u) }
        if v["address"].is_string() { return Ok(door) }
        if let Some(e) = v["error"].as_str() { return Err(format!("Tailscale: {e}")) }
    }
}

/// Hive's build of the Tailscale helper for this computer, fetched once into ~/.config/hive/bin.
fn helper() -> Result<PathBuf, String> {
    let bin = dir().join("bin");
    let exe = bin.join(if cfg!(windows) { "hive-tailnet.exe" } else { "hive-tailnet" });
    if exe.exists() { return Ok(exe) }
    let name = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "hive-tailnet-macos-arm64", ("macos", _) => "hive-tailnet-macos-x86_64",
        ("windows", _) => "hive-tailnet-windows.exe", _ => return Err("no Tailscale helper for this computer".into()),
    };
    let r = ureq::get(&format!("{}/{name}", hive_protocol::RELEASES)).timeout(Duration::from_secs(300)).call()
        .map_err(|e| format!("Couldn't download Tailscale: {e}"))?;
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let part = bin.join("hive-tailnet.part");
    std::io::copy(&mut r.into_reader(), &mut std::fs::File::create(&part).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).ok(); }
    std::fs::rename(&part, &exe).map_err(|e| e.to_string())?;
    Ok(exe)
}

#[cfg(test)]
mod tests {
    #[test]
    fn knows_a_tailnet_server() {
        assert!(super::on("https://hive.tail1234.ts.net"));
        assert!(super::on("https://hive.tail1234.ts.net/"));
        assert!(!super::on("https://153.66.203.47"));
        assert!(!super::on("https://ts.net.example.com"));
    }
}
