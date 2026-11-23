//! First-run setup, the same steps everywhere: choose the AI Hive's agents think with (ChatGPT's Codex or Claude Code), get
//! it, sign in to it, then start Hive. A window shows them on a Mac or PC (`hive-server ui`, the page in setup.html); a
//! terminal on a computer with no screen, like a VM. Codex lives in <state>/bin with its login in <state>/codex; Claude Code
//! in <state>/bin with its login in <state>/claude; <state>/engine says which one this Hive uses.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// What the person sees and answers. `show` gets the whole current step each time.
pub trait Ui: Sync {
    fn show(&self, step: Value);
    /// "codex" or "claude".
    fn engine(&self) -> String;
    /// A code the person pasted from the sign-in page, if one came since the last call.
    fn pasted(&self) -> Option<String>;
}

pub fn exe(bin: &Path, name: &str) -> PathBuf { bin.join(if cfg!(windows) { format!("{name}.exe") } else { name.into() }) }

/// The engine this Hive uses; Codex until setup chooses.
pub fn engine(state: &Path) -> String {
    match std::fs::read_to_string(state.join("engine")).unwrap_or_default().trim() { "claude" => "claude".into(), _ => "codex".into() }
}

/// The whole first run. `install` makes Hive start with the computer; the result is the dashboard's link.
pub fn run(state: &Path, ui: &dyn Ui, install: &dyn Fn(&Path) -> Result<(), String>) -> Result<String, String> {
    std::fs::create_dir_all(state.join("bin")).map_err(|e| format!("Couldn't make {}: {e}", state.display()))?;
    let engine = if state.join("engine").exists() { engine(state) } else { ui.engine() };
    std::fs::write(state.join("engine"), &engine).map_err(|e| e.to_string())?;
    if engine == "claude" { get_claude(state, ui)?; sign_in_claude(state, ui)?; } else { get_codex(state, ui)?; sign_in_codex(state, ui)?; }
    ui.show(json!({ "step": "starting" }));
    std::fs::remove_file(state.join("tls").join("why")).ok();
    install(state)?;
    for _ in 0..360 {
        if let Some(a) = crate::address(state) {
            let link = format!("{a}/#key={}", crate::owner_key(state));
            // A PC finds its Hive again under Hive in the Start menu.
            #[cfg(windows)]
            if let Ok(appdata) = std::env::var("APPDATA") {
                let programs = Path::new(&appdata).join(r"Microsoft\Windows\Start Menu\Programs");
                std::fs::write(programs.join("Hive.url"), format!("[InternetShortcut]\r\nURL={link}\r\n")).ok();
            }
            return Ok(link);
        }
        if let Some(why) = crate::why(state) { return Err(why); }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("Hive is running, but Let's Encrypt hasn't given it a secure address yet. Open Hive Server again in a few minutes.".into())
}

// ---- getting the engine ----

fn download_step<'a>(ui: &'a dyn Ui, label: &str) -> impl Fn(u64, Option<u64>) + 'a {
    let label = label.to_string();
    move |done, total| ui.show(json!({ "step": "download", "label": label, "done": done, "total": total }))
}

pub(crate) fn get_codex(state: &Path, ui: &dyn Ui) -> Result<PathBuf, String> {
    let bin = state.join("bin");
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    let target = match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin.tar.gz"),
        "windows" => format!("{arch}-pc-windows-msvc.exe"),
        _ => format!("{arch}-unknown-linux-musl.tar.gz"),
    };
    // Codex runs agents' tool calls through its code-mode host, which sits beside it: both come from one release.
    if !exe(&bin, "codex-code-mode-host").exists() { std::fs::remove_file(exe(&bin, "codex")).ok(); }
    let show = download_step(ui, "Codex");
    let latest = |name: &str| fetch(&bin, name, &format!("https://github.com/openai/codex/releases/latest/download/{name}-{target}"), None, &show);
    let codex = latest("codex")?;
    latest("codex-code-mode-host")?;
    Ok(codex)
}

