# Personal Agent core: Rust migration

This crate contains a Rust implementation of the durable conversation identity
currently in `python/resumable_thread.py`. That portion is a library and is not
wired into the running app yet. It does not start a Codex server,
control a desktop, read credentials, or create sessions by itself. A caller
supplies a `SessionTransport` for app-server JSON requests.

`ResumableThread::connect` keeps the existing state-file format and `.lock` file,
serializes creation across processes, persists an ambiguous-start marker before
requesting a thread, resumes an existing identity rather than replacing it,
forwards the same six resume overrides, rejects mismatched/ephemeral identities,
and atomically writes and syncs the resulting state. The Rust test suite checks
those boundaries, tests process concurrency and a killed start, and compares a
start/resume fixture against the Python implementation.

The update script now uses the Rust `workspace-engine-choice` binary in place of
`python/workspace_update.py` to decide whether the active workspace engine can
be replaced. It builds the binary before staging an update when both engines
exist, so builds require Cargo and the locked dependencies. A read-only
`tools/update-app.sh --check-engine CANDIDATE INSTALLED` exercises that same
binary without installing or restarting the app. Tests compare realistic
reports with Python and exercise actual subprocesses, bad data and timeouts.
Rust deliberately rejects malformed daemon reports and non-string instance IDs
more strictly than Python; it bounds doctor output to 1 MiB. It captures output
in a private temporary file, so a helper that exits while a descendant continues
writing to its inherited output is not guaranteed the pipe-EOF behavior of
Python's subprocess capture.

The workspace tool client is also implemented in Rust. Normal app builds put
`workspace-client` in `build/agent-workspace-client`; the existing Python tool
dispatch starts it when available and retains the Python transport if the
binary has not been built. Once a Rust request starts, an error is never retried
through Python because the server may already have performed the action. The
binary receives request JSON on stdin and communicates through the same private
Unix socket, with the existing response size limit and timeout. Run
`make build/agent-workspace-client && python3 -m unittest discover -s tests -p test_rust_workspace_client.py`
to compare both transports with a disposable local server. This still needs a
real-workspace end-to-end check after a controlled app restart; the running app
was not restarted for this migration.

Run locally, without a provider account or network:

```sh
cargo test --offline --manifest-path crates/agent-core/Cargo.toml
```

This is **not the requested full migration**. The app still runs the Python
conversation implementation. Before switching, integrate this crate into the app's actual
app-server transport and observation hooks, reproduce its existing end-to-end
restart/failure tests against both implementations, and verify resume on a real
session. Python's optional `observe` callback and exact error-message wording are
not yet reproduced. Tests above ran on macOS; Windows behavior, notably directory
persistence guarantees, has not been qualified.

The existing Python runtime also handles orchestration, the desktop and phone
bridges, microphone and speech pipelines, local IPC, authentication, memory,
and model-specific preprocessing. The voice stack currently relies on MLX and
other native/model libraries through Python; those integrations need Rust
bindings or replacement runtimes plus behavior and latency testing. This is an
implementation constraint, not a requirement that the project keep Python.
