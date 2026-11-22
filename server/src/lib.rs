//! Hive's one brain. Every computer runs it the same way, a laptop at home or a VM: `start` gets what it needs the first
//! time (Codex and the owner's ChatGPT sign-in), then serves the dashboard and API on this computer and on its public
//! address over HTTPS (tls.rs), which works anywhere. The Hive app starts it from "Make this computer my Hive"
//! (desktop/src/home.rs); a computer with no screen runs `hive-server` (main.rs).
mod api;
mod codex;
pub mod cred;
mod db;
mod hive;
mod http;
mod tls;
mod tools;
mod vm;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

pub use api::random;
pub use tls::address;

pub struct Config {
    /// Everything this computer's Hive keeps: its database, files, owner key, Codex and certificate.
    pub state: PathBuf,
    /// Where the dashboard and API listen on this computer.
    pub addr: String,
    /// Hive's own checkout, which Hive changes itself from, if this computer has one.
    pub repo: Option<PathBuf>,
}

/// A file only this user can read.
fn private(file: &Path, text: impl AsRef<[u8]>) {
    std::fs::write(file, text).ok();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).ok(); }
}

/// The dashboard's password, which also pairs Hive's own devices.
pub fn owner_key(state: &Path) -> String {
    let file = state.join("owner-key");
    if let Ok(k) = std::fs::read_to_string(&file) { return k.trim().to_string(); }
    std::fs::create_dir_all(state).ok();
    let k = api::random(24);
    private(&file, &k);
    k
}

/// A pairing code, good for 10 minutes.
pub fn code(state: &Path) -> String { api::new_code(&db::Db::open(&state.join("hive.db").to_string_lossy())) }

/// Sets Hive up the first time, saying how it's going, then runs it on its own thread (which ends only if Hive stops).
/// Starting Hive agrees to Let's Encrypt's terms for its certificate (the setup page says so).
pub fn start(c: Config, say: &dyn Fn(&str)) -> Result<std::thread::JoinHandle<()>, String> {
    let (bin, codex_home) = (c.state.join("bin"), c.state.join("codex"));
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&codex_home).map_err(|e| e.to_string())?;
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    let target = match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin.tar.gz"),
        "windows" => format!("{arch}-pc-windows-msvc.exe"),
        _ => format!("{arch}-unknown-linux-musl.tar.gz"),
    };
    say("Getting Codex, the AI behind Hive's agents…");
    let codex = fetch(&bin, "codex", &format!("https://github.com/openai/codex/releases/latest/download/codex-{target}"))?;
    if !codex_home.join("auth.json").exists() {
        say("Sign in to ChatGPT in the browser window that opened: Hive's agents work with your ChatGPT account.");
        Command::new(&codex).arg("login").env("CODEX_HOME", &codex_home).output().ok();
        if !codex_home.join("auth.json").exists() { return Err("ChatGPT sign-in didn't finish. Try again.".into()); }
    }
    say("Starting your Hive…");
    let db = db::Db::open(&c.state.join("hive.db").to_string_lossy());
    let codex_env = vec![("CODEX_HOME".to_string(), codex_home.to_string_lossy().into_owned())];
    let key = owner_key(&c.state);
    let hive = hive::Hive::new(db, c.state.clone(), c.repo, codex.to_string_lossy().into(), codex_env, key, hive_protocol::VERSION.into());
    let h = hive.clone();
    let handler: Arc<dyn Fn(http::Req) -> http::Res + Send + Sync> = Arc::new(move |req| api::handle(&h, req));
    tls::start(c.state, handler.clone());
    let addr = c.addr;
    std::thread::spawn(move || http::serve(&addr, handler).expect("listen"));
    Ok(std::thread::spawn(move || hive.run()))
}

/// A program Hive runs, from its maker's latest release on GitHub, fetched once.
fn fetch(bin: &Path, name: &str, url: &str) -> Result<PathBuf, String> {
    let exe = bin.join(if cfg!(windows) { format!("{name}.exe") } else { name.into() });
    if exe.exists() { return Ok(exe); }
    let failed = |e: String| format!("Couldn't download {name} ({e}). Check the internet connection and try again.");
    let r = ureq::get(url).call().map_err(|e| failed(e.to_string()))?;
    let part = bin.join(format!("{name}.part"));
    std::io::copy(&mut r.into_reader(), &mut std::fs::File::create(&part).map_err(|e| failed(e.to_string()))?).map_err(|e| failed(e.to_string()))?;
    if url.ends_with("gz") {
        let unpack = bin.join(format!("{name}.unpack"));
        std::fs::create_dir_all(&unpack).ok();
        Command::new("tar").arg("-xzf").arg(&part).arg("-C").arg(&unpack).status().map_err(|e| failed(e.to_string()))?;
        let inner = std::fs::read_dir(&unpack).ok().and_then(|mut d| d.next()).and_then(|e| e.ok()).ok_or_else(|| failed("empty archive".into()))?;
        std::fs::rename(inner.path(), &exe).map_err(|e| failed(e.to_string()))?;
        std::fs::remove_dir_all(&unpack).ok();
        std::fs::remove_file(&part).ok();
    } else {
        std::fs::rename(&part, &exe).map_err(|e| failed(e.to_string()))?;
    }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).ok(); }
    Ok(exe)
}
