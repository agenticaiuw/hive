//! `hive-agent`: the voice agent Hive.app runs (voice_agent.py's `main`, `read_app`), and
//! `hive-agent --task "..."`, one request from the command line (agent.py's `main`).

use crate::parts::{Console, RealHost, Stdout};
use crate::real::{self, Codex, NoEars, SidecarEars, SidecarVoice, Window};
use crate::shell::{Event, Parts, VoiceAgent, INTERRUPTED};
use hive_mac::AgentVHID;
use std::io::BufRead;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};

pub const USAGE: &str = "Talk to your Mac. Tap fn and it listens, showing the words as you say them (Parakeet,
python/listen.py); when you pause, Codex does what you said with the real mouse and keyboard in
whatever window you're in, talking you through it out loud (Kokoro, python/speech.py). fn only
ever resumes: it never turns listening off or closes the floating window (its mic button mutes, its
x stops the agent). Hold fn instead and what you say is
typed into the app in front when you let go: dictation. Listening and speaking run on this Mac.

    hive-agent [--no-speak] [--app]
    hive-agent --task \"make a new note in Notes that says buy milk\"

  tap fn                   it listens (the microphone opens), continuing the conversation; while
                           you have the mouse and keyboard during a task, it hands them back
  hold fn and talk         dictation: let go and your words are typed where you're typing (pasted,
                           with the clipboard put back), not given to the agent
  fn + shift, then talk    dictation that goes on after you let go: press fn again and it's typed
  just talk                a pause of LISTEN_PAUSE seconds (0.8) ends what you're saying
  talk while it's talking  it goes quiet and listens
  say \"stop\"               cancel the running task
  talk during a task       interrupts it and continues with the new instruction
  touch keys / trackpad    take over; say \"continue\" to let it carry on
  \"... on my phone\"        does it on your iPhone (hive-phone, PHONE_RELAY), while a task on
                           the Mac carries on. Any task can use the phone when it needs to.

As you start talking it takes the Mac's screenshot (LookAhead), so the request goes to Codex
with it the moment you finish. After each request the log says where the time went, from when you
stopped talking to when it started answering (\"⏱ ...\").

What it says, and what it's doing, show as captions at the bottom of the screen (CAPTIONS=0 hides
them); while it listens, so do your words.

It keeps listening while it talks: whatever the Mac plays (its own voice, a video) is taken back
out of what the microphone hears (python/mic.py), so only you are heard. It waits for you to
finish before it starts saying something. Once you've taught it your voice (./voice.sh --enroll,
python/voiceprint.py), people talking nearby are ignored too.

Needs agent-vhid-helper running: ./install.sh has the Mac start it, ./voice.sh starts it otherwise.
--app is how Agent.app (tools/app.swift) runs it at login: \"toggle\" lines on stdin turn listening on
and off like fn, and \"@@ listening 1|0\", \"@@ dictating 1|0\" and \"@@ status TEXT\" lines on stdout are
for its menu bar.

--task runs one request and exits (0 when it finished, 1 if not, 130 on Ctrl-C).
";

pub const TASK_USAGE: &str = "Give your Mac or iPhone a task in plain English; Codex does it with the real mouse and keyboard,
or with taps on the phone.

    hive-agent --task \"make a new note in Notes that says buy milk\"
    hive-agent --task \"open Maps on my phone and find coffee nearby\"

Codex looks at the screens and acts with the Mac's tools (agent-vhid) and the iPhone's (hive-phone).
Every task gets both; one that says \"phone\" or \"iPhone\" starts with the phone's screen, any other
with the Mac's. It runs on `codex app-server`, so on your Codex subscription, with our instructions
(instructions.md) in place of Codex's own. Everything you ask from when you tap fn to talk is one
conversation (Session): one Codex thread with a turn for each request, so it has all of it in
context, and Codex compacts (summarizes) the thread when it gets long. Touch any key, the trackpad
or the mouse to take over; say \"continue\" to the voice agent, or run `hive-vhid engage`, to let it
carry on.

Environment (or .env):
  CODEX_BIN     codex executable (default: the one inside ChatGPT.app, else `codex` on PATH)
  AGENT_MODEL   model (default: gpt-6.1-terra)
  AGENT_EFFORT  reasoning effort for each step: low (default, quickest), medium, high. Higher
                thinks longer before every click, which makes the agent several times slower
  AGENT_FAST    1: Codex's Fast tier, which OpenAI says is 1.5x quicker but uses up your plan's
                usage sooner (off by default)
