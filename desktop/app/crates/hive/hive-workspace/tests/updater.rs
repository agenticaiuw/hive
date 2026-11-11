//! tools/update-app.sh: when committing the new bundle fails, the updater relaunches the old app
//! it restored (test_hive_bundle_migration.py's test_updater_relaunches_restored_old_app_after_commit_failure).

use std::path::Path;
use std::process::Command;

#[test]
fn updater_relaunches_restored_old_app_after_commit_failure() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let source = std::fs::read_to_string(repo.join("tools/update-app.sh")).unwrap();
    let start = "if ! prior_login=$(\"$MIGRATOR\" commit";
    let rest = source.split_once(start).expect("update-app.sh commits through $MIGRATOR").1;
    let block = format!("{start}{}", rest.split_once("\ndescribe \"$APP\"").expect("block ends at describe").0);
    let shell = format!(
        "launch_without_activation() {{ printf '%s' \"$APP\"; }}\n\
         installed=\"$1\"; APP=\"$2\"; MIGRATOR=/usr/bin/false; staged=ignored; backup=ignored\n{block}"
    );
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("Agent.app");
    let target = dir.path().join("Hive.app");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(old.join("old"), "").unwrap();
    let out = Command::new("/bin/bash").args(["-c", &shell, "test"]).arg(&old).arg(&target).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout), old.to_string_lossy());
    assert!(old.join("old").exists());
}
