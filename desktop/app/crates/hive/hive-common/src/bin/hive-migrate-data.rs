//! Explicit maintenance utility. The operator must first stop Hive and every legacy data writer.
//! This program does not detect or stop other processes and must never be run on live data.

fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--writers-stopped"] {
        eprintln!("Usage: hive-migrate-data --writers-stopped\nStop Hive and all other writers first; this command cannot verify that they are stopped.");
        std::process::exit(2);
    }
    if std::env::var_os("AGENT_STATE_DIR").is_some()
        || std::env::var_os("HIVE_RECORDINGS").is_some()
        || std::env::var_os("HIVE_RECORDINGS_DIR").is_some()
    {
        eprintln!("Custom state or recording paths are configured; automatic migration cannot determine their intended destination.");
        std::process::exit(2);
    }
    let home = hive_common::paths::home();
    let state = home.join("Library/Application Support/Hive");
    let voiceprint = hive_common::repo_root().join("models/voiceprint.npz");
    if let Err(error) = hive_common::paths::migrate_legacy_at(&home)
        .and_then(|_| hive_common::paths::migrate_voiceprint_at(&voiceprint, &state))
    {
        eprintln!("Hive data migration stopped: {error}");
        std::process::exit(1);
    }
    eprintln!("Hive data migration completed; verify the new installation before removing any legacy voiceprint copy.");
}
