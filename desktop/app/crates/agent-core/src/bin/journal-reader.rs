use serde_json::Value;
use std::{fs::File, io::{self, BufRead, BufReader}, path::Path, process};

fn read_journal(path: &Path) -> io::Result<Vec<Value>> {
    let file = File::open(path.join("journal.jsonl"))?;
    let mut entries = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if let Ok(entry) = serde_json::from_str(&line) { entries.push(entry); }
    }
    Ok(entries)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&#x27;")
}

fn display_json(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(display_json).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}: {}", serde_json::to_string(k).unwrap(), display_json(v))).collect::<Vec<_>>().join(", ")),
        _ => v.to_string(),
    }
}

fn line(entry: &Value) -> Result<String, &'static str> {
    let obj = entry.as_object().ok_or("entry must be an object")?;
    let timestamp = obj.get("time").and_then(Value::as_f64).ok_or("missing time")?;
    let seconds = timestamp.floor() as libc::time_t;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::localtime_r(&seconds, tm.as_mut_ptr()) }.is_null() { return Err("invalid time"); }
    let tm = unsafe { tm.assume_init() };
    let kind = obj.get("kind").and_then(Value::as_str).ok_or("missing kind")?;
    let text = obj.get("text").and_then(Value::as_str).unwrap_or("");
    let label = match kind {
        "you said" => "🗣", "agent said" => "💬", "agent spoke" => "🔊", "action" => "→", "error" => "✗",
        "done" => "✅", "failed" => "❌", "request" => "▶", "dictation" => "✍️", _ => "·"
    };
    let extra: serde_json::Map<String, Value> = obj.iter().filter(|(k, _)| !["time", "kind", "text"].contains(&k.as_str())).map(|(k,v)| (k.clone(), v.clone())).collect();
    let detail = if extra.is_empty() { String::new() } else { format!("  {}", display_json(&Value::Object(extra))) };
    Ok(format!("{:02}:{:02}:{:02}  {} {}: {}{}", tm.tm_hour, tm.tm_min, tm.tm_sec, label, kind, text, detail))
}

const STYLE: &str = "body{font:15px system-ui;margin:32px;max-width:1100px}li{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}code{background:#eee;color:#111;padding:1px 4px}a{color:#1466ba}";
fn page(title: &str, body: &str) -> String {
    let title = escape(title);
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><meta http-equiv=\"refresh\" content=\"5\"><title>{title}</title><style>{STYLE}</style></head><body><h1>{title}</h1>{body}</body></html>")
}
fn session_page(input: &Value) -> Result<String, &'static str> {
    let manifest = input.get("manifest").and_then(Value::as_object).ok_or("missing manifest")?;
    let entries = input.get("entries").and_then(Value::as_array).ok_or("missing entries")?;
    let id = manifest.get("session").and_then(Value::as_str).ok_or("missing session")?;
    let mut threads = String::new();
    if let Some(list) = manifest.get("threads").and_then(Value::as_array) {
        for thread in list {
            let id = thread.get("thread").and_then(Value::as_str).ok_or("invalid thread")?;
            let rollout = thread.get("rollout").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("(not saved yet)");
            threads.push_str(&format!("<li>Codex thread <code>{}</code>: full context in <code>{}</code></li>", escape(id), escape(rollout)));
        }
    }
    let code = match manifest.get("code") { None | Some(Value::Null) => "None".to_owned(), Some(Value::String(s)) => s.clone(), Some(v) => display_json(v) };
    let mut body = format!("<p><a href=\"../index.html\">All sessions</a> · <a href=\"journal.jsonl\">journal.jsonl</a> · <a href=\"manifest.json\">manifest.json</a> · <a href=\"../../context/index.html\">Every payload (context viewer)</a></p><p>Code: <code>{}</code></p><ul>{threads}</ul><ol>", escape(&code));
    for entry in entries { body.push_str(&format!("<li>{}</li>", escape(&line(entry)?))); }
    body.push_str("</ol>");
    Ok(page(&format!("Session {id}"), &body))
}