/// Claude Code the way its own installer gets it (claude.ai/install.sh): the latest version's build for this computer, checked
/// against the release's manifest.
fn get_claude(state: &Path, ui: &dyn Ui) -> Result<PathBuf, String> {
    let bin = state.join("bin");
    if exe(&bin, "claude").exists() { return Ok(exe(&bin, "claude")); }
    let base = "https://downloads.claude.ai/claude-code-releases";
    let failed = |e: String| format!("Couldn't get Claude Code ({e}). Check the internet connection and try again.");
    let get = |url: &str| ureq::get(url).timeout(Duration::from_secs(60)).call().map_err(|e| failed(e.to_string()))?.into_string().map_err(|e| failed(e.to_string()));
    let version = get(&format!("{base}/latest"))?.trim().to_string();
    if !version.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)) { return Err(failed("odd version".into())); }
    let manifest: Value = serde_json::from_str(&get(&format!("{base}/{version}/manifest.json"))?).map_err(|e| failed(e.to_string()))?;
    let platform = claude_platform();
    let p = &manifest["platforms"][&platform];
    let (sum, name) = (p["checksum"].as_str().unwrap_or(""), p["binary"].as_str().unwrap_or("claude"));
    if sum.len() != 64 { return Err(failed(format!("no build for {platform}"))); }
    fetch(&bin, "claude", &format!("{base}/{version}/{platform}/{name}"), Some(sum), &download_step(ui, "Claude Code"))
}

fn claude_platform() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    match std::env::consts::OS {
        "macos" => format!("darwin-{arch}"),
        "windows" => format!("win32-{arch}"),
        _ if Path::new("/lib/libc.musl-x86_64.so.1").exists() || Path::new("/lib/libc.musl-aarch64.so.1").exists() => format!("linux-{arch}-musl"),
        _ => format!("linux-{arch}"),
    }
}

/// A program Hive runs, from its maker's release, fetched once. A download that stops moving for a minute starts over, up to
/// three times, instead of waiting forever; `sha256` (when the maker publishes one) must match.
pub(crate) fn fetch(bin: &Path, name: &str, url: &str, sha256: Option<&str>, progress: &dyn Fn(u64, Option<u64>)) -> Result<PathBuf, String> {
    use sha2::Digest;
    let exe = exe(bin, name);
    if exe.exists() { return Ok(exe); }
    let failed = |e: String| format!("Couldn't download {name} ({e}). Check the internet connection and try again.");
    let part = bin.join(format!("{name}.part"));
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(60)).build();
    let mut last = String::new();
    for _ in 0..3 {
        let got = agent.get(url).call().map_err(|e| e.to_string()).and_then(|r| {
            let size = r.header("content-length").and_then(|n| n.parse::<u64>().ok());
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let (mut from, mut buf, mut done, mut hash) = (r.into_reader(), vec![0u8; 1 << 16], 0u64, sha2::Sha256::new());
            let mut shown = u64::MAX;
            loop {
                let n = from.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 { break }
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                hash.update(&buf[..n]);
                done += n as u64;
                if done >> 20 != shown { shown = done >> 20; progress(done, size); }
            }
            let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if sha256.is_some_and(|want| want != got) { return Err("the download didn't match its checksum".into()) }
            Ok(())
        });
        match got { Ok(()) => { last.clear(); break } Err(e) => last = e }
    }
    if !last.is_empty() { std::fs::remove_file(&part).ok(); return Err(failed(last)); }
    if url.ends_with("gz") {
        let unpack = bin.join(format!("{name}.unpack"));
        std::fs::create_dir_all(&unpack).ok();
        Command::new("tar").arg("-xzf").arg(&part).arg("-C").arg(&unpack).status().map_err(|e| failed(e.to_string()))?;
        let inner = std::fs::read_dir(&unpack).ok().and_then(|mut d| d.next()).and_then(|e| e.ok()).ok_or_else(|| failed("empty archive".into()))?;
        std::fs::rename(inner.path(), &exe).map_err(|e| failed(e.to_string()))?;
        std::fs::remove_dir_all(&unpack).ok();
        std::fs::remove_file(&part).ok();
    } else {
        std::fs::rename(&part, &exe).map_err(|e| failed(e.to_string()))?;
    }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).ok(); }
    Ok(exe)
}

