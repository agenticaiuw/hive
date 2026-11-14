//! Bounded provider availability checks through the user's configured HTTPS proxy
//! (python/provider_wait.py).
//!
//! `<state>/provider-wait.json` (`{"version": 1, "identity", "checks", "next", "resolved"?}`, with
//! `provider-wait.json.lock` beside it) records the wait for one saved request, so a restart
//! neither loses it nor checks more often than every [`INTERVAL_SECONDS`], and gives up after
//! [`MAX_CHECKS`].

use crate::util::{unix_time, AgentError, Env};
use hive_common::atomic_write;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub const INTERVAL_SECONDS: f64 = 300.0;
/// No more than 24 hours of checks.
pub const MAX_CHECKS: i64 = 288;

/// What `reserve` decided (Python's `{'state': ...}`).
#[derive(Debug, Clone, PartialEq)]
pub enum Reservation {
    /// A check may be made now; it has been counted.
    Check,
    /// The next check is due in `delay` seconds (at most [`INTERVAL_SECONDS`]).
    Waiting { delay: f64 },
    /// [`MAX_CHECKS`] were made.
    Expired,
}

fn path(dir: &Path) -> PathBuf {
    dir.join("provider-wait.json")
}

/// `<path>.lock`, held (flock) until dropped.
struct Locked(File);

impl Locked {
    fn take(dir: &Path) -> Result<Locked, AgentError> {
        use std::os::fd::AsRawFd;
        let mut name = path(dir).into_os_string();
        name.push(".lock");
        let file = OpenOptions::new()
            .append(true)
            .read(true)
            .create(true)
            .open(PathBuf::from(name))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Locked(file))
    }
}

