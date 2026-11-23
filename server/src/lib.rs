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
pub mod tailnet;
mod tls;
mod tools;
mod vm;
pub mod setup;

use std::path::{Path, PathBuf};
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

/// Gets Codex, and the first time signs it in to the owner's ChatGPT account with a link and a code (setup.rs does this in a
/// window or terminal the first time; this covers a Hive started without it). Returns Codex.
pub fn setup(state: &Path, _say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let ui = setup::Terminal::new();
    // The owner's own Codex when setup chose it; else Hive's copy, fetched if it's missing.
    let codex = if state.join("engine-bin").exists() { setup::engine_bin(state, "codex") } else { setup::get_codex(state, &ui)? };
    setup::sign_in_codex(state, &ui)?;
    Ok(codex)
}

/// Runs Hive on its own thread (which ends only if Hive stops). Starting Hive agrees to Let's Encrypt's terms for its
/// certificate. Without a checkout it keeps itself at GitHub's latest build, and its devices follow it.
pub fn start(c: Config, say: &dyn Fn(&str)) -> Result<std::thread::JoinHandle<()>, String> {
    let engine = match std::fs::read_to_string(c.state.join("engine")).unwrap_or_default().trim() {
        "claude" => hive::Engine::Claude { cmd: claude(&c.state)?.to_string_lossy().into(), env: setup::engine_env(&c.state, "claude") },
        _ => hive::Engine::Codex { cmd: setup(&c.state, say)?.to_string_lossy().into(), env: setup::engine_env(&c.state, "codex") },
    };
    if c.repo.is_none() { std::thread::spawn(update); }
    say("Starting your Hive…");
    let db = db::Db::open(&c.state.join("hive.db").to_string_lossy());
    let key = owner_key(&c.state);
    let hive = hive::Hive::new(db, c.state.clone(), c.repo, engine, key, hive_protocol::VERSION.into(),
        format!("http://{}", c.addr));
    let h = hive.clone();
    let handler: Arc<dyn Fn(http::Req) -> http::Res + Send + Sync> = Arc::new(move |req| api::handle(&h, req));
    // A Hive at home is reached through its owner's tailnet; anywhere else, on its public address.
    if tailnet::on(&c.state) { tailnet::start(c.state.clone(), c.addr.clone()) } else { tls::start(c.state.clone(), handler.clone()) }
    let addr = c.addr;
    std::thread::spawn(move || http::serve(&addr, handler).expect("listen"));
    if c.state.join("phone-token").exists() { hive.start_phone(); }
    Ok(std::thread::spawn(move || hive.run()))
}

/// Claude Code, which setup puts in Hive's bin and signs in under its own config (`<state>/claude`).
fn claude(state: &Path) -> Result<PathBuf, String> {
    let exe = setup::engine_bin(state, "claude");
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