// ---- signing in ----

/// A sign-in command's output, line by line, without terminal colours.
fn lines(child: &mut std::process::Child) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    for out in [child.stdout.take().map(|o| Box::new(o) as Box<dyn Read + Send>), child.stderr.take().map(|e| Box::new(e) as Box<dyn Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || for l in BufReader::new(out).lines().map_while(Result::ok) { tx.send(plain(&l)).ok(); });
    }
    rx
}

fn plain(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' { for d in chars.by_ref() { if d.is_ascii_alphabetic() { break } } } else { out.push(c) }
    }
    out.trim().to_string()
}

fn no_window(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c
}

pub fn codex_signed_in(state: &Path) -> bool { state.join("codex").join("auth.json").exists() }

/// ChatGPT's device sign-in: a link and a one-time code to enter there.
pub(crate) fn sign_in_codex(state: &Path, ui: &dyn Ui) -> Result<(), String> {
    let home = state.join("codex");
    std::fs::create_dir_all(&home).ok();
    if codex_signed_in(state) { return Ok(()) }
    let mut child = no_window(Command::new(exe(&state.join("bin"), "codex")).args(["login", "--device-auth"]).env("CODEX_HOME", &home))
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start Codex: {e}"))?;
    let rx = lines(&mut child);
    let (mut url, mut code) = (String::new(), String::new());
    while child.try_wait().ok().flatten().is_none() {
        while let Ok(l) = rx.try_recv() {
            if l.starts_with("https://") && url.is_empty() { url = l.clone(); }
            if is_code(&l) { code = l.clone(); }
            if !url.is_empty() && !code.is_empty() { ui.show(json!({ "step": "signin", "engine": "codex", "url": url, "code": code })); }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if codex_signed_in(state) { Ok(()) } else { Err("ChatGPT sign-in didn't finish. Try again.".into()) }
}

/// A device code like YAEW-V8YGE.
fn is_code(l: &str) -> bool {
    l.len() <= 12 && l.contains('-') && l.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
}

pub fn claude_signed_in(state: &Path) -> bool {
    let out = no_window(Command::new(exe(&state.join("bin"), "claude")).args(["auth", "status", "--json"]).env("CLAUDE_CONFIG_DIR", state.join("claude")))
        .stdin(Stdio::null()).output();
    out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).is_some_and(|v| v["loggedIn"] == true)
}

/// Claude's own subscription sign-in (`claude auth login`, as T3 Code does it): it opens the browser itself; on a computer with
/// no browser, the page shows a code to paste back.
fn sign_in_claude(state: &Path, ui: &dyn Ui) -> Result<(), String> {
    let home = state.join("claude");
    std::fs::create_dir_all(&home).ok();
    if claude_signed_in(state) { return Ok(()) }
    let mut child = no_window(Command::new(exe(&state.join("bin"), "claude")).args(["auth", "login"]).env("CLAUDE_CONFIG_DIR", &home))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    let mut stdin = child.stdin.take();
    let rx = lines(&mut child);
    let mut url = String::new();
    ui.show(json!({ "step": "signin", "engine": "claude" }));
    while child.try_wait().ok().flatten().is_none() {
        while let Ok(l) = rx.try_recv() {
            if l.starts_with("https://") && url.is_empty() { url = l; ui.show(json!({ "step": "signin", "engine": "claude", "url": url })); }
        }
        if let (Some(code), Some(i)) = (ui.pasted(), stdin.as_mut()) { writeln!(i, "{}", code.trim()).ok(); i.flush().ok(); }
        std::thread::sleep(Duration::from_millis(200));
    }
    if claude_signed_in(state) { Ok(()) } else { Err("Claude sign-in didn't finish. Try again.".into()) }
}

// ---- the terminal, on a computer with no screen ----

pub struct Terminal { pasted: std::sync::Mutex<Option<mpsc::Receiver<String>>>, last: std::sync::Mutex<String> }

impl Terminal {
    pub fn new() -> Terminal { Terminal { pasted: std::sync::Mutex::new(None), last: std::sync::Mutex::new(String::new()) } }
}

impl Ui for Terminal {
    fn show(&self, v: Value) {
        let step = v["step"].as_str().unwrap_or("");
        let mut last = self.last.lock().unwrap();
        match step {
            "download" => {
                let mb = v["done"].as_u64().unwrap_or(0) >> 20;
                if *last != format!("download {}", v["label"]) { eprintln!("Downloading {}, the AI behind Hive's agents…", v["label"].as_str().unwrap_or("")); }
                match v["total"].as_u64() { Some(t) => eprint!("\r  {mb} of {} MB", t >> 20), None => eprint!("\r  {mb} MB") }
                *last = format!("download {}", v["label"]);
                return;
            }
            _ if last.starts_with("download") => eprintln!(),
            _ => {}
        }
        let line = match (step, v["engine"].as_str()) {
            ("signin", Some("codex")) if v["code"].is_string() =>
                format!("Sign in to ChatGPT: open {} on any device and enter the code {}", v["url"].as_str().unwrap_or(""), v["code"].as_str().unwrap_or("")),
            ("signin", Some("claude")) if v["url"].is_string() =>
                format!("Sign in to Claude: open this link on any device:\n{}\nIf the page gives you a code, paste it here and press Enter:", v["url"].as_str().unwrap_or("")),
            ("starting", _) => "Signed in. Starting your Hive and getting its secure address (up to 3 minutes)…".into(),
            _ => return,
        };
        if *last != line { eprintln!("{line}"); *last = line; }
    }

    fn engine(&self) -> String {
        if let Ok(e) = std::env::var("HIVE_ENGINE") { return if e == "claude" { e } else { "codex".into() } }
        eprintln!("Which AI should Hive's agents use?\n  1. ChatGPT (Codex), with your ChatGPT account\n  2. Claude (Claude Code), with your Claude account");
        loop {
            eprint!("Type 1 or 2: ");
            let mut l = String::new();
            if std::io::stdin().read_line(&mut l).unwrap_or(0) == 0 { return "codex".into() }
            match l.trim() { "1" => return "codex".into(), "2" => return "claude".into(), _ => {} }
        }
    }

    fn pasted(&self) -> Option<String> {
        let mut rx = self.pasted.lock().unwrap();
        let rx = rx.get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || for l in std::io::stdin().lock().lines().map_while(Result::ok) { if !l.trim().is_empty() { tx.send(l).ok(); } });
            rx
        });
        rx.try_recv().ok()
    }
}

