//! `hive`: the Hive app for Mac and Windows, and every agent's way into Hive. The app has no window (the dashboard is the web
//! page): it makes this computer one of a Hive's devices, and on a Mac it carries Hive for Safari and the fn key's type bar.
//!   hive                        open the app: this computer is one of a Hive's devices while it runs (the server is its own download)
//!   hive hook                   Lifecycle hook (SessionStart, UserPromptSubmit, PostToolUse, PreCompact) for external harnesses
//!   hive mcp                    MCP server on stdio: any agent (Claude Code, Codex, Antigravity, T3 Code, …) shares rules, memory & tasks
//!   hive connect [target]       Wire `hive mcp` + lifecycle hooks into claude | codex | antigravity | all
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(target_os = "macos")]
#[path = "../mac/apple.rs"]
mod apple;
#[cfg(target_os = "macos")]
#[path = "../mac/bar.rs"]
mod bar;
mod common;
mod connect;
#[cfg(target_os = "macos")]
mod phone_setup;
mod hook;
mod sessions;
mod mcp;
mod tailnet;
#[cfg(target_os = "macos")]
#[path = "../mac/mac.rs"]
mod os;
#[cfg(windows)]
#[path = "../windows/windows.rs"]
mod os;

/// Joins through Tailscale: once this computer is signed in to the same Tailscale account as the Hive Server, it finds the
/// server and the server takes it in. Saves the server's tailnet address; this run uses the door to it (tailnet.rs).
fn join() -> Result<hive_protocol::Conf, String> {
    let (door, server) = tailnet::open("auto", &format!("{}-{}", os::KIND, os::host()), &open)?;
    let id = hive_protocol::stable_id(os::KIND);
    let r = ureq::post(&format!("{door}/api/pair/tailnet")).set("content-type", "application/json")
        .send_string(&serde_json::json!({ "kind": os::KIND, "name": os::host() }).to_string());
    let body = match r { Ok(r) => r.into_string().unwrap_or_default(), Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(), Err(e) => return Err(e.to_string()) };
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let token = v["token"].as_str().ok_or_else(|| v["error"].as_str().unwrap_or("the Hive Server didn't take this computer in").to_string())?;
    let saved = serde_json::json!({ "server": server.trim_end_matches('/'), "token": token, "id": id });
    std::fs::write(hive_protocol::conf_path("node"), saved.to_string()).map_err(|e| e.to_string())?;
    // The dashboard, through the door: the server signs the owner's own devices in by themselves.
    open(&door);
    Ok(hive_protocol::Conf { server: door, token: token.into(), id })
}

/// A link in the browser: Tailscale's sign-in page, or the dashboard.
fn open(url: &str) {
    os::shell(&format!("{} '{url}'", if cfg!(windows) { "Start-Process" } else { "open" })).status().ok();
}

fn serve(c: hive_protocol::Conf) {
    sessions::start(hive_protocol::Conf { server: c.server.clone(), token: c.token.clone(), id: c.id.clone() });
    #[cfg(target_os = "macos")]
    phone_setup::start(&c);
    hive_protocol::run(c, hive_protocol::Node { kind: os::KIND, name: os::host(), package: "hive", tools: common::tools(),
        notes: format!("The owner's {}: {}_* tools. One agent at a time drives its input; the shell ({}) and files work alongside.",
            os::NAME, os::KIND, os::SHELL) },
        common::run)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fail = |e: String| -> ! { eprintln!("{e}"); std::process::exit(1) };
    match args.first().map(|s| s.as_str()) {
        Some("hook") => hook::run(),
        Some("sessions") => sessions::run(tailnet::load().unwrap_or_else(|| fail("Open Hive first".into()))),
        Some("mcp") => mcp::serve(),
        Some("connect") => match connect::run(args.get(1).map(|s| s.as_str()).unwrap_or("all")) {
            Ok(msg) => println!("{msg}"),
            Err(e) => fail(e),
        },
        Some("--version") => println!("{}", hive_protocol::DEVICES),
        None => {
            #[cfg(target_os = "macos")]
            os::install();
            // The Hive Server is reached through this computer's door to it, open while the app runs.
            let paired = hive_protocol::load("node").map(|c| {
                tailnet::open(&c.server, &format!("{}-{}", os::KIND, os::host()), &open).map(|(door, _)| hive_protocol::Conf { server: door, ..c })
            });
            match paired.unwrap_or_else(join) {
                #[cfg(target_os = "macos")]
                Ok(c) => { std::thread::spawn(move || serve(c)); bar::run() }
                #[cfg(windows)]
                Ok(c) => serve(c),
                Err(_) => {}
            }
        }
        _ => fail("usage: hive | hive hook | hive mcp | hive connect [claude|codex|antigravity|all]".into()),
    }
}
