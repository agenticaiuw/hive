//! The node side of the protocol (protocol/README.md), for nodes written in Rust: say hello with your tools,
//! take calls, answer them, and update yourself to GitHub's build when the server's devices' code changes.
pub mod b64;

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("HIVE_GIT");
/// The last change to the devices' own code: devices update only when it moves.
pub const DEVICES: &str = env!("HIVE_DEVICES");
/// Where every device and downloaded server gets each new build: GitHub builds (and signs) one for every push to main.
pub const RELEASES: &str = "https://github.com/agenticaiuw/hive/releases/download/latest";

/// A download from Releases: it gives up only once it stops arriving for a minute, never for taking long, so a slow line
/// still gets the update (a 9 MB app at 30 KB/s outlasts any fixed limit worth having).
pub fn release(name: &str) -> Result<ureq::Response, String> {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(60)).build()
        .get(&format!("{RELEASES}/{name}")).call().map_err(|e| e.to_string())
}

pub struct Conf { pub server: String, pub token: String, pub id: String }

pub struct Node {
    pub kind: &'static str,
    pub name: String,
    /// What agents should know about this device, one or two sentences.
    pub notes: String,
    pub tools: Vec<Value>,
    /// The program's name in GitHub's builds (hive, hive-server).
    pub package: &'static str,
}

pub fn conf_path(name: &str) -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".config").join("hive").join(format!("{name}.json"))
}

pub fn load(name: &str) -> Option<Conf> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(conf_path(name)).ok()?).ok()?;
    Some(Conf {
        server: v["server"].as_str()?.trim_end_matches('/').into(),
        token: v["token"].as_str()?.into(),
        id: v["id"].as_str()?.into(),
    })
}

pub fn call(c: &Conf, method: &str, path: &str, body: Option<&Value>, secs: u64) -> Result<(u16, Value), String> {
    let req = ureq::request(method, &format!("{}{path}", c.server)).timeout(Duration::from_secs(secs))
        .set("authorization", &format!("Bearer {}", c.token));
    let res = match body { Some(b) => req.set("content-type", "application/json").send_string(&b.to_string()), None => req.call() };
    let parse = |r: ureq::Response| { let st = r.status(); (st, serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or(Value::Null)) };
    match res {
        Ok(r) => Ok(parse(r)),
        Err(ureq::Error::Status(_, r)) => Ok(parse(r)),
        Err(e) => Err(e.to_string()),
    }
}

/// A tool declaration; set `["lock"]` or `["timeout"]` on the result when needed.
pub fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({ "name": name, "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false } })
}
pub fn s(d: &str) -> Value { json!({ "type": "string", "description": d }) }
pub fn n(d: &str) -> Value { json!({ "type": "number", "description": d }) }

static UPDATING: AtomicBool = AtomicBool::new(false);

/// Serve the device forever: hello, take calls, answer them (each call on its own thread).
pub fn run(c: Conf, node: Node, handle: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static) -> ! {
    let (c, handle) = (Arc::new(c), Arc::new(handle));
    let hello = json!({ "id": c.id, "kind": node.kind, "name": node.name, "version": DEVICES, "notes": node.notes, "tools": node.tools });
    let mut last_hello = Instant::now() - Duration::from_secs(3600);
    let mut tried = (String::new(), Instant::now());
    loop {
        if last_hello.elapsed() > Duration::from_secs(60) {
            match call(&c, "POST", "/api/node/hello", Some(&hello), 20) {
                Ok((200, v)) => {
                    last_hello = Instant::now();
                    let want = v["version"].as_str().unwrap_or("").to_string();
                    let again = tried.0 != want || tried.1.elapsed() > Duration::from_secs(600);
                    // On its own thread: on a slow line it takes minutes, and calls keep coming meanwhile.
                    if !want.is_empty() && !want.starts_with(DEVICES) && !DEVICES.starts_with(want.as_str()) && again && !UPDATING.swap(true, SeqCst) {
                        tried = (want.clone(), Instant::now());
                        let package = node.package;
                        std::thread::spawn(move || {
                            if let Err(e) = download(package, &want) { eprintln!("update to {want}: {e}"); }
                            UPDATING.store(false, SeqCst);
                        });
                    }
                }
                Ok((st, v)) => { eprintln!("hello: {st} {v}"); std::thread::sleep(Duration::from_secs(10)); continue; }
                Err(e) => { eprintln!("hello: {e}"); std::thread::sleep(Duration::from_secs(10)); continue; }
            }
        }
        match call(&c, "GET", &format!("/api/node/next?id={}", c.id), None, 40) {
            Ok((200, job)) => {
                let (c, handle) = (c.clone(), handle.clone());
                std::thread::spawn(move || {
                    let result = match handle(job["tool"].as_str().unwrap_or(""), &job["args"]) { Ok(v) => v, Err(e) => json!({ "error": e }) };
                    for _ in 0..3 {
                        if call(&c, "POST", "/api/node/result", Some(&json!({ "id": job["id"], "result": result })), 120).is_ok() { break; }
                        std::thread::sleep(Duration::from_secs(2));
                    }
                });
            }
            Ok((204, _)) => {}
            Ok((st, v)) => { eprintln!("next: {st} {v}"); std::thread::sleep(Duration::from_secs(5)); }
            Err(e) => { eprintln!("next: {e}"); std::thread::sleep(Duration::from_secs(5)); }
        }
    }
}

/// The Mac app this program runs inside (Hive.app), if it does: updates replace the whole app so its signature stays whole.
fn app() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") { return None; }
    std::env::current_exe().ok()?.ancestors().find(|d| d.extension().is_some_and(|x| x == "app")).map(PathBuf::from)
}

