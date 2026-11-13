//! The real parts behind [`crate::parts`]: the voice sidecar's ears and voice, the captions
//! window, the helper, the lip reader and Codex (hive-codex, with the other crates wired into its
//! hooks), plus the workspace, request socket and update processes [`crate::parts::Host`] starts.

use crate::parts::{self, Backend, Closeable, LocalRequest, Look, Mic, OnEvent};
use crate::shell::VoiceAgent;
use crate::util::monotonic_of;
use hive_codex::{task_recovery, Agent, CodexTask, LookAhead, TaskOptions};
use hive_common::tools::ToolNamespace;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

// -- the voice sidecar --

/// listen.Ears in the sidecar.
pub struct SidecarEars {
    pub sidecar: Arc<hive_sidecars::VoiceSidecar>,
    pub ears: hive_sidecars::Ears,
}

impl SidecarEars {
    pub fn new(sidecar: Arc<hive_sidecars::VoiceSidecar>) -> SidecarEars {
        let ears = sidecar.ears();
        SidecarEars { sidecar, ears }
    }
}

impl parts::Ears for SidecarEars {
    fn listen(&self, on: bool) {
        self.ears.listen(on)
    }
    fn listening(&self) -> bool {
        self.ears.listening()
    }
    fn cut(&self, then: Option<Box<dyn FnOnce() + Send>>) {
        match then {
            Some(then) => self.ears.cut_then(then),
            None => self.ears.cut(),
        }
    }
    fn mic_level(&self) -> f64 {
        self.ears.mic_level()
    }
    fn hears_the_mac(&self) -> bool {
        self.ears.hears_the_mac()
    }
    fn microphone(&self) -> Option<Mic> {
        self.ears.microphone().map(|m| Mic {
            description: m.describe(),
            tap_error: m.tap_error.clone(),
            canceller_error: m.canceller_error.clone(),
        })
    }
    fn heard_times(&self) -> BTreeMap<String, f64> {
        self.ears
            .heard_times()
            .into_iter()
            .map(|(k, at)| (k, monotonic_of(at)))
            .collect()
    }
    fn describe(&self) -> String {
        self.ears.describe()
    }
    fn has_model(&self) -> bool {
        self.ears.has_model()
    }
    fn has_voiceprint(&self) -> bool {
        self.ears.voiceprint().is_some()
    }
    fn describe_voiceprint(&self) -> String {
        self.ears
            .voiceprint()
            .map(|v| v.describe())
            .unwrap_or_else(|| "None".into())
    }
    fn heard_machine(&self) -> bool {
        self.ears.voiceprint().is_some_and(|v| v.heard_machine())
    }
    fn learn_its_voice(&self) -> Result<bool, String> {
        self.sidecar.learn_its_voice()
    }
}

/// speech.Voice in the sidecar.
pub struct SidecarVoice(pub hive_sidecars::Voice);

impl parts::Voice for SidecarVoice {
    fn say(&self, text: &str) {
        self.0.say(text)
    }
    fn stop(&self) {
        self.0.stop()
    }
    fn audible(&self) -> bool {
        self.0.audible()
    }
    fn quiet_for(&self) -> f64 {
        self.0.quiet_for()
    }
    fn name(&self) -> String {
        self.0.voice()
    }
}

/// Points the sidecar's callbacks at the agent. Each only puts an event on the agent's queue (or,
/// for cut-in and on_play, stops the voice and updates the captions), so the sidecar's one
/// dispatcher thread is never held up: what you say over its voice stops it at once, even while
/// the main loop is busy with what you said before.
pub fn wire_voice(sidecar: &hive_sidecars::VoiceSidecar, agent: &Arc<VoiceAgent>) {
    let ears = sidecar.ears();
    let me = Arc::downgrade(agent);
    let with = move |f: &dyn Fn(&VoiceAgent)| {
        if let Some(agent) = me.upgrade() {
            f(&agent)
        }
    };
    let on_text = with.clone();
    ears.set_on_text(move |text, final_| on_text(&|a| a.heard(text, final_)));
    let on_speech = with.clone();
    ears.set_on_speech(move || on_speech(&|a| a.cut_in()));
    let on_ignored = with.clone();
    ears.set_on_ignored(move |seconds, similarity| on_ignored(&|a| a.ignored(seconds, similarity)));
    if let Some(voice) = sidecar.voice() {
        let on_play = with;
        voice.set_on_play(move |words| on_play(&|a| a.on_play(words)));
    }
}

