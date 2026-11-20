# Hive Phone

Hive Phone lets Hive's agents use an iPhone. It's WebDriverAgent's UI-test runner (`WebDriverAgent/`,
appium/WebDriverAgent 16.14.2, BSD license in `WebDriverAgent/LICENSE`) with one addition,
`WebDriverAgent/WebDriverAgentRunner/PhoneRelay.h`. The relay dials out to the board over one WebSocket
and passes the board's WebDriverAgent calls to WDA on the phone (`127.0.0.1:8100`), and nowhere else.
Nothing can reach in.

```
agent (VM, Mac, any node) ──▶ board /v1/phone/api/* ──▶ PhoneRelay (Durable Object) ══ WebSocket ══▶ Hive Phone ──▶ WDA
```

Every node reaches the phone the same way, through the board (`cloud/tasks/phone.js`). The VM's phone
tools (`cloud/vm-agent/phone-mcp.mjs`) use the board's relay unless the machine has its own
`phone-relay.json`.

## Getting it on a phone

On the dashboard's **iPhone** section:

- **Get Hive Phone in SideStore** adds the board's source (`/v1/phone/source.json`). SideStore installs
  the app, signs it on the phone with the member's own Apple ID, and offers each newer release.
- **Connect an iPhone** copies the pairing. When Hive Phone opens it reads the pairing from the
  clipboard once (iOS asks to allow the paste), keeps it, and clears the clipboard. Universal Clipboard
  carries a copy made on a Mac to the phone.
- **Let Hive unlock with it** keeps the phone's passcode on the board, sealed, so an agent can unlock
  the phone. It types the passcode only on the passcode screen, at most once until the owner allows
  another try.

What the phone needs once: SideStore, Developer Mode, and iOS 17 or later. The runner starts from its
icon only while the phone's developer disk image is mounted (StikDebug mounts it on the phone, and it
must be mounted again after a restart). The first launch may stop at iOS's "Enable UI Automation"
passcode prompt; after it, open Hive Phone again.

## Building and releasing

```bash
node mobile/relay/build.mjs --version 2026.1118.1530-test
```

This builds `build/HivePhone.ipa` on a Mac with Xcode, and nobody signs it. The packaging follows
[OpenMinis/iCTRL](https://github.com/OpenMinis/iCTRL) (Apache-2.0):

1. Build for testing with signing off.
2. Remove XCTest's frameworks so the phone's disk image supplies its own (the binaries look in
   `/System/Developer/...`).
3. Remove debug symbols.
4. Give the app and its test bundle the id `app.hive.phone.xctrunner`, plus Hive Phone's name,
   version and icon (`icon/`, drawn by `branding/sync-icons.mjs`).
5. Sign it ad hoc and zip `Payload/`.

The build stops if anything in the app holds this machine's owner's details
(`cloud/shared/ownerDetails.mjs`).

```bash
node cloud/release.mjs phone
```

This builds from the last commit and publishes the release to the board. Releases are versioned
`<year>.<monthday>.<hourminute>-<sources hash>`, and SideStore compares the first part. If the
sources haven't changed since the newest release, it does nothing. Tests:
`cloud/tests/phone_release.test.mjs` and `cloud/tests/phone_relay.test.mjs`.
