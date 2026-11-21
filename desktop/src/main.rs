//! `hive`: a Mac or Windows computer as a Hive device, and Claude Code's way into Hive.
//!   hive pair <server> <code>   connect this computer to Hive with a pairing code from the dashboard
//!   hive                        run it
//!   hive hook                   Claude Code hook (UserPromptSubmit, PostToolUse): prompts go to Hive's orchestrator first
//!   hive end <task> …           a Claude Code session says how its task ended
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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fail = |e: String| -> ! { eprintln!("{e}"); std::process::exit(1) };
    match args.first().map(|s| s.as_str()) {
        Some("pair") if args.len() == 3 => match hive_protocol::pair("node", &args[1], &args[2], os::KIND, &os::host(), &repo()) {
            Ok(_) => println!("This computer is connected to Hive."),
            Err(e) => fail(e),
        },
        Some("hook") => hook::run(),
        Some("end") => hook::end(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("--version") => println!("{}", hive_protocol::VERSION),
        None => {
            let c = hive_protocol::load("node").unwrap_or_else(|| fail("Not connected: run `hive pair <server> <code>` with a code from the dashboard.".into()));
            hive_protocol::run(c, hive_protocol::Node { kind: os::KIND, name: os::host(), package: "hive", tools: common::tools(),
                notes: format!("The owner's {}: {}_* tools. One agent at a time drives its keyboard and mouse; the shell ({}) and files work alongside.",
                    os::NAME, os::KIND, os::SHELL) },
                common::run)
        }
        _ => fail("usage: hive | hive pair <server> <code> | hive hook | hive end <task> …".into()),
    }
}
