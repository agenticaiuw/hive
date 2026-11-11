# What the iPhone Can Actually Be in This System

## The framing insight

**The phone is not where the intelligence lives. It is a remote, a sensor, and a notifier.**

Every instinct says "put the assistant on the phone." iOS will fight you the entire way, because the one thing you'd want — an app that sits there listening and acting on your behalf — is precisely what Apple forbids. There is no background daemon. There is no custom wake word. An app cannot start the microphone unless it is already in the foreground. It cannot touch another app's UI, read another app's notifications, run a shell, or leave its own sandbox.

But the phone is exceptionally good at three things, and all three are things your pendant and Mac currently cannot do:

1. **Remote** — a button on the Lock Screen, in Control Center, on the Action Button, in Siri, on a NFC tag by the door, that fires a command at the Mac agent in under a second with the phone in your pocket.
2. **Sensor** — location, motion, Wi-Fi/Bluetooth presence, NFC taps, Focus state, camera OCR. Ambient signals the Mac agent has no way to know.
3. **Notifier** — the only surface in the whole system that can interrupt you anywhere. Your Mac can't reach you in a meeting. Your pendant speaker can't show you a diff. The phone can put "the agent wants to run `rm -rf build/` — approve?" on your Lock Screen with two buttons.

Design toward those three and iOS is generous. Design toward "the assistant lives on my phone" and you will spend a month fighting the sandbox and lose.

One corollary that matters more than it sounds: **every native surface you add — widget, Control Center button, Live Activity, Siri intent — is Swift, and none of them can call your JavaScript.** The Capacitor WebView is not running when a Siri intent fires. Each native surface has to hold its own credential and talk to the Cloudflare Worker itself. Plan for a small shared Swift networking layer, not a JS bridge.

---

## Before anything: four one-line blockers in the repo

I verified these in your tree. They gate essentially everything below.

| Blocker | Where | Fix |
|---|---|---|
| **Deployment target is iOS 15.0** | `ios/App/App.xcodeproj/project.pbxproj` lines 245, 296, 314, 337 | Raise to 26.0. Live Activities need 16.1, Controls need 18.0, AlarmKit/SpeechAnalyzer/Foundation Models need 26.0. This is the single gate on nearly every feature below. |
| **Keychain item has no access group** | `PendantSecureStoragePlugin.swift` — `baseQuery` uses only `kSecAttrService` + `kSecAttrAccount` | Add a `keychain-access-groups` entitlement and `kSecAttrAccessGroup`. Without it, no widget, intent, or extension can read your pairing key — they get `errSecItemNotFound`. This is a migration: existing items must be re-saved. (The `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` choice is already correct — do not tighten it, background code needs it.) |
| **Info.plist has only mic + local-network usage strings** | `ios/App/App/Info.plist` | Every sensor you add needs its own string first. A missing one is a hard crash on first call, not a graceful denial. No `UIBackgroundModes` at all today. |
| **`PrivacyInfo.xcprivacy` declares zero accessed APIs** | `NSPrivacyAccessedAPITypes` is an empty array | The moment you add an App Group + `UserDefaults(suiteName:)` — which every widget design needs — you must declare `NSPrivacyAccessedAPICategoryUserDefaults` / reason `CA92.1`. Only enforced at App Store Connect upload, so it will surface late and annoyingly. |

---

## What the app can do the moment it ships

With the Capacitor app you already have signed, plus trivial config:

