//! `hive-knowledge`: the knowledge base's command line (python/knowledge.py's `main`).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_knowledge::knowledge::main(&argv));
}
