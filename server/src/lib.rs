//! Hive's one brain. The VM runs it as `hive-server` (main.rs); on a home computer the Hive app runs it (desktop/src/home.rs).
mod api;
mod codex;
pub mod cred;
mod db;
mod hive;
mod http;
mod relay;
mod tls;
mod tools;
mod vm;

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use api::random;

pub struct Config {
    /// Hive's database, files and owner key.
    pub state: PathBuf,
    /// The codex program, and the Codex home it's signed in with.
    pub codex: String,
    pub codex_home: PathBuf,
    /// Where the dashboard and API listen.
    pub addr: String,
    /// On the VM, Hive's checkout, which Hive changes itself from; None on a home computer.
    pub repo: Option<PathBuf>,
    /// A home computer's address at the relay (relay/) and its key there.
    pub relay: Option<(String, String)>,
}

/// The dashboard's password, which also pairs Hive's own devices.
pub fn owner_key(state: &Path) -> String {
    let file = state.join("owner-key");
    if let Ok(k) = std::fs::read_to_string(&file) { return k.trim().to_string(); }
    std::fs::create_dir_all(state).ok();
    let k = api::random(24);
    std::fs::write(&file, &k).ok();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).ok(); }
    k
}

/// A pairing code, good for 10 minutes.
pub fn code(state: &Path) -> String { api::new_code(&db::Db::open(&state.join("hive.db").to_string_lossy())) }

/// Runs Hive; returns only if it couldn't start.
pub fn run(c: Config) {
    std::fs::create_dir_all(&c.state).expect("state folder");
    std::fs::create_dir_all(&c.codex_home).ok();
    let db = db::Db::open(&c.state.join("hive.db").to_string_lossy());
    let codex_env = vec![("CODEX_HOME".to_string(), c.codex_home.to_string_lossy().into_owned())];
    let key = owner_key(&c.state);
    let hive = hive::Hive::new(db, c.state, c.repo, c.codex, codex_env, key, hive_protocol::VERSION.into());
    let h = hive.clone();
    let handler: Arc<dyn Fn(http::Req) -> http::Res + Send + Sync> = Arc::new(move |req| api::handle(&h, req));
    if let Ok(host) = std::fs::read_to_string(hive.state.join("host")) {
        tls::start(host.trim().to_string(), hive.state.join("tls"), handler.clone());
    }
    if let Some((address, key)) = c.relay { relay::start(address, key, handler.clone()); }
    let addr = c.addr;
    std::thread::spawn(move || {
        eprintln!("Hive listening on {addr}");
        http::serve(&addr, handler).expect("listen");
    });
    hive.run();
}