- **Mission Control in your pocket.** The WebView already renders your dashboard. It works.
- **Talk directly to the Mac, no cloud, when you're home.** `Info.plist` already declares `NSAllowsLocalNetworking`, `NSBonjourServices _http._tcp`, and `NSLocalNetworkUsageDescription`. A plain `fetch()` from the WebView to `http://<mac>.local:8000` works today. That skips the entire Cloudflare hop — and note your relay's `/v1/bridge/work` long-poll sleeps 800ms between claim attempts (`cloud-relay/server.js:1296-1355`), so the LAN path isn't just lower latency, it removes an ~800ms floor you can't otherwise fix.
- **Hold-to-talk in the WebView.** `getUserMedia` + `MediaRecorder` works in WKWebView, foreground, screen on. POST the blob to `/v1/transcribe`. Zero native code. It dies the instant you background the app — WebKit force-mutes the mic — so treat it as a prototype, not the real capture path.
- **Universal Links.** Serve `apple-app-site-association` from the Worker and every link in Mission Control, every notification, every message the agent sends you opens straight into the right screen. Capacitor handles the inbound side natively via `appUrlOpen`.
- **Launch other apps and Shortcuts from the WebView.** `location.href = 'shortcuts://x-callback-url/run-shortcut?name=...'` or `bear://`, `things:///`, `comgooglemaps://`. This is the legal escape hatch from the sandbox — your planner emits a URL, the phone opens it. Fire-and-forget, foreground only.
- **Universal Clipboard as a free phone→Mac wire.** Writing `UIPasteboard.general.string` on the phone makes it instantly available on the Mac. Writing is unrestricted; reading is what triggers the prompt.
- **Tailscale, today, with no code.** Put Tailscale on the phone and the Mac and the phone reaches the Mac agent at a stable address *from anywhere*, not just the LAN. Combined with the Shortcuts loop below, this is a complete voice remote with zero Swift written. (Do not do this without keeping the relay's `principalOwnsDevice` check in front — you'd otherwise be exposing a shell-execution endpoint to your whole tailnet.)

---

## The high-value additions, ranked

Ranked by owner delight × inverse effort. **The top three are #0, #1, and #2 — build them in that order.**

### #0 — The zero-Swift voice loop (do this tonight, before writing any code)

**What you'd experience:** You say "Pendant" out loud — no "Hey Siri," no button, phone locked in your pocket. Your phone takes dictation, ships the text to the Mac agent, and speaks the reply.

**How:** Settings → Accessibility → **Vocal Shortcuts**, train the phrase "Pendant" (three utterances). Point it at a Shortcut that does `Dictate Text` → `Get Contents of URL` (POST to your Worker or the Tailscale address, pairing key in a header) → `Speak Text`.

**Effort:** Trivial. **Native Swift:** none. **Capacitor:** irrelevant — no app involvement at all.

This matters disproportionately because it does something App Shortcuts *cannot ever do*: accept arbitrary spoken text. Siri App Shortcut phrases don't support open-ended string parameters — you can't say "tell my Mac to close everything and start the deploy" to a Siri intent and have the free text arrive. `Dictate Text` inside a Shortcut can. Build this first; it's the baseline every native feature has to beat, and it may turn out to be good enough for half of what you want.

Caveat: the pairing key sits in plaintext inside the Shortcut. Fine for your own phone, not shippable.

---

### #1 — Actionable push notifications with Approve / Deny / inline reply

**What you'd experience:** The Mac agent plans something destructive. Your Lock Screen lights up: *"Agent wants to run `rm -rf build/` in ~/projects/pendant."* Two buttons: **Run it** / **Cancel**. You tap Cancel from the Lock Screen; the app never visibly opens. Or you long-press, type "use the staging dir instead," and that text goes straight back into the job as a new turn.

**Why it's #1:** This is the highest value-per-line feature in the entire inventory for a system whose whole job is executing shell and AppleScript on your personal Mac. Right now you have no human-in-the-loop gate that reaches you when you're away from the Mac. Your `jobs.js` already has a state machine; this is mostly wiring.

**API:** `UserNotifications` — `UNNotificationCategory` + `UNNotificationAction` (crucially *without* `.foreground`, so the app wakes in the background ~30s, POSTs the decision, and never appears) and `UNTextInputNotificationAction` for the reply field. Mark it `.timeSensitive` so it pierces Focus — that entitlement is a **self-serve checkbox in Xcode**, no Apple approval. Worker side: sign APNs ES256 JWTs with WebCrypto (P-256/SHA-256) — Cloudflare Workers can do this natively, no npm dependency.

**Effort:** Trivial to moderate. **Native Swift:** `@capacitor/push-notifications` covers registration, delivery, `registerActionTypes()`, and `pushNotificationActionPerformed`. The text-input action and reliable background handling want ~40 lines of Swift in `AppDelegate`. Your `AppDelegate.swift` currently has no push registration at all — this is greenfield.

**Watch out:** the background-action path requires the app to be running or suspended, not force-quit. If force-quit, tapping just launches the app. Keep handler work under 30s.

---

### #2 — Control Center / Lock Screen / Action Button control: "squeeze and talk"

**What you'd experience:** Squeeze the Action Button on the side of your iPhone, anywhere, screen off. The Pendant app snaps open already recording. Say the thing. Or swipe into Control Center and hit a "Send to Mac" button that fires your last command with no app launch at all. The same control shows a live dot: agent online / offline.

