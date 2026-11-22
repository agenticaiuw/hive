//! hive-server: Hive on a computer with no screen, started the same way the Hive app starts it (lib.rs).
//! `hive-server code` prints a pairing code; `hive-server cred` manages this computer's saved logins (`hive-cred`).
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
    let repo = std::env::var("HIVE_REPO").ok().map(PathBuf::from);
    match hive_server::start(hive_server::Config { state: state.clone(), addr: env("HIVE_ADDR", "127.0.0.1:8790"), repo }, &|t| eprintln!("{t}")) {
        Ok(hive) => {
            std::thread::sleep(std::time::Duration::from_secs(5));
            eprintln!("Hive is at {}", hive_server::address(&state).unwrap_or_default());
            hive.join().ok();
        }
        Err(e) => eprintln!("{e}"),
    }
    std::process::exit(1);
}
