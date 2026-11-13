use std::{env, io, path::Path, process};
fn main() {
    let mut args = env::args_os();
    args.next();
    let Some(path) = args.next() else {
        eprintln!("Missing settings path");
        process::exit(2);
    };
    if args.next().is_some() {
        eprintln!("Invalid arguments");
        process::exit(2);
    }
    match hive_core::settings::read(Path::new(&path)) {
        Ok(pairs) => {
            if serde_json::to_writer(io::stdout().lock(), &pairs).is_err() {
                process::exit(1);
            }
        }
        Err(_) => {
            eprintln!("Settings unavailable");
            process::exit(1);
        }
    }
}