// -- the floating window --

/// captions.py's window (build/agent-vhid-captions).
pub struct Window(pub hive_sidecars::Captions);

impl parts::Captions for Window {
    fn say(&self, words: &str) {
        self.0.say(words)
    }
    fn listening(&self, on: bool) {
        self.0.listening(on)
    }
    fn focus(&self, on: bool) {
        self.0.focus(on)
    }
    fn dictating(&self, on: bool) {
        self.0.dictating(on)
    }
    fn hands_free(&self, on: bool) {
        self.0.hands_free(on)
    }
    fn camera(&self, state: &str) {
        self.0.camera(state)
    }
    fn dismiss(&self) {
        self.0.dismiss()
    }
    fn framing(&self, text: &str) {
        self.0.framing(text)
    }
    fn preview(&self, jpeg: &str) {
        self.0.preview(jpeg)
    }
    fn hearing(&self, words: &str) {
        self.0.hearing(words)
    }
    fn doing(&self, text: &str) {
        self.0.doing(text)
    }
    fn thinking(&self, text: &str) {
        self.0.thinking(text)
    }
    fn agent_request(&self, text: &str) {
        self.0.agent_request(text)
    }
    fn paused(&self, text: &str) {
        self.0.paused(text)
    }
    fn muted(&self, on: bool) {
        self.0.muted(on)
    }
    fn activity(&self, text: &str) {
        self.0.activity(text)
    }
    fn active(&self, on: bool) {
        self.0.active(on)
    }
    fn close(&self) {
        self.0.close()
    }
}

/// The window's text box and buttons go to the agent's queue.
pub fn wire_window(captions: &hive_sidecars::Captions, agent: &Arc<VoiceAgent>) {
    let me = Arc::downgrade(agent);
    captions.set_on_input(move |text| {
        if let Some(agent) = me.upgrade() {
            agent.on_input(text)
        }
    });
    let me = Arc::downgrade(agent);
    captions.set_on_control(move |kind, value| {
        if let Some(agent) = me.upgrade() {
            agent.on_control(kind, value)
        }
    });
}

// -- the helper --

impl parts::Mac for hive_mac::AgentVHID {
    fn is_engaged(&self) -> Result<bool, String> {
        hive_mac::AgentVHID::is_engaged(self).map_err(|e| e.to_string())
    }
    fn engage(&self) -> Result<(), String> {
        hive_mac::AgentVHID::engage(self).map_err(|e| e.to_string())
    }
    fn disengage(&self) -> Result<(), String> {
        hive_mac::AgentVHID::disengage(self).map_err(|e| e.to_string())
    }
    fn release_all(&self) -> Result<(), String> {
        hive_mac::AgentVHID::release_all(self).map_err(|e| e.to_string())
    }
    fn socket(&self) -> PathBuf {
        self.socket_path.clone()
    }
}

// -- lip reading --

/// lipread.LipReader.
pub struct LipsReader(pub hive_sidecars::LipReader);

impl parts::Lips for LipsReader {
    fn open(&self) -> Result<(), String> {
        self.0.open().map_err(|e| e.to_string())
    }
    fn start(&self) -> Result<(), String> {
        self.0.start().map_err(|e| e.to_string())
    }
    fn stop(&self) -> Result<String, String> {
        self.0
            .stop(hive_sidecars::lipread::STOP_TIMEOUT)
            .map_err(|e| e.to_string())
    }
    fn close(&self) {
        self.0.close()
    }
    fn session(&self) -> Option<u64> {
        Some(self.0.session())
    }
}

