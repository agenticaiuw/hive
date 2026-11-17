//! Hive's data folder is ~/Library/Application Support/Hive. It was called Personal Agent until
//! 2026-11; a Mac that has only the old folder keeps using it, and once Hive exists the old one
//! (on the owner's Mac, a link to Hive for the input helper installed as root) is ignored.
use hive_common::paths::state_dir_in;
use std::fs;
use std::path::PathBuf;

fn home(name: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("hive-state-dir-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(home.join("Library/Application Support")).unwrap();
    home
}

#[test]
fn a_new_mac_gets_a_folder_named_hive() {
    let home = home("new");
    assert_eq!(state_dir_in(&home), home.join("Library/Application Support/Hive"));
}

#[test]
fn a_mac_with_only_the_old_folder_keeps_it() {
    let home = home("old");
    fs::create_dir(home.join("Library/Application Support/Personal Agent")).unwrap();
    assert_eq!(state_dir_in(&home), home.join("Library/Application Support/Personal Agent"));
}

#[test]
fn once_hive_exists_the_old_name_is_ignored_even_as_a_link_to_it() {
    let home = home("moved");
    let support = home.join("Library/Application Support");
    fs::create_dir(support.join("Hive")).unwrap();
    std::os::unix::fs::symlink("Hive", support.join("Personal Agent")).unwrap();
    assert_eq!(state_dir_in(&home), support.join("Hive"));
    fs::remove_file(support.join("Personal Agent")).unwrap();
    fs::create_dir(support.join("Personal Agent")).unwrap();
    assert_eq!(state_dir_in(&home), support.join("Hive"));
}