// ---- the window, on a Mac or PC ----

const PAGE: &str = include_str!("setup.html");

pub struct Window { step: std::sync::Mutex<Value>, engine: (std::sync::Mutex<Option<String>>, std::sync::Condvar), pasted: std::sync::Mutex<Option<String>>, token: String,
    polled: std::sync::Mutex<std::time::Instant> }

impl Ui for Window {
    fn show(&self, v: Value) { *self.step.lock().unwrap() = v; }
    fn engine(&self) -> String {
        self.show(json!({ "step": "choose" }));
        let mut g = self.engine.0.lock().unwrap();
        while g.is_none() { g = self.engine.1.wait(g).unwrap(); }
        g.take().unwrap()
    }
    fn pasted(&self) -> Option<String> { self.pasted.lock().unwrap().take() }
}

/// Serves the setup page on this computer only and runs setup behind it; `opened` gets the page's address. Returns when the
/// page is closed after setup ends (or Hive is already set up and the page is closed).
pub fn window(state: &Path, install: &'static (dyn Fn(&Path) -> Result<(), String> + Sync), opened: &dyn Fn(&str)) {
    use std::sync::Arc;
    let ui = Arc::new(Window { step: std::sync::Mutex::new(json!({ "step": "checking" })), engine: (std::sync::Mutex::new(None), std::sync::Condvar::new()),
        pasted: std::sync::Mutex::new(None), token: crate::api::random(16), polled: std::sync::Mutex::new(std::time::Instant::now()) });
    let (quit_tx, quit_rx) = mpsc::channel::<()>();
    let flow = {
        let (ui, state) = (ui.clone(), state.to_path_buf());
        move || {
            let done = if ready(&state) { Ok(dashboard(&state)) } else { run(&state, &*ui, install) };
            ui.show(match done {
                Ok(link) => json!({ "step": "done", "dashboard": link, "os": std::env::consts::OS }),
                Err(e) => json!({ "step": "error", "message": e }),
            });
        }
    };
    let flow = Arc::new(flow);
    { let f = flow.clone(); std::thread::spawn(move || f()); }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a local port");
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    drop(listener);
    let handler: Arc<dyn Fn(crate::http::Req) -> crate::http::Res + Send + Sync> = {
        let (ui, flow) = (ui.clone(), flow.clone());
        Arc::new(move |req: crate::http::Req| {
            use crate::http::Res;
            // The page's own requests carry its secret; its last word (a beacon, which can't set headers) carries it in the query.
            let ok = req.headers.get("x-hive-setup").is_some_and(|t| *t == ui.token) || req.query.contains_key(&ui.token);
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/") => Res::new(200, "text/html; charset=utf-8", PAGE),
                ("GET", "/icon.png") => Res::new(200, "image/png", include_bytes!("../../dashboard/icon.png").as_slice()),
                (_, _) if !ok => Res::err(403, "This page only answers Hive Server's own window."),
                ("GET", "/step") => { *ui.polled.lock().unwrap() = std::time::Instant::now(); Res::json(&ui.step.lock().unwrap()) }
                ("POST", "/engine") => {
                    let e = req.json()["engine"].as_str().unwrap_or("codex").to_string();
                    *ui.engine.0.lock().unwrap() = Some(if e == "claude" { e } else { "codex".into() });
                    ui.engine.1.notify_all();
                    Res::json(&json!({ "ok": true }))
                }
                ("POST", "/paste") => { *ui.pasted.lock().unwrap() = req.json()["code"].as_str().map(String::from); Res::json(&json!({ "ok": true })) }
                ("POST", "/retry") => {
                    if ui.step.lock().unwrap()["step"] == "error" { ui.show(json!({ "step": "checking" })); let f = flow.clone(); std::thread::spawn(move || f()); }
                    Res::json(&json!({ "ok": true }))
                }
                ("POST", "/closed") => { quit_tx.send(()).ok(); Res::json(&json!({ "ok": true })) }
                _ => Res::err(404, "not here"),
            }
        })
    };
    std::thread::spawn(move || crate::http::serve(&format!("127.0.0.1:{port}"), handler).ok());
    opened(&format!("http://127.0.0.1:{port}/#{}", ui.token));
    // The page says when it closes; a reload says so too, so quit only if it doesn't come back within a few seconds.
    while quit_rx.recv().is_ok() {
        let closed = std::time::Instant::now();
        std::thread::sleep(Duration::from_secs(4));
        if *ui.polled.lock().unwrap() < closed { return }
    }
}

/// Set up already: its engine is here and signed in, and Hive has its address.
fn ready(state: &Path) -> bool {
    let bin = state.join("bin");
    let signed = if engine(state) == "claude" { exe(&bin, "claude").exists() && claude_signed_in(state) } else { exe(&bin, "codex").exists() && codex_signed_in(state) };
    signed && state.join("engine").exists() && crate::address(state).is_some()
}

fn dashboard(state: &Path) -> String { format!("{}/#key={}", crate::address(state).unwrap_or_default(), crate::owner_key(state)) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_codex_sign_in() {
        assert_eq!(plain("   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m"), "https://auth.openai.com/codex/device");
        assert!(is_code(&plain("   \x1b[94mYAEW-V8YGE\x1b[0m")));
        assert!(!is_code("2. Enter this one-time code (expires in 15 minutes)"));
    }
    #[test]
    fn engine_defaults_to_codex() {
        let d = std::env::temp_dir().join(format!("hive-engine-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(engine(&d), "codex");
        std::fs::write(d.join("engine"), "claude\n").unwrap();
        assert_eq!(engine(&d), "claude");
        std::fs::remove_dir_all(&d).ok();
    }
}
