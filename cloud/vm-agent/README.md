# VM agent

Posts to Discord and X through an ordinary Chromium on the owner's VM, for when those sites are
blocked on the owner's own devices. The owner signs in on the VM themselves; the worker only ever
publishes text the owner approved, word for word, once.

Status (2026-11-11): written and tested against a local fixture site with a real browser.
**Not yet verified against live Discord or X** — the selectors in `sites.mjs` come from knowledge of
those pages, not from a run. Treat the first real post on each site as the verification.

## What it guarantees

- A post moves `drafted → approved → sending → sent | failed | unknown` (or `cancelled`).
- `send` needs an approval made in the last 10 minutes for the exact platform, destination, text
  and attachments (sha256 digest). Any change means a new draft and a new approval.
- Before submitting, the composer is cleared, typed, read back and compared with the approved text.
  A mismatch stops the send (`failed` — nothing was submitted).
- Submit happens once. If the site gives no proof the message landed, the post is `unknown` and is
  **never retried**; look at the site before deciding. A worker restart during a send also yields
  `unknown`.
- Before and after screenshots are kept in `<state>/evidence/`.
- Control is a mode-0600 Unix socket (`<state>/control.sock`). Nothing listens on the network.
- The worker never types credentials. The owner signs in on the sign-in desktop (below).

## What it does not do

