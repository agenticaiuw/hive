//! `hive-agent`: the voice agent Hive.app runs (`python/voice_agent.py`), or one request from the
//! command line with `--task` (`python3 python/agent.py "..."`).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_app::app::main(&argv));
}
