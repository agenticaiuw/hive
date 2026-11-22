//! Hive's one brain, its own download (`hive-server`, main.rs), apart from the desktop app and browser extension, which are
//! only devices. Every computer runs it the same way, a laptop at home or a VM: `setup` gets Codex and the owner's ChatGPT
//! sign-in the first time, then `start` serves the dashboard and API on this computer and on its public address over HTTPS
//! (tls.rs), which works anywhere.
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
pub(crate) fn private(file: &Path, text: impl AsRef<[u8]>) {
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

/// Gets Codex, and the first time signs it in to the owner's ChatGPT account with a link and a code, which works on a
/// computer with no screen too. Returns Codex.
pub fn setup(state: &Path, say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let (bin, codex_home) = (state.join("bin"), state.join("codex"));
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&codex_home).map_err(|e| e.to_string())?;
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    let target = match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin.tar.gz"),
        "windows" => format!("{arch}-pc-windows-msvc.exe"),
        _ => format!("{arch}-unknown-linux-musl.tar.gz"),
    };
    say("Getting Codex, the AI behind Hive's agents…");
    // Codex runs agents' tool calls through its code-mode host, which sits beside it: both come from one release.
    let latest = |name: &str| fetch(&bin, name, &format!("https://github.com/openai/codex/releases/latest/download/{name}-{target}"));
    if !bin.join(if cfg!(windows) { "codex-code-mode-host.exe" } else { "codex-code-mode-host" }).exists() {
        std::fs::remove_file(bin.join(if cfg!(windows) { "codex.exe" } else { "codex" })).ok();
    }
    let codex = latest("codex")?;
    latest("codex-code-mode-host")?;
    if !codex_home.join("auth.json").exists() {
        say("Sign in to ChatGPT (Hive's agents work with your ChatGPT account): open the link below on any device and enter the code.");
        Command::new(&codex).args(["login", "--device-auth"]).env("CODEX_HOME", &codex_home).status().ok();
        if !codex_home.join("auth.json").exists() { return Err("ChatGPT sign-in didn't finish. Run hive-server again.".into()); }
    }
    Ok(codex)
}

/// Runs Hive on its own thread (which ends only if Hive stops). Starting Hive agrees to Let's Encrypt's terms for its
/// certificate. Without a checkout it keeps itself at GitHub's latest build, and its devices follow it.
pub fn start(c: Config, say: &dyn Fn(&str)) -> Result<std::thread::JoinHandle<()>, String> {
    let codex = setup(&c.state, say)?;
    let codex_home = c.state.join("codex");
    if c.repo.is_none() { std::thread::spawn(update); }
    say("Starting your Hive…");
    let db = db::Db::open(&c.state.join("hive.db").to_string_lossy());
    let codex_env = vec![("CODEX_HOME".to_string(), codex_home.to_string_lossy().into_owned())];
    let key = owner_key(&c.state);
    let hive = hive::Hive::new(db, c.state.clone(), c.repo, codex.to_string_lossy().into(), codex_env, key, hive_protocol::VERSION.into(),
        format!("http://{}", c.addr));
    let h = hive.clone();
    let handler: Arc<dyn Fn(http::Req) -> http::Res + Send + Sync> = Arc::new(move |req| api::handle(&h, req));
    tls::start(c.state.clone(), handler.clone());
    let addr = c.addr;
    std::thread::spawn(move || http::serve(&addr, handler).expect("listen"));
    if c.state.join("phone-token").exists() { hive.start_phone(); }
    Ok(std::thread::spawn(move || hive.run()))
}

/// Every hour: if GitHub's latest build isn't this one, swap it in and restart into it.
fn update() {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        let want = ureq::get(&format!("{}/version", hive_protocol::RELEASES)).call().ok().and_then(|r| r.into_string().ok()).unwrap_or_default();
        let (want, have) = (want.trim(), hive_protocol::VERSION);
        if want.len() >= 7 && !want.starts_with(have) && !have.starts_with(want) {
            if let Err(e) = hive_protocol::download("hive-server", want) { eprintln!("update to {want}: {e}"); }
        }
    }
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
