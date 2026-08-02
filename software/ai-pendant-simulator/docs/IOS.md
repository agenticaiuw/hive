# iOS (Capacitor)

The pendant UI is wrapped as a native iOS app with Capacitor.

## Prerequisites

- Mac with Xcode installed
- Apple ID (free account works for device testing)
- Home Mac agent running: `npm run agent`

## Open in Xcode

```bash
npm run ios
```

This builds the web UI, syncs it into `ios/`, and opens Xcode.

## Run on iPhone

1. In Xcode, select your iPhone (or Simulator)
2. Set your Team under Signing & Capabilities
3. Press Run
4. On first launch, allow Microphone + Local Network

## Connect to home Mac

1. Tap the tiny settings orb (bottom-right)
2. Set Mac Agent URL to your Mac LAN IP, e.g. `http://192.168.0.12:8000`
3. Paste the same `AGENT_TOKEN` from `.env`
4. Save & Connect
5. Close settings → tap the pendant to speak

Find Mac IP:

```bash
ipconfig getifaddr en0
```

## Daily workflow after UI changes

```bash
npm run ios:sync
```

Then rebuild/run from Xcode.
