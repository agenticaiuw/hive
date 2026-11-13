//! Local authentication broker (python/credentials.py). Tool arguments/results contain no
//! credentials.
//!
//! Configuration is a native secure-entry sheet; secrets live in macOS Keychain, behind the
//! signed Hive bundle's `Agent --credential ...`. Phone passcodes are bound to the relay and WDA's
//! device UUID, and sent once over HTTPS, never in argv. This does not replace account passwords
//! or OTPs. Nothing here prints or logs a secret; secrets are wiped from memory when dropped.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::process;
use crate::vhid::{char_key, AgentVHID, VhidError, SHIFT};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialError(pub String);

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CredentialError {}

fn err<T>(message: &str) -> Result<T, CredentialError> {
    Err(CredentialError(message.into()))
}

/// Bytes that are zeroed when dropped (a password or passcode).
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Secret {
        Secret(bytes)
    }
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        for b in self.0.iter_mut() {
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// The signed Hive bundle's credential helper (`<bundle>/Contents/MacOS/Agent`).
pub fn executable() -> Result<PathBuf, CredentialError> {
    executable_in(&hive_common::paths::home(), &hive_common::repo_root())
}

/// [`executable`] for this home folder and repository.
pub fn executable_in(home: &Path, repo: &Path) -> Result<PathBuf, CredentialError> {
    // Prefer the installed, signed Hive bundle. A present but damaged bundle must
    // not silently redirect credential operations to an older or unsigned copy.
    let bundles = [
        home.join("Applications/Hive.app"),
        home.join("Applications/Agent.app"),
        repo.join("build/Agent.app"),
    ];
    for bundle in bundles {
        let link = std::fs::symlink_metadata(&bundle).ok();
        let is_symlink = link.as_ref().is_some_and(|m| m.file_type().is_symlink());
        if !bundle.exists() && !is_symlink {
            continue;
        }
        let path = bundle.join("Contents/MacOS/Agent");
        let path_is_symlink =
            std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
        if is_symlink
            || !bundle.is_dir()
            || path_is_symlink
            || !path.is_file()
            || !executable_file(&path)
        {
            return err("The selected local authentication helper is unavailable.");
        }
        return Ok(path);
    }
    err("Build Hive first with make build/Agent.app.")
}

fn executable_file(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// The credential helper: `Agent --credential ARGS...` (12 s at most).
pub trait Native: Send + Sync {
    /// A command whose answer isn't secret; its output, stripped.
    fn text(&self, args: &[&str]) -> Result<String, CredentialError>;
    /// A command that answers with a secret. Its errors never echo what it printed.
    fn secret(&self, args: &[&str]) -> Result<Secret, CredentialError>;
}

/// The real helper in the Hive bundle.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeHelper;

/// Runs `Agent --credential ARGS...` (python's `native`).
pub fn native(args: &[&str], secret: bool) -> Result<Vec<u8>, CredentialError> {
    let mut full = vec!["--credential"];
    full.extend_from_slice(args);
    let run = match process::run(executable()?, &full, None, Some(Duration::from_secs(12))) {
        Ok(run) => run,
        Err(_) => {
            return err("The local authentication helper did not finish. No automatic retry.")
        }
    };
    if !run.success() {
        // Read-phone errors must never accidentally echo stdout or a credential.
        let mut out = run;
        out.stdout.iter_mut().for_each(|b| *b = 0);
        if secret {
            return err("Saved password unavailable or Keychain locked. Configure it in Hive → Authentication.");
        }
        let why = out.stderr_text().trim().to_string();
        return Err(CredentialError(if why.is_empty() {
            "Authentication unavailable.".into()
        } else {
            why
        }));
    }
    Ok(run.stdout)
}

impl Native for NativeHelper {
    fn text(&self, args: &[&str]) -> Result<String, CredentialError> {
        let out = native(args, false)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }
    fn secret(&self, args: &[&str]) -> Result<Secret, CredentialError> {
        native(args, true).map(Secret)
    }
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What credentials needs from the phone (python/phone.py's Phone): its relay address and
/// WebDriverAgent requests. Errors are the phone's own messages.
pub trait PhoneDevice {
    fn base(&self) -> String;
    fn request(
        &self,
        path: &str,
        method: &str,
        body: Option<&Value>,
        sensitive: bool,
    ) -> Result<Value, String>;
    fn session(&self) -> Result<String, String>;
    fn in_session(&self, path: &str, method: &str, body: Option<&Value>) -> Result<Value, String>;
}

fn phone_err(e: String) -> CredentialError {
    CredentialError(e)
}

/// The phone's Keychain account: its relay and WDA's device UUID, hashed.
pub fn phone_account(phone: &dyn PhoneDevice) -> Result<String, CredentialError> {
    let base = phone.base();
    let scheme = base
        .split_once(':')
        .map(|(s, _)| s.to_ascii_lowercase())
        .unwrap_or_default();
    if scheme != "https" {
        return err("Phone credentials require an HTTPS relay.");
    }
    let info = phone
        .request("/api/wda/device/info", "GET", None, false)
        .map_err(phone_err)?;
    let uuid = info
        .get("value")
        .and_then(|v| v.get("uuid"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let valid =
        (32..=36).contains(&uuid.len()) && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !valid {
        return err("Could not verify the connected phone identity. No credential was used.");
    }
    Ok(format!(
        "phone:{}",
        sha256_hex(format!("{base}\0{uuid}").as_bytes())
    ))
}

/// `<state>/authentication/<sha256(account)>.attempt`, the folder made if needed.
pub fn attempt_path(account: &str) -> PathBuf {
    let folder = hive_common::state_dir().join("authentication");
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&folder);
    }
    folder.join(format!("{}.attempt", sha256_hex(account.as_bytes())))
}

/// Marks an attempt as under way; fails if an earlier one was never confirmed.
pub fn claim_attempt(account: &str) -> Result<PathBuf, CredentialError> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = attempt_path(account);
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path) {
        Ok(_) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => err(
            "A previous authentication attempt was not confirmed. Check the device and re-save the credential in \
             Authentication before another attempt.",
        ),
        Err(e) => Err(CredentialError(process::strerror(&e))),
    }
}

/// Caps Lock is on.
pub fn caps_lock_on() -> bool {
    crate::ffi::caps_lock_on()
}

/// Types the saved Mac password with the agent's keyboard into the field that has the keyboard
/// focus, then presses Return, the way the user would. The agent clicks the password field first.
/// The password goes from the Keychain through a private pipe to the keyboard, never into model
/// arguments, tool results, logs, argv or the clipboard.
pub fn authenticate_mac() -> Result<String, CredentialError> {
    let mac = AgentVHID::new(crate::vhid::default_socket(), 1.0, false);
    authenticate_mac_with(&mac, &NativeHelper, &caps_lock_on)
}

/// [`authenticate_mac`] with this keyboard, credential helper and Caps Lock reading.
pub fn authenticate_mac_with(
    mac: &AgentVHID,
    native: &dyn Native,
    caps_on: &dyn Fn() -> bool,
) -> Result<String, CredentialError> {
    let mut caps_changed = false;
    let typed = (|| -> Result<String, Failure> {
        if !mac.is_engaged()? {
            return Err(Failure::Said(CredentialError(
                "The user has control. Call mac.wait_for_control, then authenticate again.".into(),
            )));
        }
        let layout = native.text(&["keyboard-layout"])?;
        if layout != "com.apple.keylayout.ABC" && layout != "com.apple.keylayout.US" {
            return Err(Failure::Said(CredentialError(
                "The keyboard layout is not ABC/US, so the password would be typed wrong.".into(),
            )));
        }
        let secret = native.secret(&["read-mac"])?;
        let value = std::str::from_utf8(secret.bytes()).map_err(|_| Failure::Other)?;
        if value.is_empty() || value.chars().any(|c| char_key(c).is_none()) {
            return Err(Failure::Said(CredentialError(
                "The saved password has characters the keyboard path cannot type.".into(),
            )));
        }
        if caps_on() {
            mac.key("capslock")?;
            caps_changed = true;
        }
        for ch in value.chars() {
            let (usage, shifted) = char_key(ch).ok_or(Failure::Other)?;
            let mods = if shifted { SHIFT } else { 0 };
            if mods != 0 {
                mac.keys(mods, &[])?;
            }
            mac.keys(mods, &[usage])?;
            mac.keys(0, &[])?;
        }
        mac.key("return")?;
        std::thread::sleep(Duration::from_millis(500));
        Ok("Typed the saved Mac password into the focused field and pressed Return. Take a screenshot to see the \
            result."
            .into())
    })();
    if caps_changed && mac.is_engaged().unwrap_or(false) && !caps_on() {
        let _ = mac.key("capslock");
    }
    mac.close();
    typed.map_err(|f| match f {
        Failure::Said(e) => e,
        Failure::Other => CredentialError(
            "Could not type the saved Mac password. Take a screenshot and try again.".into(),
        ),
    })
}

/// A credential failure with its own message, or anything else (which gets a generic one).
enum Failure {
    Said(CredentialError),
    Other,
}

impl From<CredentialError> for Failure {
    fn from(e: CredentialError) -> Failure {
        Failure::Said(e)
    }
}

impl From<VhidError> for Failure {
    fn from(_: VhidError) -> Failure {
        Failure::Other
    }
}

/// An element of the phone's accessibility source: its tag and attributes.
struct Element {
    tag: String,
    attrs: Vec<(String, String)>,
}

impl Element {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn visible(&self) -> bool {
        self.attr("visible") == Some("true")
    }
    /// label, else name, else "" (Python's `label or name or ''`).
    fn label(&self) -> &str {
        self.attr("label")
            .filter(|l| !l.is_empty())
            .or_else(|| self.attr("name"))
            .unwrap_or("")
    }
}

/// Every element of an XML document, in document order (ElementTree's `root.iter()`).
fn elements(source: &str) -> Result<Vec<Element>, CredentialError> {
    use quick_xml::events::Event;
    let bad = || CredentialError("The phone's screen description could not be read.".into());
    let mut reader = quick_xml::Reader::from_str(source);
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        let event = reader.read_event().map_err(|_| bad())?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                if depth == 0 {
                    roots += 1;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
                let mut attrs = Vec::new();
                for a in e.attributes() {
                    let a = a.map_err(|_| bad())?;
                    let value = a
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|_| bad())?;
                    attrs.push((a.key.as_ref().to_string(), value.into_owned()));
                }
                out.push(Element {
                    tag: e.name().as_ref().to_string(),
                    attrs,
                });
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || depth != 0 {
        return Err(bad());
    }
    Ok(out)
}

fn source_of(phone: &dyn PhoneDevice) -> Result<String, CredentialError> {
    let source = phone
        .in_session("/source", "GET", None)
        .map_err(phone_err)?;
    source
        .get("value")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CredentialError("The phone's screen description could not be read.".into()))
}

/// Checks that the phone shows the system passcode prompt, and returns its session.
pub fn phone_prompt(phone: &dyn PhoneDevice) -> Result<String, CredentialError> {
    let app = phone
        .request("/api/wda/activeAppInfo", "GET", None, false)
        .map_err(phone_err)?;
    if app
        .get("value")
        .and_then(|v| v.get("bundleId"))
        .and_then(Value::as_str)
        != Some("com.apple.springboard")
    {
        return err("The phone is not showing a verified system passcode screen.");
    }
    let all = elements(&source_of(phone)?)?;
    let visible: Vec<&Element> = all.iter().filter(|e| e.visible()).collect();
    // Only labels: never read a secure field's value into model-visible diagnostics.
    let text = visible
        .iter()
        .map(|e| e.label())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let denied = [
        "incorrect",
        "try again",
        "failed",
        "attempts remaining",
        "unavailable",
        "disabled",
        "new passcode",
        "change passcode",
        "reset",
        "erase",
        "payment",
        "pay ",
        "purchase",
    ];
    if denied.iter().any(|w| text.contains(w))
        || !(text.contains("enter passcode") || text.contains("enter iphone passcode"))
    {
        return err(
            "This is not a supported sign-in/unlock passcode prompt, or it shows a failed attempt.",
        );
    }
    let fields = visible
        .iter()
        .filter(|e| e.tag == "XCUIElementTypeSecureTextField")
        .count();
    if fields != 1 {
        return err("This passcode screen does not expose one secure field; unlock it yourself.");
    }
    phone.session().map_err(phone_err)
}

/// Types the saved phone passcode into the system passcode prompt, once.
pub fn authenticate_phone(phone: &dyn PhoneDevice) -> Result<String, CredentialError> {
    authenticate_phone_with(phone, &NativeHelper, &|d| std::thread::sleep(d))
}

/// [`authenticate_phone`] with this credential helper and sleep.
pub fn authenticate_phone_with(
    phone: &dyn PhoneDevice,
    native: &dyn Native,
    sleep: &dyn Fn(Duration),
) -> Result<String, CredentialError> {
    // Checks precede secret access. Never fall back to coordinates, generic keys or clipboard.
    let account = phone_account(phone)?;
    let session = phone_prompt(phone)?;
    let found = phone
        .in_session(
            "/elements",
            "POST",
            Some(&json!({"using": "predicate string",
                         "value": "type == 'XCUIElementTypeSecureTextField' AND visible == 1"})),
        )
        .map_err(phone_err)?;
    let found = found
        .get("value")
        .and_then(Value::as_array)
        .filter(|f| f.len() == 1);
    let Some(found) = found else {
        return err("Cannot target the system passcode field unambiguously.");
    };
    let element = found[0]
        .get("ELEMENT")
        .filter(|e| hive_common::mcp::truthy(e))
        .or_else(|| found[0].get("element-6066-11e4-a52e-4f735466cecf"));
    let element = match element.and_then(Value::as_str) {
        Some(e)
            if !e.is_empty()
                && e.chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '-') =>
        {
            e.to_string()
        }
        _ => return err("Invalid secure field identifier."),
    };
    let secret = native.secret(&["read-phone", &account])?;
    let digits = secret.bytes();
    if !(4..=12).contains(&digits.len()) || !digits.iter().all(u8::is_ascii_digit) {
        return err("The saved phone passcode is not supported. Configure a numeric passcode in Authentication.");
    }
    if phone_account(phone)? != account || phone_prompt(phone)? != session {
        return err("The phone or authentication screen changed. No credential was used.");
    }
    let marker = claim_attempt(&account)?;
    // One addressed field write; unlike in_session(), this never recreates a session and retries.
    let body = json!({"value": [std::str::from_utf8(digits).unwrap_or("")]});
    phone
        .request(
            &format!("{session}/element/{element}/value"),
            "POST",
            Some(&body),
            true,
        )
        .map_err(phone_err)?;
    drop(body);
    sleep(Duration::from_millis(800));
    let locked = phone
        .request("/api/wda/locked", "GET", None, false)
        .map_err(phone_err)?;
    if locked.get("value") != Some(&Value::Bool(false)) {
        return err("The phone has not confirmed it is unlocked. No retry; check it yourself.");
    }
    let still = elements(&source_of(phone)?)?.iter().any(|e| {
        e.visible()
            && e.tag == "XCUIElementTypeSecureTextField"
            && e.label().to_lowercase().contains("passcode")
    });
    if still {
        return err("The passcode prompt is still present. No automatic retry.");
    }
    let _ = std::fs::remove_file(marker);
    Ok("Phone passcode prompt completed. Verify the account sign-in result on screen.".into())
}

