# personal-agent

Talk to your Mac and it talks back. Tap **fn** in any window and say what you
want, and a computer agent does the work on screen with a real-looking
keyboard and mouse, then tells you out loud what it did. It hands control back to you the
instant you touch anything, like Tesla's Autopilot. Captions at the bottom of the screen show
what it says and what it's doing. It can use your iPhone too, whenever a request needs it,
and "... on my phone" runs on the phone at the same time as a task on the Mac. Hold **fn**
instead and it's dictation: what you say is typed into the app you're in when you let go.

```bash
git submodule update --init   # once, after cloning: Karabiner's client headers
./install.sh                  # Agent in the menu bar, opened at login
```

The app builds its workspace engine from the maintained `workspace-engine/` source in this
repository, including its MIT license; the build does not clone Braus. The normal app keeps
physical-device mode by default. The workspace candidate enables the virtual workspace by
default, and `AGENT_EXPERIMENTAL_SPACEO` can explicitly choose it. The former experimental
single-window Braus seat is not available in this build. Rust crates and voice models still
need to be available locally or downloaded during setup.

The keyboard and mouse part is **agent-vhid**:

The input goes through Karabiner's virtual HID driver, so macOS sees a USB
keyboard and mouse, not simulated events. Nothing to plug in.

```
agent (Python / any shell)                 you
   │  /tmp/agent-vhid.sock                  │ keyboard, trackpad, mouse
   ▼                                        ▼
agent-vhid-helper (root) ── gate ◄── watcher (IOHIDManager + MultitouchSupport)
   │
   ▼
Karabiner-VirtualHIDDevice-Daemon → DriverKit virtual keyboard + mouse → macOS
```

## Taking turns

| You do | What happens |
|---|---|
| Give it a task (say it, or type it) | After 0.4 s with your hands off, the agent gets control (chime: Glass) |
| Press any key, touch the trackpad, move or click a mouse | The agent loses control at once; anything it was holding is released (chime: Funk) |
| Touch anything during that 0.4 s | The hand-over is cancelled |
| Say "continue" | It takes control back the same way and carries on |
| Tap **fn**, or hold it to dictate | The voice agent starts listening, or stops, or types what you say; a task it's doing carries on either way |

The helper starts with you in control. An agent asks for control (`engage`)
when it starts a task, and only gets it once your hands have been off for 0.4 s;
touching anything takes it back at once. If Input Monitoring is denied, the
helper refuses to start, so the agent never runs without your takeover working.

## Talk to it

```bash
./install.sh
```

It asks for your password, has the Mac start the helper (as root, from now on
at every startup), and puts **Agent** in `~/Applications` and opens it: a
microphone in the menu bar, opened at login. Then, in any window, **tap fn and
say what you want**. The icon turns red, the captions say it's listening, and
the words show up there as you say them. When you pause (0.8 s, or 2.5 s if you
trailed off on "and..." or a comma), the computer agent works out the steps from
screenshots and does them with the virtual mouse and keyboard while you watch,
telling you out loud what it's doing as it goes and what happened at the end.
Then control comes back to you. Tap fn again to stop it listening: what you were
in the middle of saying still counts, and a task it's doing carries on. Agent's
menu does the same (Start/Stop Listening), and has Open at Login, Show Log
(`~/Library/Logs/Agent.log`), Restart Agent and Quit Agent.

Once, after installing:

