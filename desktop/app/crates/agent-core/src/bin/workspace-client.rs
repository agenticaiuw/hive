#[cfg(unix)]
fn main() {
    use personal_agent_core::workspace_client;
    use std::{env, io, path::Path, process, time::Duration};
    let mut args = env::args_os();
    let _ = args.next();
    let Some(socket) = args.next() else {
        eprintln!("usage: workspace-client SOCKET");
        process::exit(2)
    };
    if args.next().is_some() {
        eprintln!("usage: workspace-client SOCKET");
        process::exit(2);
    }
    let value = match serde_json::from_reader(io::stdin().lock()) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("Invalid workspace request");
            process::exit(1)
        }
    };
    match workspace_client::request(Path::new(&socket), &value, Duration::from_secs(50)) {
        Ok(response) => {
            serde_json::to_writer(io::stdout().lock(), &response).expect("stdout write failed");
        }
        Err(error) => {
            eprintln!("{error}");
            process::exit(1)
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Unix sockets are required");
    std::process::exit(1)
}