/// The phone through its relay (python/phone.py's Phone, the part credentials needs), using
/// agent-core's phone transport in-process.
pub struct RelayPhone {
    pub folder: String,
    pub base: String,
    session: std::sync::Mutex<Option<String>>,
}

impl RelayPhone {
    /// The relay in `folder`, else PHONE_RELAY.
    pub fn new(folder: Option<&str>) -> Result<RelayPhone, String> {
        let folder = folder
            .map(str::to_string)
            .or_else(|| std::env::var("PHONE_RELAY").ok())
            .unwrap_or_default();
        if folder.is_empty() {
            return Err("Phone control isn't set up: PHONE_RELAY (in .env) isn't set.".into());
        }
        let base =
            std::fs::read_to_string(Path::new(&folder).join("endpoint.txt")).map_err(|e| {
                format!(
                    "Phone control isn't set up: can't read the relay's endpoint.txt ({}).",
                    process::strerror(&e)
                )
            })?;
        let base = base.trim().trim_end_matches('/').to_string();
        Ok(RelayPhone {
            folder,
            base,
            session: std::sync::Mutex::new(None),
        })
    }

    fn call(
        &self,
        operation: &str,
        path: &str,
        method: &str,
        body: Option<&Value>,
        sensitive: bool,
    ) -> Result<Value, String> {
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let payload = json!({"operation": operation, "folder": self.folder, "base": self.base,
                             "session": *session, "path": path, "method": method,
                             "body": body.cloned().unwrap_or(Value::Null), "sensitive": sensitive});
        let mut input = Secret::new(serde_json::to_vec(&payload).unwrap_or_default());
        drop(payload);
        input.0.push(0);
        let response = unsafe {
            let out = personal_agent_core::phone_transport::agent_phone_call(
                input.bytes().as_ptr() as *const std::ffi::c_char,
            );
            if out.is_null() {
                return Err("The phone relay transport failed.".into());
            }
            let text = std::ffi::CStr::from_ptr(out).to_bytes().to_vec();
            personal_agent_core::phone_transport::agent_phone_free(out);
            text
        };
        let response: Value = serde_json::from_slice(&response)
            .map_err(|_| "The phone relay transport failed.".to_string())?;
        *session = response
            .get("session")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(error) = response.get("error") {
            return Err(error
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string()));
        }
        Ok(response.get("value").cloned().unwrap_or(Value::Null))
    }
}

