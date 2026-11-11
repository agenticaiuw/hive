//! Control this Mac the way a person does, through agent-vhid-helper, from a shell
//! (`python3 python/agent_vhid.py ...`): same subcommands, output and exit codes.
//!
//! Exit codes: 0 done, 1 error, 2 bad arguments, 3 the human has control, 4 timed out (wait,
//! engage), 5 not on screen (find).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use hive_mac::vhid::{default_socket, AgentVHID, VhidError};

const PROG: &str = "hive-vhid";

const USAGE: &str = "usage: hive-vhid [-h] [--socket SOCKET] [--fast]
                 {status,cursor,release,watch,wait,engage,move,click,drag,scroll,type,key,screenshot,read,find}
                 ...";

const HELP: &str = "Control this Mac the way a person does, through agent-vhid-helper.

positional arguments:
  {status,cursor,release,watch,wait,engage,move,click,drag,scroll,type,key,screenshot,read,find}
    watch               print every hand-over until Ctrl-C
    wait                block until control has passed to the agent
    engage              take control (once your hands are off), then return
    read                print every word on screen with its position in points
    find                print where a word is on screen (exit 5 if not visible)

options:
  -h, --help            show this help message and exit
  --socket SOCKET
  --fast                straight moves, no typing jitter";

/// What argparse would say, and its exit code 2.
fn usage_error(msg: &str) -> ExitCode {
    eprintln!("{USAGE}\n{PROG}: error: {msg}");
    ExitCode::from(2)
}

/// The arguments after the subcommand: its positionals and its `--name value` options.
struct Sub {
    positional: Vec<String>,
    options: Vec<(String, String)>,
}

impl Sub {
    fn parse(args: &[String], takes: &[&str]) -> Result<Sub, String> {
        let mut sub = Sub {
            positional: Vec::new(),
            options: Vec::new(),
        };
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            if let Some(name) = arg.strip_prefix("--").filter(|n| !n.is_empty()) {
                let (name, inline) = match name.split_once('=') {
                    Some((n, v)) => (n.to_string(), Some(v.to_string())),
                    None => (name.to_string(), None),
                };
                if !takes.contains(&name.as_str()) {
                    return Err(format!("unrecognized arguments: {arg}"));
                }
                let value = match inline.or_else(|| it.next().cloned()) {
                    Some(v) => v,
                    None => return Err(format!("argument --{name}: expected one argument")),
                };
                sub.options.push((name, value));
            } else {
                sub.positional.push(arg.clone());
            }
        }
        Ok(sub)
    }

    fn option(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

fn float(name: &str, v: &str) -> Result<f64, String> {
    v.trim()
        .parse()
        .map_err(|_| format!("argument {name}: invalid float value: '{v}'"))
}

fn int(name: &str, v: &str) -> Result<i64, String> {
    v.trim()
        .parse()
        .map_err(|_| format!("argument {name}: invalid int value: '{v}'"))
}

/// `names` positionals, all required, then nothing more.
fn exactly<'a>(sub: &'a Sub, names: &[&str]) -> Result<Vec<&'a str>, String> {
    if sub.positional.len() < names.len() {
        let missing = names[sub.positional.len()..].join(", ");
        return Err(format!("the following arguments are required: {missing}"));
    }
    if sub.positional.len() > names.len() {
        return Err(format!(
            "unrecognized arguments: {}",
            sub.positional[names.len()..].join(" ")
        ));
    }
    Ok(sub.positional.iter().map(String::as_str).collect())
}

fn timeout(sub: &Sub) -> Result<Option<Duration>, String> {
    sub.option("timeout")
        .map(|t| {
            float("--timeout", t)
                .map(|s| Duration::try_from_secs_f64(s.max(0.0)).unwrap_or(Duration::MAX))
        })
        .transpose()
}

enum Failure {
    Usage(String),
    Vhid(VhidError),
}

impl From<VhidError> for Failure {
    fn from(e: VhidError) -> Self {
        Failure::Vhid(e)
    }
}

impl From<String> for Failure {
    fn from(e: String) -> Self {
        Failure::Usage(e)
    }
}

