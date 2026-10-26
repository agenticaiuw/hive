# personal-agent

Talk to your Mac and it talks back. It's always listening: say what you want, in
any window, and a computer agent does the work on screen with a real-looking
keyboard and mouse, then tells you out loud what it did. It hands control back to you the
instant you touch anything, like Tesla's Autopilot.

```bash
git submodule update --init   # once, after cloning: Karabiner's client headers
./voice.sh
```

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
| Double-tap **Right Option**, then let go | After 0.4 s with your hands off, the agent gets control (chime: Glass) |
| Press any key, touch the trackpad, move or click a mouse | The agent loses control at once; anything it was holding is released (chime: Funk) |
| Touch anything during that 0.4 s | The hand-over is cancelled |
| Say what you want (voice agent) | Your spoken task starts and gets control once your hands are off |

The helper starts with you in control, and the agent can't take control
itself: it needs the double-tap. The one exception is the voice agent, when the
helper was started with `--hands-free` (`./voice.sh` does that): a task you
speak can take control, still only after 0.4 s with your hands off, and touching
anything still takes it back at once. Without `--hands-free`, a spoken task
needs you to have just held Right Option while talking (one hand-over per hold,
within 30 s). If Input Monitoring is
denied, the helper refuses to start, so the agent never runs without your
takeover working.

## Talk to it

```bash
./voice.sh
```

One password prompt (for the helper), then, in any window, **just say what you
want**. No key to hold: it listens all the time and the words show up in the
terminal as you say them. When you pause (1.2 s, or 2.5 s if you trailed off on
"and..." or a comma), the computer agent works out the steps from screenshots
and does them with the virtual mouse and keyboard while you watch, telling you
out loud what it's doing as it goes and what happened at the end. Then control
comes back to you.

| | |
|---|---|
| Talk | It listens all the time; a pause ends what you're saying |
| Talk while it's talking | It goes quiet at once and listens |
| Say more within a few seconds | It's added to what you just asked |
| Say something new while it works | It drops the old task and does the new one, knowing what it was doing |
| Say "stop" | Stops the computer agent |
| Touch any key, the trackpad or the mouse | The computer agent stops at once and waits |
| Double-tap Right Option | It carries on from where things are now |

It keeps listening while it talks, out of the speakers too: everything the Mac
plays (its own voice, a video, music) is taken back out of what the microphone
hears, so only you count. It waits for you to finish before it starts a sentence.

Listening and speaking both run on this Mac with open-source models, so they
cost nothing and nothing you say leaves the Mac (until it becomes the task for
Codex):

