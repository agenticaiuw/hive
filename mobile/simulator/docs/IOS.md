# iOS client and TestFlight

AI Pendant ships the same product UI inside a Capacitor iOS shell. The shell is
device-specific; durable product state is not.

- Cloudflare Worker: authenticated API and device coordination
- Cloudflare D1: relay jobs, device registrations, credentials, and normalized
  shared product sessions, turns, and memory
- Mac agent: Mac-only capabilities and local permission state
- iOS app: microphone, mobile UI, device identity, and a scoped cloud credential

The iOS app does **not** use ChatGPT authentication and does not contain the
relay administrator key. It connects directly to the relay API over HTTPS.
The separately hosted web dashboard uses its own pairing-key session.

## Security model

On first connection, the app sends:

```http
POST /v1/devices/pair
Content-Type: application/json

{
  "deviceId": "<stable mobile device id>",
  "deviceType": "mobile",
  "name": "Mobile Pendant Controller",
  "pairingCode": "<one-time setup code>"
}
```

The relay returns a scoped device credential. iOS saves it in Keychain with
`AfterFirstUnlockThisDeviceOnly`; it is not synchronized to iCloud, copied into
the web bundle, or stored in WebKit local storage. Revoking that credential on
the relay disconnects only this installation. A 401 prompts the app to pair
again.

The build script explicitly clears `VITE_RELAY_API_KEY`,
`VITE_PAIRING_CODE`, and `VITE_AGENT_TOKEN`, then scans the generated bundle
against locally configured secrets. It refuses to continue if one leaked into
`dist/`.

## Local prerequisites

- Xcode
- Node.js 20.19+ or 22.12+, with dependencies installed using `npm install`
- Apple Developer team configured in Xcode
- An App Store Connect app record matching the bundle identifier

This repository currently uses:

| Setting | Value |
| --- | --- |
| Display name | AI Pendant |
| Bundle identifier | `com.aipendant.app` |
| Apple team | `9684Z8GZ26` |
| Minimum iOS | 15.0 |

Override the team or bundle for a different App Store record without editing the
project:

```bash
PENDANT_APPLE_TEAM_ID=YOUR_TEAM_ID \
PENDANT_BUNDLE_ID=com.yourcompany.aipendant \
npm run ios:archive
```

## Build and run

Sync the sanitized web bundle into the native project:

```bash
npm run ios:sync
```

Open it in Xcode:

```bash
npm run ios
```

Choose an iPhone or Simulator and press Run. The first recording asks for
microphone permission. Direct LAN development additionally asks for Local
Network permission; ordinary remote use goes through the HTTPS cloud relay.

To point a development build at another relay, use a public URL only:

```bash
IOS_RELAY_URL=https://your-relay.workers.dev npm run ios:sync
```

Never pass `RELAY_API_KEY` or another administrator credential to an iOS build.

## Archive and TestFlight

Create a signed release archive:

```bash
npm run ios:archive
```

The archive is written under `build/ios/AI-Pendant-<build>.xcarchive`. Each
invocation uses a timestamp as the build number unless
`PENDANT_BUILD_NUMBER` is supplied.

After the App Store Connect record exists and its agreements are current,
archive and upload in one command:

```bash
npm run ios:testflight
```

Automatic signing is enabled. Xcode may ask for Apple-account authorization when
it needs to create or download an App Store distribution profile. After upload,
wait for App Store Connect processing, answer export-compliance questions if
prompted, then add the build to an internal TestFlight group.

## Native privacy metadata

- Microphone purpose string for voice commands
- Local Network purpose string for optional LAN development
- App Transport Security allows local networking but not arbitrary remote HTTP
- Privacy manifest declares app-functionality use of audio, command content,
  and the random device identifier; none are used for tracking
- `ITSAppUsesNonExemptEncryption` is false; the app only uses system TLS

Update the privacy manifest and App Store privacy answers before adding
analytics, crash reporting, advertising, or additional native SDKs.

## Data ownership

Deleting the app removes device-local UI preferences; Keychain behavior follows
iOS uninstall semantics. The mobile client reads and writes the canonical
`product-sync.v1` state through the relay. Cloudflare D1 stores normalized
account, session, turn, and memory records, and the relay merges versioned
records so the same dashboard data persists across app launches and devices.

Mac permissions and browser-extension permissions stay attached to those device
agents and appear in the shared dashboard as per-device capability snapshots.