pub fn new_lips(on_event: Arc<dyn Fn(Value) + Send + Sync>) -> Arc<dyn parts::Lips> {
    Arc::new(LipsReader(hive_sidecars::LipReader::new(move |event| {
        on_event(event)
    })))
}

// -- Codex --

/// A request on Codex.
pub struct CodexJob(pub Arc<CodexTask>);

impl parts::Task for CodexJob {
    fn task(&self) -> String {
        self.0.task().to_owned()
    }
    fn device(&self) -> String {
        self.0.device().to_owned()
    }
    fn running(&self) -> bool {
        self.0.running()
    }
    fn start(&self, look: bool) {
        self.0.start(look);
    }
    fn stop(&self) {
        self.0.stop()
    }
    fn stop_for_maintenance(&self) {
        self.0.stop_for_maintenance()
    }
    fn started_at(&self) -> f64 {
        self.0.started_at()
    }
    fn elapsed(&self) -> f64 {
        self.0.elapsed()
    }
    fn began(&self) -> f64 {
        self.0.began()
    }
    fn times(&self) -> Vec<(String, f64)> {
        self.0.times()
    }
    fn looked_ahead(&self) -> bool {
        self.0.looked_ahead()
    }
    fn calls_to_words(&self) -> i64 {
        self.0.calls_to_words()
    }
    fn thread_id(&self) -> Option<String> {
        self.0.thread_id()
    }
    fn on_thread(&self) -> bool {
        self.0.on_thread()
    }
    fn recovery_id(&self) -> Option<String> {
        self.0.recovery_id()
    }
    fn set_receipt_id(&self, receipt: Option<String>) {
        self.0.set_receipt_id(receipt)
    }
    fn set_on_event(&self, on_event: OnEvent) {
        self.0.set_on_event(on_event)
    }
    fn set_prompt(&self, prompt: String) {
        self.0.set_prompt(prompt)
    }
    fn set_durable_recovery(&self, durable: bool) {
        self.0.set_durable_recovery(durable)
    }
    fn wait_done(&self, seconds: f64) -> bool {
        self.0.wait_done(seconds)
    }
    fn final_text(&self) -> Option<String> {
        self.0.final_text()
    }
    fn ended(&self) -> String {
        self.0.ended()
    }
    fn handed_back(&self) {
        if let Some(mac) = self.0.device_tool("mac") {
            mac.handed_back();
        }
    }
}

/// hive-codex's agent, as the shell uses it.
pub struct Codex(pub Arc<Agent>);

impl Codex {
    fn dir(&self) -> PathBuf {
        self.0.state_dir()
    }
}

impl Backend for Codex {
    fn task(
        &self,
        text: &str,
        previous: Option<&str>,
        device: &str,
        ahead: Option<Look>,
    ) -> Arc<dyn parts::Task> {
        let options = TaskOptions {
            previous: previous.map(str::to_owned),
            device: Some(device.to_owned()),
            ahead: ahead.and_then(|look| look.downcast::<LookAhead>().ok()),
            ..TaskOptions::default()
        };
        Arc::new(CodexJob(CodexTask::new(&self.0, text, options)))
    }
    fn focus(&self, words: &str) -> String {
        hive_codex::focus(words).to_owned()
    }
    fn new_session(&self) {
        self.0.new_session();
    }
    fn look_ahead(&self) -> Option<Look> {
        Some(LookAhead::new(&self.0) as Look)
    }
    fn describe_model(&self) -> String {
        self.0.describe_model()
    }
    fn server_running(&self) -> bool {
        self.0.running_server().is_some()
    }
    fn request(&self, method: &str, params: Value, timeout: f64) -> Option<Result<Value, String>> {
        let server = self.0.running_server()?;
        Some(
            server
                .request(method, params, timeout)
                .map_err(|e| e.to_string()),
        )
    }
    fn restore(&self) -> Result<Option<Arc<dyn parts::Task>>, String> {
        let dir = self.dir();
        let owner = task_recovery::acquire_owner(&dir).map_err(|e| e.to_string())?;
        let record = match owner {
            Some(_) => hive_codex::startup_recovery_record(&dir).map_err(|e| e.to_string())?,
            None => None,
        };
        let Some(record) = record else {
            if let Some(owner) = owner {
                owner.close();
            }
            return Ok(None);
        };
        let device = record
            .get("device")
            .and_then(Value::as_str)
            .unwrap_or("mac")
            .to_owned();
        let options = TaskOptions {
            device: Some(device),
            ..TaskOptions::default()
        };
        let task = CodexTask::new(&self.0, "Continue the previously authorized work", options);
        task.set_startup_record(record, owner);
        Ok(Some(Arc::new(CodexJob(task))))
    }
    fn recovery_current(&self) -> Result<Option<Value>, String> {
        task_recovery::current(&self.dir()).map_err(|e| e.to_string())
    }
    fn recovery_finish(&self, id: &str, status: &str) -> Result<(), String> {
        task_recovery::finish(&self.dir(), id, status)
            .map(drop)
            .map_err(|e| e.to_string())
    }
    fn provider_status(&self, id: &str) -> Result<Option<String>, String> {
        hive_codex::provider_wait::status(&self.dir(), id)
            .map(|s| s.map(str::to_owned))
            .map_err(|e| e.to_string())
    }
}

