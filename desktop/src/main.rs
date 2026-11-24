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
#[cfg(target_os = "macos")]
mod phone_setup;
mod hook;
mod tailnet;
#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod os;
#[cfg(windows)]
#[path = "windows.rs"]
mod os;

/// The link from the dashboard's Pair a device: `https://<server>/#pair=<code>`.
/// A Hive on a tailnet pairs through this computer's door to it (tailnet.rs), and keeps the tailnet address.
fn connect(link: &str) -> Result<hive_protocol::Conf, String> {
    let (server, code) = link.trim().split_once("/#pair=")
        .ok_or("That isn't a pairing link. On your Hive Server's dashboard, choose Pair a device and paste the link it copies.")?;
    if !tailnet::on(server) { return hive_protocol::pair("node", server, code, os::KIND, &os::host()) }
    let (door, server) = tailnet::open(server, &format!("{}-{}", os::KIND, os::host()), &sign_in)?;
    let c = hive_protocol::pair("node", &door, code, os::KIND, &os::host())?;
    keep(&server, &c)
}

/// Saves the pairing with the server's tailnet address (pairing went through this computer's door).
fn keep(server: &str, c: &hive_protocol::Conf) -> Result<hive_protocol::Conf, String> {
    let saved = serde_json::json!({ "server": server.trim_end_matches('/'), "token": c.token, "id": c.id });
    std::fs::write(hive_protocol::conf_path("node"), saved.to_string()).map_err(|e| e.to_string())?;
    Ok(hive_protocol::Conf { server: c.server.clone(), token: c.token.clone(), id: c.id.clone() })
}

/// Joins through Tailscale: once this computer is signed in to the same Tailscale account as the Hive Server, it finds the
/// server and the server takes it in, with no link.
fn join_tailnet() -> Result<hive_protocol::Conf, String> {
    let (door, server) = tailnet::open("auto", &format!("{}-{}", os::KIND, os::host()), &sign_in)?;
    let id = format!("{}-{}", os::KIND, os::host().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>());
    let r = ureq::post(&format!("{door}/api/pair/tailnet")).set("content-type", "application/json")
        .send_string(&serde_json::json!({ "kind": os::KIND, "name": os::host() }).to_string());
    let body = match r { Ok(r) => r.into_string().unwrap_or_default(), Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(), Err(e) => return Err(e.to_string()) };
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let token = v["token"].as_str().ok_or_else(|| v["error"].as_str().unwrap_or("the Hive Server didn't take this computer in").to_string())?;
    keep(&server, &hive_protocol::Conf { server: door, token: token.into(), id })
}

/// Tailscale's sign-in page, in the browser.
fn sign_in(url: &str) {
    os::shell(&format!("{} '{url}'", if cfg!(windows) { "Start-Process" } else { "open" })).status().ok();
}

fn dashboard(c: &hive_protocol::Conf) -> String { format!("{}/#key={}", c.server, c.token) }

/// Not paired yet: join with the link the dashboard's Pair a device copies, and open that dashboard in the browser. A link
/// already on the clipboard joins at once; otherwise a box asks for it, and asks again until it works or is cancelled.
fn join() -> Result<hive_protocol::Conf, String> {
    let (paste, open) = if cfg!(windows) { ("Get-Clipboard", "Start-Process") } else { ("pbpaste", "open") };
    let copied = os::shell(paste).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let mut link = if copied.contains("/#pair=") { copied } else { String::new() };
    // Most Hive Servers are on the owner's tailnet: signing in to Tailscale joins it. A pairing link is for one on a cloud VM.
    if link.is_empty() && tailscale_first() {
        let c = join_tailnet()?;
        os::shell(&format!("{open} '{}'", dashboard(&c))).status().ok();
        return Ok(c)
    }
    let mut tried = connect(&link);
    while let Err(e) = &tried {
        // Say why only once a link was tried: an empty clipboard isn't a mistake.
        let why = if link.is_empty() { String::new() } else { format!("That didn't connect: {e}\n\n") };
        link = ask(&format!("{why}{PAIR}"), &link).ok_or("cancelled")?;
        tried = connect(&link);
    }
    let c = tried?;
    os::shell(&format!("{open} '{}'", dashboard(&c))).status().ok();
    Ok(c)
}

/// Asks how to connect: through Tailscale (the usual way), or with a pairing link. True for Tailscale.
fn tailscale_first() -> bool {
    let text = "Connect this computer to your Hive Server.\n\nSign in to the same Tailscale account as your Hive Server, and this computer \
        finds it and connects by itself. Use a pairing link instead if your Hive Server is on a cloud VM.";
    let cmd = if cfg!(windows) {
        format!("Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{}', 'Hive', 'YesNo')",
            format!("{text}\n\nYes: sign in with Tailscale. No: paste a pairing link.").replace('\'', "''"))
    } else {
        format!("osascript -e 'button returned of (display dialog \"{}\" buttons {{\"Paste a pairing link\", \"Sign in with Tailscale\"}} default button 2 with title \"Hive\")'",
            text.replace('"', "\\\""))
    };
    let out = os::shell(&cmd).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    out == "Sign in with Tailscale" || out == "Yes"
}

const PAIR: &str = "Paste this computer's pairing link: on your Hive Server's dashboard, click Pair a device, and it copies the link.";

/// A box to paste into, with OK and Cancel: what was entered, or None when cancelled.
fn ask(prompt: &str, default: &str) -> Option<String> {
    let cmd = if cfg!(windows) {
        let q = |s: &str| s.replace('\'', "''");
        format!("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('{}', 'Hive', '{}')", q(prompt), q(default))
    } else {
        let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\'', "'\\''");
        format!("osascript -e 'text returned of (display dialog \"{}\" default answer \"{}\" with title \"Hive\")'", q(prompt), q(default))
    };
    let out = os::shell(&cmd).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn serve(c: hive_protocol::Conf) {
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
        Some("end") => hook::end(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("task") => hook::task(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("rule") => hook::rule(&args[1..]).unwrap_or_else(|e| fail(e)),
        Some("--version") => println!("{}", hive_protocol::DEVICES),
        None => {
            #[cfg(target_os = "macos")]
            os::install();
            // A Hive on a tailnet is reached through this computer's door to it, open while the app runs.
            let paired = hive_protocol::load("node").map(|c| {
                if !tailnet::on(&c.server) { return Ok(c) }
                tailnet::open(&c.server, &format!("{}-{}", os::KIND, os::host()), &sign_in).map(|(door, _)| hive_protocol::Conf { server: door, ..c })
            });
            match paired.unwrap_or_else(join) {
                #[cfg(target_os = "macos")]
                Ok(c) => { std::thread::spawn(move || serve(c)); bar::run() }
                #[cfg(windows)]
                Ok(c) => serve(c),
                Err(_) => {}
            }
        }
        _ => fail("usage: hive | hive hook | hive task … | hive rule … | hive end <task> …".into()),
    }
}