impl Drop for Locked {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn invalid() -> AgentError {
    AgentError::Value("invalid provider wait state".into())
}

/// The record, None if there is none; `ValueError` if it isn't valid JSON.
fn read(dir: &Path) -> Result<Option<Value>, AgentError> {
    match std::fs::read(path(dir)) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes).map_err(|e| AgentError::Value(e.to_string()))?;
            serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| AgentError::Value(e.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The record when it is a version-1 object (else `ValueError`).
fn read_valid(dir: &Path) -> Result<Option<Value>, AgentError> {
    let record = read(dir)?;
    if let Some(r) = &record {
        if !r.is_object() || r.get("version") != Some(&json!(1)) {
            return Err(invalid());
        }
    }
    Ok(record)
}

fn write(dir: &Path, record: &Value) -> Result<(), AgentError> {
    let text = format!("{}\n", crate::py::dumps(record, true));
    atomic_write(&path(dir), text.as_bytes()).map_err(|e| AgentError::Os(e.to_string()))
}

fn prepare(dir: &Path) -> Result<(), AgentError> {
    crate::task_recovery::make_private_dir(dir)
}

/// Persists a wait without making a network request or consuming a check.
pub fn arm(dir: &Path, identity: &str, now: Option<f64>) -> Result<bool, AgentError> {
    let now = now.unwrap_or_else(unix_time);
    prepare(dir)?;
    let _lock = Locked::take(dir)?;
    let record = read_valid(dir)?;
    if let Some(r) = record.filter(|r| r.get("identity").and_then(Value::as_str) == Some(identity))
    {
        return Ok(!crate::py::truthy(r.get("resolved")));
    }
    write(
        dir,
        &json!({"version": 1, "identity": identity, "checks": 0, "next": now}),
    )?;
    Ok(true)
}

/// Persists the next check before it is made, so crashes cannot cause a tight loop. `arm`:
/// start (or restart) the wait if there is none for `identity`.
pub fn reserve(
    dir: &Path,
    identity: &str,
    now: Option<f64>,
    arm: bool,
) -> Result<Option<Reservation>, AgentError> {
    let now = now.unwrap_or_else(unix_time);
    prepare(dir)?;
    let _lock = Locked::take(dir)?;
    let record = read_valid(dir)?;
    let mut record = match record {
        Some(r)
            if crate::py::truthy(Some(&r))
                && r.get("identity").and_then(Value::as_str) == Some(identity) =>
        {
            if crate::py::truthy(r.get("resolved")) {
                if !arm {
                    return Ok(None);
                }
                let mut r = r;
                r["resolved"] = json!(false);
                write(dir, &r)?;
                r
            } else {
                r
            }
        }
        _ => {
            if !arm {
                return Ok(None);
            }
            json!({"version": 1, "identity": identity, "checks": 0, "next": now})
        }
    };
    let checks = record
        .get("checks")
        .filter(|c| c.is_i64() || c.is_u64())
        .and_then(Value::as_i64);
    let due = record.get("next").and_then(Value::as_f64);
    let (Some(checks), Some(due)) = (checks, due) else {
        return Err(invalid());
    };
    if checks >= MAX_CHECKS {
        return Ok(Some(Reservation::Expired));
    }
    if now < due {
        return Ok(Some(Reservation::Waiting {
            delay: INTERVAL_SECONDS.min(due - now),
        }));
    }
    record["checks"] = json!(checks + 1);
    record["next"] = json!(now + INTERVAL_SECONDS);
    write(dir, &record)?;
    Ok(Some(Reservation::Check))
}

/// A wait for `identity` that hasn't been resolved.
pub fn exists(dir: &Path, identity: &str) -> Result<bool, AgentError> {
    Ok(status(dir, identity)? == Some("waiting"))
}

/// "waiting", "resolved", or None if there's no wait for `identity`.
pub fn status(dir: &Path, identity: &str) -> Result<Option<&'static str>, AgentError> {
    let Some(record) = read_valid(dir)? else {
        return Ok(None);
    };
    if record.get("identity").and_then(Value::as_str) != Some(identity) {
        return Ok(None);
    }
    Ok(Some(if crate::py::truthy(record.get("resolved")) {
        "resolved"
    } else {
        "waiting"
    }))
}

/// Marks the wait for `identity` resolved: its continuation goes ahead, once.
pub fn resolve(dir: &Path, identity: &str) -> Result<bool, AgentError> {
    let _lock = Locked::take(dir)?;
    let Some(mut record) = read(dir)? else {
        return Err(AgentError::Os(format!(
            "No such file or directory: '{}'",
            path(dir).display()
        )));
    };
    if !record.is_object() {
        return Err(invalid());
    }
    if record.get("identity").and_then(Value::as_str) != Some(identity) {
        return Ok(false);
    }
    record["resolved"] = json!(true);
    write(dir, &record)?;
    Ok(true)
}

/// A closed or unknown workspace viewer must never be reopened by recovery
/// (`<state>/workspace-viewer-visible` holds "1" while it is open).
pub fn workspace_is_open(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("workspace-viewer-visible"))
        .map(|t| crate::py::strip(&t) == "1")
        .unwrap_or(false)
}

/// Probes chatgpt.com only via the configured HTTPS proxy; never falls back to a direct
/// connection. The proxy is `https_proxy` (any `*_proxy` variable turns the system settings off,
/// as in Python's `urllib.request.getproxies()`), else the system's HTTPS proxy.
pub fn reachable(env: &Env) -> bool {
    let Some(proxy) = https_proxy(env) else {
        return false;
    };
    let Some((host, port)) = proxy_address(&proxy) else {
        return false;
    };
    probe(&host, port)
}