**API:** WidgetKit `ControlWidget` + `ControlWidgetButton`/`ControlWidgetToggle`, backed by an `AppIntent`. Once the intent exists, the *same* code appears in Control Center, on the Lock Screen (replacing the flashlight slot), bound to the Action Button, in Siri, in Spotlight, and in Shortcuts. Write once, land on eight surfaces. This is the best effort-to-surface-area ratio on iOS.

**Effort:** Moderate — but that's almost entirely the one-time cost of adding a Widget Extension target to `App.xcodeproj` and setting up an App Group. The control itself is ~40 lines.

**Native Swift:** yes, unavoidable. There is no Capacitor plugin for modern App Intents; the community `capacitor-plugin-siri-shortcuts` packages are legacy `NSUserActivity` donation and are not a substitute.

**The important limitation:** a control **cannot start the microphone**. Nothing backgrounded can. So a "talk" control must set `openAppWhenRun` and foreground the app (Face ID, screen on) into a recording view. A control that just *sends* something — "run my morning routine," "cancel current job," "wake the Mac" — runs fully in the background with no app launch. Design accordingly: two controls, not one.

One correction worth knowing, since it changes your architecture: two of the research passes claimed App Intents always run in a memory-starved extension process with no access to the app's permissions. That's true for intents *defined inside a widget extension*. An `AppIntent` declared in the **main app target** runs in your app's own process, launched into the background — meaning it can share your networking code, your Keychain items, and potentially your granted Local Network permission. Verify the last one on device before you build the LAN-first path around it, but do not accept "you must duplicate the whole HTTP client" as inevitable.

---

### #3 — Live Activity: the pipeline on your Lock Screen, started by the pendant

**What you'd experience:** You speak into the nRF9160. Before you touch your phone, a card appears on your Lock Screen: *"heard: 'run the firmware build' → transcribing → planning → executing on Mac (step 2/4)"*, ticking in real time, with Cancel and Approve buttons. On iPhone 14 Pro and later it also lives in the Dynamic Island while you're in other apps. On a watch it mirrors into the Smart Stack for free. In your car it appears on the CarPlay home screen for free.

This is the flagship. It is also the only genuinely low-latency Mac→phone channel Apple gives third parties.

**API:** ActivityKit + a Widget Extension. **Push-to-start tokens** (iOS 17.2+) are the magic part — the Worker starts the activity remotely, so it appears even if you haven't opened the app in days. APNs `apns-push-type: liveactivity`. Add `supplementalActivityFamilies([.small])` and you get the Watch Smart Stack and CarPlay with no extra work.

**Effort:** Heavy. Widget extension, SwiftUI card, APNs plumbing, push tokens, and buttons must conform to `LiveActivityIntent` (not plain `AppIntent`) with the type shared between app and extension.

**Native Swift:** yes. Capacitor plugins exist (`@capgo/capacitor-live-activities`, `ludufre/capacitor-live-activities`) and can start/update/end from JS, but you still write the SwiftUI extension.

**Real constraints:** 8 hours active + 4 hours stale, 12h max — this is a per-session card, not a permanent presence. 4KB payload, so truncate transcripts. Push updates are budgeted and silently dropped when you exceed them — debounce on the Worker, don't stream agent log lines. And push-to-start tokens are known to be flaky: register in `didFinishLaunchingWithOptions` on *every* launch, and build an alert-push fallback for when the token is nil.

---

### #4 — Background URLSession for audio upload

**What you'd experience:** You hit record, talk, hit send, lock the phone and put it away. The upload finishes anyway — even if iOS terminates the app mid-transfer, it relaunches you in the background to handle the response.

**API:** `URLSessionConfiguration.background(withIdentifier:)`, `uploadTask(with:fromFile:)`.

**Effort:** Moderate. **Native Swift:** required — WebView `fetch()` dies the moment the app suspends.

Unglamorous, and the single most reliable primitive on the list. If the phone ever captures audio for real, this replaces `fetch()`, full stop. Note the body must come from a *file*, not `Data`, for the terminated-app case, and force-quitting cancels everything.

---

### #5 — Face ID gate on destructive commands (Secure Enclave)

**What you'd experience:** The agent proposes something dangerous. Approving it requires your face — not just possession of your unlocked phone.

