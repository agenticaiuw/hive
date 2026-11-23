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
    /// "codex" or "claude". `found` says which the owner already has signed in on this computer ({"codex": true, …}).
    fn engine(&self, found: &Value) -> String;
    /// A code the person pasted from the sign-in page, if one came since the last call.
    fn pasted(&self) -> Option<String>;
}

pub fn exe(bin: &Path, name: &str) -> PathBuf { bin.join(if cfg!(windows) { format!("{name}.exe") } else { name.into() }) }

/// The engine this Hive uses; Codex until setup chooses.
pub fn engine(state: &Path) -> String {
    match std::fs::read_to_string(state.join("engine")).unwrap_or_default().trim() { "claude" => "claude".into(), _ => "codex".into() }
}

/// The engine's program: the owner's own when setup found it signed in (`<state>/engine-bin`), else Hive's copy.
pub fn engine_bin(state: &Path, name: &str) -> PathBuf {
    std::fs::read_to_string(state.join("engine-bin")).ok().map(|p| PathBuf::from(p.trim())).filter(|p| p.exists())
        .unwrap_or_else(|| exe(&state.join("bin"), name))
}

/// Where the engine keeps its sign-in: the owner's own (`<state>/engine-home`; empty means the program's own default), else
/// Hive's folder for it.
pub fn engine_env(state: &Path, name: &str) -> Vec<(String, String)> {
    let var = if name == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" };
    match std::fs::read_to_string(state.join("engine-home")) {
        Ok(h) if h.trim().is_empty() => vec![],
        Ok(h) => vec![(var.into(), h.trim().into())],
        Err(_) => vec![(var.into(), state.join(name).to_string_lossy().into_owned())],
    }
}

fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()) }

/// A program the owner installed, wherever their own terminal would find it (an app opened from Finder doesn't get their PATH).
fn installed(name: &str) -> Option<PathBuf> {
    let h = home();
    let mut places: Vec<PathBuf> = if cfg!(windows) {
        vec![h.join(".local").join("bin").join(format!("{name}.exe")), h.join("AppData").join("Roaming").join("npm").join(format!("{name}.cmd"))]
    } else {
        vec![h.join(".local/bin").join(name), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), h.join(".npm-global/bin").join(name), h.join(".claude/local").join(name)]
            .into_iter().map(|p| if p.ends_with("bin") { p.join(name) } else { p }).collect()
    };
    let shell = if cfg!(windows) { Command::new("where").arg(name).output() }
        else { Command::new(std::env::var("SHELL").unwrap_or("/bin/zsh".into())).args(["-lc", &format!("command -v {name}")]).output() };
    if let Some(p) = shell.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| PathBuf::from(l.trim()))) { places.insert(0, p) }
    places.into_iter().find(|p| p.is_file())
}

/// The owner's own Codex or Claude Code, if they're signed in to it on this computer: its program (None when Hive should use
/// its own copy of the program but their sign-in) and where its sign-in lives ("" for the program's default).
fn found(name: &str) -> Option<(Option<PathBuf>, String)> {
    if name == "codex" {
        let home = std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_| home().join(".codex"));
        if !home.join("auth.json").exists() { return None }
        // Hive runs agents' tools through Codex's code-mode host, which a native install has beside it (an npm one doesn't).
        let bin = installed("codex").filter(|b| b.canonicalize().is_ok_and(|c| c.with_file_name(if cfg!(windows) { "codex-code-mode-host.exe" } else { "codex-code-mode-host" }).exists()));
        return Some((bin, home.to_string_lossy().into_owned()))
    }
    let bin = installed("claude")?;
    let out = no_window(Command::new(&bin).args(["auth", "status", "--json"]).env_remove("CLAUDE_CONFIG_DIR")).stdin(Stdio::null()).output().ok()?;
    let signed = serde_json::from_slice::<Value>(&out.stdout).is_ok_and(|v| v["loggedIn"] == true);
    signed.then(|| (Some(bin), String::new()))
}