/// `http://host[:port]` without credentials, as (host, port); None for anything else.
pub(crate) fn proxy_address(proxy: &str) -> Option<(String, u16)> {
    let url = if proxy.contains("://") {
        proxy.to_owned()
    } else {
        format!("http://{proxy}")
    };
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let netloc = rest.split(['/', '?', '#']).next().unwrap_or("");
    if netloc.contains('@') {
        return None; // credentials
    }
    let (host, port) = if let Some(inner) = netloc.strip_prefix('[') {
        let (host, after) = inner.split_once(']')?;
        (host.to_owned(), after.strip_prefix(':'))
    } else {
        match netloc.rsplit_once(':') {
            Some((host, port)) => (host.to_owned(), Some(port)),
            None => (netloc.to_owned(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = match port {
        None | Some("") => 80,
        Some(p) => p.parse().ok()?,
    };
    Some((host.to_lowercase(), port))
}

fn probe(host: &str, port: u16) -> bool {
    let address = if host.contains(':') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    };
    let Ok(proxy) = ureq::Proxy::new(address) else {
        return false;
    };
    let agent = ureq::AgentBuilder::new()
        .proxy(proxy)
        .timeout(std::time::Duration::from_secs(8))
        .redirects(0)
        .build();
    match agent.head("https://chatgpt.com/").call() {
        Ok(response) => (200..400).contains(&response.status()),
        Err(_) => false,
    }
}

/// The HTTPS proxy, as Python's `urllib.request.getproxies().get('https')` finds it.
pub(crate) fn https_proxy(env: &Env) -> Option<String> {
    let from_env = environment_proxies(env);
    if !from_env.is_empty() {
        return from_env
            .into_iter()
            .find(|(k, _)| k == "https")
            .map(|(_, v)| v);
    }
    system_https_proxy()
}

/// `getproxies_environment()`: every `*_proxy` variable, lower-case names winning.
fn environment_proxies(env: &Env) -> Vec<(String, String)> {
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .collect();
    names.extend(env.overridden());
    names.sort();
    names.dedup();
    names.retain(|name| env.raw(name).is_some());
    let mut proxies: Vec<(String, String)> = Vec::new();
    let put = |proxies: &mut Vec<(String, String)>, key: String, value: Option<String>| {
        proxies.retain(|(k, _)| *k != key);
        if let Some(v) = value {
            proxies.push((key, v));
        }
    };
    // First pass: any case; then lower-case names override (and an empty one removes).
    for name in &names {
        let value = env.raw(name).unwrap_or_default();
        let lower = name.to_lowercase();
        if !value.is_empty() && lower.ends_with("_proxy") {
            put(
                &mut proxies,
                lower[..lower.len() - 6].to_owned(),
                Some(value),
            );
        }
    }
    if env.raw("REQUEST_METHOD").is_some() {
        proxies.retain(|(k, _)| k != "http");
    }
    for name in &names {
        if name.ends_with("_proxy") {
            let value = env.raw(name).unwrap_or_default();
            let lower = name.to_lowercase();
            let key = lower[..lower.len() - 6].to_owned();
            put(&mut proxies, key, (!value.is_empty()).then_some(value));
        }
    }
    proxies
}

#[cfg(target_os = "macos")]
fn system_https_proxy() -> Option<String> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    #[link(name = "SystemConfiguration", kind = "framework")]
    extern "C" {
        fn SCDynamicStoreCopyProxies(store: *const std::ffi::c_void) -> CFDictionaryRef;
    }
    let raw = unsafe { SCDynamicStoreCopyProxies(std::ptr::null()) };
    if raw.is_null() {
        return None;
    }
    let proxies: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let get = |key: &str| proxies.find(CFString::new(key)).map(|v| v.clone());
    let enabled = get("HTTPSEnable")
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_i32())
        .unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let host = get("HTTPSProxy")
        .and_then(|v| v.downcast::<CFString>())?
        .to_string();
    Some(
        match get("HTTPSPort")
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i32())
        {
            Some(port) => format!("http://{host}:{port}"),
            None => format!("http://{host}"),
        },
    )
}

