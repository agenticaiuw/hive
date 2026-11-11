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
- The worker never types credentials. Sign-in happens through the viewer (below).

## What it does not do

- No disguise: no user-agent changes, no stealth patches, no CAPTCHA handling. If a site asks for
  verification, the owner does it in the viewer.
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
node desktop/vm-post.mjs login discord        # opens the VM's browser locally so you can sign in
node desktop/vm-post.mjs where discord        # your servers; add a server id for its channels
node desktop/vm-post.mjs send --to club-general --file shot.png --text "hello"
node desktop/vm-post.mjs send --to x --text "hello"
```

`send` shows a macOS dialog with the destination and the exact text; only "Send" publishes.
Exit codes: 0 sent, 1 cancelled, 3 the VM is signed out, 4 unknown (check the site, do not resend),
5 failed (nothing was submitted).

The sign-in viewer is a loopback page on the VM reached through an SSH tunnel. It needs a one-time
link, closes when idle, and does not log what is typed. "Open a link…" opens a pasted Discord or X
link (such as a verify-login link from an email) in the VM's browser; other sites are refused.

## Tests

```bash
node --test cloud/vm-agent/vm-agent.test.mjs desktop/tests/vm_post.test.mjs
```

## Neighbours on the VM

Keep this worker's files and credentials separate from Bucky Match and other VM services.
Do not remove or migrate existing services until their owner approves the concrete plan.