";

extern "C" fn interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

/// SIGTERM (the app quit, or stdin ended) and SIGINT end the main loop (Python's `interrupt`).
pub fn on_signals() {
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, interrupt as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, interrupt as *const () as libc::sighandler_t);
    }
}

/// What a line from Agent.app's menu asks for: "toggle" is the same as tapping fn; "ingest PATH"
/// adds the text in PATH to the conversation; "input voice|lips" picks how you talk to it;
/// "speak on|off" is Speak Aloud and "window on|off" Show Floating Window.
pub fn app_line(line: &str) -> Option<Event> {
    let line = line.trim();
    if line == "toggle" {
        return Some(Event::Toggle);
    }
    let (what, arg) = line.split_once(' ')?;
    let on = || match arg.trim() {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    };
    match what {
        "ingest" => Some(Event::Ingest(arg.to_owned())),
        "input" => Some(Event::Input(arg.to_owned())),
        "speak" => on().map(Event::Speak),
        "window" => on().map(Event::Window),
        _ => None,
    }
}

/// "quit" and "restart": the menu's Quit Agent and Restart Agent, said in the log and the session
/// journal before the agent stops itself (the app starts it again after a restart).
pub fn menu_stop(line: &str) -> Option<&'static str> {
    match line.trim() {
        "quit" => Some("quit from the menu"),
        "restart" => Some("restart from the menu"),
        _ => None,
    }
}

/// Agent.app's menu on stdin (python's `read_app`). The end of stdin means the app quit: it
/// sends itself SIGTERM, as it does after "quit" and "restart". Lines before the agent exists
/// are dropped. Speak Aloud is set here, not on the main loop, so it goes quiet at once.
pub fn read_app(agent: Arc<Mutex<Option<Weak<VoiceAgent>>>>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let target = || {
            agent
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .and_then(Weak::upgrade)
        };
        if let Some(what) = menu_stop(&line) {
            match target() {
                Some(agent) => agent.note_menu_stop(what),
                None => hive_common::say(format!("⏏  {what}")),
            }
            break;
        }
        let Some(event) = app_line(&line) else {
            continue;
        };
        match (target(), event) {
            (Some(agent), Event::Speak(on)) => agent.set_speaking(on),
            (Some(agent), event) => agent.put(event),
            (None, _) => {}
        }
    }
    // SAFETY: kill and getpid have no memory effects.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGTERM);
    }
}

/// `hive-agent`'s main.
pub fn main(argv: &[String]) -> i32 {
    // SpaceO, the old virtual workspace, only when it's asked for at launch
    // (AGENT_EXPERIMENTAL_SPACEO=1). Hive.app's workspace build passes AGENT_SPACEO_COMMAND by
    // default; with it, the agent's mouse and keyboard, its voice and the floating window all
    // went to a workspace that never started, so fn listened with no window to show it. Before
    // any thread starts, so everything here and every helper sees the same environment.
    if std::env::var("AGENT_EXPERIMENTAL_SPACEO").as_deref() != Ok("1") {
        std::env::remove_var("AGENT_SPACEO_COMMAND");
    }
    if let Some(at) = argv.iter().position(|a| a == "--task") {
        return task_main(&argv[at + 1..]);
    }
    if argv.iter().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        return 0;
    }
    let app = argv.iter().any(|a| a == "--app");
    if let Err(error) = hive_common::settings::load(None) {
        eprintln!("{error}");
        return 1;
    }
    let console = Arc::new(Stdout::fixed());
    let codex = real::codex();
    if let Err(error) = codex.find_codex() {
        eprintln!("{error}");
        return 1;
    }
    {
        // Codex is ready by the time you've said something
        let codex = codex.clone();
        std::thread::spawn(move || codex.warm_up());
    }
    // From the start, so the app quitting stops us even while we wait for the helper.
    let target: Arc<Mutex<Option<Weak<VoiceAgent>>>> = Arc::new(Mutex::new(None));
    if app {
        let target = target.clone();
        let _ = std::thread::Builder::new()
            .name("read-app".into())
            .spawn(move || read_app(target));
    }
    let mac = Arc::new(AgentVHID::default());
    if !hive_mac::vhid::wait_for_helper(&mac, app) {
        return 1;
    }
    let speak = !argv.iter().any(|a| a == "--no-speak");
    let log_to = console.clone();
    let options = hive_sidecars::VoiceOptions {
        speak,
        listening: false,
        log: Arc::new(move |line: &str| log_to.line(line)),
        ..hive_sidecars::VoiceOptions::default()
    };
    let sidecar = match hive_sidecars::VoiceSidecar::start(options) {
        Ok(sidecar) => Some(Arc::new(sidecar)),
        Err(error) => {
            console.line(&format!("   ✗ the voice sidecar couldn't start: {error}"));
            None
        }
    };
    let (ears, voice): (
        Arc<dyn crate::parts::Ears>,
        Option<Arc<dyn crate::parts::Voice>>,
    ) = match &sidecar {
        Some(sidecar) => (
            Arc::new(SidecarEars::new(sidecar.clone())),
            sidecar
                .voice()
                .map(|v| Arc::new(SidecarVoice(v)) as Arc<dyn crate::parts::Voice>),
        ),
        None => (
            Arc::new(NoEars("the voice sidecar didn't start".into())),
            None,
        ),
    };
    let window = Arc::new(Window(hive_sidecars::Captions::new(true)));
    let agent = VoiceAgent::new(Parts {
        ears,
        voice,
        captions: window.clone(),
        mac: mac.clone(),
        backend: Arc::new(Codex(codex.clone())),
        host: Arc::new(RealHost),
        console,
        app,
    });
    if let Some(sidecar) = &sidecar {
        real::wire_voice(sidecar, &agent);
    }
    real::wire_window(&window.0, &agent);
    real::start_recording(&agent);
    *target.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::downgrade(&agent));
    on_signals(); // a script may start us with Ctrl-C ignored
    agent.run();
    agent.shutdown();
    codex.stop_server();
    if let Some(sidecar) = sidecar {
        sidecar.close();
    }
    0
}

