use personal_agent_core::workspace_update::{compare_engines, decision, doctor, EngineChoice};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

fn report(running: bool, matches: Option<bool>, instance: Option<&str>) -> Value {
    json!({"daemon":{"running":running,"matchesCLI":matches,"instanceID":instance}})
}

#[test]
fn workspace_engine_choice_fail_closed_on_ambiguous_or_different_daemons() {
    use EngineChoice::{New, Preserve, Unsafe};
    assert_eq!(
        decision(&report(false, None, None), &report(false, None, None)),
        New
    );
    assert_eq!(
        decision(
            &report(true, Some(true), Some("one")),
            &report(true, Some(true), Some("one"))
        ),
        New
    );
    assert_eq!(
        decision(
            &report(true, Some(false), Some("one")),
            &report(true, Some(true), Some("one"))
        ),
        Preserve
    );
    assert_eq!(
        decision(&json!({}), &report(true, Some(true), Some("one"))),
        Unsafe
    );
    assert_eq!(
        decision(
            &report(true, Some(false), Some("one")),
            &report(true, Some(true), Some("other"))
        ),
        Unsafe
    );
    assert_eq!(
        decision(
            &report(true, Some(false), Some("one")),
            &report(false, Some(true), Some("one"))
        ),
        Unsafe
    );
    assert_eq!(
        decision(
            &report(true, Some(false), Some("")),
            &report(true, Some(true), Some(""))
        ),
        Unsafe
    );
    assert_eq!(
        decision(
            &json!({"daemon":{"running":"yes"}}),
            &report(true, Some(true), Some("one"))
        ),
        Unsafe
    );
    assert_eq!(
        decision(
            &json!({"daemon":{"running":true,"instanceID":4,"matchesCLI":true}}),
            &json!({"daemon":{"running":true,"instanceID":4,"matchesCLI":true}})
        ),
        Unsafe
    );
}

#[test]
fn existing_python_and_rust_decisions_agree_on_realistic_reports() {
    let scenarios = json!([
        [{"daemon":{"running":false}}, {"daemon":{"running":false}}],
        [{"daemon":{"running":true,"instanceID":"one","matchesCLI":true}}, {"daemon":{"running":true,"instanceID":"one","matchesCLI":true}}],
        [{"daemon":{"running":true,"instanceID":"one","matchesCLI":false}}, {"daemon":{"running":true,"instanceID":"one","matchesCLI":true}}],
        [{}, {"daemon":{"running":true,"instanceID":"one","matchesCLI":true}}],
        [{"daemon":{"running":true,"instanceID":"one","matchesCLI":false}}, {"daemon":{"running":true,"instanceID":"two","matchesCLI":true}}],
        [{"daemon":{"running":true,"instanceID":"one","matchesCLI":false}}, {"daemon":{"running":false}}],
        [{"daemon":{"running":true,"instanceID":"","matchesCLI":true}}, {"daemon":{"running":true,"instanceID":"","matchesCLI":true}}],
        [{"daemon":{"running":true,"instanceID":"one","matchesCLI":"yes"}}, {"daemon":{"running":true,"instanceID":"one","matchesCLI":false}}]
    ]);
    let results: Vec<_> = scenarios
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| decision(&pair[0], &pair[1]).as_str())
        .collect();
    let code = "import json,sys; from workspace_update import decision; pairs=json.loads(sys.argv[1]); print(json.dumps([decision(a,b) for a,b in pairs]))";
    let python_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("python");
    let output = std::process::Command::new("python3")
        .args(["-c", code, &scenarios.to_string()])
        .env("PYTHONPATH", python_dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let python: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(results, python);
}

#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn real_subprocess_reports_support_valid_nonzero_exit_and_reject_invalid_data() {
    let dir = tempfile::tempdir().unwrap();
    let candidate = script(dir.path(), "candidate helper", "printf '%s\\n' '{\"daemon\":{\"running\":true,\"instanceID\":\"abc\",\"matchesCLI\":false}}'; exit 1");
    let installed = script(dir.path(), "installed", "printf '%s\\n' '{\"daemon\":{\"running\":true,\"instanceID\":\"abc\",\"matchesCLI\":true}}'");
    assert_eq!(
        compare_engines(&candidate, &installed, Duration::from_secs(2)),
        EngineChoice::Preserve
    );
    let malformed = script(dir.path(), "malformed", "printf '%s\\n' '{not json'");
    assert_eq!(
        compare_engines(&malformed, &installed, Duration::from_secs(2)),
        EngineChoice::Unsafe
    );
    let array = script(dir.path(), "array", "printf '%s\\n' '[]'");
    assert_eq!(doctor(&array, Duration::from_secs(2)), json!({}));
    let binary = env!("CARGO_BIN_EXE_workspace-engine-choice");
    let output = std::process::Command::new(binary)
        .arg(&candidate)
        .arg(&installed)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"preserve\n");
    assert!(output.stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn hung_and_excessive_doctor_outputs_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let hung = script(dir.path(), "hung", "exec sleep 5");
    let start = Instant::now();
    assert_eq!(doctor(&hung, Duration::from_millis(120)), json!({}));
    assert!(start.elapsed() < Duration::from_secs(2));
    let oversized = script(dir.path(), "huge", "head -c 1048577 /dev/zero");
    assert_eq!(doctor(&oversized, Duration::from_secs(2)), json!({}));
}