/// hive-phone's `Phone` as hive-mac's credentials see a phone.
struct PhoneDevice<'a>(&'a hive_phone::Phone);

impl hive_mac::credentials::PhoneDevice for PhoneDevice<'_> {
    fn base(&self) -> String {
        self.0.base.clone()
    }
    fn request(
        &self,
        path: &str,
        method: &str,
        body: Option<&Value>,
        sensitive: bool,
    ) -> Result<Value, String> {
        self.0
            .request(
                path,
                method,
                body.cloned().unwrap_or(Value::Null),
                sensitive,
            )
            .map_err(|e| e.0)
    }
    fn session(&self) -> Result<String, String> {
        self.0.session().map_err(|e| e.0)
    }
    fn in_session(&self, path: &str, method: &str, body: Option<&Value>) -> Result<Value, String> {
        self.0
            .in_session(path, method, body.cloned().unwrap_or(Value::Null))
            .map_err(|e| e.0)
    }
}

/// The phone's `authenticate` tool: credentials.authenticate_phone.
pub struct PhonePasscode;

impl hive_phone::PhoneAuthenticator for PhonePasscode {
    fn authenticate_phone(&self, phone: &hive_phone::Phone) -> Result<String, String> {
        hive_mac::credentials::authenticate_phone(&PhoneDevice(phone)).map_err(|e| e.0)
    }
}

/// agent.py's `device_tools()`: `{"mac": MacTools(), "phone": PhoneTools()}`.
pub fn device_tools() -> Vec<Arc<dyn ToolNamespace>> {
    vec![
        Arc::new(hive_mac::MacTools::new()),
        Arc::new(hive_phone::PhoneTools::new().with_authenticator(Arc::new(PhonePasscode))),
    ]
}

struct KnowledgeBase;

impl hive_codex::Knowledge for KnowledgeBase {
    fn namespace(&self) -> Option<Value> {
        Some(hive_knowledge::knowledge::namespace())
    }
    fn rules(&self) -> String {
        hive_knowledge::knowledge::RULES.to_owned()
    }
    fn turn_hint(&self) -> String {
        hive_knowledge::knowledge::TURN_HINT.to_owned()
    }
    fn is_call(&self, namespace: Option<&str>, tool: Option<&str>, args: &Value) -> bool {
        hive_knowledge::knowledge::is_call(namespace, tool, args)
    }
    fn describe(&self, namespace: Option<&str>, tool: Option<&str>, args: &Value) -> String {
        hive_knowledge::knowledge::describe(namespace, tool, args)
    }
    fn call(
        &self,
        namespace: Option<&str>,
        tool: Option<&str>,
        args: &Value,
        task: &str,
        device: &str,
    ) -> Result<(Value, String), String> {
        hive_knowledge::knowledge::call(namespace, tool, args, task, device)
            .map_err(|e| e.to_string())
    }
}

struct PersonalMemory;

