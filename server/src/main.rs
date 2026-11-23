//! hive-server: Hive's own download. Run it once on a computer that stays on, a VM or an old laptop: it signs in to
//! ChatGPT, makes itself start with the computer (`hive-server run`), and prints the dashboard's address.
//! `hive-server code` prints a pairing code; `hive-server cred` manages this computer's saved logins (`hive-cred`).
use std::path::{Path, PathBuf};
use std::process::Command;

fn env(k: &str, d: &str) -> String { std::env::var(k).unwrap_or_else(|_| d.to_string()) }

/// Linux keeps Hive in /var/lib/hive (run by its own user, `hive`); a Mac or PC in the user's ~/.config/hive/server.
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
        // Opened as Hive Server.app from Finder: there's no window to talk in, so it reopens itself in Terminal.
        #[cfg(target_os = "macos")]
        None if std::env::var_os("HIVE_REPO").is_none() && in_app() && !std::io::IsTerminal::is_terminal(&std::io::stderr()) => {
            let me = std::env::current_exe().unwrap_or_default();
            if let Err(e) = Command::new("open").args(["-a", "Terminal"]).arg(&me).status() { eprintln!("Couldn't open Terminal: {e}") }
            return;
        }
        // Started by a person (a checkout's server, like the owner's VM, is always started by its service).
        None if std::env::var_os("HIVE_REPO").is_none() => {
            let made = std::fs::create_dir_all(&state).map_err(|e| format!("Couldn't make {}: {e}{}", state.display(),
                if cfg!(target_os = "linux") { ". Run it as root: sudo ./hive-server" } else { "" }));
            std::fs::remove_file(state.join("tls").join("why")).ok();
            match made.and_then(|_| hive_server::setup(&state, &say)).and_then(|_| install(&state)) {
                Ok(()) => {
                    say("Hive is running, and starts again whenever this computer does. Getting its secure address (up to 3 minutes)…");
                    let address = (0..360).find_map(|_| hive_server::address(&state).map(Ok).or_else(|| hive_server::why(&state).map(Err))
                        .or_else(|| { std::thread::sleep(std::time::Duration::from_millis(500)); None }));
                    match address {
                        Some(Ok(a)) => say(&format!("Your Hive's dashboard (keep this link private, it signs you in):\n{a}/#key={}", hive_server::owner_key(&state))),
                        Some(Err(why)) => say(&why),
                        None => say("Let's Encrypt hasn't answered yet. Run this again in a few minutes to see where it stands."),
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

/// Whether this program is the one inside Hive Server.app (what a Mac downloads), not a bare copy.
#[cfg(target_os = "macos")]
fn in_app() -> bool {
    std::env::current_exe().is_ok_and(|p| p.parent().is_some_and(|d| d.ends_with("Contents/MacOS")))
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
    let ok = |cmd: &str, args: &[&str]| Command::new(cmd).args(args).output().is_ok_and(|o| o.status.success());
    #[cfg(target_os = "linux")]
    {
        // Hive runs as its own user, never root: its agents can't change the rest of the computer or read anyone's home
        // folder, only that user can open Hive's folder, and it may use the HTTPS ports and nothing else.
        let dir = state.to_string_lossy();
        if !ok("id", &["-u", "hive"]) && !ok("useradd", &["--system", "--home-dir", &dir, "--shell", "/usr/sbin/nologin", "hive"]) {
            return Err("Couldn't make the hive user. Run it as root: sudo ./hive-server".into());
        }
        if !(ok("chown", &["-R", "hive:hive", &dir]) && ok("chmod", &["700", &dir])) { return Err(format!("Couldn't give {dir} to the hive user")); }
        // This computer's own firewall lets HTTPS in, as UPnP asks the router to: ufw, firewalld, or plain iptables (an Oracle
        // Cloud image refuses everything else).
        ok("ufw", &["allow", "80/tcp"]);
        ok("ufw", &["allow", "443/tcp"]);
        if ok("firewall-cmd", &["--permanent", "--add-service=http", "--add-service=https"]) { ok("firewall-cmd", &["--reload"]); }
        let rules = Command::new("iptables").args(["-S", "INPUT"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        if rules.contains("REJECT") && !rules.contains("443 -j ACCEPT") {
            ok("iptables", &["-I", "INPUT", "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "ACCEPT"]);
            ok("netfilter-persistent", &["save"]);
        }
        std::fs::write("/etc/systemd/system/hive-server.service", format!("[Unit]\nDescription=Hive's server\nAfter=network-online.target\n\n\
            [Service]\nUser=hive\nEnvironment=HIVE_STATE={dir} HOME={dir}\nExecStart={} run\nRestart=always\nRestartSec=3\n\
            AmbientCapabilities=CAP_NET_BIND_SERVICE\nNoNewPrivileges=yes\nProtectHome=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=multi-user.target\n", exe.display()))
            .map_err(|e| format!("Run it as root (sudo ./hive-server): {e}"))?;
        if !(ok("systemctl", &["daemon-reload"]) && ok("systemctl", &["enable", "hive-server"]) && ok("systemctl", &["restart", "hive-server"])) {
            return Err("systemd couldn't start Hive".into());
        }
    }
    #[cfg(not(target_os = "linux"))]
    let (exe, state) = (exe.display(), state.display());
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