- **System Settings › Privacy & Security › Input Monitoring:** turn on
  `agent-vhid-helper` (add `/Library/PrivilegedHelperTools/agent-vhid-helper`
  with + if it isn't listed), so touching anything takes control back.
- **Microphone** and **Screen & System Audio Recording:** allow Agent when it
  asks, then Restart Agent from its menu.
- **Accessibility:** allow Agent when it asks, the first time you dictate, so it
  can type what you said.
- **System Settings › Keyboard › "Press 🌐 key to": Do Nothing**, or each tap of
  fn also starts the Mac's own dictation. Another app that records on fn
  (superwhisper) needs another shortcut, or quitting.

Agent runs the Python in this folder, so after changing it, Restart Agent from its
menu; after changing the helper (`src/`) or the app (`workspace-engine/Sources/UnifiedAgent/app.swift`), run
`./install.sh` again. `./install.sh --uninstall` takes it all out. Or, without
installing anything, `./voice.sh` runs the same in a terminal (one password prompt for the helper; Ctrl-C stops it), and the
terminal app needs the permissions instead.

| | |
|---|---|
| Tap fn | It starts listening, and a new conversation: until the next time, it remembers everything you've asked. Tap again and it stops |
| Talk | A pause ends what you're saying |
| Talk while it's talking | It goes quiet at once and listens |
| Say more within a few seconds | It's added to what you just asked |
| Say something new while it works | It drops the old task and does the new one, knowing what it was doing |
| Say "... on my phone" / "on my iPhone" | It does that on your iPhone, alongside whatever it's doing on the Mac. Other requests can use the phone too when they need it |
| Say "stop" | Stops the computer agent (on the Mac and the phone) |
| Touch any key, the trackpad or the mouse | The computer agent stops at once and waits |
| Say "continue" | It carries on from where things are now (tap fn first if it isn't listening) |
| Hold fn and talk | Dictation: when you let go, what you said is typed where you're typing, and isn't a task |

### Workspace creation policy

Closing a virtual workspace is durable: it will not be recreated just because a session is
missing or the app restarts. `python3 python/workspace_fence.py closed` records an explicit
closure without changing any display. To explicitly authorize one creation attempt, run
`python3 python/workspace_fence.py allow-once`; the next workspace bootstrap consumes that
permit before attempting creation. An ambiguous failure is not retried automatically. The
command records policy only; it does not open a display itself.

### Local request receipts

The local request socket records an admission before sending a request to the agent. Its
private `control/request-ledger.sqlite3` stores task text and goal objectives encrypted with
AES-GCM; the key is in `control/request-ledger.key`. Both files are mode 0600. Because the key
is stored on the same Mac, encryption protects against casual plaintext inspection, not an
account that can read both files. Requests matching conservative credential patterns are
admitted without saving their text. This screening cannot recognize every unlabeled secret;
do not submit credentials as task text. Source IDs are stored as hashes, and repeated IDs
never cause a second dispatch, including when the first outcome is uncertain. The ledger
records admission, not task completion, and does not automatically replay tasks.

To inspect the most recent receipts locally, run:

```sh
build/agent-request-ledger "${AGENT_STATE_DIR:-$HOME/Library/Application Support/Personal Agent}/control"
```

The output contains decrypted task text and should be treated as private. If the ledger,
key, or Rust request service is unavailable, the local request channel fails closed.

### Dictation

Hold fn, say what you want written, and let go: Parakeet writes it down (with its
own punctuation) and it's typed into the app in front, wherever the cursor is. It's
pasted: the clipboard gets the text, ⌘V, and then the clipboard gets back what it
had (`build/agent-vhid-paste`, `tools/paste.swift`; it marks the text so clipboard
managers leave it out). Pauses while you hold fn are fine; it all goes in together.
The captions say "Dictating" and show your words, and the menu bar icon turns into
an orange waveform. fn with another key (fn+arrow, fn+delete) is a shortcut and
types nothing; a quick tap is still the agent's on/off. It works whether or not
the agent is listening, which carries on as before when you let go, and with your
voice enrolled only your voice is written down. Agent's log notes how many words
it typed, not what they were. Typing into another app needs Accessibility for
Agent; until you allow it, what you dictated is left on the clipboard instead.

It keeps listening while it talks, out of the speakers too: everything the Mac
plays (its own voice, a video, music) is taken back out of what the microphone
hears, so only you count. It waits for you to finish before it starts a sentence.

To keep other people out (someone talking nearby, a video on another device),
teach it your voice once:

```bash
./voice.sh --enroll
```

You read five short lines aloud. From then on it only listens to that voice:
someone else's words don't show up or become a task, even when they talk right
before or after you or carry on while you speak; the line your words show on
just says "(not your voice, ignored ...)". It takes up to 0.8 s of your speech
to be sure it's you, so the words and cutting in while it talks start then. Enroll
again to add another microphone or room; `.venv/bin/python python/voiceprint.py
--forget` goes back to hearing everyone.

Listening and speaking both run on this Mac with open-source models, so they
cost nothing and nothing you say leaves the Mac (until it becomes the task for
Codex):

- **Hearing you: Parakeet** ([parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
  NVIDIA's speech recognition model, CC-BY-4.0) in `python/listen.py`, through
  MLX on the Mac's GPU, at full precision. The microphone is open only while
  it's listening (the orange dot). [Silero VAD](https://github.com/snakers4/silero-vad)
  (MIT, 2 MB) notices when someone starts talking; only that stretch, from just
  before it until your pause, is transcribed, and nothing is recorded to disk.
  Coughs, clicks and "mm-hmm"s are ignored. While you talk it re-reads what
  you've said every quarter second to show the words, and when you pause it reads
  the whole thing once more for the final text, about 0.3 s later. If you switch
  microphones it follows, except to a Bluetooth headset's (AirPods, Sony, ...):
  listening through one switches it to call-quality sound, so it keeps using the
  Mac's own microphone and your headphones keep sounding right.
- **Telling your voice from others: WeSpeaker** ([ResNet34-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM),
  trained on VoxCeleb, CC-BY-4.0, 26 MB) in `python/voiceprint.py`, through ONNX
  Runtime. Once you've enrolled, each thing heard is turned into a voiceprint and
  compared with yours (your own voice scores around 0.6-0.9, other people's under
  0.3; `VOICE_MATCH`, 0.4, is the line). Each phrase (speech between pauses of a
  quarter second) is checked on its own after 0.8 s or when it ends; someone
  else's is left out and counts as quiet, so you're done when *you* stop. While
  someone else talks it keeps checking in case you start right after them, and
  all you said together is checked once more at the end. Your voiceprint stays in
  `models/voiceprint.npz`.
- **Echo cancellation: WebRTC's** (the one in Chrome and Google Meet, from the
  `livekit` package, running on this Mac) in `python/mic.py`. `build/agent-vhid-tap`
  (`tools/tap.swift`, a Core Audio process tap) streams what the Mac is playing,
  and the canceller subtracts it from the microphone. Leftover echo is much quieter
  than you talking at the computer, so while the Mac plays something, only sound
  about as loud as you usually are counts as you (it learns how loud that is).
- **The worker: GPT-6.1 Terra** on your Codex subscription, at low reasoning effort
  (set `AGENT_MODEL` or `AGENT_EFFORT` to change them). Each step is a look and a
  click, and more thinking mostly adds seconds to every one of them. It gets what
  you said word for word, and keeps web search.
- **The voice: Kokoro** ([Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M),
  Apache 2.0) in `python/speech.py`, through ONNX Runtime at full precision. It
  speaks a sentence at a time, so it starts before the whole reply is made, and
  plays through `afplay`, so it uses whatever the sound output is at the time. It
  sounds calm and natural, not dramatic. Without the model the Mac's own voice
  speaks.

`./install.sh` (or `./voice.sh`) sets these up the first time: the Python packages in `.venv`
(`requirements.txt`), Kokoro and Silero VAD in `models/` (350 MB) and Parakeet and
WeSpeaker in the Hugging Face cache (2.4 GB). The rest of the project uses only the standard library.

Settings live in `.env` (copy `.env.example`; it's gitignored and wins over your shell):

| | |
|---|---|
| `TTS_VOICE` | `af_heart` (default), `af_sarah`, `af_bella`, `am_michael`, `am_adam`, `bf_emma`, `bm_george`, ...: `af`/`am` are American, `bf`/`bm` British. `say` uses the Mac's voice |
| `TTS_SPEED` | `1.0` is normal; `1.1` is a little quicker |
| `STT_MODEL` | Empty for Parakeet v2 (English); `mlx-community/parakeet-tdt-0.6b-v3` also knows 24 other European languages |
| `LISTEN_PAUSE` | Seconds of quiet that end what you're saying; `0.8` by default. Raise it if it cuts you off mid-thought |
| `VOICE_MATCH` | After `./voice.sh --enroll`: how alike a voice has to be to count as you; `0.4` by default. Lower it if it ignores you, raise it if it still hears others |
| `AGENT_MODEL` | Override the computer agent's model; empty means `gpt-6.1-terra` |
| `AGENT_FAST` | `1` uses Codex's Fast tier: quicker replies, but it uses up your plan's usage sooner |
| `AGENT_EFFORT` | Its reasoning effort: `low` (default), `medium`, `high`, ... |
| `CAPTIONS` | `0` turns the on-screen captions off |
| `PHONE_RELAY` | The phone relay's folder (see [Your iPhone](#your-iphone)); empty means no phone |

To hear a voice before you pick it, or check what it hears:

```bash
TTS_VOICE=am_michael .venv/bin/python python/speech.py "Done. Twelve percent of 340 is 40.8."
```

```bash
.venv/bin/python python/listen.py
```

`./voice.sh --no-speak` keeps it quiet. If it says "The microphone only gives
silence", allow microphone access for Agent (with `./voice.sh`, the app you run
it in) under System Settings › Privacy & Security › Microphone, and restart it. If
it says it can't hear what the Mac is playing, allow the same app under Screen &
System Audio Recording (the agent's screenshots need it anyway); until then it stops listening
while it talks out of the speakers, and a video playing out loud may be taken for
you.

### The computer agent

- **Codex** runs as one `codex app-server` (`python/codex_app.py`), started with
  the voice agent and kept while it runs. It's the server the Codex app and
  its IDE extensions use, signed in with your ChatGPT account, so the agent runs
  on your Codex subscription; no API key. Requests use a persistent primary thread,
  resumed by ID after app or app-server restarts. Tapping fn keeps that conversation.
- **Only our tools and instructions:** `python/instructions.md` (a few lines)
  replaces Codex's coding-agent system prompt, and the model gets two sets of
  tools: the Mac's from `python/mac_mcp.py` (screenshot, click, type_text,
  press_key, scroll, drag, open_app, find_text, read_screen, wait_for_control,
  batch, ...) and the iPhone's from `python/phone_mcp.py`. They run in the voice
  agent's own process: Codex calls back into it. Codex's own tools (shell, file
  edits, sub-agents, browser, image generation, ...), your connectors, plugins,
  hooks, skills and MCP servers are switched off for it with `-c` overrides; your
  config file isn't changed. Web search stays.
- **Kept quick:** your models are set to call tools directly instead of through
  Codex's "code mode", where every tool sits behind a JavaScript `exec` tool that
  the model first has to search for and then unpack screenshots from (a copy of
  Codex's model list, `$TMPDIR/agent-vhid-models.json`). That roughly halves what
  the model reads before its first step, and it stays cached from task to task.
  Tapping fn starts the conversation's Codex thread straight away, which gets Codex's
  connection to the model ready (the first request's reply starts 1–2.5 s sooner).
  The Mac's screenshot, open windows and browser tabs are taken as you start
  talking and go with the request the moment you finish, so it doesn't spend a
  step looking. Every action returns a fresh screenshot, and `batch` does several
  actions in one call, so most steps are a single round trip to the model, about
  1.5–2 s. Replies are short, and each sentence is spoken as soon as the model has
  written it. After each request `Agent.log` has a `⏱` line saying where the time
  went (waiting to be sure you'd finished, writing it down, Codex, the voice), and
  each step's timing is in Codex's log.
- It uses the Codex inside ChatGPT.app when present (newer than the npm one);
  set `CODEX_BIN`, `AGENT_MODEL` or `AGENT_EFFORT` to change that.

#### Durable sessions and visible context

`python/resumable_thread.py` integrates the staged persistence prototype. The primary
Codex thread ID lives in `~/Library/Application Support/Personal Agent/codex-thread-id`
(`AGENT_STATE_DIR` overrides the directory). New threads use `ephemeral=false`;
Codex stores their history in its own state directory. Identity writes use a private
temporary file, fsync and atomic replacement, with a lock around creation/resumption.
Missing state starts a thread. Invalid state, a mismatched resume ID, or a server
resume error fails the task visibly and preserves the saved identity. No automatic
fallback creates a replacement conversation. An interrupted/failed creation leaves
an explicit pending marker and blocks another start, since the server may already
have created a thread. Recovery requires investigating that state; it is not reset
automatically.

In Agent.app, **Show Agent Context** opens a local viewer of the exact app-visible
thread instructions/tool definitions, request text, attached screenshots, tool
arguments/results, and completed server items (including compaction events).
The terminal prints its path: `$AGENT_STATE_DIR/context/index.html`, using the default
directory above when unset. The index refreshes; individual records show images,
full text, and a link to their exact JSON payload. Records survive restarts, use
owner-only files, and load no remote resources. Recording failures produce a visible
error rather than quietly pretending the view is complete. This is the exchanged
event history, not hidden reasoning or an exact reconstruction of the model's
post-compaction context. Screenshots and full payloads are retained locally without
automatic pruning. The existing caption-window screenshot inclusion is preserved.

#### Session journal (for reviewing and improving the agent)

Each run of the voice agent, from opening Agent.app to quitting it, is a session saved in
`$AGENT_STATE_DIR/sessions/<started>-<pid>/` (`sessions/latest` is the newest):

- `journal.jsonl`: one line per thing that happened, written and synced to disk as it
  happens. Every transcript of what you said and what became of it (`request`, `stop`,
  `continue`, `filler, ignored`, `its own voice, ignored`), voices it left out, each request
  with its device and whether it was added to or interrupted the last one, every action,
  error, reply and outcome of each task with its Codex thread, and what it said that wasn't
  from a task ("Stopped.", "Sorry, that didn't work.").
- `manifest.json`: start and end, backend and model, the git commit of the code, and every
  Codex thread used, with the path of its rollout file
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`). That file is Codex's own
  record of the thread's full model context: base and developer instructions, every input
  with its screenshots, tool calls and results, replies, and compactions.
- `index.html`: the same, readable in a browser.
- `panel.json`: what the **Agent Context panel** shows (`python/context_panel.py`).

#### Agent Context panel

Agent menu › **Show Agent Context** opens a floating, resizable panel over every app
(Esc or ⌘W closes it, ⌘F filters, ⌘R refreshes). It shows this session live, one group per
request: what you said, what the agent did and said, and, folded under *What went to the
model*, the prompt text, screenshots (counted, with **Open Exact Record** for the payload),
tool calls and results. Text you added appears as its own group with whether it was
verified. The top says plainly that this is the app's recorded history, not the model's
exact current context, which Codex holds and compacts; it shows the last context size Codex
reported, when it last compacted, and where Codex's full rollout file is. VoiceOver reads
each row. *More* › *Every Payload (Browser)* is the old HTML viewer.

#### Adding a transcript or other text to the conversation

Agent menu › **Add Clipboard to Context…** or **Add Text File to Context…** asks first,
showing its size, estimated tokens and that it goes to the model (OpenAI, through Codex).
The text is saved privately (`$AGENT_STATE_DIR/ingested/`, mode 600) and split at paragraph
breaks into parts of about 12,000 characters. Up to about 60,000 tokens, each part is a turn on
the session's thread, marked as material, not instructions. Past that it isn't stuffed in:
one turn says it exists, and the agent reads parts when it needs them with the
`read_ingested` tool. Each part is checked against Codex's own rollout file; the journal and
panel say *verified*, *sent, not verified* or *failed*. A thread past `COMPACT_AT` gets
compacted, after which the model has a summary, but the saved text stays readable.
`read_clipboard` used to return the first 8,000 characters and say nothing; now it says how
long the clipboard is and reads on from an offset. `python/ingest.py list | read ID [PART]`.

#### Lip reading (optional)

Agent menu › **Input** › **Lip Reading (camera)**: tap fn and the camera turns on (green
light, a "📷 Camera on" caption and a camera icon in the menu bar). Words appear in the
floating window while you mouth your request. Tap fn again to turn the camera off and
submit the final transcript. Drafts can change as more video arrives; they never trigger
commands. Voice stays the default, and holding fn still dictates with the microphone.

The local model is [FLARE Large](https://github.com/jxzhanggg/FLARE), released in October
2026 by researchers including iFLYTEK (MIT code). Its lightweight decoder reports 15.9%
word error on LRS3; this benchmark is not a guarantee for silently mouthed webcam input.
Capture and inference run concurrently, using overlapping video windows and Apple GPU
acceleration when available. This is a full-context model producing rolling drafts,
not a native causal speech recognizer. Latency depends on hardware and phrase length.
Frames stay in memory and no microphone input is used for lip reading.

`scripts/setup-lipread.sh` installs the pinned source, isolated Python runtime and verified
checkpoint (4.85 GB download). macOS asks once for camera access. `LIPREAD_DEVICE=cpu`
overrides GPU selection. See `python/lipread.py`.

Every context-viewer record carries the session's id, so the two join up.

```bash
.venv/bin/python python/session_journal.py              # sessions, newest first
.venv/bin/python python/session_journal.py show         # the latest, readable (or: show ID)
.venv/bin/python python/session_journal.py paths        # its files and Codex rollouts
```

Not saved: what you dictate into other apps by holding fn (only its word count, unless
`AGENT_JOURNAL_DICTATION=1`), audio, and words shown live while you talk (the final
transcript is). On the Claude backend Claude Code keeps no transcript of its own
(`--no-session-persistence`); the context viewer's records are its full history. Nothing is
pruned automatically.

Scope: primary Codex conversation recovery, without automatically continuing an
interrupted task. An already-running ephemeral thread cannot be recovered by this
change. Concurrent secondary threads still run separately; their history is saved
by Codex and shown in the viewer, but they are not automatically reattached after
restart. Their in-memory summaries have the same lifetime as the app. Claude gets
the context viewer hooks; its existing session persistence behavior is unchanged.
Resumption follows the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server),
which restores saved dynamic tools when resuming without replacements.

Offline regression tests (synthetic tools/screenshots, separate fake server and app
processes; no account access):

```sh
AGENT_ENV_FILE=/dev/null .venv/bin/python tests/test_resumption.py -v
AGENT_ENV_FILE=/dev/null .venv/bin/python tests/test_tools.py CodexTaskTest -v
```
- **Captions:** `build/agent-vhid-captions` (`tools/captions.swift`) shows what it
  says and, under that, what it's doing ("Thinking", "Typing “weather”"), at the
  bottom of the screen over every app. Clicks go through them and its screenshots
  leave them out. `CAPTIONS=0` turns them off.
- Questions that don't need the screen are answered directly, without screenshots.
- The prompt (in `python/agent.py`) has it stop before buying, sending, deleting,
  changing settings or typing passwords unless you asked for exactly that.

Typing a task instead: `python3 python/agent.py "open Calculator and work out 12% of 340"`
(it takes control once your hands are off), or `"open Maps on my phone"` for the iPhone. What Codex does,
step by step with timings, goes to `agent-vhid-codex.log` in your temp folder (`$TMPDIR`),
the voice agent's output to `~/Library/Logs/Agent.log`, and the helper's to
`/Library/Logs/agent-vhid-helper.log` (with `./voice.sh`, `/tmp/agent-vhid-helper.log`).

### Your iPhone

It uses the relay from the Phone Control Automation project: the iPhone runs
WebDriverAgent inside its controller app, which keeps a connection open to a
Cloudflare Worker, so it works over Wi-Fi or cellular with no cable. Set
`PHONE_RELAY` in `.env` to that project's `work/phone-relay` folder (it reads the
address from `endpoint.txt` and the token from `private/secrets.json`, and never
prints the token). To connect the phone, unlock it and run the **Pocket Connect**
Shortcut, then check:

```bash
.venv/bin/python python/phone.py
```

On the phone it looks with screenshots, taps, swipes, types, opens apps by bundle
id and reads the accessibility tree for exact labels. Every task gets the phone's
tools along with the Mac's, so it uses the phone whenever a request needs it; one
that says "phone" or "iPhone" starts by looking at the phone and leaves the Mac to
any other task. If the phone isn't
connected it says so and tells you to run Pocket Connect.

## One-time setup

Already done on this Mac: Karabiner-DriverKit-VirtualHIDDevice (driver 1.8.0,
daemon 6.14.0) is installed and activated. This project builds against the
matching v6.14.0 client headers in `third_party/`.

1. Build: `make` (needs Xcode's command-line tools, and `git submodule update --init`
   after a fresh clone). `./install.sh`, `./voice.sh` and `./run.sh` build it for you.
   With an "Apple Development" certificate in your keychain, `make` signs Agent with
   it (and `./install.sh` the helper it installs), so macOS keeps their permissions
   when they're rebuilt: it knows them by identifier and certificate, not by the build.
   The first time, macOS asks whether codesign may use the certificate's key; choose
   **Always Allow**, or each build asks. `./install.sh` and `tools/update-app.sh`
   refuse to install an ad-hoc build (whose permissions would all be asked again);
   `SIGN=-` signs ad hoc on purpose. `tools/update-app.sh` updates just Agent.app,
   without sudo; `tools/update-app.sh --check` says how the installed app is signed.
2. Permissions, in System Settings › Privacy & Security:
   - **Input Monitoring**, so the helper can see your keyboard and mouse: for
     `agent-vhid-helper` once `./install.sh` has installed it, or else for the
     terminal app you run the helper from (Terminal, iTerm, …).
   - **Screen & System Audio Recording**, so `screenshot()` sees windows rather than
     only the wallpaper, and the voice agent can take the Mac's own sound out of what
     it hears: for Agent, or whatever runs the agent.
   - **Microphone**, so the voice agent can hear you: for Agent, or the terminal app.
   macOS asks the first time; restart the helper (or Agent) after allowing.

## Run it

```bash
./run.sh
```

Not needed once `./install.sh` has the Mac running the helper. It asks for your
password once, starts Karabiner's daemon if needed, then runs the helper in the
foreground. Ctrl-C stops both. Options: `--verbose` logs every physical input,
`--no-sound`, `--quiet-ms N`, `--start-engaged`.

Then check everything end to end (moves the cursor, types into a scratch
TextEdit file, takes a screenshot):

```bash
python3 examples/demo.py
```

## Using it from an agent

Python (no dependencies):

```python
import sys; sys.path.insert(0, "python")
from agent_vhid import AgentVHID, Disengaged

mac = AgentVHID()
mac.engage()                               # ask for control
mac.wait_engaged()                         # once your hands have been off for 0.4 s
shot = mac.screenshot(max_width=1280)      # shot.path is a PNG for the model
x, y = shot.to_screen(640, 400)            # image pixels -> screen points
try:
    mac.click(x, y)
    mac.type_text("hello")
    mac.key("cmd+s")
except Disengaged:
    mac.wait_engaged()                     # then take a fresh screenshot: you changed things
```

Everything else: `move_to`, `move_by`, `double_click`, `right_click`, `drag`,
`scroll(down=, right=)`, `mouse_down/up`, `paste_text`, `cursor`, `status`,
`watch()` (yields each hand-over and fn tap), `release_all`, `disengage()` (hand control
back when done), and `click(..., modifiers="cmd")`. `AgentVHID(speed=2)` moves
and types faster; `human=False` drops the curved paths and timing jitter.

Shell, for agents that only have a terminal (exit code 3 means you took over):

```bash
python3 python/agent_vhid.py click 720 450
python3 python/agent_vhid.py type "hello"
python3 python/agent_vhid.py key cmd+s
python3 python/agent_vhid.py screenshot /tmp/screen.png --max-width 1280
python3 python/agent_vhid.py status
python3 python/agent_vhid.py engage        # take control, once your hands are off
```

## How it behaves like a person

- **Mouse:** a real mouse only reports "moved this much", and macOS adds
  acceleration, so the wrapper steers in a closed loop: it sends a step, reads
  where the cursor went, and corrects. Paths curve slightly and follow a
  minimum-jerk speed profile with Fitts's-law timing, and each move either ends
  within 0.75 points of the target or raises `MoveFailed`.
- **Keyboard:** real key-down/key-up reports through a US keyboard, shift
  pressed before the key, small random gaps. Characters a US keyboard can't
  type (accents, emoji, Chinese) are pasted with cmd+v, and the previous
  clipboard text is restored afterwards.
- **Clicks:** macOS works out double-clicks from timing, as it does for a real mouse.

## Tests

```bash
python3 tests/test_dry_run.py
.venv/bin/python tests/test_voice.py
.venv/bin/python tests/test_speech.py
.venv/bin/python tests/test_tools.py
```

The first runs the real helper with `--dry-run` (no root, no virtual devices) and
checks the HID reports it would send, the hand-over rules (including `engage` and
what fn does), release-on-disconnect, and the wrapper. The second runs
the voice agent against that helper and a fake `codex app-server` (`tests/fake_codex.py`), with
speech made by `say` in place of the microphone and Parakeet really transcribing
it: fn starts and stops it listening, stopping mid-sentence still takes what you
said, holding fn dictates (a stand-in does the typing, so your clipboard isn't
touched) and fn+key doesn't, "continue" carries on after you took over, words
show up as you talk, short pauses and trailing "and" don't cut you off,
more said right after is added, the task reaches Codex and its reply is spoken
once, "stop" stops it, noise does nothing, talking over it stops its voice, and,
through a simulated room, the echo canceller hears you and not its own voice.
The third makes speech with Kokoro without playing it: sentence splitting,
stopping, waiting for you to finish, and falling back to the Mac's voice. The
fourth checks `batch` against the dry-run helper, the iPhone tools against a
stand-in for the relay (taps, typing, element labels, hidden passwords and tokens,
the "not connected" message), a task's trip through the fake app-server (our
instructions and tools, the call back into our tools, one server for every task,
stopping), and draws the captions into a PNG. None of them play anything aloud or
touch your phone.

## Things to know

- **While it's listening**, other people talking nearby (a call on another
  device, a TV) can be taken as a task, unless you've enrolled your voice. The
  Mac's own sound is cancelled, the computer agent stops before anything risky,
  and touching anything takes over. Tap fn to stop it listening.

- **Input method:** typing goes through whatever input source is active. If a
  Chinese/Pinyin input method is on, letters go to the IME. Switch to ABC first.
- **Secure input:** while a password field has focus, macOS hides keystrokes
  from Input Monitoring, so your typing there won't disengage the agent.
  Touching the trackpad or mouse still will.
- **Trackpads plugged in later** aren't watched until you restart the helper. Keyboards and mice are picked up automatically.
- **Scrolling** follows your Natural Scrolling setting; `down > 0` always
  means "show content further down". The vertical direction follows from the
  setting; horizontal scrolling hasn't been checked on a real app yet.
- **Version match:** if Karabiner-Elements or the driver is updated, check out
  the matching tag in `third_party/` and rebuild, or the daemon rejects the
  helper (`driver_version_mismatched=1` in `status`).
- **Uninstall the driver:** see the uninstall steps in
  [Karabiner-DriverKit-VirtualHIDDevice](https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice).