fn run(mac: &AgentVHID, cmd: &str, rest: &[String]) -> Result<u8, Failure> {
    let takes: &[&str] = match cmd {
        "wait" | "engage" => &["timeout"],
        "click" => &["button", "count"],
        "screenshot" => &["max-width"],
        _ => &[],
    };
    let sub = Sub::parse(rest, takes)?;
    match cmd {
        "status" => {
            exactly(&sub, &[])?;
            for (k, v) in &mac.status()?.0 {
                println!("{k}={v}");
            }
        }
        "cursor" => {
            exactly(&sub, &[])?;
            let (x, y) = mac.cursor();
            println!("{x:.1} {y:.1}");
        }
        "release" => {
            exactly(&sub, &[])?;
            mac.release_all()?;
        }
        "watch" => {
            exactly(&sub, &[])?;
            for event in mac.watch()? {
                let event = event?;
                match event.get("fn") {
                    Some(f) => println!("fn {f}"),
                    None => println!(
                        "{} {}",
                        event.get("state").unwrap_or("None"),
                        event.get("reason").unwrap_or("None")
                    ),
                }
            }
        }
        "wait" => {
            exactly(&sub, &[])?;
            return Ok(if mac.wait_engaged(timeout(&sub)?, true)? { 0 } else { 4 });
        }
        "engage" => {
            exactly(&sub, &[])?;
            let timeout = timeout(&sub)?;
            mac.engage()?;
            return Ok(if mac.wait_engaged(timeout, true)? { 0 } else { 4 });
        }
        "move" => {
            let p = exactly(&sub, &["x", "y"])?;
            mac.move_to(float("x", p[0])?, float("y", p[1])?)?;
        }
        "click" => {
            if sub.positional.len() > 2 {
                return Err(Failure::Usage(format!("unrecognized arguments: {}", sub.positional[2..].join(" "))));
            }
            let x = sub.positional.first().map(|v| float("x", v)).transpose()?;
            let y = sub.positional.get(1).map(|v| float("y", v)).transpose()?;
            let button = sub.option("button").unwrap_or("left");
            if !["left", "right", "middle"].contains(&button) {
                return Err(Failure::Usage(format!(
                    "argument --button: invalid choice: '{button}' (choose from 'left', 'right', 'middle')"
                )));
            }
            let count = sub.option("count").map(|c| int("--count", c)).transpose()?.unwrap_or(1);
            let at = match (x, y) {
                (Some(x), Some(y)) => Some((x, y)),
                (None, None) => None,
                _ => return Err(Failure::Vhid(VhidError::Invalid("click needs both x and y, or neither".into()))),
            };
            mac.click(at, button, count, None)?;
        }
        "drag" => {
            let p = exactly(&sub, &["x1", "y1", "x2", "y2"])?;
            let n: Vec<f64> = ["x1", "y1", "x2", "y2"]
                .iter()
                .zip(&p)
                .map(|(name, v)| float(name, v))
                .collect::<Result<_, _>>()?;
            mac.drag(n[0], n[1], n[2], n[3], "left")?;
        }
        "scroll" => {
            if sub.positional.is_empty() {
                return Err(Failure::Usage("the following arguments are required: down".into()));
            }
            if sub.positional.len() > 2 {
                return Err(Failure::Usage(format!("unrecognized arguments: {}", sub.positional[2..].join(" "))));
            }
            let down = int("down", &sub.positional[0])?;
            let right = sub.positional.get(1).map(|v| int("right", v)).transpose()?.unwrap_or(0);
            mac.scroll(down, right, None)?;
        }
        "type" => {
            let p = exactly(&sub, &["text"])?;
            mac.type_text(p[0])?;
        }
        "key" => {
            let p = exactly(&sub, &["combo"])?;
            mac.key(p[0])?;
        }
        "screenshot" => {
            if sub.positional.len() > 1 {
                return Err(Failure::Usage(format!("unrecognized arguments: {}", sub.positional[1..].join(" "))));
            }
            let path = sub.positional.first().map(PathBuf::from);
            let max_width = sub
                .option("max-width")
                .map(|w| int("--max-width", w))
                .transpose()?
                .map(|w| w.max(1) as usize);
            let shot = mac.screenshot(path.as_deref(), max_width)?;
            println!("{} {}x{} points_per_pixel={:.4}", shot.path.display(), shot.width, shot.height, shot.scale);
        }
        "read" => {
            exactly(&sub, &[])?;
            for b in mac.read_screen(None)? {
                let (x, y) = b.center();
                println!("{x:7.1} {y:6.1}  {}", b.text);
            }
        }
        "find" => {
            let p = exactly(&sub, &["word"])?;
            match mac.find_text(p[0], None, None)? {
                Some(b) => {
                    let (x, y) = b.center();
                    println!("{x:.1} {y:.1}");
                }
                None => return Ok(5),
            }
        }
        other => {
            return Err(Failure::Usage(format!(
                "argument cmd: invalid choice: '{other}' (choose from 'status', 'cursor', 'release', 'watch', \
                 'wait', 'engage', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'screenshot', 'read', 'find')"
            )))
        }
    }
    Ok(0)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut socket = default_socket();
    let mut fast = false;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => {
                println!("{USAGE}\n\n{HELP}");
                return ExitCode::SUCCESS;
            }
            "--fast" => fast = true,
            "--socket" => match args.get(i + 1) {
                Some(path) => {
                    socket = PathBuf::from(path);
                    i += 1;
                }
                None => return usage_error("argument --socket: expected one argument"),
            },
            _ if arg.starts_with("--socket=") => socket = PathBuf::from(&arg["--socket=".len()..]),
            _ if arg.starts_with('-') && arg.len() > 1 => {
                return usage_error(&format!("unrecognized arguments: {arg}"))
            }
            _ => break,
        }
        i += 1;
    }
    let Some(cmd) = args.get(i) else {
        return usage_error("the following arguments are required: cmd");
    };
    let mac = AgentVHID::new(socket, 1.0, !fast);
    let code = match run(&mac, cmd, &args[i + 1..]) {
        Ok(code) => code,
        Err(Failure::Usage(msg)) => {
            mac.close();
            return usage_error(&msg);
        }
        Err(Failure::Vhid(VhidError::Disengaged(e))) => {
            eprintln!("disengaged: {e}");
            3
        }
        Err(Failure::Vhid(e)) => {
            eprintln!("error: {e}");
            1
        }
    };
    mac.close();
    ExitCode::from(code)
}