fn sessions_page(directory: &Path) -> io::Result<String> {
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if !kind.is_dir() || kind.is_symlink() { continue; }
        let Ok(data) = std::fs::read(entry.path().join("manifest.json")) else { continue; };
        let Ok(manifest) = serde_json::from_slice::<Value>(&data) else { continue; };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue; };
        let backend = match manifest.get("backend") {
            None => String::new(), Some(Value::String(s)) => s.clone(), Some(Value::Null) => "None".into(),
            Some(v) => display_json(v),
        };
        sessions.push((name, backend));
    }
    sessions.sort_by(|a,b| b.0.cmp(&a.0));
    let items = sessions.into_iter().map(|(name, backend)| {
        let name = escape(&name);
        format!("<li><a href=\"{name}/index.html\">{name}</a> · {}</li>", escape(&backend))
    }).collect::<String>();
    Ok(page("Agent sessions", &format!("<ol>{items}</ol>")))
}

fn initialize_journal(input: &Value) -> Result<Value, &'static str> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let directory = input.get("directory").and_then(Value::as_str).ok_or("missing directory")?;
    let path = Path::new(directory);
    let mut builder = std::fs::DirBuilder::new();
    use std::os::unix::fs::DirBuilderExt;
    builder.recursive(true).mode(0o700).create(path).map_err(|_| "directory creation failed")?;
    let parent = path.parent().ok_or("missing parent")?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(|_| "parent permissions failed")?;
    let journal = path.join("journal.jsonl");
    let file = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&journal).map_err(|_| "journal creation failed")?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|_| "journal permissions failed")?;
    Ok(Value::Null)
}

fn save_manifest(input: &Value) -> Result<Value, &'static str> {
    let directory = input.get("directory").and_then(Value::as_str).ok_or("missing directory")?;
    let mut manifest = input.get("manifest").and_then(Value::as_object).cloned().ok_or("missing manifest")?;
    let threads = input.get("threads").and_then(Value::as_array).ok_or("missing threads")?;
    manifest.insert("threads".into(), Value::Array(threads.clone()));
    let value = Value::Object(manifest);
    let bytes = serde_json::to_vec_pretty(&value).map_err(|_| "invalid manifest")?;
    personal_agent_core::thread_identity::atomic_write_standard(&Path::new(directory).join("manifest.json"), &bytes).map_err(|_| "manifest write failed")?;
    Ok(value)
}

fn append_journal(fd: i32, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::fd::FromRawFd;
    if fd < 0 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid descriptor")); }
    // The caller passes a duplicate descriptor to this child process. Closing it
    // here cannot close the Python owner's descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(data)?;
    file.sync_all()
}