impl hive_codex::Memory for PersonalMemory {
    fn automatic_context(&self, request: &str) -> Result<Value, String> {
        Ok(hive_knowledge::memory_search::automatic_context(
            request,
            &hive_knowledge::memory_search::default_database(),
        ))
    }
    fn activity_summary(&self, result: &Value) -> Option<String> {
        hive_knowledge::memory_search::activity_summary(result)
    }
}

struct ContextInspector;

impl hive_codex::ContextRecorder for ContextInspector {
    fn record(
        &self,
        kind: &str,
        payload: &Value,
        task: Option<&str>,
        thread: Option<&str>,
    ) -> Result<Option<String>, String> {
        hive_knowledge::agent_context::ContextLog::new()
            .record(kind, payload, task, thread)
            .map(Some)
    }
}

struct Workspace;

impl hive_codex::WorkspaceTools for Workspace {
    fn workspace(&self, request: &Value) -> Result<Value, String> {
        hive_workspace::tools::workspace(&hive_common::state_dir(), request)
    }
    fn memory(&self, request: &Value) -> Result<Value, String> {
        hive_workspace::tools::memory(&hive_common::state_dir(), request)
    }
}

/// Everything hive-codex reaches outside itself, wired to the other crates.
pub fn hooks() -> hive_codex::Hooks {
    hive_codex::Hooks {
        device_tools: Arc::new(device_tools),
        knowledge: Arc::new(KnowledgeBase),
        memory: Arc::new(PersonalMemory),
        context: Arc::new(ContextInspector),
        workspace_tools: Arc::new(Workspace),
        virtual_monitor_enabled: Arc::new(hive_mac::virtual_monitor::enabled),
        warm_browser_tabs: Arc::new(|| {
            hive_mac::desktop::browser_tabs(None, Duration::from_secs(120));
        }),
        provider: Arc::new(hive_codex::FileProviderWait),
    }
}

/// `<repo>/build/hive-auth-mcp`: Codex's "authentication" MCP server.
pub fn auth_mcp() -> PathBuf {
    hive_common::build_dir().join("hive-auth-mcp")
}

/// The agent's Codex, as agent.py configured it, with the sign-in tools served by hive-auth-mcp.
pub fn codex() -> Arc<Agent> {
    let config = hive_codex::Config {
        authentication_command: auth_mcp().display().to_string(),
        authentication_args: Vec::new(),
        ..hive_codex::Config::default()
    };
    Agent::new(hive_codex::Env::default(), config, hooks())
}

// -- what the Host starts --

/// Runs `program args` with no input: Some(exit code), or None after `timeout` (it is killed).
fn run_quietly(program: &str, args: &[&str], timeout: Duration) -> std::io::Result<Option<i32>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = std::io::Read::read_to_string(stderr, &mut text);
        }
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status.code().unwrap_or(-1));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = reader.join();
    Ok(status)
}

pub fn pause_workspace(engine: &str) -> bool {
    let args = [
        "session",
        "pause",
        "--session",
        "personal-agent-workspace",
        "--operator",
        "--reason",
        "Stopped by fn",
    ];
    matches!(
        run_quietly(engine, &args, Duration::from_secs(3)),
        Ok(Some(0))
    )
}

struct Bridge(Arc<hive_workspace::bridge::Bridge>);

impl Closeable for Bridge {
    fn close(&self) {
        self.0.close()
    }
}

pub fn start_workspace(spaceo: &str, on_activity: OnEvent) -> Result<Arc<dyn Closeable>, String> {
    let bridge = hive_workspace::bridge::Bridge::spawn(spaceo, Some(on_activity))?;
    if let Err(error) = bridge.start_embedded() {
        bridge.close();
        return Err(error);
    }
    Ok(Arc::new(Bridge(bridge)))
}

struct Requests(hive_workspace::local_request::LocalRequests);

impl Closeable for Requests {
    fn close(&self) {
        self.0.close()
    }
}