**API:** `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and `SecAccessControlCreateWithFlags(.privateKeyUsage, .biometryCurrentSet)`. The phone signs the job ID; the Worker verifies with WebCrypto ECDSA P-256.

**Effort:** Moderate, ~80 lines modeled on your existing Keychain plugin. **Native Swift:** yes.

Notably stronger than a notification button, which anyone holding your unlocked phone can tap. Two constraints: `.biometryCurrentSet` destroys the key when your Face ID enrollment changes (that's the security property, but it makes a re-enrollment flow mandatory), and **Face ID cannot be invoked from a background intent, widget, or Live Activity button** — the approval must route through the app foreground. So the pattern is: notification with an "Approve" button that *opens the app* to the biometric prompt.

Adjacent and worth the same trip: **App Attest** (`DCAppAttestService`). Your pairing key is a bearer token — anyone who extracts it gets shell on your Mac. App Attest replaces it with a Secure-Enclave-backed key Apple vouches for. Same Worker-side WebCrypto work you're already doing for APNs. Keep the pairing key as a re-enrollment path, because attestation keys don't survive a device restore.

---

### #6 — On-device transcription (SpeechAnalyzer)

**What you'd experience:** You speak into the phone and the text appears as you talk, before any network round-trip, working on a plane.

**API:** iOS 26's `SpeechAnalyzer` + `SpeechTranscriber` (+ `SpeechDetector` for auto-stop on end-of-speech). No one-minute cap, streaming partial results, reportedly beats Whisper Small.

**Effort:** Moderate. **Native Swift:** yes, plus `NSSpeechRecognitionUsageDescription` which your plist lacks.

**Important scope limit:** this only helps *phone-captured* audio. The nRF9160's audio goes pendant → LTE → Worker and never touches the phone. So this is worth it only if phone-as-pendant becomes a real path for you. `SpeechTranscriber` also requires iPhone 15 Pro or newer; older devices fall back to `DictationTranscriber`.

---

### #7 — On-device LLM triage (Foundation Models)

Run Apple's ~3B on-device model to classify "lock my Mac" into a structured command before it ever hits your Worker's planner. Free, offline, zero API cost, typed output via `@Generable` guided generation. Moderate effort, native Swift, gated on iPhone 15 Pro+ with Apple Intelligence enabled — so you always need the Worker fallback. Good at extraction and classification, useless for actual multi-step planning. A nice latency win for the trivial 40% of commands, not an architecture change.

---

### #8 — Camera OCR into the pipeline

`VisionKit`'s `DataScannerViewController` is a drop-in live text/barcode scanner with built-in guidance UI and tap-to-select. "Point at this error message and send it to my Mac" is about thirty lines. Trivial effort, small native plugin, needs `NSCameraUsageDescription`. The most underrated cheap feature on the list — it's the only way real-world information gets into your agent without you typing it.

---

### The one that isn't an iOS feature at all: iPhone Mirroring

Every "iOS has no cross-app automation" statement is true for code running *on the iPhone*. It is not true for **your system**, because your system has a Mac.

On macOS 26, iPhone Mirroring renders your live iPhone screen as an ordinary AppKit window that accepts synthetic clicks and keystrokes. Your Mac agent already holds Accessibility and Screen Recording permissions — I verified both are requested and probed in `local-agent/macos/permissions.js` (`checkAccessibility()`, `CGRequestScreenCaptureAccess()`, the System Events probe). So "open Instagram on my phone and DM Sam" becomes the same class of action the agent already performs on Mac apps: screenshot the mirroring window, have the planner find the target, click it.

**No iOS code, no entitlement, no App Store exposure.** Effort: moderate, all Mac-side in Node.

Caveats that matter: requires an Apple silicon Mac, same Apple ID, and **the iPhone locked and nearby** — picking up the phone severs the session, which makes it unreliable exactly when you're holding the device. Pixel-driven automation over a scaled window is brittle; use it as the fallback for apps with no URL scheme, not the primary path. And it's the one capability where the Mac can see your phone's screen content, so gate it behind an explicit app allowlist. I could not re-verify current 26.x behavior — test it before designing around it.

---

## Shortcuts specifically

Shortcuts is not a consolation prize for not writing Swift. For a single-owner system it is frequently the *better* answer, because it needs no review, no entitlement, no build, and no TestFlight.

**What App Intents buy you:** you write one Swift struct — `RunMacCommandIntent`, `MacStatusIntent`, `SpeakOnPendantIntent`, `CancelJobIntent` — and it appears simultaneously in Siri, Spotlight, the Shortcuts editor, widgets, Control Center, on the Action Button, on Lock Screen controls, in Live Activity buttons, and (when iOS 27's Siri lands) in Siri's natural-language reasoning. This is the highest-leverage Swift you will write.

**What Siri specifically buys you, and what it doesn't:** `AppShortcutsProvider` gives you zero-setup phrases — "Hey Siri, AI Pendant status" works the instant the app is installed, answers out loud, and never opens the app. Three hard limits: max 10 App Shortcuts per app; every phrase must literally contain your app name (`"lock my Mac with AI Pendant"` — `"lock my Mac"` is impossible); and **phrases cannot take open-ended string parameters**. That last one is why the Vocal Shortcut + `Dictate Text` path in #0 exists.

**Automations you probably haven't considered:**

- **NFC tag on your desk.** Tap the phone to it → "start work session" fires a batch of Mac commands. A second tag on the pendant's charging dock marks it as docked in the Worker. This is the closest thing iOS offers to a physical button, and it needs no app whatsoever.
- **Wi-Fi joins home network** → switch the pendant's endpoint from the Cloudflare Worker to `http://<mac>.local:8000`. This directly exploits the local-networking config already sitting in your `Info.plist`.
- **Arrive home / leave the office** → "tell the Mac to wake and announce pending items" / "lock the Mac." Passive geofences, so expect a minute of lag.
- **Focus mode changes.** Work Focus on → agent executes immediately; Sleep Focus on → agent queues everything and mutes the pendant. Note: your app can *react* to Focus (`SetFocusFilterIntent`) but **cannot set one** — only a Shortcut can do that.
- **Bluetooth connects to car / CarPlay** → driving mode, voice-only replies.
- **AirPods connect** → route pendant replies to AirPods instead of the pendant speaker.
- **Time of day / sunrise / sunset** → 8am morning brief with zero server cron.
- **Charger connected, battery below 20%, alarm goes off, an app opens.** All available.
- **Email or Message received, filtered by sender and subject.** This is the only way, today, for your Worker to remotely trigger something on the phone. Combine it with **Emergency Bypass** on that contact and you get Critical-Alert behavior — rings through silent mode and every Focus — with no entitlement and no Apple approval. Lock it to a sender you control *plus* a secret in the body, prefer iMessage over trivially-spoofed SMS, and understand the payoff for an attacker here is shell execution on your Mac.
- **iOS 27 (~Sept 2026): notification → Shortcut automation.** This is the one that closes the loop properly — your Worker pushes, the phone runs a Shortcut. Not available on shipping iOS 26. It's coming; don't architect around its absence permanently.

