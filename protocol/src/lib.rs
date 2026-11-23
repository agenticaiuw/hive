//! The node side of the protocol (protocol/README.md), for nodes written in Rust: pair, say hello with your tools,
//! take calls, answer them, and update yourself to GitHub's build when the server's devices' code changes.
pub mod b64;

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("HIVE_GIT");
/// The last change to the devices' own code: devices update only when it moves.
pub const DEVICES: &str = env!("HIVE_DEVICES");
/// Where every device and downloaded server gets each new build: GitHub builds (and signs) one for every push to main.
pub const RELEASES: &str = "https://github.com/agenticaiuw-org/hive/releases/download/latest";

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

/// Trade a pairing code for this device's token and save it (readable only by this user).
pub fn pair(name: &str, server: &str, code: &str, kind: &str, label: &str) -> Result<Conf, String> {
    let server = server.trim().trim_end_matches('/');
    let server = if server.contains("://") { server.to_string() } else { format!("https://{server}") };
    let r = ureq::post(&format!("{server}/api/pair")).set("content-type", "application/json")
        .send_string(&json!({ "code": code.trim(), "kind": kind, "name": label }).to_string());
    let body = match r {
        Ok(r) => r.into_string().unwrap_or_default(),
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(e) => return Err(e.to_string()),
    };
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let token = v["token"].as_str().ok_or_else(|| v["error"].as_str().unwrap_or("pairing failed").to_string())?;
    let id = format!("{kind}-{}", label.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>());
    let path = conf_path(name);
    std::fs::create_dir_all(path.parent().unwrap()).ok();
    std::fs::write(&path, json!({ "server": server, "token": token, "id": id }).to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok(); }
    Ok(Conf { server, token: token.into(), id })
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
                    if !want.is_empty() && !want.starts_with(DEVICES) && !DEVICES.starts_with(want.as_str()) && again {
                        tried = (want.clone(), Instant::now());
                        if let Err(e) = download(node.package, &want) { eprintln!("update to {want}: {e}"); }
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
    let r = ureq::get(&format!("{RELEASES}/{name}")).timeout(Duration::from_secs(300)).call().map_err(|e| e.to_string())?;
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
    let r = ureq::get(&format!("{RELEASES}/Hive-Mac.zip")).timeout(Duration::from_secs(300)).call().map_err(|e| e.to_string())?;
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
