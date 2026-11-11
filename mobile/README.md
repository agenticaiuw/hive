# Mobile

`ios` points to the existing Capacitor iOS application. It is a controller shell,
not evidence of a standalone mobile Codex agent. The independent mobile runtime,
remote session connection and phone-control integration still need implementation.

`mesh-pairing.mjs` implements the relay's existing `/v1/devices/pair` exchange
for `mobile` and `mac_bridge` identities. Its caller must obtain the pairing
code and save the returned token in platform secure storage; this module does
not persist either. A desktop bridge can use a separately provisioned `mac_bridge`
credential, with the mobile device ID explicitly listed in `allowedSenders`.

`pc-mesh-client.mjs` and `pc-mesh-store.mjs` provide a mobile-compatible mesh
client and IndexedDB request-metadata store. Submit persists an unknown state
before sending, never automatically retries an ambiguous send, and records the
relay's message ID when available. Poll accepts results only from the configured
PC and persists them before acknowledging the inbox; `accepted` means local
admission, not completed work. The store must be owned by one client instance.
Request text and bearer tokens are not stored in the journal. An unknown send
may have succeeded; absence of a result does not prove failure. The dashboard `/pc` page uses these modules and is accessible from the iOS shell.
The page retains the token only until it is closed or reloaded; pairing again
creates a new relay credential. UI behavior has not yet been verified on an
iOS device or against a live relay.