- No disguise: no user-agent changes, no stealth patches, no CAPTCHA handling. If a site asks for
  verification, the owner does it on the sign-in desktop or in the viewer. Sites that refuse a
  remote-controlled browser (Google's sign-in) are not tricked: on the sign-in desktop the browser
  really is not remote-controlled.
- No scheduled or autonomous posting. Every post is one explicit owner approval.

Both sites restrict automation of personal accounts (Discord's "self-bot" rule, X's rule against
scripting its website). Running this is the owner's decision and risk; X's API is the sanctioned
route for posting there.

## Run on the VM

Needs Node 22+ and a Chromium build. No npm install.

```bash
HIVE_VM_BROWSER=/path/to/chromium node server.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `HIVE_VM_STATE` | `~/.hive/vm-agent` | browser profile, post ledger, uploads, evidence |
| `HIVE_VM_BROWSER` | first Chromium found | browser executable |
| `HIVE_VM_HEADLESS` | unset | `1` runs headless; otherwise needs a display (Xvfb) |
| `HIVE_VM_VIEW_PORT` | `38917` | loopback port for the sign-in viewer |
| `HIVE_VM_DESKTOP_PORT` | `38918` | loopback VNC port for the sign-in desktop (x11vnc) |
| `HIVE_VM_PROXY` | unset | the browser's proxy, e.g. `socks5://127.0.0.1:11080` from `vpn.sh` |

`node ctl.mjs status` talks to the running worker; see the top of `ctl.mjs` for the commands.

## Use from the Mac

`desktop/vm-post.mjs` reaches the worker over SSH. It reads `~/.hivemind/vm-agent.json`:

```json
{
  "ssh": { "host": "<vm address>", "user": "ubuntu", "identityFile": "~/.ssh/<key>" },
  "remoteDir": "/home/ubuntu/hive-vm-agent/app",
  "stateDir": "/home/ubuntu/hive-vm-agent/state",
  "node": "/usr/local/bin/node",
  "destinations": {
    "club-general": { "platform": "discord", "destination": "https://discord.com/channels/<server>/<channel>" }
  }
}
```

```bash
node desktop/vm-post.mjs login x              # the VM's browser in Screen Sharing: sign in yourself
node desktop/vm-post.mjs view x               # watch and use the worker's own browser
node desktop/vm-post.mjs watch                # the VM's whole screen, live and view only, in Screen Sharing
node desktop/vm-post.mjs where discord        # your servers; add a server id for its channels
node desktop/vm-post.mjs send --to club-general --file shot.png --text "hello"
node desktop/vm-post.mjs send --to x --text "hello"
```

`send` shows a macOS dialog with the destination and the exact text; only "Send" publishes.
Exit codes: 0 sent, 1 cancelled, 3 the VM is signed out, 4 unknown (check the site, do not resend),
5 failed (nothing was submitted).

The sign-in desktop (`login`) is the same browser and profile started with no remote control (no
debugging port), shown by x11vnc on loopback with a one-time password, through an SSH tunnel into
macOS Screen Sharing. The worker drives nothing while it is open; Ctrl-C (or 30 minutes) closes it,
the browser saving its cookies as it quits, and the worker's own browser starts again signed in.
Needs `sudo apt-get install x11vnc` on the VM.

The viewer (`view`) is a loopback page on the VM reached through an SSH tunnel. It needs a one-time
link, closes when idle, and does not log what is typed. "Open a link…" opens a pasted Discord or X
link (such as a verify-login link from an email) in the VM's browser; other sites are refused.
Every tab and popup window of the VM's browser is a tab in the viewer: a sign-in popup (such as
X's "Continue with Google") is shown as it opens, and the page that opened it is shown again when
it closes.

## Hive's agent on the VM

Besides the posting worker, the VM runs Hive's agent itself: a task given in words, done by Codex
on the VM's own screen, the way the Mac's Hive works on the Mac.

```bash
echo "Open enroll.wisc.edu and tell me what is in my cart" | node hive-task.mjs --keep-open
```

- `hive-task.mjs` starts the VM's Codex (`/root/.local/bin/codex`) with a Codex home of its own,
  `HIVE_CODEX_HOME` (default `/root/.codex-hive`), signed in with `codex login --device-auth` to the
  owner's ChatGPT account. It runs read-only, with no config file and no saved sessions, and prints
  each step the agent states; everything goes to `<state>/tasks/<time>/`. `--model`, `--effort`
  (defaults `HIVE_TASK_MODEL`, `HIVE_TASK_EFFORT`), and `--keep-open` to leave the browser up after.
- `desktop-mcp.mjs` is its desktop: it opens the sign-in desktop (the same browser and profile, no
  remote control), starts a private x11vnc on a Unix socket only this user can open, and gives
  Codex screenshot, zoom, click, drag, scroll, type_text, press_key, wait, wait_until (a time on the
  owner's clock, `HIVE_OWNER_TZ`), authenticate, list_files and fetch_file. Every tool needs a
  `step`. `vnc.mjs` is the small VNC client underneath. Only printable ASCII, Return and Tab can be
  typed; anything else is refused before a key is pressed (emoji go through a site's picker).
- The screen (`screen/`, set up with `sudo sh screen/install.sh`): the worker's Xvfb :99 is a small
  desktop, openbox with a taskbar holding Terminal (xfce4-terminal as `ubuntu`) and Chrome (the
  sign-in desktop through `ctl.mjs desktop-open`), so the owner can watch the agent and use the VM
  by hand. A Chrome the owner opened stays theirs: an agent task that starts meanwhile gets a new
  window of the same browser (its page, a sign-in or a captcha half done, stays under it), and the
  end of a task closes only a Chrome the agent opened (`by: "agent"` on /desktop/open and close);
  either way it closes after 30 minutes. `vm-screen-share` shares :99 with x11vnc on loopback port
  5901 only, for an SSH tunnel from the owner's Mac; its password is one the owner sets. Both are
  systemd units that look up Xvfb's auth file each start, so they come back after the worker does.
  `vm-shot [--window]` writes a PNG of the screen to stdout, for screenshots from the Mac (Screen
  Sharing sends the Mac's Cmd-Shift-3/4 through to the VM, where nothing takes them).
- Saved logins: `hive-cred.mjs` (installed as the `hive-cred` command, run through sudo) keeps the
  owner's logins encrypted with `systemd-creds` under the VM's machine key, in
  `/var/lib/hive-credentials` (root only). `hive-cred import < export.csv` takes a Passwords (Mac) or
  Chrome export; `list`, `sites`, `add`, `remove` manage it. The agent's `authenticate` tool types a
  saved login into the field it clicked; the agent never sees the password.
- The phone: the owner's iPhone runs WebDriverAgent inside its relay app, which keeps a connection
  open to the phone relay Worker in the cloud. `phone-mcp.mjs` talks to that Worker straight from the
  VM, with its address and key in `<state>/phone-relay.json` (mode 600), so the phone needs nothing
  from the Mac: Duo approvals and "Hey Siri, ask Hive" tasks run with the Mac asleep or locked. Its
  `authenticate` asks the relay to unlock (`POST /agent/unlock-now`): the relay keeps the passcode
  sealed, bound to the phone it was saved for, and types it at the keypad itself, so neither the VM
  nor the model ever sees it. Without the key file it answers with no tools and says why.
- The owner's own browser: `browser-mcp.mjs` sends each command (tabs, open, navigate, snapshot,
  read, click, type, select, scroll, press_key, wait_for, screenshot) to the board Worker's browser
  mailbox (`/v1/browser/`, `cloud/tasks/browser.js`) with the machines' token from root's hive-tasks
  config, and the Hive extension in the owner's Safari or Chrome takes it, runs it in that signed-in
  browser and sends back what came of it (`browser/chrome/src/cloud-peer.js`). The first browser that
  answers runs the rest of the task's commands. `navigate` opens its own tab unless given one, no tool
  types a password, and with no browser listening it says so after one 25 s wait and cancels the
  command, so nothing runs it late. Without the config it answers with no tools.
- Files: the R2 bucket `hive-files` is where Hive's nodes meet. `node desktop/hive-files.mjs send
  <file> --to vm` uploads from the Mac and has the VM fetch it into `~/hive-files`;
  `files.mjs fetch | put | list` is the VM's side (through root's Cloudflare login, by `sudo -n`).

## Hive's orchestrator

`orchestrator.mjs` is where the owner's instructions from the dashboard go, from any surface (the
website, the phone, the extension). The dashboard queues each one on the task board Worker
(`POST /v1/requests`, `cloud/tasks`), where it is also a board message on machine `cloud`. The
orchestrator takes the oldest one and then:

1. Plans it: a cheap Codex (`gpt-6.1-terra`, low effort, no tools) splits it into tasks and rates
   each `easy`, `normal`, `hard` or `hardest`.
2. Picks each task's model from its rating (`MODELS`: `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol`,
   `gpt-6-astra`). A code task gets at least `gpt-6.1-sol`. The board shows the choice in the task's
   evidence.
3. Files the tasks on the board under the request, in the folder the owner sent it from. A folder the
   planner names is used only if it already exists.
4. Runs each task through `hive-task.mjs` with that model. The task gets the owner's standing rules
   for the project (`GET /v1/rules`) and every memory of its folder, in full.
5. Runs a code task in a repository the VM can push to (`REPOS`: hive, with the dream's deploy key)
   in a fresh worktree off main under root's `/var/lib/hive-orchestrator`, with the network off
   (`hive-task.mjs --code`, the dream's Rust toolchain). Its change is committed and pushed to its
   own branch, `hive/r<request>-<n>-<title>`, never to main, and the task waits on the board for the
   owner's review. A code task anywhere else waits for a coding agent on the Mac.
6. Reports each task as it goes: its status, time, tokens, outcome and report. A task's report is
   also saved to its folder as a memory. After each request the VM's ledger syncs, which also sends
   its Codex plan limits.

It runs as the `hive-orchestrator` systemd service (`hive-orchestrator.service`), as `ubuntu`. It
reads the board's address and token from root's hive-tasks config by `sudo -n`. One request runs at
a time, and its tasks run one after another, since the VM has one screen.

## Tests

```bash
node --test cloud/vm-agent/vm-agent.test.mjs cloud/vm-agent/hive-agent.test.mjs cloud/vm-agent/orchestrator.test.mjs desktop/tests/vm_post.test.mjs
```

## Neighbours on the VM

Keep this worker's files and credentials separate from Bucky Match and other VM services.
Do not remove or migrate existing services until their owner approves the concrete plan.
