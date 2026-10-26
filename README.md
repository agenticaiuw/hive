# personal-agent

Talk to your Mac and it talks back. Hold Right Option in any window and say what
you want: a live voice answers you, and a computer agent does the work on screen
with a real-looking keyboard and mouse. It hands control back to you the instant
you touch anything, like Tesla's Autopilot.

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
| Hold **Right Option** (longer than a tap) and speak | Voice agent: your spoken task starts and gets control once you let go and your hands are off |

The helper starts with you in control, and the agent can't take control
itself: it needs the double-tap, or, for a spoken task, your having just held
Right Option (one hand-over per hold, within 30 s). If Input Monitoring is
denied, the helper refuses to start, so the agent never runs without your
takeover working.

## Talk to it

```bash
./voice.sh
```

One password prompt (for the helper), then, in any window: **hold Right Option,
talk, let go.** It answers out loud. Anything that takes real work goes to the
computer agent, which works out the steps from screenshots and does them with the
virtual mouse and keyboard while you watch. When it's done, the voice tells you
what happened and control comes back to you.

| | |
|---|---|
| Hold Right Option and talk | It stops speaking and listens (a soft *tink*) |
| Touch any key, the trackpad or the mouse | The computer agent stops at once and waits |
| Double-tap Right Option | It carries on from where things are now |
| Say something new while it works | It drops the old task and does the new one, knowing what it was doing |
| Say "stop" | Stops the computer agent |

Two models, each doing what it's good at:

- **The voice: GPT-Live** (`gpt-live-1`, OpenAI's live speech-to-speech model),
  in `python/live_agent.py`. It listens, talks and keeps the conversation going,
  and hands over (*delegates*) anything that needs the computer, the screen, a
  fact, a calculation, writing or careful thought. It's told not to guess while
  the work is happening.
- **The worker: your Codex model**, e.g. **gpt-6-astra**, at your Codex config's
  reasoning effort (high, unless you set `AGENT_EFFORT`). Nothing about it is
  scaled down for voice: it gets the request word for word plus the conversation
  so far, uses your config's model and effort, and keeps web search. Its progress
  goes back to GPT-Live as silent notes, so "what's it doing?" gets a real answer,
  and its final report is what the voice tells you.

Settings live in `.env` (copy `.env.example`; it's gitignored and wins over your shell):

| | |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI key. Without one, `./voice.sh` uses Superwhisper instead (below) |
| `LIVE_VOICE` | `marin` (default), `cedar`, `vesper`, ...; the full list is in `.env.example` |
| `LIVE_IDLE_SECONDS` | How long a quiet conversation stays open (default 45) |
| `AGENT_MODEL`, `AGENT_EFFORT` | Override the computer agent's model and effort; empty means your Codex config's |

**Cost:** GPT-Live is $0.05 a minute, billed per second, for as long as a
conversation is open. One opens when you hold Right Option and closes after
`LIVE_IDLE_SECONDS` of quiet, never while the computer agent is working. Each
close prints the seconds used and the cost. A new conversation is given the last
few turns, so it carries on where you left off. A quick question and answer is
about a cent.

**Microphone:** it opens when `./voice.sh` starts and stays open, so macOS shows
the orange microphone dot while it runs. A Mac can take seconds to wake its
microphone after it has been idle, and push-to-talk has to catch your first word.
What it hears is only sent while you hold Right Option: from 0.3 s before you
press until 0.4 s after you let go. The rest of the time GPT-Live gets silence.
After each conversation it rescans the audio devices, and if the microphone goes
quiet (AirPods, an iPhone, a Zoom or Teams device coming or going) it reopens it.
macOS asks for microphone access for the app you run it in the first time. If
it prints "The microphone only gives silence", allow it in System Settings ›
Privacy & Security › Microphone and restart `./voice.sh`.

The first run sets up `.venv` with `websockets` and `sounddevice`
(`requirements.txt`); the rest of the project uses only the standard library.

### Without an OpenAI key: Superwhisper

`./voice.sh --superwhisper` (or no key in `.env`) uses Superwhisper to transcribe
what you say, and the Mac's own voice reads out the result (`--no-speak` to keep
it quiet). It's one-way: you talk, it works, it reports.

- `voice_agent.py` adds a *Computer Agent* mode to Superwhisper (a copy of your
  Default mode with pasting turned off), switches to it while you hold the key,
  starts and stops recording with `superwhisper://` links, and switches back
  afterwards, so fn dictation works as before. It reads the transcript from
  `~/Documents/superwhisper/recordings` and ignores recordings that are only
  silence (Whisper tends to "hear" sentences in silence).

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
   - **Screen Recording**, so `screenshot()` sees windows rather than only the wallpaper.
     (This one is needed by whatever runs the agent, if that's a different app.)
   - **Microphone**, for talking to it with GPT-Live.
   macOS asks the first time; restart the helper after allowing.

## Run it

```bash
./run.sh
```

It asks for your password once, starts Karabiner's daemon if needed, then runs
the helper in the foreground. Ctrl-C stops both. Options: `--verbose` logs every
physical input, `--no-sound`, `--quiet-ms N`, `--start-engaged`.

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
back when done), `engage_after_talk()` (take control after a spoken task), and
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
.venv/bin/python tests/test_live.py
```

The first runs the real helper with `--dry-run` (no root, no virtual devices) and
checks the HID reports it would send, the hand-over rules (including the talk-hold
grant), release-on-disconnect, and the wrapper. The second runs `live_agent.py`
against a fake GPT-Live server, the dry-run helper and a fake Codex
(`tests/fake_codex.py`): handing a request over and reading the result back,
"stop", replacing a running task, closing when idle and remembering on reconnect.
Neither needs an API key or costs anything.

## Things to know

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