/// The whole first run. `install` makes Hive start with the computer; the result is the dashboard's link.
pub fn run(state: &Path, ui: &dyn Ui, install: &dyn Fn(&Path) -> Result<(), String>) -> Result<String, String> {
    std::fs::create_dir_all(state.join("bin")).map_err(|e| format!("Couldn't make {}: {e}", state.display()))?;
    let engine = if state.join("engine").exists() { engine(state) } else {
        // What the owner already has signed in here, Hive uses as it is: no download, no second sign-in.
        let have: Vec<(&str, Option<(Option<PathBuf>, String)>)> = ["claude", "codex"].iter().map(|n| (*n, found(n))).collect();
        let chosen = ui.engine(&json!(have.iter().map(|(n, f)| (n.to_string(), json!(f.is_some()))).collect::<serde_json::Map<_, _>>()));
        if let Some((_, Some((bin, home)))) = have.into_iter().find(|(n, _)| *n == chosen) {
            if let Some(b) = bin { std::fs::write(state.join("engine-bin"), b.to_string_lossy().as_bytes()).ok(); }
            std::fs::write(state.join("engine-home"), home).ok();
        }
        chosen
    };
    std::fs::write(state.join("engine"), &engine).map_err(|e| e.to_string())?;
    let own = state.join("engine-bin").exists();
    if engine == "claude" { if !own { get_claude(state, ui)?; } sign_in_claude(state, ui)?; }
    else { if !own { get_codex(state, ui)?; } sign_in_codex(state, ui)?; }
    // At home, the owner's devices reach Hive through their own Tailscale network; a cloud VM has a public address.
    let home = crate::tailnet::on(state) || (!state.join("reach").exists() && !crate::tailnet::cloud());
    if home {
        crate::tailnet::get(state, &download_step(ui, "Tailscale"))?;
        std::fs::write(state.join("reach"), "tailnet").map_err(|e| e.to_string())?;
    }
    ui.show(json!({ "step": "starting" }));
    std::fs::remove_file(state.join("tls").join("why")).ok();
    install(state)?;
    if home { return connect_devices(state, ui) }
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

/// Waits while the owner signs in to Tailscale (and turns on HTTPS for their tailnet), showing them each step, until Hive has
/// its tailnet address.
fn connect_devices(state: &Path, ui: &dyn Ui) -> Result<String, String> {
    let mut failing = 0;
    for _ in 0..3600 {
        let v = crate::tailnet::status(state);
        if let Some(a) = v["address"].as_str() { return Ok(format!("{a}/#key={}", crate::owner_key(state))) }
        // A passing hiccup (the network blinking) isn't a failure; one that lasts half a minute is.
        match crate::tailnet::why(state) { Some(e) if failing > 60 => return Err(e), Some(_) => failing += 1, None => failing = 0 }
        if let Some(u) = v["login"].as_str() { ui.show(json!({ "step": "tailscale", "url": u })) }
        if let Some(u) = v["admin"].as_str() { ui.show(json!({ "step": "tailscale-https", "url": u })) }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("Tailscale sign-in didn't finish. Open Hive Server again to carry on.".into())
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
pub fn fetch(bin: &Path, name: &str, url: &str, sha256: Option<&str>, progress: &dyn Fn(u64, Option<u64>)) -> Result<PathBuf, String> {
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

pub fn codex_signed_in(state: &Path) -> bool {
    engine_env(state, "codex").first().map(|(_, h)| PathBuf::from(h)).unwrap_or_else(|| home().join(".codex")).join("auth.json").exists()
}

/// ChatGPT's device sign-in: a link and a one-time code to enter there.
pub(crate) fn sign_in_codex(state: &Path, ui: &dyn Ui) -> Result<(), String> {
    if codex_signed_in(state) { return Ok(()) }
    for (_, h) in engine_env(state, "codex") { std::fs::create_dir_all(h).ok(); }
    let mut child = no_window(Command::new(engine_bin(state, "codex")).args(["login", "--device-auth"]).envs(engine_env(state, "codex")))
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
    let out = no_window(Command::new(engine_bin(state, "claude")).args(["auth", "status", "--json"]).envs(engine_env(state, "claude")))
        .stdin(Stdio::null()).output();
    out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).is_some_and(|v| v["loggedIn"] == true)
}

/// Claude's own subscription sign-in (`claude auth login`, as T3 Code does it): it opens the browser itself; on a computer with
/// no browser, the page shows a code to paste back.
fn sign_in_claude(state: &Path, ui: &dyn Ui) -> Result<(), String> {
    if claude_signed_in(state) { return Ok(()) }
    for (_, h) in engine_env(state, "claude") { std::fs::create_dir_all(h).ok(); }
    let mut child = no_window(Command::new(engine_bin(state, "claude")).args(["auth", "login"]).envs(engine_env(state, "claude")))
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
            ("starting", _) => "Signed in. Starting your Hive…".into(),
            ("tailscale", _) => format!("Your phone and other computers reach this Hive through Tailscale, a free private network only your \
                devices can use. Sign in (or make a free account) here, on any device:\n{}", v["url"].as_str().unwrap_or("")),
            ("tailscale-https", _) => format!("Last step: turn on MagicDNS and HTTPS for your Tailscale network, here:\n{}", v["url"].as_str().unwrap_or("")),
            _ => return,
        };
        if *last != line { eprintln!("{line}"); *last = line; }
    }

    fn engine(&self, found: &Value) -> String {
        if let Ok(e) = std::env::var("HIVE_ENGINE") { return if e == "claude" { e } else { "codex".into() } }
        let here = |n: &str| if found[n] == true { " (already signed in on this computer)" } else { "" };
        eprintln!("Which AI should Hive's agents use?\n  1. ChatGPT (Codex), with your ChatGPT account{}\n  2. Claude (Claude Code), with your Claude account{}",
            here("codex"), here("claude"));
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
    fn engine(&self, found: &Value) -> String {
        self.show(json!({ "step": "choose", "found": found }));
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
    let e = engine(state);
    let signed = engine_bin(state, &e).exists() && if e == "claude" { claude_signed_in(state) } else { codex_signed_in(state) };
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
    fn finds_the_owners_own_signed_in_codex() {
        let h = std::env::temp_dir().join(format!("hive-home-{}", std::process::id()));
        std::fs::create_dir_all(h.join(".codex")).unwrap();
        std::fs::create_dir_all(h.join(".local/bin")).unwrap();
        std::env::set_var("HOME", &h);
        std::env::set_var("SHELL", "/usr/bin/false");
        std::env::remove_var("CODEX_HOME");
        assert!(found("codex").is_none(), "not signed in yet");
        std::fs::write(h.join(".codex/auth.json"), "{}").unwrap();
        // Signed in but no native Codex: Hive uses its own copy with the owner's sign-in.
        let (bin, home) = found("codex").unwrap();
        assert!(bin.is_none() && home.ends_with(".codex"));
        for f in ["codex", "codex-code-mode-host"] { std::fs::write(h.join(".local/bin").join(f), "").unwrap(); }
        let (bin, _) = found("codex").unwrap();
        assert_eq!(bin.unwrap(), h.join(".local/bin/codex"));
        // Chosen: the engine's place follows.
        let state = h.join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("engine-home"), h.join(".codex").to_string_lossy().as_bytes()).unwrap();
        assert!(codex_signed_in(&state));
        assert_eq!(engine_env(&state, "codex")[0].1, h.join(".codex").to_string_lossy());
        std::fs::write(state.join("engine-home"), "").unwrap();
        assert!(engine_env(&state, "claude").is_empty(), "an empty home means the program's own default");
        std::fs::remove_dir_all(&h).ok();
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
