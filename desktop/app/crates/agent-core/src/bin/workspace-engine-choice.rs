use personal_agent_core::workspace_update::{compare_engines, DOCTOR_TIMEOUT};
use std::path::Path;

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        eprintln!("Usage: workspace-engine-choice CANDIDATE INSTALLED");
        std::process::exit(2);
    }
    let choice = compare_engines(Path::new(&args[1]), Path::new(&args[2]), DOCTOR_TIMEOUT);
    println!("{}", choice.as_str());
}
