//! Hive's one brain, its own download (`hive-server`, main.rs), apart from the desktop app and browser extension, which are
//! only devices. Every computer runs it the same way, a laptop at home or a VM: `setup` gets Codex and the owner's ChatGPT
//! sign-in the first time, then `start` serves the dashboard and API on this computer and on its public address over HTTPS
//! (tls.rs), which works anywhere.
mod api;
mod claude;
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
pub use tls::{address, why};

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
    say("Downloading Codex, the OpenAI program Hive's agents run on…");
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
    let engine = match std::fs::read_to_string(c.state.join("engine")).unwrap_or_default().trim() {
        "claude" => hive::Engine::Claude { cmd: claude(&c.state)?.to_string_lossy().into(),
            env: vec![("CLAUDE_CONFIG_DIR".into(), c.state.join("claude").to_string_lossy().into_owned())] },
        _ => hive::Engine::Codex { cmd: setup(&c.state, say)?.to_string_lossy().into(),
            env: vec![("CODEX_HOME".into(), c.state.join("codex").to_string_lossy().into_owned())] },
    };
    if c.repo.is_none() { std::thread::spawn(update); }
    say("Starting your Hive…");
    let db = db::Db::open(&c.state.join("hive.db").to_string_lossy());
    let key = owner_key(&c.state);
    let hive = hive::Hive::new(db, c.state.clone(), c.repo, engine, key, hive_protocol::VERSION.into(),
        format!("http://{}", c.addr));
    let h = hive.clone();
    let handler: Arc<dyn Fn(http::Req) -> http::Res + Send + Sync> = Arc::new(move |req| api::handle(&h, req));
    tls::start(c.state.clone(), handler.clone());
    let addr = c.addr;
    std::thread::spawn(move || http::serve(&addr, handler).expect("listen"));
    if c.state.join("phone-token").exists() { hive.start_phone(); }
    Ok(std::thread::spawn(move || hive.run()))
}

/// Claude Code, which setup puts in Hive's bin and signs in under its own config (`<state>/claude`).
fn claude(state: &Path) -> Result<PathBuf, String> {
    let exe = state.join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
    if exe.exists() { Ok(exe) } else { Err(format!("This Hive runs on Claude Code, but {} isn't there. Run hive-server again to set it up.", exe.display())) }
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

/// Copies a download to its file, showing how far it has got when a person is watching in a terminal.
fn copy_showing(from: &mut dyn std::io::Read, to: &mut std::fs::File, size: Option<u64>) -> std::io::Result<()> {
    use std::io::{IsTerminal, Write};
    let watched = std::io::stderr().is_terminal();
    let (mut buf, mut done, mut shown) = (vec![0u8; 1 << 16], 0u64, u64::MAX);
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 { break }
        to.write_all(&buf[..n])?;
        done += n as u64;
        let mb = done >> 20;
        if watched && mb != shown {
            shown = mb;
            match size { Some(t) => eprint!("\r  {mb} of {} MB", t >> 20), None => eprint!("\r  {mb} MB") }
        }
    }
    if watched { eprintln!() }
    Ok(())
}

/// A program Hive runs, from its maker's latest release on GitHub, fetched once.
fn fetch(bin: &Path, name: &str, url: &str) -> Result<PathBuf, String> {
    let exe = bin.join(if cfg!(windows) { format!("{name}.exe") } else { name.into() });
    if exe.exists() { return Ok(exe); }
    let failed = |e: String| format!("Couldn't download {name} ({e}). Check the internet connection and try again.");
    let part = bin.join(format!("{name}.part"));
    // A download that stops moving for a minute starts over, up to three times, instead of waiting forever.
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(30)).timeout_read(std::time::Duration::from_secs(60)).build();
    let mut last = String::new();
    for attempt in 1..=3 {
        if attempt > 1 && std::io::IsTerminal::is_terminal(&std::io::stderr()) { eprintln!("  The download stalled ({last}). Trying again…") }
        let got = agent.get(url).call().map_err(|e| e.to_string()).and_then(|r| {
            let size = r.header("content-length").and_then(|n| n.parse::<u64>().ok());
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            copy_showing(&mut r.into_reader(), &mut file, size).map_err(|e| e.to_string())
        });
        match got { Ok(()) => { last.clear(); break } Err(e) => last = e }
    }
    if !last.is_empty() { std::fs::remove_file(&part).ok(); return Err(failed(last)); }
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
