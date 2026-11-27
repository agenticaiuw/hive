//! A Hive Server lives on its owner's Tailscale network (server/src/tailnet.rs). This computer reaches it through
//! Hive's own Tailscale helper (tailnet/, `hive-tailnet dial`), which the app runs while it's open: a plain-HTTP door on this
//! computer (127.0.0.1:8791) that goes across the tailnet, encrypted by WireGuard. Signing in to the same Tailscale account
//! as the Hive Server is all it takes: the app finds the server and joins it (server/src/api.rs, /api/pair/tailnet). Claude
//! Code's hook goes through the app's door too.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const DOOR: &str = "127.0.0.1:8791";

/// This computer's place in its Hive, with the server swapped for the door.
pub fn load() -> Option<hive_protocol::Conf> {
    let mut c = hive_protocol::load("node")?;
    c.server = format!("http://{DOOR}");
    Some(c)
}

fn dir() -> PathBuf { hive_protocol::conf_path("node").with_file_name("") }

/// Opens the door to `server` (once per app run), after the owner has signed in to Tailscale if they need to, and returns it
/// with the server's address. `server` "auto" finds the owner's Hive Server on their tailnet. `login` is told Tailscale's
/// sign-in link.
pub fn open(server: &str, label: &str, login: &dyn Fn(&str)) -> Result<(String, String), String> {
    let door = format!("http://{DOOR}");
    if server != "auto" && std::net::TcpStream::connect_timeout(&DOOR.parse().unwrap(), Duration::from_millis(300)).is_ok() {
        return Ok((door, server.into()))
    }
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
    let mut found = server.to_string();
    loop {
        let v = rx.recv_timeout(Duration::from_secs(600)).map_err(|_| "Tailscale sign-in didn't finish.".to_string())?;
        if let Some(u) = v["login"].as_str() { login(u) }
        if let Some(s) = v["server"].as_str() { found = s.into() }
        if v["address"].is_string() { return Ok((door, found)) }
        if let Some(e) = v["error"].as_str() { return Err(format!("Tailscale: {e}")) }
    }
}

/// Hive's build of the Tailscale helper for this computer, fetched once into ~/.config/hive/bin.
fn helper() -> Result<PathBuf, String> {
    let bin = dir().join("bin");
    let exe = bin.join(if cfg!(windows) { "hive-tailnet.exe" } else { "hive-tailnet" });
    // The helper follows the app: a new app fetches the helper built with it.
    let stamp = bin.join("hive-tailnet.version");
    if exe.exists() && std::fs::read_to_string(&stamp).unwrap_or_default() == hive_protocol::DEVICES { return Ok(exe) }
    let name = hive_protocol::tailnet_asset();
    let r = hive_protocol::release(&name).map_err(|e| format!("Couldn't download Tailscale: {e}"))?;
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let part = bin.join("hive-tailnet.part");
    std::io::copy(&mut r.into_reader(), &mut std::fs::File::create(&part).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).ok(); }
    std::fs::rename(&part, &exe).map_err(|e| e.to_string())?;
    std::fs::write(&stamp, hive_protocol::DEVICES).ok();
    Ok(exe)
}
