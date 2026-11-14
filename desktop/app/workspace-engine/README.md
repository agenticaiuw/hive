# workspace-engine

The Swift package for Hive.app's main executable, `agent-unified-host` (`Sources/UnifiedAgent`:
the app shell, the context panel and the credential helper). `tools/build-workspace.sh` builds it
under `build/workspace-engine/`, and the Makefile copies it into `build/Agent.app` as
`Contents/MacOS/Agent`.

Hive's own virtual workspace engine, a separate display the agent works on without taking your
screen, is being written for this package. The Rust side already expects it: `hive-workspace`'s
`workspace-mcp-bridge` talks to the engine named by `AGENT_WORKSPACE_ENGINE`, and Hive starts it
only with `AGENT_EXPERIMENTAL_VIRTUAL_WORKSPACE=1`. Until the engine lands, Hive works on your
own screen only.
