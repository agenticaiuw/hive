//! Authentication boundaries with synthetic credentials; no device, account or Keychain
//! interaction (tests/test_credentials.py's phone half, tests/test_credentials_executable.py).

use std::cell::{Cell, RefCell};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use hive_mac::credentials::{self, CredentialError, Native, PhoneDevice, Secret};
use serde_json::{json, Value};

const SECRET: &str = "654321";
const SOURCE: &str = r#"<AppiumAUT><XCUIElementTypeApplication name="SpringBoard" visible="true">
<XCUIElementTypeStaticText label="Enter iPhone Passcode" visible="true"/>
<XCUIElementTypeSecureTextField label="Passcode" visible="true"/>
</XCUIElementTypeApplication></AppiumAUT>"#;

struct FakePhone {
    base: RefCell<String>,
    owner: RefCell<String>,
    source: RefCell<String>,
    sent: RefCell<Vec<(String, Value, bool)>>,
    accept: Cell<bool>,
    uuid: RefCell<String>,
}

impl FakePhone {
    fn new() -> FakePhone {
        FakePhone {
            base: RefCell::new("https://phone.example.test".into()),
            owner: RefCell::new("com.apple.springboard".into()),
            source: RefCell::new(SOURCE.into()),
            sent: RefCell::new(Vec::new()),
            accept: Cell::new(true),
            uuid: RefCell::new("12345678-1234-1234-1234-123456789abc".into()),
        }
    }
}

impl PhoneDevice for FakePhone {
    fn base(&self) -> String {
        self.base.borrow().clone()
    }
    fn request(
        &self,
        path: &str,
        _method: &str,
        body: Option<&Value>,
        sensitive: bool,
    ) -> Result<Value, String> {
        match path {
            "/api/wda/device/info" => Ok(json!({"value": {"uuid": *self.uuid.borrow()}})),
            "/api/wda/activeAppInfo" => Ok(json!({"value": {"bundleId": *self.owner.borrow()}})),
            "/api/wda/locked" => Ok(json!({"value": !self.accept.get()})),
            p if p.ends_with("/value") => {
                self.sent.borrow_mut().push((
                    p.to_string(),
                    body.cloned().unwrap_or(Value::Null),
                    sensitive,
                ));
                if self.accept.get() {
                    *self.source.borrow_mut() = "<AppiumAUT/>".into();
                }
                Ok(json!({"value": null}))
            }
            other => panic!("unexpected request {other}"),
        }
    }
    fn session(&self) -> Result<String, String> {
        Ok("/api/session/S1".into())
    }
    fn in_session(
        &self,
        path: &str,
        _method: &str,
        _body: Option<&Value>,
    ) -> Result<Value, String> {
        match path {
            "/source" => Ok(json!({"value": *self.source.borrow()})),
            "/elements" => Ok(json!({"value": [{"ELEMENT": "secure-1"}]})),
            other => panic!("unexpected request {other}"),
        }
    }
}

/// The credential helper, pretend; `on_read` runs when the secret is read.
struct FakeNative<'a> {
    reads: Mutex<usize>,
    on_read: Box<dyn Fn() + Send + Sync + 'a>,
}

impl<'a> FakeNative<'a> {
    fn new() -> FakeNative<'a> {
        FakeNative {
            reads: Mutex::new(0),
            on_read: Box::new(|| {}),
        }
    }
    fn reads(&self) -> usize {
        *self.reads.lock().unwrap()
    }
}

impl Native for FakeNative<'_> {
    fn text(&self, _args: &[&str]) -> Result<String, CredentialError> {
        Ok(String::new())
    }
    fn secret(&self, args: &[&str]) -> Result<Secret, CredentialError> {
        assert_eq!(args[0], "read-phone");
        *self.reads.lock().unwrap() += 1;
        (self.on_read)();
        Ok(Secret::new(SECRET.as_bytes().to_vec()))
    }
}

static STATE: Mutex<()> = Mutex::new(());

/// A fresh state folder (AGENT_STATE_DIR) for one test; tests that use one take turns.
struct State {
    dir: tempfile::TempDir,
    _turn: MutexGuard<'static, ()>,
}

fn state() -> State {
    let turn = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("AGENT_STATE_DIR", dir.path());
    State { dir, _turn: turn }
}

fn attempts(dir: &Path) -> Vec<PathBuf> {
    let folder = dir.join("authentication");
    std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "attempt"))
                .collect()
        })
        .unwrap_or_default()
}

fn authenticate(phone: &FakePhone, native: &FakeNative) -> Result<String, CredentialError> {
    credentials::authenticate_phone_with(phone, native, &|_| {})
}

#[test]
fn phone_exact_secure_field_and_secret_free_result() {
    let state = state();
    let phone = FakePhone::new();
    let native = FakeNative::new();
    let said = authenticate(&phone, &native).unwrap();
    assert!(!said.contains(SECRET));
    assert_eq!(
        *phone.sent.borrow(),
        [(
            "/api/session/S1/element/secure-1/value".to_string(),
            json!({"value": [SECRET]}),
            true
        )]
    );
    assert!(attempts(state.dir.path()).is_empty());
}

#[test]
fn rejected_passcode_cannot_be_retried_across_instances() {
    let state = state();
    let phone = FakePhone::new();
    phone.accept.set(false);
    let native = FakeNative::new();
    assert!(authenticate(&phone, &native).is_err());
    let again = authenticate(&phone, &FakeNative::new()).unwrap_err();
    assert!(again.0.contains("previous authentication"), "{}", again.0);
    assert_eq!(phone.sent.borrow().len(), 1);
    assert_eq!(attempts(state.dir.path()).len(), 1);
}