fn main() {
    let arg = std::env::args_os().nth(1);
    if arg.as_deref() == Some(std::ffi::OsStr::new("--append")) {
        use std::io::Read;
        let result = std::env::args().nth(2).and_then(|n| n.parse::<i32>().ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing descriptor"))
            .and_then(|fd| { let mut data = Vec::new(); io::stdin().read_to_end(&mut data)?; append_journal(fd, &data) });
        if result.is_err() { eprintln!("Journal append failed"); process::exit(1); }
        return;
    }
    let result: Result<Value, String> = if arg.as_deref() == Some(std::ffi::OsStr::new("--render")) {
        serde_json::from_reader::<_, Value>(io::stdin().lock()).map_err(|_| "invalid input".to_string()).and_then(|input| {
            match input.get("op").and_then(Value::as_str) {
                Some("line") => line(&input["entry"]).map(Value::String),
                Some("save_manifest") => save_manifest(&input),
                Some("initialize") => initialize_journal(&input),
                Some("session_page") => session_page(&input).map(Value::String),
                Some("sessions_page") => input.get("directory").and_then(Value::as_str).ok_or("missing directory").and_then(|dir| sessions_page(Path::new(dir)).map(Value::String).map_err(|_| "directory unavailable")),
                _ => Err("invalid operation"),
            }.map_err(str::to_string)
        })
    } else {
        arg.ok_or_else(|| "missing path".to_string()).and_then(|path| read_journal(Path::new(&path)).map(Value::Array).map_err(|_| "read failed".to_string()))
    };
    match result {
        Ok(value) => { if serde_json::to_writer(io::stdout().lock(), &value).is_err() { process::exit(1); } }
        Err(_) => { eprintln!("Journal operation failed"); process::exit(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_valid_entries_in_order_and_skips_crash_fragments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("journal.jsonl"), "{\"kind\":\"one\"}\n{\"kind\":\"two\",\"text\":\"雪\"}\n{\"cut\":\n").unwrap();
        let entries = read_journal(dir.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["kind"], "one");
        assert_eq!(entries[1]["text"], "雪");
    }
    #[test]
    fn session_page_escapes_content_and_renders_thread_and_entry() {
        let input = serde_json::json!({"manifest":{"session":"id<&", "code":"<dirty>", "threads":[{"thread":"a&b", "rollout":null}]}, "entries":[{"time":0,"kind":"you said","text":"<script>雪</script>","meta":{"value":"&"}}]});
        let html = session_page(&input).unwrap();
        assert!(html.contains("Session id&lt;&amp;"));
        assert!(html.contains("a&amp;b"));
        assert!(html.contains("(not saved yet)"));
        assert!(html.contains("&lt;script&gt;雪&lt;/script&gt;"));
        assert!(html.contains("&quot;meta&quot;: {&quot;value&quot;: &quot;&amp;&quot;}"));
        assert!(!html.contains("<script>"));
        assert!(html.contains("default-src 'none'"));
    }
    #[test]
    fn line_uses_local_time_and_preserves_extra_fields() {
        let value = serde_json::json!({"time":0,"kind":"action","text":"go", "ok":true});
        let rendered = line(&value).unwrap();
        assert!(rendered.contains("  → action: go  {\"ok\": true}"));
        assert!(line(&serde_json::json!({"kind":"error"})).is_err());
    }
    #[test]
    fn sessions_index_ignores_symlinks_and_invalid_manifests() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["old", "new", "invalid"] { std::fs::create_dir(dir.path().join(name)).unwrap(); }
        std::fs::write(dir.path().join("old/manifest.json"), r#"{"backend":"<old>"}"#).unwrap();
        std::fs::write(dir.path().join("new/manifest.json"), r#"{"backend":"new"}"#).unwrap();
        std::fs::write(dir.path().join("invalid/manifest.json"), b"{").unwrap();
        std::os::unix::fs::symlink("new", dir.path().join("latest")).unwrap();
        let html = sessions_page(dir.path()).unwrap();
        assert!(html.contains("&lt;old&gt;"));
        assert!(html.find("old/index.html").unwrap() < html.find("new/index.html").unwrap());
        assert!(!html.contains("latest/index.html"));
        assert!(!html.contains("invalid/index.html"));
    }
    #[test]
    fn append_writes_to_open_descriptor_without_replacing_file() {
        use std::os::fd::IntoRawFd;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        std::fs::write(&path, b"before\n").unwrap();
        let file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        append_journal(file.into_raw_fd(), "{\"text\": \"雪\"}\n".as_bytes()).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "before\n{\"text\": \"雪\"}\n");
    }
    #[test]
    fn initializes_private_journal_without_truncating_existing_data() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("sessions/run");
        let input = serde_json::json!({"directory": session.to_str().unwrap()});
        initialize_journal(&input).unwrap();
        std::fs::write(session.join("journal.jsonl"), b"existing\n").unwrap();
        initialize_journal(&input).unwrap();
        assert_eq!(std::fs::read(session.join("journal.jsonl")).unwrap(), b"existing\n");
        for path in [&session, &session.join("journal.jsonl"), &dir.path().join("sessions")] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert!(mode == 0o700 || mode == 0o600);
        }
    }
    #[test]
    fn writes_private_manifest_with_threads_and_unicode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let input = serde_json::json!({"directory":dir.path().to_str().unwrap(),"manifest":{"session":"雪", "threads":[]},"threads":[{"thread":"abc","rollout":null}]});
        let written = save_manifest(&input).unwrap();
        let path = dir.path().join("manifest.json");
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(), written);
        assert_eq!(written["threads"][0]["thread"], "abc");
        assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".pending-")));
    }
    #[test]
    fn missing_or_invalid_utf8_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_journal(dir.path()).is_err());
        std::fs::write(dir.path().join("journal.jsonl"), [0xff, b'\n']).unwrap();
        assert!(read_journal(dir.path()).is_err());
    }
}