#[cfg(not(target_os = "macos"))]
fn system_https_proxy() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // tests/test_provider_wait.py

    #[test]
    fn checks_persist_and_are_rate_limited() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        assert_eq!(
            reserve(dir, "one", Some(100.0), true).unwrap(),
            Some(Reservation::Check)
        );
        assert_eq!(
            reserve(dir, "one", Some(101.0), true).unwrap(),
            Some(Reservation::Waiting { delay: 299.0 })
        );
        assert!(exists(dir, "one").unwrap());
        assert_eq!(
            reserve(dir, "one", Some(400.0), false).unwrap(),
            Some(Reservation::Check)
        );
        assert!(resolve(dir, "one").unwrap());
        assert!(!exists(dir, "one").unwrap());
        assert_eq!(
            reserve(dir, "one", Some(401.0), true).unwrap(),
            Some(Reservation::Waiting { delay: 299.0 })
        );
        assert!(exists(dir, "one").unwrap());
    }

    #[test]
    fn arm_keeps_an_existing_wait_and_reports_resolution() {
        let d = tempfile::tempdir().unwrap();
        assert!(arm(d.path(), "one", Some(100.0)).unwrap());
        assert_eq!(
            reserve(d.path(), "one", Some(100.0), false).unwrap(),
            Some(Reservation::Check)
        );
        assert!(arm(d.path(), "one", Some(500.0)).unwrap()); // not reset: still one check used
        resolve(d.path(), "one").unwrap();
        assert!(!arm(d.path(), "one", Some(600.0)).unwrap());
        assert_eq!(status(d.path(), "other").unwrap(), None);
    }

    #[test]
    fn expires_after_the_last_check() {
        let d = tempfile::tempdir().unwrap();
        let record = json!({"version": 1, "identity": "one", "checks": MAX_CHECKS, "next": 0});
        std::fs::write(d.path().join("provider-wait.json"), record.to_string()).unwrap();
        assert_eq!(
            reserve(d.path(), "one", Some(100.0), false).unwrap(),
            Some(Reservation::Expired)
        );
    }

    #[test]
    fn invalid_state_is_a_value_error() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("provider-wait.json"), "{\"version\": 2}").unwrap();
        assert!(matches!(
            reserve(d.path(), "one", None, true),
            Err(AgentError::Value(_))
        ));
        assert!(matches!(status(d.path(), "one"), Err(AgentError::Value(_))));
    }

    #[test]
    fn never_attempts_direct_network_when_proxy_missing() {
        // (Python checked that no connection was made; here no proxy means no address to use.)
        assert_eq!(proxy_address(""), None);
        let env = Env::default();
        env.set("https_proxy", "");
        env.set("no_proxy", "localhost");
        assert_eq!(https_proxy(&env), None); // a *_proxy variable means the system settings aren't read
    }

    #[test]
    fn probe_uses_proxy_tunnel_without_credentials() {
        assert_eq!(
            proxy_address("http://127.0.0.1:7769"),
            Some(("127.0.0.1".into(), 7769))
        );
        assert_eq!(
            proxy_address("127.0.0.1:7769"),
            Some(("127.0.0.1".into(), 7769))
        );
        assert_eq!(
            proxy_address("http://proxy.local"),
            Some(("proxy.local".into(), 80))
        );
        assert_eq!(proxy_address("http://user:pass@127.0.0.1:7769"), None);
        assert_eq!(proxy_address("https://127.0.0.1:7769"), None);
        assert_eq!(proxy_address("socks5://127.0.0.1:1080"), None);
        let env = Env::default();
        env.set("https_proxy", "http://127.0.0.1:7769");
        assert_eq!(https_proxy(&env).as_deref(), Some("http://127.0.0.1:7769"));
    }

    #[test]
    fn probe_sends_connect_for_chatgpt_through_the_proxy() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut writer = stream;
            // Refuse the tunnel: the probe must report unreachable, never connect directly.
            let _ = writer.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            line
        });
        let env = Env::default();
        env.set("https_proxy", format!("http://127.0.0.1:{port}"));
        assert!(!reachable(&env));
        assert!(seen.join().unwrap().starts_with("CONNECT chatgpt.com:443 "));
    }
}