#[test]
fn webpage_cannot_request_device_passcode() {
    let _state = state();
    let phone = FakePhone::new();
    *phone.owner.borrow_mut() = "com.apple.mobilesafari".into();
    let native = FakeNative::new();
    assert!(authenticate(&phone, &native).is_err());
    assert_eq!(native.reads(), 0);
    assert!(phone.sent.borrow().is_empty());
}

#[test]
fn reject_failed_attempt_and_passcode_change_screens() {
    let _state = state();
    let native = FakeNative::new();
    for text in [
        "Incorrect passcode",
        "Enter new passcode",
        "Try again in 1 minute",
        "Confirm payment",
    ] {
        let phone = FakePhone::new();
        *phone.source.borrow_mut() = SOURCE.replace(
            "Enter iPhone Passcode",
            &format!("Enter iPhone Passcode {text}"),
        );
        assert!(authenticate(&phone, &native).is_err(), "{text}");
    }
    assert_eq!(native.reads(), 0);
}

#[test]
fn no_http_or_unknown_device() {
    let _state = state();
    let phone = FakePhone::new();
    let native = FakeNative::new();
    *phone.base.borrow_mut() = "http://phone.example.test".into();
    assert!(authenticate(&phone, &native).is_err());
    *phone.base.borrow_mut() = "https://phone.example.test".into();
    *phone.uuid.borrow_mut() = "unknown".into();
    assert!(authenticate(&phone, &native).is_err());
    assert_eq!(native.reads(), 0);
}

#[test]
fn device_changed_before_write() {
    let _state = state();
    let phone = FakePhone::new();
    let changed = std::sync::atomic::AtomicBool::new(false);
    let native = FakeNative {
        reads: Mutex::new(0),
        on_read: Box::new(|| changed.store(true, std::sync::atomic::Ordering::SeqCst)),
    };
    // the phone's identity changes as the secret is read
    struct Changing<'a>(&'a FakePhone, &'a std::sync::atomic::AtomicBool);
    impl PhoneDevice for Changing<'_> {
        fn base(&self) -> String {
            self.0.base()
        }
        fn request(
            &self,
            path: &str,
            method: &str,
            body: Option<&Value>,
            sensitive: bool,
        ) -> Result<Value, String> {
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                *self.0.uuid.borrow_mut() = "00000000-0000-0000-0000-000000000000".into();
            }
            self.0.request(path, method, body, sensitive)
        }
        fn session(&self) -> Result<String, String> {
            self.0.session()
        }
        fn in_session(
            &self,
            path: &str,
            method: &str,
            body: Option<&Value>,
        ) -> Result<Value, String> {
            self.0.in_session(path, method, body)
        }
    }
    let err = credentials::authenticate_phone_with(&Changing(&phone, &changed), &native, &|_| {})
        .unwrap_err();
    assert!(err.0.contains("changed"), "{}", err.0);
    assert!(phone.sent.borrow().is_empty());
}

// --- which credential helper runs (tests/test_credentials_executable.py) ---

struct Bundles {
    _temp: tempfile::TempDir,
    home: PathBuf,
    repo: PathBuf,
}

fn bundles() -> Bundles {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let repo = temp.path().join("repo");
    std::fs::create_dir(&home).unwrap();
    std::fs::create_dir(&repo).unwrap();
    Bundles {
        _temp: temp,
        home,
        repo,
    }
}

fn bundle(path: &Path) -> PathBuf {
    let binary = path.join("Contents/MacOS/Agent");
    std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
    std::fs::write(&binary, "fixture").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    binary
}

#[test]
fn prefers_installed_hive_over_legacy_and_build() {
    let b = bundles();
    let legacy = bundle(&b.home.join("Applications/Agent.app"));
    let build = bundle(&b.repo.join("build/Agent.app"));
    let hive = bundle(&b.home.join("Applications/Hive.app"));
    let found = credentials::executable_in(&b.home, &b.repo).unwrap();
    assert_eq!(found, hive);
    assert_ne!(found, legacy);
    assert_ne!(found, build);
}

#[test]
fn fallback_only_when_hive_bundle_is_absent() {
    let b = bundles();
    let legacy = bundle(&b.home.join("Applications/Agent.app"));
    assert_eq!(
        credentials::executable_in(&b.home, &b.repo).unwrap(),
        legacy
    );
    std::fs::remove_dir_all(b.home.join("Applications/Agent.app")).unwrap();
    let build = bundle(&b.repo.join("build/Agent.app"));
    assert_eq!(credentials::executable_in(&b.home, &b.repo).unwrap(), build);
}

#[test]
fn damaged_or_symlinked_hive_never_falls_back() {
    let b = bundles();
    bundle(&b.home.join("Applications/Agent.app"));
    let hive = b.home.join("Applications/Hive.app");
    std::fs::create_dir(&hive).unwrap();
    assert!(credentials::executable_in(&b.home, &b.repo).is_err());
    std::fs::remove_dir(&hive).unwrap();
    std::os::unix::fs::symlink(b.home.join("Applications/Agent.app"), &hive).unwrap();
    assert!(credentials::executable_in(&b.home, &b.repo).is_err());
}

#[test]
fn nonexecutable_hive_never_falls_back() {
    let b = bundles();
    bundle(&b.home.join("Applications/Agent.app"));
    let hive = bundle(&b.home.join("Applications/Hive.app"));
    std::fs::set_permissions(&hive, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(credentials::executable_in(&b.home, &b.repo).is_err());
}

#[test]
fn missing_bundles_fail_without_invocation() {
    let b = bundles();
    assert!(credentials::executable_in(&b.home, &b.repo).is_err());
}

#[test]
fn usage() {
    let dir = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_hive-credentials"))
        .arg("configure")
        .env("AGENT_ENV_FILE", dir.path().join("none.env"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "Usage: hive-credentials configure mac|phone\n"
    );
}
