//! What you added to the conversation (python/ingest.py's command line):
//!
//!     build/hive-ingest list | read ID [PART]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_common::ingest::main(&args));
}
