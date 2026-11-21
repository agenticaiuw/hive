//! The one contract between Hive's cloud and every device (desktop, phone, wearable, …). A device:
//!   1. pairs once:        POST /api/pair {code, kind, name} -> {token}   (code from the dashboard's "Pair a device")
//!   2. says hello often:  POST /api/node/hello {id, kind, name, version, notes, tools}
//!      tools = [{name, description, inputSchema, lock?, timeout?}]: everything agents can do with this device.
//!      lock = a name like "input": one agent at a time uses the tools that share it. timeout = seconds (default 120).
//!   3. takes tool calls:  GET /api/node/next?id=  (long poll) -> {id, tool, args}
//!      and answers:       POST /api/node/result {id, result}, result = {text, images?: [data URLs], data?, name?} or {error}
//! Files: an argument named vm_path reaches the device with the file's base64 in `data`; a result with `data` (base64)
//! and `name` is saved into Hive's files and the agent gets its VM path. The browser extension speaks this in JavaScript.
pub mod b64;

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("HIVE_GIT");

pub struct Conf { pub server: String, pub token: String, pub id: String, pub repo: String }

pub struct Node {
    pub kind: &'static str,
    pub name: String,
    /// What agents should know about this device, one or two sentences.
    pub notes: String,
    pub tools: Vec<Value>,
    /// The cargo package to rebuild when Hive's code changes (only if the device has a checkout of Hive).
    pub package: &'static str,
}

pub fn conf_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/hive").join(format!("{name}.json"))
}

pub fn load(name: &str) -> Option<Conf> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(conf_path(name)).ok()?).ok()?;
    Some(Conf {
        server: v["server"].as_str()?.trim_end_matches('/').into(),
        token: v["token"].as_str()?.into(),
        id: v["id"].as_str()?.into(),
        repo: v["repo"].as_str().unwrap_or("").into(),
    })
}

/// Trade a pairing code for this device's token and save it (readable only by this user).
pub fn pair(name: &str, server: &str, code: &str, kind: &str, label: &str, repo: &str) -> Result<Conf, String> {
    let server = server.trim_end_matches('/').to_string();
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
    std::fs::write(&path, json!({ "server": server, "token": token, "id": id, "repo": repo }).to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok(); }
    Ok(Conf { server, token: token.into(), id, repo: repo.into() })
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
    let hello = json!({ "id": c.id, "kind": node.kind, "name": node.name, "version": VERSION, "notes": node.notes, "tools": node.tools });
    let mut last_hello = Instant::now() - Duration::from_secs(3600);
    let mut tried = String::new();
    loop {
        if last_hello.elapsed() > Duration::from_secs(60) {
            match call(&c, "POST", "/api/node/hello", Some(&hello), 20) {
                Ok((200, v)) => {
                    last_hello = Instant::now();
                    let want = v["version"].as_str().unwrap_or("").to_string();
                    if !c.repo.is_empty() && !want.is_empty() && want != VERSION && want != tried {
                        tried = want.clone();
                        if let Err(e) = update(&c, node.package) { eprintln!("update to {want}: {e}"); }
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

/// Hive's code changed on the VM: bring this checkout to it (fast-forward only), rebuild, and restart into the new build.
fn update(c: &Conf, package: &str) -> Result<(), String> {
    let r = ureq::get(&format!("{}/api/git/bundle?have={VERSION}", c.server)).timeout(Duration::from_secs(300))
        .set("authorization", &format!("Bearer {}", c.token)).call().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    r.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let bundle = std::env::temp_dir().join(format!("hive-{}.bundle", std::process::id()));
    std::fs::write(&bundle, bytes).map_err(|e| e.to_string())?;
    let run = |args: &[&str]| -> Result<(), String> {
        let o = std::process::Command::new(args[0]).args(&args[1..]).current_dir(&c.repo).output().map_err(|e| e.to_string())?;
        if o.status.success() { Ok(()) } else { Err(format!("{}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim())) }
    };
    let b = bundle.to_string_lossy().into_owned();
    let fetched = run(&["git", "fetch", &b, "HEAD"]).and_then(|_| run(&["git", "merge", "--ff-only", "FETCH_HEAD"]));
    std::fs::remove_file(&bundle).ok();
    fetched?;
    run(&["cargo", "build", "--release", "-p", package])?;
    let exe = PathBuf::from(&c.repo).join("target/release").join(package);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(exe).args(std::env::args().skip(1)).exec();
        return Err(e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}
