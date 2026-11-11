//! `hive-session-journal [list | show [ID] | paths [ID]]` (python/session_journal.py's `main`).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_knowledge::session_journal::main(
        &argv,
        &mut std::io::stdout().lock(),
    ));
}
