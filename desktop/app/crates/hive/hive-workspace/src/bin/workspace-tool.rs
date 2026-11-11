fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hive_workspace::tool_cli::main(&args));
}