/// `hive-agent --task WORDS...` (agent.py's `main`): one request, its events printed.
pub fn task_main(argv: &[String]) -> i32 {
    if argv.is_empty() || matches!(argv[0].as_str(), "-h" | "--help") {
        print!("{TASK_USAGE}");
        return 0;
    }
    if let Err(error) = hive_common::settings::load(None) {
        eprintln!("{error}");
        return 1;
    }
    hive_common::say(format!(
        "Agent context: {}",
        hive_common::state_dir()
            .join("context/index.html")
            .display()
    ));
    let task = argv.join(" ");
    let receipt = match hive_knowledge::ui_ingress::admit(&task, "cli") {
        Ok(receipt) => receipt,
        Err(error) => {
            hive_common::say(format!(
                "Could not save the request; it was not started: {error}"
            ));
            return 1;
        }
    };
    let mac = AgentVHID::default();
    if hive_codex::focus(&task) == "mac" {
        let status = match mac.status() {
            Ok(status) => status,
            Err(e) => {
                hive_common::say(format!(
                    "agent-vhid-helper isn't reachable ({e}). Start it with ./run.sh or ./voice.sh."
                ));
                return 1;
            }
        };
        if status.get("state") != Some("engaged") {
            if let Err(e) = mac.engage() {
                // you typed the task; it takes over once your hands are off
                hive_common::say(format!("Couldn't take the mouse and keyboard: {e}"));
            }
        }
    }
    let codex = real::codex();
    let print: hive_codex::OnEvent = Arc::new(|kind: &str, text: &str| {
        if let Some(line) = hive_codex::print_event(kind, text) {
            hive_common::say(line);
        }
    });
    let options = hive_codex::TaskOptions {
        on_event: Some(print),
        ..hive_codex::TaskOptions::default()
    };
    let run = hive_codex::CodexTask::new(&codex, &task, options);
    run.set_receipt_id(Some(receipt.clone()));
    run.start(true);
    if let Err(error) = hive_knowledge::ui_ingress::finish(&receipt, "accepted") {
        hive_common::say(format!(
            "Request started, but receipt status is unknown: {error}"
        ));
    }
    on_signals();
    let mut code = None;
    while !run.wait_done(0.2) {
        if INTERRUPTED.load(Ordering::SeqCst) {
            run.stop();
            code = Some(130);
            break;
        }
    }
    let _ = crate::parts::Mac::disengage(&mac);
    codex.stop_server();
    code.unwrap_or(if run.final_text().is_some() { 0 } else { 1 })
}
