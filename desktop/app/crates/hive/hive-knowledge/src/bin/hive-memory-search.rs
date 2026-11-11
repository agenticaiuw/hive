//! `hive-memory-search WORDS...`: searches personal memory (python/memory_search.py's `main`).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_knowledge::memory_search::main(
        &argv,
        &mut std::io::stdout().lock(),
    ));
}
