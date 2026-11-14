# Hive Cloud

One person's private cloud for their Hive data, deployed into their own Cloudflare account.
`worker.js` is the whole server; the Mac client is `desktop/app/crates/hive/hive-cloud`
(`hive-cloud`). Devices encrypt every chunk and every file's metadata before upload, so the
server never sees file contents or names. It does see record IDs (keyed hashes of paths), sizes,
times and which device wrote what.

## Set up

```sh
hive-cloud deploy            # asks for a Cloudflare API token ("Edit Cloudflare Workers" template)
hive-cloud invite            # on the first Mac: a one-use link for another device
hive-cloud join '<link>'     # on the other device
hive-cloud recover <url>     # a device with only the recovery code
```

`deploy` uploads `worker.js` through the Cloudflare API, keeps chunks in an R2 bucket named
`<name>-chunks` when R2 is on for the account (else in Durable Objects), claims the new cloud
for this Mac, and prints a recovery code. The recovery code is the only way back in if every
device is lost; keep it somewhere safe. `deploy --update` replaces the code and keeps the data.

## What goes up

| Folder | Cloud name |
| --- | --- |
| Hive's state folder (`AGENT_STATE_DIR`, else ~/Library/Application Support/Hive) | `state/` |
| Task recordings, while they still live outside the state folder (~/Movies/Hive) | `recordings/` |
| The voiceprint, while it still lives in the checkout (`models/voiceprint.npz`) | `voiceprint/` |

Left out, each with its reason, counted in `hive-cloud status` and listed by
`hive-cloud inventory` (which sends nothing):

| Path in the state folder | Why |
| --- | --- |
| `authentication/`, `control/request-ledger.key` | credentials, never uploaded |
| `cloud/` | this device's sync settings and keys |
| `lipread/` | model weights, downloaded again rather than restored |
| `app-backups/`, `updates/` | app builds, reinstalled rather than restored |
| `dream/target`, `dream/worktrees`, `dream/tmp` | build output |

Lock files, sockets, SQLite `-wal`/`-shm`/`-journal` files, `*.tmp` and `.DS_Store` are skipped.
A SQLite database is copied with `VACUUM INTO` first, so one in use goes up consistent.

A device without the recordings or voiceprint folder gets them inside its own state folder
(`state/recordings/…`), and they stay the same records: deleting one there deletes it everywhere.

## How Hive runs it

Once the Mac is connected (`<state>/cloud/config.json` exists), Hive starts
`hive-cloud watch --parent <its pid>` and keeps it running: a sync every minute, and one right
away when a task recording finishes (Hive touches `<state>/cloud/nudge`). It stops when Hive
quits. Output goes to `<state>/cloud/watch.log`. There is no LaunchAgent.

## When things go wrong

- Two devices changed the same file: both versions are kept, the other one beside it as
  `<name>.conflict-<device>-<time>`.
- A sync that would delete more than a quarter of the cloud's files (and more than 20) stops;
  `hive-cloud push --allow-mass-delete` lets it through.
- Deleted and replaced versions stay in the cloud's history for 30 days.
- `hive-cloud verify --all` downloads every file and checks every chunk and file hash;
  `hive-cloud status` shows the last verified sync.
- `hive-cloud revoke <device id>` locks out a lost device.

## Tests

```sh
npm test                                    # the Worker, in-process
cargo test -p hive-cloud                    # in desktop/app/crates/hive
bash test/e2e.sh                            # the client against worker.js; `e2e.sh r2` for R2
```

`e2e.sh` runs three fake devices against a local copy of the Worker with synthetic data only.
