//! `hive`: the Hive app for Mac and Windows, and Claude Code's way into Hive. The app has no window (the dashboard is the web
//! page): it makes this computer one of a Hive's devices, and on a Mac it carries Hive for Safari and the fn key's type bar.
//!   hive                        open the app: this computer is one of a Hive's devices while it runs (the server is its own download)
//!   hive hook                   Claude Code hook (UserPromptSubmit, PostToolUse): prompts go to Hive's orchestrator first
//!   hive task <request> …       a Claude Code session writes a task for a prompt; `hive rule <scope> …` a rule
//!   hive end <task> …           a Claude Code session says how its task ended
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(target_os = "macos")]
mod bar;
mod common;
mod hook;
#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod os;
#[cfg(windows)]
#[path = "windows.rs"]
mod os;

/// The link from the dashboard's Pair a device: `https://<server>/#pair=<code>`.
fn connect(link: &str) -> Result<hive_protocol::Conf, String> {
    let (server, code) = link.trim().split_once("/#pair=")
        .ok_or("That isn't a pairing link. On your Hive dashboard, choose Pair a device and paste the link it copies.")?;
    hive_protocol::pair("node", server, code, os::KIND, &os::host())
}

fn dashboard(c: &hive_protocol::Conf) -> String { format!("{}/#key={}", c.server, c.token) }

/// Not paired yet: join with the link the dashboard's Pair a device just copied, and open that dashboard in the browser.
fn join() -> Result<hive_protocol::Conf, String> {
    let (paste, open) = if cfg!(windows) { ("Get-Clipboard", "Start-Process") } else { ("pbpaste", "open") };
    let link = os::shell(paste).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let c = connect(&link)?;
    os::shell(&format!("{open} '{}'", dashboard(&c))).status().ok();
    Ok(c)
}

/// The app's one message, when there's nothing to join with.
fn say(text: &str) {
    os::shell(&if cfg!(windows) { format!("Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{text}', 'Hive')") }
        else { format!("osascript -e 'display alert \"Hive\" message \"{text}\"'") }).status().ok();
}

fn serve(c: hive_protocol::Conf) {
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
        Some("end") => hook::end(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("task") => hook::task(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("rule") => hook::rule(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("--version") => println!("{}", hive_protocol::DEVICES),
        None => {
            #[cfg(target_os = "macos")]
            os::install();
            match hive_protocol::load("node").map(Ok).unwrap_or_else(join) {
                #[cfg(target_os = "macos")]
                Ok(c) => { std::thread::spawn(move || serve(c)); bar::run() }
                #[cfg(windows)]
                Ok(c) => serve(c),
                Err(_) => say("To connect this computer, click Pair a device on your Hive dashboard, then open Hive again within 10 minutes."),
            }
        }
        _ => fail("usage: hive | hive hook | hive task … | hive rule … | hive end <task> …".into()),
    }
}