impl PhoneDevice for RelayPhone {
    fn base(&self) -> String {
        self.base.clone()
    }
    fn request(
        &self,
        path: &str,
        method: &str,
        body: Option<&Value>,
        sensitive: bool,
    ) -> Result<Value, String> {
        self.call("request", path, method, body, sensitive)
    }
    fn session(&self) -> Result<String, String> {
        match self.call("session", "", "GET", None, false)? {
            Value::String(s) => Ok(s),
            other => Ok(other.to_string()),
        }
    }
    fn in_session(&self, path: &str, method: &str, body: Option<&Value>) -> Result<Value, String> {
        self.call("in_session", path, method, body, false)
    }
}

/// `hive-credentials configure mac|phone`: shows the native secure-entry sheet for that account
/// (Hive.app's Authentication menu runs it). Returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let _ = hive_common::settings::load(None);
    if args.len() != 2 || args[0] != "configure" || !(args[1] == "mac" || args[1] == "phone") {
        println!("Usage: hive-credentials configure mac|phone");
        return 2;
    }
    let phone = args[1] == "phone";
    let configured = (|| -> Result<i32, String> {
        let account = if phone {
            let relay = RelayPhone::new(None)?;
            phone_account(&relay).map_err(|e| e.0)?
        } else {
            "mac".to_string()
        };
        // Only this user-invoked setup route displays the secure native entry sheet.
        let status = std::process::Command::new(executable().map_err(|e| e.0)?)
            .args(["--credential", "configure", &account])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            let _ = std::fs::remove_file(attempt_path(&account));
        }
        Ok(status.code().unwrap_or(1))
    })();
    match configured {
        Ok(code) => code,
        Err(_) => {
            let message = if phone {
                "Phone credential setup needs the configured phone online and unlocked. Open the WebDriverAgent relay \
                 app on the phone, then try again."
            } else {
                "Authentication setup could not start."
            };
            let script = format!(
                "display alert \"Authentication setup\" message {}",
                crate::desktop::json_quote(message)
            );
            let _ = process::run("osascript", ["-e", &script], None, None);
            println!("{message}");
            1
        }
    }
}
