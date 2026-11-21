//! hive-server: Hive on the VM. `hive-server` runs it; `hive-server code` prints a pairing code;
//! `hive-server cred` manages the VM's saved logins (the `hive-cred` command).
use std::path::PathBuf;

fn env(k: &str, d: &str) -> String { std::env::var(k).unwrap_or_else(|_| d.to_string()) }

fn main() {
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("cred") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        if let Err(e) = hive_server::cred::main(&args) { eprintln!("hive-cred: {e}"); std::process::exit(1); }
        return;
    }
    let state = PathBuf::from(env("HIVE_STATE", "/var/lib/hive"));
    if arg.as_deref() == Some("code") { return println!("{}", hive_server::code(&state)); }

    // Hive's own Codex home: the owner's Codex login, none of their other Codex settings.
    let codex_home = state.join("codex");
    std::fs::create_dir_all(&codex_home).ok();
    let login_from = PathBuf::from(env("HIVE_CODEX_LOGIN", "/root/.codex-hive"));
    #[cfg(unix)]
    if !codex_home.join("auth.json").exists() { std::os::unix::fs::symlink(login_from.join("auth.json"), codex_home.join("auth.json")).ok(); }
    // No login shells: the VM's login profile belongs to other work and moves every shell out of the agent's folder.
    if !codex_home.join("config.toml").exists() { std::fs::write(codex_home.join("config.toml"), "allow_login_shell = false\n").ok(); }
    if !codex_home.join("models_cache.json").exists() { std::fs::copy(login_from.join("models_cache.json"), codex_home.join("models_cache.json")).ok(); }

    hive_server::run(hive_server::Config {
        state, codex: env("HIVE_CODEX", "/root/.local/bin/codex"), codex_home, addr: env("HIVE_ADDR", "127.0.0.1:8790"),
        repo: Some(PathBuf::from(env("HIVE_REPO", "/opt/hive"))), relay: None,
    });
}
