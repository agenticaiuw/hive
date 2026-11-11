//! `hive-context-panel [SESSION_DIR]`: prints the Agent Context panel's data
//! (python/context_panel.py's `main`).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_knowledge::context_panel::main(
        &argv,
        &mut std::io::stdout().lock(),
    ));
}
