//! hive-server: Hive's own download. Run it once on a computer that stays on, a VM or an old laptop: it signs in to
//! ChatGPT, makes itself start with the computer (`hive-server run`), and prints the dashboard's address.
//! `hive-server code` prints a pairing code; `hive-server cred` manages this computer's saved logins (`hive-cred`).
use std::path::{Path, PathBuf};
use std::process::Command;

fn env(k: &str, d: &str) -> String { std::env::var(k).unwrap_or_else(|_| d.to_string()) }

/// Linux keeps Hive in /var/lib/hive (it runs as root, for the HTTPS ports); a Mac or PC in the user's ~/.config/hive/server.
fn state() -> PathBuf {
    match std::env::var("HIVE_STATE") {
        Ok(s) => s.into(),
        Err(_) if cfg!(target_os = "linux") => "/var/lib/hive".into(),
        Err(_) => hive_protocol::conf_path("server").with_extension(""),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let state = state();
    let say = |t: &str| eprintln!("{t}");
    match args.first().map(|s| s.as_str()) {
        Some("--version") => return println!("{}", hive_protocol::VERSION),
        Some("code") => return println!("{}", hive_server::code(&state)),
        Some("cred") => if let Err(e) = hive_server::cred::main(&args[1..]) { eprintln!("hive-cred: {e}"); std::process::exit(1) } else { return },
        // Started by a person (a checkout's server, like the owner's VM, is always started by its service).
        None if std::env::var_os("HIVE_REPO").is_none() => {
            let made = std::fs::create_dir_all(&state).map_err(|e| format!("Couldn't make {}: {e}{}", state.display(),
                if cfg!(target_os = "linux") { ". Run it as root: sudo ./hive-server" } else { "" }));
            match made.and_then(|_| hive_server::setup(&state, &say)).and_then(|_| install(&state)) {
                Ok(()) => {
                    say("Hive is running, and starts again whenever this computer does. Getting its secure address…");
                    let address = (0..240).find_map(|_| hive_server::address(&state).or_else(|| { std::thread::sleep(std::time::Duration::from_millis(500)); None }));
                    match address {
                        Some(a) => say(&format!("Your Hive's dashboard (keep this link private, it signs you in):\n{a}/#key={}", hive_server::owner_key(&state))),
                        None => say("The internet can't reach this computer: its router didn't open Hive's ports (UPnP is off), or the internet \
                            provider shares one address among many homes. A computer with its own address, like a VM, works anywhere."),
                    }
                    return;
                }
                Err(e) => { eprintln!("{e}"); std::process::exit(1) }
            }
        }
        _ => {}
    }
    let repo = std::env::var("HIVE_REPO").ok().map(PathBuf::from);
    match hive_server::start(hive_server::Config { state: state.clone(), addr: env("HIVE_ADDR", "127.0.0.1:8790"), repo }, &say) {
        Ok(hive) => {
            std::thread::sleep(std::time::Duration::from_secs(5));
            eprintln!("Hive is at {}", hive_server::address(&state).unwrap_or_default());
            hive.join().ok();
        }
        Err(e) => eprintln!("{e}"),
    }
    std::process::exit(1);
}

/// Copies this program into Hive's folder (where it updates itself) and has the computer run it from there, now and at
/// every start: systemd on Linux, launchd on a Mac (kept awake while it runs), the sign-in Run key on Windows.
fn install(state: &Path) -> Result<(), String> {
    let exe = state.join("bin").join(if cfg!(windows) { "hive-server.exe" } else { "hive-server" });
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if me != exe {
        std::fs::remove_file(&exe).ok();
        std::fs::copy(&me, &exe).map_err(|e| format!("Couldn't copy hive-server into {}: {e}", state.display()))?;
    }
    let ok = |cmd: &str, args: &[&str]| Command::new(cmd).args(args).status().is_ok_and(|s| s.success());
    let (exe, state) = (exe.display(), state.display());
    #[cfg(target_os = "linux")]
    {
        std::fs::write("/etc/systemd/system/hive-server.service", format!("[Unit]\nDescription=Hive's server\nAfter=network-online.target\n\n\
            [Service]\nEnvironment=HIVE_STATE={state} HOME=/root\nExecStart={exe} run\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n"))
            .map_err(|e| format!("Run it as root (sudo ./hive-server): {e}"))?;
        if !(ok("systemctl", &["daemon-reload"]) && ok("systemctl", &["enable", "--now", "hive-server"])) { return Err("systemd couldn't start Hive".into()); }
    }
    #[cfg(target_os = "macos")]
    {
        let plist = PathBuf::from(env("HOME", "")).join("Library/LaunchAgents/app.hive.server.plist");
        std::fs::create_dir_all(plist.parent().unwrap()).ok();
        std::fs::write(&plist, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>app.hive.server</string>\
            <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>{exe}</string><string>run</string></array>\
            <key>EnvironmentVariables</key><dict><key>HIVE_STATE</key><string>{state}</string></dict>\
            <key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n")).map_err(|e| e.to_string())?;
        let plist = plist.to_string_lossy();
        ok("launchctl", &["unload", &plist]);
        if !ok("launchctl", &["load", "-w", &plist]) { return Err("launchd couldn't start Hive".into()); }
    }
    #[cfg(windows)]
    {
        let run = format!("\"{exe}\" run");
        ok("reg", &["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "Hive server", "/t", "REG_SZ", "/d", &run, "/f"]);
        Command::new(exe.to_string()).arg("run").env("HIVE_STATE", state.to_string()).stdin(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