**Third-party actions worth knowing:** Scriptable runs arbitrary JavaScript inside a Shortcut (fetch, JSON, the works) — you can write real phone-side logic in the same language as the rest of this codebase with no Xcode. Data Jar gives Shortcuts actual persistent structured storage. Exhaust these before writing Swift.

**iOS 26's `Use Model` action** runs Apple Intelligence (on-device, Private Cloud Compute, or ChatGPT) inline in a Shortcut — you can reshape a transcript into a structured command on the phone before POSTing, and in on-device mode the transcript never leaves the device. Better privacy story than your current Worker-side LLM path, and free.

---

## Hard limits — stop wondering

These are not "hard for now." They are Apple's design.

- **No custom wake word.** Ever. Apple reserves wake-word detection for Siri. Vocal Shortcuts and Voice Control are Accessibility features you configure by hand in Settings; an app cannot register one, so it can never be a shipped feature.
- **The mic cannot start from the background.** A recording begun in the foreground *continues* through backgrounding and screen lock (with `UIBackgroundModes: audio`), but starting one from a Shortcut, an intent, a control, the Action Button, a push, or a BLE event fails with `AVAudioSessionErrorCodeCannotStartRecording`. The only exceptions are the PushToTalk and CallKit frameworks, both of which require Apple-approved entitlements and a plausible walkie-talkie/calling product. This is the ceiling on "phone as pendant," and it is exactly the gap your hardware exists to fill.
- **No cross-app UI automation from the phone.** No AppleScript equivalent, no accessibility driver, no tapping buttons in other apps. Only URL schemes, Shortcuts actions the other app volunteered, and a custom keyboard typing into a field you're already in. (The Mac-side iPhone Mirroring route above is the genuine workaround.)
- **No shell, no process spawning, no filesystem outside the container.**
- **No reading other apps' notifications.** There is no Android-style notification listener. Mirroring notifications to the pendant is buildable — but on the *Mac* end, not the phone.
- **No persistent background daemon.** Every mechanism is either event-triggered or a bounded slice: ~30s for most, minutes for `BGProcessingTask`. Silent pushes are throttled to a few per hour, dropped in Low Power Mode, and never delivered after force-quit. `BGAppRefreshTask` may not run for hours or at all.
- **No server-triggered Shortcuts on iOS 26.** A webhook cannot invoke a Shortcut or an App Intent on your phone. (Pushcut's Automation Server genuinely does this and the flat "impossible" verdict is wrong — but it wants a dedicated, plugged-in, foregrounded device, which with one iPhone limits it severely.)
- **Force-quitting the app disables almost everything.** No silent pushes, no background tasks, no background upload relaunch. What survives: alert pushes, Live Activity push updates and push-to-start, VoIP pushes, CoreBluetooth state restoration, significant location change.
- **Widgets and Live Activities support Buttons and Toggles only.** No text field, no scrolling, no gestures. Want text from the Lock Screen? Use a notification with `UNTextInputNotificationAction`.
- **Critical Alerts will be denied.** Apple restricts it to medical, first-responder, severe weather, and personal safety. Use Time-Sensitive (self-serve), AlarmKit (iOS 26, pierces silent mode and Focus, no approval), or the Emergency Bypass contact trick.
- **Geofences cap at 20 regions per app**, and Always-location authorization gets re-confirmed with the user periodically.
- **App Shortcut Siri phrases can't take free text**, and every phrase must contain your app name.

---

## The Apple Watch question

**Answer: don't build a watch app. Get 80% of the value for free, then stop.**

The free 80%, all of which requires zero watchOS code:

- Add `supplementalActivityFamilies([.small])` to your iPhone Live Activity and it **mirrors into the watch Smart Stack automatically**. Raise your wrist, see what the Mac is doing.
- On watchOS 26, **Control Center controls from your iPhone app appear on the Watch automatically** — your "Send to Mac" control shows up in the watch's Control Center gallery and can be bound to the Ultra's Action Button. The intent still executes on the phone, so the phone must be reachable.
- **Double Tap** (`.handGestureShortcut(.primaryAction)`, Series 9 / Ultra 2 and later) fires the primary button of whatever's in the Smart Stack — including your Live Activity. Approve the agent's action by tapping two fingers together, hands still on the keyboard.
- Any Shortcut you build runs on the Watch already. "Hey Siri, Tell My Mac" works from your wrist today with nothing installed.

The paid 20% is a **native SwiftUI watchOS target** — Capacitor produces nothing for watchOS, there is no WebView, and you'd be rewriting your pairing flow and status UI from scratch in Swift. It buys you: recording from the wrist with the phone out of range, and a face complication. `SpeechAnalyzer` isn't available on watchOS, so transcription still goes to the phone or the Worker. Credential bootstrap is annoying — keychain access groups don't cross devices, so you'd need `WatchConnectivity` to ship the pairing key over.

Verdict: excellent as a record-and-send remote, useless as an always-listening daemon (watchOS background execution is *tighter* than iOS). Build it last, or never. Wrist Flick, for the record, is a system dismiss gesture with no third-party API — you cannot bind anything to it.

---

## Does the app need to stay open?

**For most of what you want: no.** For the one thing you want most: yes.

**Works with the app closed, killed, never opened today:**
- Push notifications, including Approve/Deny buttons and inline text reply
- Live Activities, including push-to-start — the Worker can put the pipeline on your Lock Screen when the pendant fires, with the app never launched
- Siri App Shortcuts and any App Intent — the intent wakes your process in the background, answers, and exits
- Control Center / Lock Screen / Action Button controls that *send* something
- Shortcuts automations
- Widget refresh via push

**Requires the app foregrounded:**
- **Starting any audio recording.** Full stop. This is the constraint that shapes everything. A control or intent that needs the mic must set `openAppWhenRun` and bring the app up — Face ID, screen on, ~1 second. That's the actual UX for "squeeze the Action Button and talk," and it's fine; it's just not "talk with the screen off."
- Face ID / Touch ID approval
- Opening another app
- Any WebView JavaScript at all

**The nuance:** a recording *started* in the foreground continues through backgrounding and screen lock if you declare `UIBackgroundModes: audio` (which your plist currently doesn't). So: press record, lock the phone, put it in your pocket, keep talking. That works. Starting from the pocket does not.

**Force-quit is a kill switch.** If you swipe the app out of the App Switcher, iOS treats it as an explicit signal and disables silent pushes, background tasks, and background upload relaunch. Only alert pushes and Live Activity pushes survive. Don't force-quit it.

---

## Recommended build order

### Phase 1 — Prove the loop with no Swift (a weekend)

1. Install Tailscale on the phone and Mac. Confirm `curl` from the phone reaches the Mac agent from off-network.
2. Build the Shortcut: `Dictate Text` → `Get Contents of URL` (POST, pairing key header) → `Speak Text`. Name it something Siri hears reliably.
3. Wire it to **Vocal Shortcuts** ("Pendant"), the **Action Button**, and **Back Tap**.
4. Add two automations: NFC tag on the desk → "start work session"; home Wi-Fi joins → switch the agent endpoint to the LAN address.
5. Set up the Emergency Bypass contact + Message automation as your escalation channel.

You now have a working hands-free voice remote with arbitrary command text, an escalation path, and physical triggers — and you have written zero lines of code. Live with it for a week. What still annoys you is your actual Phase 2 spec.

### Phase 2 — The four features that need the app (a few weekends)

Do the four blockers first, in one commit: deployment target 15.0 → 26.0, Keychain access group, privacy manifest entries, and add an App Group.

Then, in order:
1. **Push notifications with Approve/Deny/reply.** APNs ES256 signing in the Worker (WebCrypto), device token in the D1 `devices` table, `@capacitor/push-notifications` plus ~40 lines of Swift in `AppDelegate`. Time-Sensitive interruption level.
2. **App Intents in the main app target** — `RunMacCommandIntent`, `MacStatusIntent`, `CancelJobIntent`, `SpeakOnPendantIntent` — plus an `AppShortcutsProvider`. Put the Worker HTTP client and Keychain accessor in a Swift package conforming to `AppIntentsPackage` so the extensions can share it. Every intent must **enqueue and return**, never await the full transcribe→plan→execute chain: you get roughly 30 seconds.
3. **Widget Extension target** with a Control Center / Action Button control (one background "send," one `openAppWhenRun` "talk"), plus a small status widget reading the App Group.
4. **Background `URLSession`** replacing `fetch()` for any audio upload.

Commit the `project.pbxproj` changes carefully and re-verify after every `npx cap sync` — that's the most common place Capacitor projects lose hand-added targets.

### Phase 3 — The flagship, and the interesting long shots

1. **Live Activity with push-to-start.** The pendant fires; the Lock Screen shows the pipeline; Cancel and Approve are real buttons. `supplementalActivityFamilies([.small])` gets you the Watch and CarPlay free. Debounce updates hard on the Worker side.
2. **Secure Enclave + Face ID gate** on destructive commands, and **App Attest** replacing the bearer pairing key. Do these together — same plugin, same Worker-side crypto.
3. **iPhone Mirroring automation from the Mac agent.** Pure Node work, no iOS code, and it's the only route to "control an app on my phone." Prototype it against one app with an allowlist before generalizing.
4. Optional, if the phone becomes a real capture device: `SpeechAnalyzer` for on-device transcription, `UIBackgroundModes: audio` so a started recording survives lock.
5. Optional, cheap, high charm: `DataScannerViewController` for "point the camera at this and send it to my Mac."

**Distribution note:** don't accept the TestFlight 90-day re-upload treadmill. With your paid membership, a development-signed build installed from Xcode carries a profile valid for ~a year, runs without Xcode attached, and needs no upload and no review. Ad Hoc is likewise a year. Neither gives you automatic updates — that's the real tradeoff, not the 90 days. Development signing also sidesteps the privacy-manifest enforcement and any Apple-gated entitlement approval entirely.

---

**Two things to verify on device before you commit to designs that depend on them:** whether a background-launched App Intent inherits the app's Local Network permission (determines whether Siri can talk to the Mac over LAN or must go through Cloudflare), and whether the iPhone Mirroring window is reliably drivable by the Mac's accessibility stack on current macOS 26.x. Both are load-bearing and both are unverified.