pub fn local_requests(
    dir: &Path,
    on_request: Arc<dyn Fn(LocalRequest) + Send + Sync>,
) -> Result<Arc<dyn Closeable>, String> {
    let host = Arc::new(
        move |request: hive_workspace::local_request::LocalRequest| {
            on_request(LocalRequest {
                text: request.text.clone(),
                resume_goal: request.resume_goal,
                goal_objective: request.goal_objective.clone(),
                receipt_id: request.receipt_id.clone(),
                deadline: request.deadline,
                reply: Box::new(move |value| request.reply(value)),
            })
        },
    );
    Ok(Arc::new(Requests(
        hive_workspace::local_request::LocalRequests::start_with(dir, host)?,
    )))
}

/// `/bin/bash <repo>/tools/update-app.sh` in a session of its own (it restarts this process),
/// its output appended to `log`.
pub fn start_update(log: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)?;
    let err = out.try_clone()?;
    let mut command = Command::new("/bin/bash");
    command.arg(hive_common::repo_root().join("tools").join("update-app.sh"));
    command.stdin(Stdio::null()).stdout(out).stderr(err);
    // SAFETY: setsid is async-signal-safe; it only makes the child a session leader.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Every task is recorded: the screen as a video, with a timeline of Hive's status and the Mac's
/// state at exact times, uploaded to Cloudflare R2 afterwards (task_recording, cloud_archive).
/// Also the knowledge base in the cloud: saves made while offline go up, the Mac's copy is
/// refreshed.
pub fn start_recording(agent: &Arc<VoiceAgent>) {
    use hive_knowledge::task_recording::{Recorder, RecorderOptions};
    let report = |agent: Weak<VoiceAgent>, mark: &'static str| -> hive_knowledge::Report {
        Arc::new(move |line: &str| {
            if let Some(agent) = agent.upgrade() {
                agent.out(&format!("   {mark}  {line}"));
            }
        })
    };
    let me = Arc::downgrade(agent);
    let running = me.clone();
    let mut options =
        RecorderOptions::new(move || running.upgrade().is_some_and(|a| a.tasks.lock().any()));
    let engaged = me.clone();
    options.engaged = Some(Box::new(move || {
        engaged
            .upgrade()
            .is_some_and(|a| a.mac.is_engaged().unwrap_or(false))
    }));
    let titled = me.clone();
    options.title = Some(Box::new(move || {
        titled
            .upgrade()
            .and_then(|a| {
                let tasks = a.tasks.get();
                tasks.mac.or(tasks.phone).map(|t| t.task())
            })
            .unwrap_or_default()
    }));
    options.cursor = Some(Box::new(|| {
        Some(hive_mac::System::cursor(&hive_mac::RealMac))
    }));
    let finished = report(me.clone(), "🎞");
    options.on_finished = Some(Box::new(move |_folder: &Path| {
        hive_knowledge::cloud_archive::archive_in_background(Some(finished.clone()));
    }));
    agent.recorder.set(Some(Recorder::new(options)));
    hive_knowledge::cloud_archive::archive_in_background(Some(report(me.clone(), "🎞")));
    hive_knowledge::knowledge::sync_in_background(Some(report(me, "📚")));
}

/// Ears when the voice sidecar couldn't start: typed requests still work.
pub struct NoEars(pub String);

impl parts::Ears for NoEars {
    fn listen(&self, _on: bool) {}
    fn listening(&self) -> bool {
        false
    }
    fn cut(&self, then: Option<Box<dyn FnOnce() + Send>>) {
        if let Some(then) = then {
            then()
        }
    }
    fn mic_level(&self) -> f64 {
        -1.0 // no microphone to warn about
    }
    fn hears_the_mac(&self) -> bool {
        true
    }
    fn microphone(&self) -> Option<Mic> {
        None
    }
    fn heard_times(&self) -> BTreeMap<String, f64> {
        BTreeMap::new()
    }
    fn describe(&self) -> String {
        format!("nothing ({})", self.0)
    }
    fn has_model(&self) -> bool {
        false
    }
    fn has_voiceprint(&self) -> bool {
        false
    }
    fn describe_voiceprint(&self) -> String {
        "off".into()
    }
    fn heard_machine(&self) -> bool {
        false
    }
}
