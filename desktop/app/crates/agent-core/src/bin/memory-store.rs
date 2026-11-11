use std::{env, io, path::Path, process};
fn main() {
    let mut args = env::args_os();
    args.next();
    let Some(state) = args.next() else {
        eprintln!("Missing state directory");
        process::exit(2);
    };
    if args.next().is_some() {
        eprintln!("Invalid arguments");
        process::exit(2);
    }
    let request = match serde_json::from_reader(io::stdin().lock()) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("Invalid memory request");
            process::exit(1);
        }
    };
    match personal_agent_core::memory::execute(Path::new(&state), &request) {
        Ok(value) => {
            if serde_json::to_writer(io::stdout().lock(), &value).is_err() {
                process::exit(1);
            }
        }
        Err(_) => {
            eprintln!("Memory store unavailable");
            process::exit(1);
        }
    }
}
