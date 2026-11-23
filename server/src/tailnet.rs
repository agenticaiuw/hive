//! How a Hive on a laptop at home is reached: through its owner's own Tailscale network, built into Hive (tailnet/,
//! `hive-tailnet`), not the public internet, which a home router or provider keeps out. Only the owner's devices can reach it,
//! end-to-end encrypted, at https://hive.<tailnet>.ts.net with Tailscale's certificate. A cloud VM keeps its public address
//! (tls.rs). Setup chooses (`<state>/reach` says "tailnet"); the helper's latest word is kept in `<state>/tailnet.json`.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Whether this Hive is reached through Tailscale.
pub fn on(state: &Path) -> bool { std::fs::read_to_string(state.join("reach")).is_ok_and(|r| r.trim() == "tailnet") }

/// Every big cloud answers on this address inside its VMs; a home network doesn't.
pub fn cloud() -> bool { std::net::TcpStream::connect_timeout(&"169.254.169.254:80".parse().unwrap(), Duration::from_secs(1)).is_ok() }

/// The helper's latest word: {"login": url}, {"https": "off", "admin": url}, {"address": url} or {"error": text}.
pub fn status(state: &Path) -> Value {
    std::fs::read(state.join("tailnet.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}))
}

pub fn address(state: &Path) -> Option<String> { status(state)["address"].as_str().map(String::from) }

pub fn why(state: &Path) -> Option<String> { status(state)["error"].as_str().map(|e| format!("Tailscale couldn't start: {e}")) }

/// Hive's build of the helper for this computer, from Hive's release, fetched once.
pub fn get(state: &Path, progress: &dyn Fn(u64, Option<u64>)) -> Result<PathBuf, String> {
    let name = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "hive-tailnet-macos-arm64".to_string(),
        ("macos", _) => "hive-tailnet-macos-x86_64".to_string(),
        ("windows", _) => "hive-tailnet-windows.exe".to_string(),
        (_, arch) => format!("hive-tailnet-linux-{arch}"),
    };
    crate::setup::fetch(&state.join("bin"), "hive-tailnet", &format!("{}/{name}", hive_protocol::RELEASES), None, progress)
}

/// Keeps the helper serving this Hive (listening on `addr` on this computer) on the tailnet, starting it again if it stops.
pub fn start(state: PathBuf, addr: String) {
    std::thread::spawn(move || loop {
        let exe = crate::setup::exe(&state.join("bin"), "hive-tailnet");
        // The helper follows Hive: a new Hive fetches the helper built with it.
        let stamp = state.join("bin").join("hive-tailnet.version");
        if std::fs::read_to_string(&stamp).unwrap_or_default() != hive_protocol::VERSION {
            std::fs::remove_file(&exe).ok();
            if get(&state, &|_, _| {}).is_ok() { std::fs::write(&stamp, hive_protocol::VERSION).ok(); }
        }
        if !exe.exists() { if let Err(e) = get(&state, &|_, _| {}) { note(&state, &json!({ "error": e })); } }
        let mut c = Command::new(&exe);
        c.args(["serve", "--name", "hive", "--to", &addr]).arg("--state").arg(state.join("tailscale"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
        match c.spawn() {
            Ok(mut child) => {
                // Its stdin stays open while Hive runs; when Hive stops, the helper does too.
                let _keep = child.stdin.take();
                for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if let Some(a) = v["address"].as_str() { std::fs::write(state.join("host"), a.trim_start_matches("https://")).ok(); }
                        note(&state, &v);
                    }
                }
                child.wait().ok();
            }
            Err(e) => note(&state, &json!({ "error": e.to_string() })),
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

fn note(state: &Path, v: &Value) { std::fs::write(state.join("tailnet.json"), v.to_string()).ok(); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_the_helpers_word() {
        let d = std::env::temp_dir().join(format!("hive-tailnet-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(!on(&d) && address(&d).is_none());
        std::fs::write(d.join("reach"), "tailnet\n").unwrap();
        note(&d, &json!({ "address": "https://hive.tail1234.ts.net" }));
        assert!(on(&d));
        assert_eq!(address(&d).as_deref(), Some("https://hive.tail1234.ts.net"));
        note(&d, &json!({ "error": "no network" }));
        assert!(why(&d).unwrap().contains("no network"));
        std::fs::remove_dir_all(&d).ok();
    }
}
