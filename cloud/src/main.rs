//! hive-server: Hive's one brain, on the VM. `hive-server` runs it; `hive-server code` prints a pairing code.
mod api;
mod codex;
mod db;
mod hive;
mod http;
mod tools;
mod vm;

use std::path::PathBuf;
use std::sync::Arc;

fn env(k: &str, d: &str) -> String { std::env::var(k).unwrap_or_else(|_| d.to_string()) }

fn main() {
    let state = PathBuf::from(env("HIVE_STATE", "/var/lib/hive"));
    std::fs::create_dir_all(&state).expect("state folder");
    let db = db::Db::open(&state.join("hive.db").to_string_lossy());
    if std::env::args().nth(1).as_deref() == Some("code") {
        println!("{}", api::new_code(&db));
        return;
    }
    let key_file = state.join("owner-key");
    let owner_key = std::fs::read_to_string(&key_file).map(|k| k.trim().to_string()).unwrap_or_else(|_| {
        let k = api::random(24);
        std::fs::write(&key_file, &k).ok();
        k
    });
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).ok(); }
    let repo = PathBuf::from(env("HIVE_REPO", "/opt/hive"));
    let version = std::process::Command::new("git").arg("-C").arg(&repo).args(["rev-parse", "--short", "HEAD"]).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|| "dev".into());

    // Hive's own Codex home: the owner's Codex login, none of their other Codex settings.
    let codex_home = state.join("codex");
    std::fs::create_dir_all(&codex_home).ok();
    let login_from = PathBuf::from(env("HIVE_CODEX_LOGIN", "/root/.codex-hive"));
    #[cfg(unix)]
    if !codex_home.join("auth.json").exists() { std::os::unix::fs::symlink(login_from.join("auth.json"), codex_home.join("auth.json")).ok(); }
    if !codex_home.join("models_cache.json").exists() { std::fs::copy(login_from.join("models_cache.json"), codex_home.join("models_cache.json")).ok(); }
    let codex_env = vec![("CODEX_HOME".to_string(), codex_home.to_string_lossy().into_owned())];

    let hive = hive::Hive::new(db, state, repo, env("HIVE_CODEX", "/root/.local/bin/codex"), codex_env, owner_key, version);
    let h = hive.clone();
    let addr = env("HIVE_ADDR", "127.0.0.1:8790");
    std::thread::spawn(move || {
        eprintln!("Hive listening on {addr}");
        http::serve(&addr, Arc::new(move |req| api::handle(&h, req))).expect("listen");
    });
    hive.run();
}