/// A device, or a server with no checkout: fetch GitHub's build of version `want` and swap it in for this one.
pub fn download(package: &str, want: &str) -> Result<(), String> {
    if let Some(app) = app() { return download_app(&app, package, want); }
    let name = match std::env::consts::OS {
        "macos" => format!("{package}-macos"), "windows" => format!("{package}-windows.exe"),
        "linux" => format!("{package}-linux-{}", std::env::consts::ARCH), os => return Err(format!("no downloads for {os}")),
    };
    let r = release(&name)?;
    let mut bytes = Vec::new();
    r.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let new = exe.with_extension(if cfg!(windows) { "new.exe" } else { "new" });
    std::fs::write(&new, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).ok(); }
    let got = std::process::Command::new(&new).arg("--version").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    if got.is_empty() || !(got.starts_with(want) || want.starts_with(got.as_str())) {
        std::fs::remove_file(&new).ok();
        return Err(format!("GitHub's build is {got:?}, not {want} yet; trying again in 10 minutes"));
    }
    #[cfg(windows)]
    { let old = exe.with_extension("old.exe"); std::fs::remove_file(&old).ok(); std::fs::rename(&exe, &old).map_err(|e| e.to_string())?; }
    std::fs::rename(&new, &exe).map_err(|e| e.to_string())?;
    restart(exe)
}

/// A downloaded Mac app: unpack GitHub's Hive-Mac.zip next to this one and swap the whole app.
fn download_app(app: &std::path::Path, package: &str, want: &str) -> Result<(), String> {
    let r = release("Hive-Mac.zip")?;
    let mut bytes = Vec::new();
    r.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let dir = app.with_extension("update");
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("Hive-Mac.zip"), bytes).map_err(|e| e.to_string())?;
    let new = dir.join("Hive.app");
    let exe = |a: &std::path::Path| a.join("Contents/MacOS").join(package);
    let unzipped = std::process::Command::new("ditto").args(["-x", "-k"]).arg(dir.join("Hive-Mac.zip")).arg(&dir).status().map_err(|e| e.to_string())?;
    let got = std::process::Command::new(exe(&new)).arg("--version").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    if !unzipped.success() || got.is_empty() || !(got.starts_with(want) || want.starts_with(got.as_str())) {
        std::fs::remove_dir_all(&dir).ok();
        return Err(format!("GitHub's build is {got:?}, not {want} yet; trying again in 10 minutes"));
    }
    let old = app.with_extension("old");
    std::fs::remove_dir_all(&old).ok();
    std::fs::rename(app, &old).and_then(|_| std::fs::rename(&new, app)).map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(&old).ok();
    std::fs::remove_dir_all(&dir).ok();
    // Through Launch Services, so macOS sees the app start (exec'd in place, it gets no menu bar item).
    std::process::Command::new("open").args(["-n", "-g", "-j"]).arg(app).status().map_err(|e| e.to_string())?;
    std::process::exit(0)
}

fn restart(exe: PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(exe).args(std::env::args().skip(1)).exec();
        return Err(e.to_string());
    }
    #[allow(unreachable_code)]
    {
        std::process::Command::new(exe).args(std::env::args().skip(1)).spawn().map_err(|e| e.to_string())?;
        std::process::exit(0)
    }
}