- **Hearing you: Parakeet** ([parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
  NVIDIA's speech recognition model, CC-BY-4.0) in `python/listen.py`, through
  MLX on the Mac's GPU, at full precision. The microphone stays open while
  `./voice.sh` runs (the orange dot). [Silero VAD](https://github.com/snakers4/silero-vad)
  (MIT, 2 MB) notices when someone starts talking; only that stretch, from just
  before it until your pause, is transcribed, and nothing is recorded to disk.
  Coughs, clicks and "mm-hmm"s are ignored. While you talk it re-reads what
  you've said every quarter second to show the words, and when you pause it reads
  the whole thing once more for the final text, about 0.3 s later. If you switch
  microphones it follows, except to a Bluetooth headset's (AirPods, Sony, ...):
  listening through one switches it to call-quality sound, so it keeps using the
  Mac's own microphone and your headphones keep sounding right.
- **Echo cancellation: WebRTC's** (the one in Chrome and Google Meet, from the
  `livekit` package, running on this Mac) in `python/mic.py`. `build/agent-vhid-tap`
  (`tools/tap.swift`, a Core Audio process tap) streams what the Mac is playing,
  and the canceller subtracts it from the microphone. Leftover echo is much quieter
  than you talking at the computer, so while the Mac plays something, only sound
  about as loud as you usually are counts as you (it learns how loud that is).
- **The worker: your Codex model**, e.g. **gpt-6-astra**, at your Codex config's
  reasoning effort (high, unless you set `AGENT_EFFORT`). Nothing about it is
  scaled down for voice: it gets what you said word for word, uses your config's
  model and effort, and keeps web search.
- **The voice: Kokoro** ([Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M),
  Apache 2.0) in `python/speech.py`, through ONNX Runtime at full precision. It
  speaks a sentence at a time, so it starts before the whole reply is made, and
  plays through `afplay`, so it uses whatever the sound output is at the time. It
  sounds calm and natural, not dramatic. Without the model the Mac's own voice
  speaks.

`./voice.sh` sets these up the first time: the Python packages in `.venv`
(`requirements.txt`), Kokoro and Silero VAD in `models/` (350 MB) and Parakeet in
the Hugging Face cache (2.4 GB). The rest of the project uses only the standard library.

Settings live in `.env` (copy `.env.example`; it's gitignored and wins over your shell):

| | |
|---|---|
| `TTS_VOICE` | `af_heart` (default), `af_sarah`, `af_bella`, `am_michael`, `am_adam`, `bf_emma`, `bm_george`, ...: `af`/`am` are American, `bf`/`bm` British. `say` uses the Mac's voice |
| `TTS_SPEED` | `1.0` is normal; `1.1` is a little quicker |
| `STT_MODEL` | Empty for Parakeet v2 (English); `mlx-community/parakeet-tdt-0.6b-v3` also knows 24 other European languages |
| `LISTEN_PAUSE` | Seconds of quiet that end what you're saying; `1.2` by default |
| `AGENT_MODEL`, `AGENT_EFFORT` | Override the computer agent's model and effort; empty means your Codex config's |

To hear a voice before you pick it, or check what it hears:

```bash
TTS_VOICE=am_michael .venv/bin/python python/speech.py "Done. Twelve percent of 340 is 40.8."
```

```bash
.venv/bin/python python/listen.py
```

`./voice.sh --no-speak` keeps it quiet. If it prints "The microphone only gives
silence", allow microphone access for the app you run it in (System Settings ›
Privacy & Security › Microphone) and restart `./voice.sh`. If it says it can't
hear what the Mac is playing, allow that app under Screen & System Audio
Recording (the agent's screenshots need it anyway); until then it stops listening
while it talks out of the speakers, and a video playing out loud may be taken for
you.

### The computer agent

- **Codex** runs as `codex exec` with only one set of tools, `python/mac_mcp.py`
  (an MCP server: screenshot, click, type_text, press_key, scroll, drag,
  open_app, find_text, read_screen, wait_for_control, ...). Your Codex
  connectors, plugins and other MCP servers are switched off for these runs
  through `-c` overrides; your config file isn't changed. The shell is read-only.
  It uses the Codex inside ChatGPT.app when present (newer than the npm one);
  set `CODEX_BIN`, `AGENT_MODEL` or `AGENT_EFFORT` to change that.
- Questions that don't need the screen are answered directly, without screenshots.
- The prompt (in `python/agent.py`) has it stop before buying, sending, deleting,
  changing settings or typing passwords unless you asked for exactly that.

Typing a task instead: `python3 python/agent.py "open Calculator and work out 12% of 340"`
(double-tap Right Option to hand over). Codex's output goes to `/tmp/agent-vhid-codex.log`,
the helper's to `/tmp/agent-vhid-helper.log`.

## One-time setup

Already done on this Mac: Karabiner-DriverKit-VirtualHIDDevice (driver 1.8.0,
daemon 6.14.0) is installed and activated. This project builds against the
matching v6.14.0 client headers in `third_party/`.

1. Build: `make` (needs Xcode's command-line tools, and `git submodule update --init`
   after a fresh clone). `./voice.sh` and `./run.sh` build it for you.
2. Give the terminal app you'll run the helper from (Terminal, iTerm, …) these
   permissions in System Settings › Privacy & Security:
   - **Input Monitoring**, so the helper can see your keyboard and mouse.
   - **Screen & System Audio Recording**, so `screenshot()` sees windows rather than
     only the wallpaper, and the voice agent can take the Mac's own sound out of what
     it hears. (Needed by whatever runs the agent, if that's a different app.)
   - **Microphone**, so the voice agent can hear you.
   macOS asks the first time; restart the helper after allowing.

## Run it

```bash
./run.sh
```

It asks for your password once, starts Karabiner's daemon if needed, then runs
the helper in the foreground. Ctrl-C stops both. Options: `--verbose` logs every
physical input, `--no-sound`, `--quiet-ms N`, `--start-engaged`, `--hands-free`
(a task spoken to the voice agent may take control without a key held).

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
mac.wait_engaged()                         # until you double-tap Right Option
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
`watch()` (yields each hand-over and talk hold), `release_all`, `disengage()` (hand control
back when done), `engage_after_talk()` / `engage_by_voice()` (take control for a spoken
task: after a talk hold, or with a `--hands-free` helper), and
`click(..., modifiers="cmd")`. `AgentVHID(speed=2)` moves
and types faster; `human=False` drops the curved paths and timing jitter.

Shell, for agents that only have a terminal (exit code 3 means you took over):

```bash
python3 python/agent_vhid.py click 720 450
python3 python/agent_vhid.py type "hello"
python3 python/agent_vhid.py key cmd+s
python3 python/agent_vhid.py screenshot /tmp/screen.png --max-width 1280
python3 python/agent_vhid.py status
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
```

The first runs the real helper with `--dry-run` (no root, no virtual devices) and
checks the HID reports it would send, the hand-over rules (including the talk-hold
grant and `--hands-free`), release-on-disconnect, and the wrapper. The second runs
the voice agent against that helper and a fake Codex (`tests/fake_codex.py`), with
speech made by `say` in place of the microphone and Parakeet really transcribing
it: words show up as you talk, short pauses and trailing "and" don't cut you off,
more said right after is added, the task reaches Codex and its reply is spoken
once, "stop" stops it, noise does nothing, talking over it stops its voice, and,
through a simulated room, the echo canceller hears you and not its own voice.
The third makes speech with Kokoro without playing it: sentence splitting,
stopping, waiting for you to finish, and falling back to the Mac's voice. None of
them play anything aloud.

## Things to know

- **Always listening** means other people talking nearby (a call on another
  device, a TV) can be taken as a task. The Mac's own sound is cancelled, the
  computer agent stops before anything risky, and touching anything takes over.

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
