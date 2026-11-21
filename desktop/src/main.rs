//! `hive`: the Hive app for Mac and Windows (desktop/src/app.rs), and Claude Code's way into Hive.
//!   hive                        open the app: this computer works with Hive while it runs
//!   hive hook                   Claude Code hook (UserPromptSubmit, PostToolUse): prompts go to Hive's orchestrator first
//!   hive end <task> …           a Claude Code session says how its task ended
#![cfg_attr(windows, windows_subsystem = "windows")]
mod app;
mod common;
mod hook;
#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod os;
#[cfg(windows)]
#[path = "windows.rs"]
mod os;

/// The checkout of Hive this binary was built in, if any: Hive's code changes reach this computer through it.
fn repo() -> String {
    std::env::current_exe().ok().and_then(|e| e.ancestors().find(|d| d.join(".git").exists() && d.join("desktop").join("Cargo.toml").exists())
        .map(|d| d.to_string_lossy().into_owned())).unwrap_or_default()
}

/// The link from the dashboard's Pair a device: `https://<server>/#pair=<code>`.
fn connect(link: &str) -> Result<hive_protocol::Conf, String> {
    let (server, code) = link.trim().split_once("/#pair=")
        .ok_or("That isn't a pairing link. On your Hive dashboard, choose Pair a device and paste the link it copies.")?;
    hive_protocol::pair("node", server, code, os::KIND, &os::host(), &repo())
}

fn serve(c: hive_protocol::Conf) {
    hive_protocol::run(c, hive_protocol::Node { kind: os::KIND, name: os::host(), package: "hive", tools: common::tools(),
        notes: format!("The owner's {}: {}_* tools. One agent at a time drives its keyboard and mouse; the shell ({}) and files work alongside.",
            os::NAME, os::KIND, os::SHELL) },
        common::run)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fail = |e: String| -> ! { eprintln!("{e}"); std::process::exit(1) };
    match args.first().map(|s| s.as_str()) {
        Some("hook") => hook::run(),
        Some("end") => hook::end(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("--version") => println!("{}", hive_protocol::VERSION),
        None => app::run(hive_protocol::load("node"), connect, serve),
        _ => fail("usage: hive | hive hook | hive end <task> …".into()),
    }
}
