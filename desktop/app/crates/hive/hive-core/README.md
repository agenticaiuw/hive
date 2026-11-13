# hive-core

The part of Hive's Rust workspace (`crates/hive`) that has to stay exact across restarts and
processes. The other crates call it in-process.

- `thread_identity`: the durable conversation identity. `ResumableThread::connect` keeps the
  state file and its `.lock`, serializes creation across processes, saves an ambiguous-start
  marker before asking for a thread, and resumes an existing identity rather than replacing it.
  It forwards the seven resume overrides (`baseInstructions`, `developerInstructions`, `cwd`,
  `sandbox`, `permissions`, `approvalPolicy`, `config`), refuses mismatched or ephemeral
  identities, and writes and syncs the result atomically. hive-codex resumes Codex through it.
  A caller supplies a `SessionTransport` for the app-server's JSON requests.
- `task_recovery`: the record of the running task, so a restart can recover it.
- `request_ledger`: the encrypted ledger of requests from the request socket
  (`build/hive-request-ledger` lists it; see the app's README).
- `workspace_update`: whether the active workspace engine can be replaced. `tools/update-app.sh`
  runs the `workspace-engine-choice` binary for this; `--check-engine CANDIDATE INSTALLED`
  runs it read-only. Rust rejects malformed daemon reports and non-string instance IDs, bounds
  the doctor's output to 1 MiB, and captures it in a private temporary file.
- `phone_transport`, `memory`, `ingest` and `settings`: the iPhone's WebDriverAgent calls, the
  local memory store, splitting text for ingest, and the `.env`-style settings parser
  (`build/hive-settings-reader` prints it for the Python sidecars).

`hive-app-server-transport` is what hive-codex runs Codex's app-server under when it's built
(`build/hive-app-server-transport`): it forwards the bytes exactly, passes signals on and
reaps the server if the agent goes away.

Run the tests locally, without a provider account or network:

```sh
cargo test --offline --manifest-path crates/hive/Cargo.toml -p hive-core
```

They cover process concurrency and a killed start, atomic writes under competing and killed
writers, the transport's signals and exit codes, the ledger's paging and fail-closed cases, and
the settings parser. Where the Python version of something used to be compared against the
Rust one (resume, engine choice, settings), the Python's results are recorded in the tests.
They ran on macOS; Windows behavior, notably directory persistence guarantees, has not been
qualified.
