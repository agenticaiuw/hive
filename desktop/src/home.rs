//! This computer as the owner's Hive, for anyone with a computer that can stay on at home: Hive's server runs inside the
//! app (server/), Codex works with the owner's ChatGPT account, and the relay (relay/) gives it an address that works anywhere.
use hive_protocol::Conf;
use std::path::{Path, PathBuf};
use std::process::Command;

const RELAY: &str = "https://home.agenticaiuw.com";
const LOCAL: &str = "http://127.0.0.1:8790";

fn dir() -> PathBuf { hive_protocol::conf_path("home").with_extension("") }

pub fn is_on() -> bool { dir().join("relay").exists() }

/// Starts this computer's Hive, setting it up the first time, and connects this computer to it. Returns the dashboard's
/// address (signed in) and this computer's connection.
pub fn start(say: &dyn Fn(&str)) -> Result<(String, Conf), String> {
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let codex = codex(&dir, say)?;
    let codex_home = dir.join("codex-home");
    if !codex_home.join("auth.json").exists() {
        say("Sign in to ChatGPT in the browser window that opened: Hive's agents work with your ChatGPT account.");
        std::fs::create_dir_all(&codex_home).ok();
        Command::new(&codex).arg("login").env("CODEX_HOME", &codex_home).output().ok();
        if !codex_home.join("auth.json").exists() { return Err("ChatGPT sign-in didn't finish. Click the button to try again.".into()); }
    }
    let relay = dir.join("relay");
    if !relay.exists() { std::fs::write(&relay, format!("{RELAY}/{} {}", hive_server::random(8), hive_server::random(24))).map_err(|e| e.to_string())?; }
    let line = std::fs::read_to_string(&relay).unwrap_or_default();
    let (address, key) = line.trim().split_once(' ').ok_or("Hive's relay file is broken")?;
    say("Starting your Hive…");
    crate::os::stay_on();
    let state = dir.join("server");
    let config = hive_server::Config { state: state.clone(), codex: codex.to_string_lossy().into(), codex_home,
        addr: LOCAL.trim_start_matches("http://").into(), repo: None, relay: Some((address.into(), key.into())) };
    std::thread::spawn(move || hive_server::run(config));
    let conf = match hive_protocol::load("node") {
        Some(c) if c.server == LOCAL => c,
        _ => (0..40).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            hive_protocol::pair("node", LOCAL, &hive_server::owner_key(&state), crate::os::KIND, &crate::os::host(), "").ok()
        }).ok_or("Hive didn't start. Quit the app and open it again.")?,
    };
    Ok((format!("{address}/#key={}", conf.token), conf))
}

/// Codex, which Hive's agents run on: OpenAI's latest release, fetched once.
fn codex(dir: &Path, say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let exe = dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    if exe.exists() { return Ok(exe); }
    say("Getting Codex, the AI behind Hive's agents…");
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    let name = if cfg!(windows) { format!("codex-{arch}-pc-windows-msvc.exe") } else { format!("codex-{arch}-apple-darwin.tar.gz") };
    let failed = |e: String| format!("Couldn't download Codex ({e}). Check the internet connection and try again.");
    let r = ureq::get(&format!("https://github.com/openai/codex/releases/latest/download/{name}")).call().map_err(|e| failed(e.to_string()))?;
    let part = dir.join("codex.part");
    std::io::copy(&mut r.into_reader(), &mut std::fs::File::create(&part).map_err(|e| failed(e.to_string()))?).map_err(|e| failed(e.to_string()))?;
    if cfg!(windows) { std::fs::rename(&part, &exe).map_err(|e| failed(e.to_string()))?; } else {
        Command::new("tar").arg("-xzf").arg(&part).arg("-C").arg(dir).status().map_err(|e| failed(e.to_string()))?;
        std::fs::rename(dir.join(name.trim_end_matches(".tar.gz")), &exe).map_err(|e| failed(e.to_string()))?;
        std::fs::remove_file(&part).ok();
    }
    Ok(exe)
}
