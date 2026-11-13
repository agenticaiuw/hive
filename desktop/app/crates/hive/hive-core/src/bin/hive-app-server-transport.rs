//! Supervise the Codex app server and forward its exact byte streams to the host.
use std::{
    env,
    io::{self, Write},
    process::{self, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
fn run() -> io::Result<i32> {
    let mut args = env::args_os();
    args.next();
    let command = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing server command"))?;
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing server input"))?;
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing server output"))?;
    let (events, receiver) = mpsc::channel();
    let input_events = events.clone();
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut input);
        drop(input);
        let _ = input_events.send("input_closed");
    });
    let output_events = events;
    let reader = thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        let result = io::copy(&mut output, &mut stdout).and_then(|_| stdout.flush());
        if result.is_err() {
            let _ = output_events.send("output_closed");
        }
    });
    let mut closing = None;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok("input_closed") => closing = Some(Instant::now() + Duration::from_secs(3)),
            Ok("output_closed") => {
                let _ = child.kill();
            }
            _ => (),
        }
        if closing.is_some_and(|deadline| Instant::now() >= deadline) {
            let _ = child.kill();
        }
    };
    // Drain complete output before reporting exit, as a direct process pipe does.
    let _ = reader.join();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            unsafe {
                libc::raise(signal);
            }
            return Ok(128 + signal);
        }
    }
    Ok(status.code().unwrap_or(1))
}
fn main() {
    match run() {
        Ok(code) => process::exit(code),
        Err(_) => {
            eprintln!("App-server transport unavailable");
            process::exit(1);
        }
    }
}
