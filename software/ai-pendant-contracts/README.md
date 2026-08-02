# AI Pendant shared contracts

Versioned, transport-neutral contracts shared by the web dashboard, Capacitor
iOS app, Cloudflare API, and device agents.

The contracts deliberately separate two kinds of state:

- `product-snapshot.v1` is account-scoped product state read from the cloud.
- `device-agent-report.v1` is a short-lived report of one device agent's
  capabilities, permissions, presence, and diagnostic access.

Neither contract contains API keys, pairing codes, macOS paths, raw logs, or
audio. Product clients should use stable `accountId`, `deviceId`, `agentId`,
`sessionId`, and `runId` values rather than display names or host paths as
identifiers.

Run the dependency-free contract checks with:

```sh
npm test
```

The runtime assertions are intentionally small. JSON Schema remains the source
of truth for API validation, while the TypeScript declarations make the same
shape consumable from both React clients.
