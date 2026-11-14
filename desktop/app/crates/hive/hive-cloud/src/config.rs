//! Where Hive Cloud keeps its own settings and secrets on this device.
//!
//! Settings: `<state>/cloud/config.json` (the cloud's address, this device's ID and name).
//! Secrets (the device token and the account key): the macOS login Keychain, service
//! "Hive Cloud". They are passed to `security` over a pipe, never on a command line. Tests and
//! headless Linux set `HIVE_CLOUD_SECRETS_DIR` to keep them in private files instead.
//! The `cloud` folder is never uploaded.
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn cloud_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("HIVE_CLOUD_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    hive_common::state_dir().join("cloud")
}

#[derive(Clone, Debug)]
pub struct Config {
    pub url: String,
    pub device_id: String,
    pub device_name: String,
    pub key_check: String,
    pub enrolled_at: i64,
}

impl Config {
    pub fn path() -> PathBuf {
        cloud_dir().join("config.json")
    }

    pub fn load() -> Result<Option<Config>, String> {
        let path = Self::path();
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("reading {}: {e}", path.display())),
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("{} is damaged: {e}", path.display()))?;
        let s = |k: &str| v[k].as_str().map(String::from).ok_or_else(|| format!("{} has no {k}", path.display()));
        Ok(Some(Config {
            url: s("url")?,
            device_id: s("deviceId")?,
            device_name: s("deviceName")?,
            key_check: s("keyCheck")?,
            enrolled_at: v["enrolledAt"].as_i64().unwrap_or(0),
        }))
    }

    pub fn save(&self) -> Result<(), String> {
        let value = json!({
            "url": self.url, "deviceId": self.device_id, "deviceName": self.device_name,
            "keyCheck": self.key_check, "enrolledAt": self.enrolled_at,
        });
        write_private(&Self::path(), serde_json::to_string_pretty(&value).unwrap().as_bytes())
    }
}

/// Write a file only this user can read, atomically.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let tmp = dir.join(format!(".{}.tmp-{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("saving {}: {e}", path.display()))
}

pub enum Secrets {
    Keychain,
    Files(PathBuf),
}

const SERVICE: &str = "Hive Cloud";

impl Secrets {
    pub fn system() -> Secrets {
        match std::env::var_os("HIVE_CLOUD_SECRETS_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => Secrets::Files(PathBuf::from(dir)),
            None if cfg!(target_os = "macos") => Secrets::Keychain,
            None => Secrets::Files(cloud_dir().join("secrets")),
        }
    }

    fn account(host: &str, name: &str) -> String {
        format!("{host} {name}")
    }

    pub fn set(&self, host: &str, name: &str, value: &str) -> Result<(), String> {
        if !value.chars().all(|c| c.is_ascii_alphanumeric() || "-_+/=".contains(c)) {
            return Err("secret values are base64 or hex".into());
        }
        match self {
            Secrets::Files(dir) => write_private(&dir.join(Self::account(host, name).replace(['/', ' ', ':'], "_")), value.as_bytes()),
            Secrets::Keychain => {
                let account = Self::account(host, name);
                if account.contains('"') {
                    return Err("bad account name".into());
                }
                let mut child = Command::new("/usr/bin/security")
                    .arg("-i")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("starting security: {e}"))?;
                let line = format!("add-generic-password -U -s \"{SERVICE}\" -a \"{account}\" -w \"{value}\"\n");
                child.stdin.take().unwrap().write_all(line.as_bytes()).map_err(|e| format!("talking to security: {e}"))?;
                let out = child.wait_with_output().map_err(|e| format!("security: {e}"))?;
                if !out.status.success() || !out.stderr.is_empty() {
                    return Err(format!("the Keychain refused to save {name}: {}", String::from_utf8_lossy(&out.stderr).trim()));
                }
                Ok(())
            }
        }
    }

    pub fn get(&self, host: &str, name: &str) -> Result<String, String> {
        match self {
            Secrets::Files(dir) => std::fs::read_to_string(dir.join(Self::account(host, name).replace(['/', ' ', ':'], "_")))
                .map(|s| s.trim().to_string())
                .map_err(|_| format!("this device has no saved Hive Cloud {name}")),
            Secrets::Keychain => {
                let out = Command::new("/usr/bin/security")
                    .args(["find-generic-password", "-s", SERVICE, "-a", &Self::account(host, name), "-w"])
                    .output()
                    .map_err(|e| format!("starting security: {e}"))?;
                if !out.status.success() {
                    return Err(format!("this device has no saved Hive Cloud {name} in the Keychain"));
                }
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
        }
    }

    pub fn delete(&self, host: &str, name: &str) {
        match self {
            Secrets::Files(dir) => {
                let _ = std::fs::remove_file(dir.join(Self::account(host, name).replace(['/', ' ', ':'], "_")));
            }
            Secrets::Keychain => {
                let _ = Command::new("/usr/bin/security")
                    .args(["delete-generic-password", "-s", SERVICE, "-a", &Self::account(host, name)])
                    .output();
            }
        }
    }
}

pub fn device_name() -> String {
    if let Ok(out) = Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name.chars().take(80).collect();
        }
    }
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes into buf.
    if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0 {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        return String::from_utf8_lossy(&buf[..end]).chars().take(80).collect();
    }
    "Hive device".into()
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
