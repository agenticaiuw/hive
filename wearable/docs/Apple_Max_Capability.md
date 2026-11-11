# Maximum-Capability Blueprint: iOS + watchOS + Mac for the Pendant Agent

Written for August 2026 — iOS/watchOS/macOS 26 shipping, 27 in public beta (GA ~mid-September). Assumes: your own devices, paid Apple Developer account, willingness to write Swift, internal TestFlight and/or development signing, no App Store review in the path.

---

## 1. Direct answers to what you named

| Capability | Where it runs | Verdict | One-line how |
|---|---|---|---|
| **Calendar — read/write/recurrence/geofenced alarms** | Phone (and Mac) | Works today, no approval | EventKit `EKEventStore.requestFullAccessToEvents()`; Info.plist `NSCalendarsFullAccessUsageDescription` |
| **Calendar — add an event with zero permission prompt** | Phone | Works today | EventKitUI `EKEventEditViewController` with a prefilled `EKEvent`; needs no auth and no plist key on the iOS 17+ SDK |
| **Reminders — full CRUD, alarms, location triggers** | Phone (and Mac) | Works today, no approval | Same `EKEventStore`, `requestFullAccessToReminders()`, `NSRemindersFullAccessUsageDescription` |
| **Reading email** | **Mac** (or Worker) | Works today | Mail.app's `~/Library/Mail/V10/MailData/Envelope Index` SQLite + `.emlx` bodies; needs Full Disk Access. ~1000× faster than AppleScript iteration |
| **Reading email — live trigger** | Phone | Works today, zero code | Shortcuts → Automation → Email trigger (Sender/Subject/Account/Recipient filters) → Get Contents of URL → your Worker. Exposes Subject, Sender, **Content** |
| **Reading email — provider API** | Worker | Works today (pick your provider) | Fastmail JMAP bearer token is the cheapest; iCloud IMAP with an app-specific password is next; Gmail read scopes are *restricted* and cost you CASA unless you use a Workspace-internal OAuth app |
| **Sending email — unattended** | Worker | Works today | Gmail `gmail.send` is only a *sensitive* scope (no CASA), or Resend/Postmark HTTP from the Worker, or Mail.app AppleScript on the Mac |
| **Reading notifications from other apps** | **Pendant over BLE**, or **Mac** | Works today (two routes) | ANCS — Apple's public GATT service `7905F431-…`, consumed by an nRF52840/nRF53 companion, gives AppIdentifier/Title/Message/Date with no app and no entitlement. Or: iPhone Mirroring forwards iPhone notifications to the Mac permanently, and `~/Library/Group Containers/group.com.apple.usernoted/db2/db` is readable with FDA |
| **Reading what's on the phone's screen in any app** | **Phone** | Works today, no entitlement | ReplayKit **Broadcast Upload Extension** (`RPBroadcastSampleHandler.processSampleBuffer`) — system-wide screen + app audio + mic, every third-party app. This is the one most people wrongly declare impossible |
| **Battery level (phone)** | Phone | Works today, trivial | `UIDevice.current.isBatteryMonitoringEnabled = true` then `.batteryLevel` / `.batteryState`. No permission, no plist key |
| **Battery level (watch / Mac / pendant)** | Watch / Mac / device | Works today | `WKInterfaceDevice.current().batteryLevel`; `pmset -g batt`; pendant already reports over LTE |
| **Sending iMessage/SMS — one tap** | Phone | Works today | `MFMessageComposeViewController` prefilled; the Send tap is drawn by a system remote view and cannot be automated |
| **Sending iMessage/SMS — zero tap** | **Mac** | Works today | `osascript` → Messages.app, from your real iMessage identity; SMS relay covers green bubbles |
| **Reading iMessage/SMS history** | **Mac** | Works today | `~/Library/Messages/chat.db` (SQLite, Full Disk Access) — the same iCloud-synced history the phone has, plus attachments |
| **Reading incoming SMS on the phone** | Phone | Works today, partial | Message Filter Extension (`ILMessageFilterQueryHandling` + `ILMessageFilterExtensionNetworkURL`) — unknown senders only, but that is exactly every OTP, bank alert, and delivery notice |
| **Reading incoming messages from known senders** | Phone | Works today, zero code | Shortcuts Message automation trigger, Run Immediately, POST to the Worker |
| **Photos — fetch, EXIF, GPS, smart albums, screenshots** | Phone | Works today | PhotoKit `PHPhotoLibrary.requestAuthorization(for: .readWrite)`, `PHAsset.fetchAssets`, `PHAssetCollection` smart album subtypes |
| **Photos — no permission prompt at all** | Phone | Works today | `PHPickerViewController` runs out of process; no auth, no plist key, full library visible |
| **Photos — search by person / by scene** | **Mac** | Works today | `osxphotos` over `Photos.sqlite` gives `photo.persons` (Apple's own face clustering, already named by you), `photo.labels` (Apple's scene classification), `photo.place`, `photo.search_info`. PhotoKit deliberately exposes no People/Places album |
| **Phone location without an app running** | **Mac** | Works today | `~/Library/Caches/com.apple.findmy.fmipcore/Items.data` — every device and AirTag's live location, no CoreLocation, no Always auth, immune to the iOS 26 geofence-relaunch regression |

The short version: **nothing you named is blocked.** Three of them (mail bodies, message history, cross-app notifications) are blocked *on the phone* and completely open *on the Mac*, and that's the architecture, not a workaround.

---

## 2. The architecture that unlocks everything

### The pattern

The Mac is not a fallback. It is a full-privilege, always-on peer that already holds Accessibility, Screen Recording, Full Disk Access, and Automation consent for System Events, Finder, Reminders, Calendar, Mail, and Notes. iOS is a sandbox; macOS is not. Every "iOS can't do that" has a macOS API that can, and the relay you already run is the transport.

The call path, concretely, using what's already in the repo:

```
pendant press / phone intent / watch tap
    → POST relay  (Cloudflare Worker, per-device scoped token)
    → Claude plans → emits tool_use blocks
    → each tool_use becomes a row in the D1 job queue
    → Mac agent long-polls GET /v1/bridge/work  (server.js:1350)
    → executes: EventKit / AppleScript / SQLite / shell / computer-use
    → POST /v1/pendant/jobs/:jobId/events with the result
    → relay pushes result to phone (APNs alert) / watch / pendant TTS
```

One thing to fix immediately: `server.js:1350` sleeps **800 ms** between claim attempts in the long-poll. That is a hard latency floor per tool hop, and it compounds — a five-step plan burns four seconds in polling alone. Either shorten it, move to a Durable Object with a WebSocket, or (better, see §6) run the agent loop *on the Mac* so there are no hops at all.

### What the Mac unlocks, specifically

**Reading iMessage and SMS.** `~/Library/Messages/chat.db`, opened read-only with the WAL present so you can poll while Messages runs. Three landmines that break naive readers:

1. `message.text` is NULL for most modern messages — the content lives in `message.attributedBody` as an NSAttributedString typedstream blob. On macOS this is universally true for outbound messages. Decode it (pytypedstream, or an NSString-marker + length-prefix parser).
2. `message.date` is **nanoseconds** since 2001-01-01 UTC on Apple Silicon: `datetime(date/1000000000 + strftime('%s','2001-01-01'),'unixepoch')`.
3. macOS 26 (Tahoe) changed `chat.guid` service prefixes from `iMessage;-;` to `any;-;`. Code that extracts the service from the GUID passes `any` to AppleScript and gets **error -1700**. Map `any` → `iMessage` before building the script.

Poll on `ROWID > last_seen` for a cheap change feed. Turnkey alternative if you'd rather not own this: BlueBubbles wraps chat.db as a REST API with webhooks and reports Tahoe working (its Private API tier needs SIP disabled; the plain REST tier does not).

**Sending iMessage and SMS, zero-tap.** `osascript -e 'tell application "Messages" to send "…" to participant "+1…" of account id "…"'`. Valid services: `iMessage`, `SMS`, `RCS`. Same `any;-;` bug applies. Add a delivery verification read-back from chat.db after each send — group-chat sends silently fail on Tahoe for some paths.

**Reading Mail.** The Envelope Index SQLite at `~/Library/Mail/V10/MailData/Envelope Index` (bump `V10` per OS generation) holds subjects, senders, recipients, mailbox/account joins, read and flag state, and message IDs. It's WAL-mode, so read-only access works while Mail runs. Bodies come from AppleScript (`get content of message id X`) or by reading `.emlx` files directly. Benchmark: ~500 messages in ~32 ms via SQL vs ~30 seconds via AppleScript iteration. This reads *every* account Mail has configured — iCloud, Gmail, Exchange — through one code path with no OAuth and no per-provider review.

**Reading cross-app notifications.** Two independent routes, and you should build both because their failure modes are uncorrelated:

- *iPhone Mirroring forwarding.* Once iPhone Mirroring has been set up, Apple's own documentation states the Mac keeps receiving iPhone notifications and Live Activities **even when Mirroring is not in use, and even when the iPhone is not nearby** — only powered on. Those land in the Mac's notification store: `~/Library/Group Containers/group.com.apple.usernoted/db2/db` (Apple moved it there in Sequoia specifically to put it behind TCC). Tables `app`, `record`, `delivered`, `requests`; `record.data` is a `bplist00` blob whose `req.titl` / `req.subt` / `req.body` carry the text. `plutil -convert xml1 -o -` is the easy decode.
- *ANCS on the pendant.* See §3 — it's better, but it's a board revision.

**Driving any iOS app.** iPhone Mirroring plus `CGEvent` injection from the Mac agent. Locate the mirroring window with `CGWindowListCopyWindowInfo`/ScreenCaptureKit, capture frames, inject HID-level mouse and keyboard events. Requires only Screen Recording + Accessibility, both of which you already have. Zero code on the phone. Two working precedents to copy: `mirroir-mcp` (OCR-based `describe_screen` returning tap coordinates) and `iphoneclaw` (CGWindowList → VLM → CGEvent with dHash memoization). Requirements: macOS 15+, iOS 18+, same Apple ID, passcode set on the iPhone.

Its two real costs, which matter for design: the Mac must be awake and unlocked, and **the iPhone is locked out locally while Mirroring is active** — you cannot use your phone while the agent looks at it. That makes it excellent for *actuation* and useless for *ambient observation*. Use the Broadcast Upload Extension (§3) for observation.

If you need a structured accessibility tree rather than pixels — deterministic, repeatable automations where OCR drift is unacceptable — the escalation is WebDriverAgent/XCUITest on a dev-signed device: `XCUIApplication(bundleIdentifier: "net.whatsapp.WhatsApp").launch()` drives any installed app plus SpringBoard. iOS 17+ requires a RemoteXPC tunnel (`go-ios tunnel start` or `pymobiledevice3 remote tunneld`). Higher operational cost; permanently forfeits App Store eligibility, which you've already accepted.

**Other iPhone-origin data sitting on the Mac already:**

| Data | Path | Why it matters |
|---|---|---|
| Phone + AirTag live location | `~/Library/Caches/com.apple.findmy.fmipcore/Items.data` | Replaces the whole CoreLocation-on-iOS plan for "where is Evan" |
| iPhone Safari history | `~/Library/Safari/History.db` (Mac absolute time, secs since 2001-01-01) | What you browsed on the phone |
| **iPhone's currently open tabs** | `~/Library/Safari/CloudTabs.db` | Highest-signal "what is he working on right now" input available, one SQL query |
| Voice Memos | `~/Library/Application Support/com.apple.voicememos/Recordings/*.m4a` | Stock app or a Shortcuts "Record Audio" action becomes a zero-code backup capture path |
| Screen Time / app usage | `~/Library/Application Support/Knowledge/knowledgeC.db` | With Screen Time "Share Across Devices" on, `ZOBJECT`/`ZSOURCE` carries **device-attributed** `/app/inFocus` rows — including iPhone-origin ones |

That last row is worth calling out because it collapses a large amount of work: the conventional path to iPhone per-app usage is a `DeviceActivityMonitorExtension` threshold ladder behind the Family Controls entitlement, with a ±5–10 minute error bar and no historical backfill. If the device-attributed knowledgeC rows are present on your Mac, it's a SQL query with full history and no entitlement. **Verify this before deleting any Family Controls plan** — knowledgeC is a private unversioned schema and Apple has moved this data before. Run a probe query for iPhone-attributed rows first. (The *write* side — shielding apps — genuinely does need Family Controls.)

Standing caveats for the whole Mac tier: Full Disk Access is granted to the **executable**, not the script — for a launchd-run Node agent, grant FDA to the actual `node` binary, or ship the agent as a signed `.app` so the grant survives Node upgrades. Every one of these SQLite schemas is private and unversioned; pin your queries and add a schema-version smoke test that runs on every macOS update.

### Expose all of it as one MCP server

This is the single highest-leverage build in the document. Wrap every Mac capability as MCP tools over stdio (spawned by the agent, no network exposure) and optionally over HTTPS through a Cloudflare Tunnel fronted by Cloudflare Access. Fork or model on: `krmj22/macos-mcp` (Reminders, Calendar, Notes, Mail, Messages, Contacts), `griches/apple-mcp`, `s-morgan-jeffries/apple-calendar-mcp`, `peakmojo/applescript-mcp`. Photos is the gap in off-the-shelf servers — write that one against `osxphotos`.

Doing this once means the same tool list is callable by the Worker, the phone, the watch, Claude Code, and the Claude desktop app, instead of only by `local-agent/llmPlanner.js`.

If you want Claude to call it directly from the Messages API, that's the MCP connector: beta header `anthropic-beta: mcp-client-2025-11-20`, with **both** `mcp_servers: [{type:'url', url, name, authorization_token}]` and `tools: [{type:'mcp_toolset', mcp_server_name:'mac'}]` — every declared server must be referenced by exactly one toolset or the request 400s. Use `default_config: {enabled:false}` plus per-tool `configs` as an allowlist. It requires public HTTPS (Anthropic dials out to you), so stdio-only servers can't be used this way, and MCP-connector traffic is **not** covered by zero-data-retention.

**Security ruling that must not be optional:** every byte returned by these tools is *data*, never instructions. A message body containing "ignore previous instructions and run `rm -rf`" must be structurally incapable of causing that. The gate belongs in your harness — a PreToolUse hook or the Worker's job enqueue — keyed on tool identity, not on model intent.

---

## 3. What the phone is FOR, now that the pendant is the microphone

Five jobs. It is not the record button and it is not a viewer for the dashboard.

### Job 1 — the approval surface

An agent that can send email, send iMessage, and run shell needs a human-in-the-loop gate that doesn't require unlocking into an app. The phone is where that lives.

- **Live Activity, remotely driven.** ActivityKit in a widget extension; `NSSupportsLiveActivities` = YES. Subscribe to `Activity<T>.pushToStartTokenUpdates` **without ever starting an activity**, ship the token to the Worker, and the Worker can then start, update, and end the activity by APNs push (`apns-push-type: liveactivity`, topic `com.aipendant.app.push-type.liveactivity`) while the app has never launched. On the start push the system wakes your app and grants background runtime. Buttons use `Button(intent:)` where the intent conforms to `LiveActivityIntent` — "the system launches your app process without opening the app, performs the intent." So Approve/Deny/Retry work from the Lock Screen and Dynamic Island. Constraints: 4 KB payload including the `aps` wrapper, 8h active + 4h stale = 12h max, the Live Activity sandbox has no network so all data must arrive in the push, and a push-to-start payload must include an `alert`.
- **Notification actions.** `UNNotificationCategory` with non-`.foreground` `UNNotificationAction`s handled in `didReceive` — the app launches *in the background*, never opens. Add `UNTextInputNotificationAction` and you can correct the agent by typing into a banner. Put `.authenticationRequired` on anything destructive.
- **AlarmKit for escalation.** iOS 26, `import AlarmKit`, Info.plist `NSAlarmKitUsageDescription` (missing or empty string = alarms silently cannot be scheduled), `AlarmManager.shared.requestAuthorization()`. Apple's own wording: an alarm "overrides both a device's focus and silent mode, if necessary." Its `stopIntent` and `secondaryIntent` take `LiveActivityIntent`s, so "Stop" can call the Mac agent from the Lock Screen. **This is the free replacement for the Critical Alerts entitlement**, which Apple grants essentially only to glucose monitors, patient monitoring, first responders, and severe weather — a personal agent will not clear that bar, so stop planning for it. AlarmKit must be scheduled *on device*; there is no push-to-alarm, so it needs a wake path first.
- **Time Sensitive** (`com.apple.developer.usernotifications.time-sensitive`) is a self-serve Xcode checkbox and breaks through most Focus modes. That's your default level for real agent alerts. Communication Notifications (`INSendMessageIntent` donated from the NSE) is the other free Focus-piercing route.

### Job 2 — reliable remote wake

**The ruling: never build the command channel on `content-available`.** Apple caps background pushes at roughly 2–3/hour, coalesces them, drops them in Low Power Mode, and — decisively — never delivers them to an app the user force-quit.

Instead: `apns-push-type: alert`, `apns-priority: 10`, `"mutable-content": 1`, into a **Notification Service Extension**, with `content.interruptionLevel = .passive` set inside the NSE. Apple DTS: the NSE "will be executed for every visible push notification," and it runs *even if the user force-quit the app*. `.passive` means no banner, no sound, no screen wake — the notification lands silently in Notification Center while your ~30 s / ~24 MB of code runs. Add `apns-collapse-id` so a chatty agent leaves exactly one row.

That is functionally the `com.apple.developer.usernotifications.filtering` entitlement — which Apple routinely rejects for non-messaging apps — obtained legitimately at the cost of one silent Notification Center row.

Secondary wake vectors, all uncorrelated, worth arming together with a shared correlation ID and a first-delivery ACK that cancels the rest:

- `EKAlarm` + `EKStructuredLocation` + `.proximity` — the Reminders daemon owns the geofence, so it fires with your app force-quit and costs your app no CoreLocation permission and no background budget.
- HealthKit background delivery on `.workoutType` at `.immediate` with a long-lived `HKObserverQuery` registered in `didFinishLaunchingWithOptions` — one of very few mechanisms that relaunches a *terminated* app on a real-world event.
- **iBeacon regions.** `startMonitoring(for: CLBeaconRegion(uuid:identifier:))` relaunches a terminated app on enter/exit like a geofence but at ~1 second latency, indoors, where GPS geofences don't fire. Your ANCS companion SoC can advertise as an iBeacon for free. Note two researchers report an iOS 26 regression where force-quit apps stopped being relaunched for *geographic* region entry — test whether `CLBeaconRegion` is affected identically before relying on it.
- **A Wallet pass.** See Job 3.
- **Self-hosted MDM.** The nuclear option, and it's available to an individual: the Apple Developer Enterprise Program is about in-house *distribution* and is irrelevant here. You need an APNs MDM push certificate from identity.apple.com with a CSR signed by an MDM-vendor cert (MicroMDM publishes a free public signing service precisely so individuals can do this), NanoMDM or MicroMDM running on the Mac behind the same tunnel, a SCEP server, and supervision via Apple Configurator (**which erases the iPhone**). What that buys with zero app code, immune to force-quit, reboot, and every background budget: `DeviceInformation` (battery, capacity, OS version), `DeviceLocation` (supervised, iOS 13+ — real coordinates on demand, no CoreLocation permission, no app running), `InstalledApplicationList`, `InstallProfile`, `DeviceLock`, `ScheduleOSUpdate`. Plus Declarative Device Management, where the *device* proactively pushes status reports when they change. It cannot read Messages, Mail, Photos, or notifications — it's control and telemetry, not content. Verify MicroMDM's cert-signing service is still live before committing; and put Cloudflare Access in front of a server that can lock and wipe your phone.

### Job 3 — ambient sensor and data source

The phone knows things the Mac cannot.

- **ReplayKit Broadcast Upload Extension.** File → New → Target → Broadcast Upload Extension. `RPBroadcastSampleHandler.processSampleBuffer(_:with:)` receives `.video`, `.audioApp`, and `.audioMic` sample buffers for the **entire device screen** — every third-party app, SpringBoard, notification banners. This is what Zoom and Discord use. No entitlement, no approval, standard extension target. Started once by the user via `RPSystemBroadcastPickerView` (set `.preferredExtension` to pre-select yours) or the Control Center screen-record long-press, and it then runs across app switches until stopped.

  Do the OCR *in the extension* (`VNRecognizeTextRequest`) and POST only text, so raw pixels never leave the device. **Hard 50 MB memory limit** — this is what kills naive implementations. Downscale to ~640 px in the vImage/CoreImage path, throttle to 0.5–1 fps, release buffers immediately, and link nothing heavy into the extension. DRM surfaces render black. There is a permanent red status pill and no way to hide it, which is correct — this sees your banking and password-manager screens, so build an app-identifier denylist derived from the OCR before you turn it on.

- **ANCS on the pendant** (not the phone, but it's the same observability problem). Service UUID `7905F431-B5CE-4E99-A40F-4B1E122D00D0`; Notification Source, Control Point, Data Source characteristics; retrievable attributes AppIdentifier, Title, Subtitle, Message, MessageSize, Date, plus positive/negative action labels you can invoke back. Nordic ships it first-class: `CONFIG_BT_ANCS_CLIENT`, `bt_ancs_client_init()`, `bt_ancs_register_attr()`, `bt_ancs_request_attrs()`, sample at `samples/bluetooth/peripheral_ancs_client`. Companion AMS gives now-playing metadata. Requires one-time BLE bonding. **The nRF9160 has no BLE radio** — this is a board-revision decision requiring an nRF52840/nRF53 companion, but the nRF9160-DK and Thingy:91 both carry an onboard nRF52840, so it's prototypable this week.

  ANCS + Broadcast Extension compose into complete phone observability with the Mac asleep: ANCS covers "phone is in my pocket, something arrived"; the broadcast extension covers "I'm actively looking at an app." Neither locks the phone. Neither needs the Mac. iPhone Mirroring then correctly demotes to a precision actuation tool.

- **Health and body state.** HealthKit capability (self-serve), `NSHealthShareUsageDescription` **and** `NSHealthUpdateUsageDescription` (missing either *crashes* on `requestAuthorization`). Sleep stages, HRV (`heartRateVariabilitySDNN`), resting HR, `appleSleepingWristTemperature`, `timeInDaylight`, workouts, and `HKStateOfMind` (iOS 18+, `.valence` −1…1, `.labels`) for zero-friction mood capture from the pendant. Critical asymmetry: `authorizationStatus(for:)` **never** reports denied *read* access — a denial is indistinguishable from "no data." Treat empty results as ambiguous.
- **CoreMotion, free and historical.** `CMPedometer.queryPedometerData(from:to:)` and `CMMotionActivityManager.queryActivityStarting(from:to:to:)` return the last ~7 days of step/distance and a `.stationary/.walking/.automotive/.cycling` timeline **without your app having run in the background at all**. `NSMotionUsageDescription` only.
- **Thermal and power.** `ProcessInfo.processInfo.thermalState`, `.isLowPowerModeEnabled`. Use these as backpressure: at `.serious` thermal or Low Power Mode, the relay should stop dispatching phone jobs entirely and route to the Mac. It also explains a whole class of "the agent went quiet" incidents. (Known deadlock: don't read `isLowPowerModeEnabled` inside its own change handler; cache it.)
- **Network policy.** `NWPathMonitor` → `path.isExpensive` / `.isConstrained`. On Wi-Fi, talk straight to the Mac at `localhost:8000` over the LAN — your Info.plist already has `NSLocalNetworkUsageDescription` and `NSBonjourServices` `_http._tcp`. On cellular, fall back to the relay.
- **Focus status.** `INFocusStatusCenter.default.focusStatus.isFocused` (Communication Notifications capability + `NSFocusStatusUsageDescription`). One boolean, but it's the boolean that decides whether the agent is an assistant or a nuisance: if focused, queue instead of interrupting.

### Job 4 — the notifier, before any Swift ships

**A Wallet pass.** This needs no app, no entitlement, no TestFlight build, and no App Review — just a Pass Type ID + certificate. Build a signed `.pkpass`, put `webServiceURL` + `authenticationToken` in pass.json, and implement the five Wallet Web Service endpoints on your existing Worker. To update, POST an empty payload to APNs using the *pass* certificate (topic = pass type identifier — a different auth path from your app's .p8), and the device calls back and pulls.

Fields that matter: `relevantDate` surfaces it on the Lock Screen near a time; `locations` (up to 10 lat/long) surfaces it on arrival — free geofencing with no CoreLocation permission and no app; `changeMessage` on a field produces a Lock Screen notification when the value changes.

So: a "Pendant Agent" pass showing `Status: Mac executing 3/5`, `Pending approvals: 2`, `Last answer: …`, on the Lock Screen and in the Watch's Wallet app, updated from the Worker, this week, with zero Swift and no dependency on your Capacitor build shipping. It's one-way — no buttons — but it's the fastest status surface in existence and it keeps working if the app is deleted.

### Job 5 — workflow trigger

Covered in §5, but the phone's unique contribution is the trigger inventory: NFC tags, Back Tap, Action Button, Control Center controls, the Focus change, the arriving message, the taken screenshot. See below.

---

## 4. The Apple Watch app

### Targets and project layout

Open `software/ai-pendant-simulator/ios/App/App.xcworkspace` → File ▸ New ▸ Target ▸ watchOS ▸ App. Xcode 26 creates a single watch app target (no separate WatchKit extension since watchOS 7).

| Setting | Value | Note |
|---|---|---|
| Watch app bundle ID | `com.aipendant.app.watchkitapp` | The `.watchkitapp` suffix is enforced by the toolchain and App Store Connect |
| Widget extension bundle ID | `com.aipendant.app.watchkitapp.widgets` | Second target: File ▸ New ▸ Target ▸ watchOS ▸ Widget Extension |
| `WATCHOS_DEPLOYMENT_TARGET` | `26.0` | Controls, `RelevanceConfiguration`, `WidgetPushHandler` are all 26.0 |
| `IPHONEOS_DEPLOYMENT_TARGET` | raise from **15.0** to **18.0** | Currently 15.0 in `project.pbxproj`. iOS Controls need 18, Live Activity watch mirroring needs 18, `WidgetPushHandler` needs 26 |
| Watch Info.plist | `WKApplication`=YES, `WKCompanionAppBundleIdentifier`=`com.aipendant.app` | Xcode writes these |
| | `WKRunsIndependentlyOfCompanionApp`=YES | Gives the watch its own APNs token and its own network stack |
| | `WKPrefersNetworkUponForeground`=YES | Measurably cuts first-request latency |
| | `NSMicrophoneUsageDescription` | The watch has its **own** privacy DB and prompt; the iOS string does not cover it |
| | `UIBackgroundModes: [audio]`, `WKBackgroundModes` as needed | See recording below |

Put watch sources in `ios/App/PendantWatch/` and `ios/App/PendantWatchWidgets/`, **outside** `ios/App/App/public`, so `npx cap sync` never touches them. Register both new bundle IDs as App IDs with their own provisioning profiles. The watch app is not a separate App Store Connect record — it rides inside `com.aipendant.app`.

**Capacitor gives you nothing here.** There is no WKWebView on watchOS at all, so the dashboard HTML cannot be reused. `Cap-go/capacitor-watch` is not a web runtime — it renders a fixed set of primitives from a JSON blob and locks you out of AVAudioRecorder, WidgetKit, App Intents, controls, and haptics. Write plain SwiftUI. The relay's JSON contract becomes the real interface between the two clients; consider promoting the shapes in `software/ai-pendant-contracts` to a small Swift package shared by the iOS and watch targets so they can't drift.

### Networking

`URLSession` on watchOS transparently picks the path: proxied through the paired iPhone over Bluetooth if reachable, direct over known Wi-Fi, or LTE on a cellular watch. Your code is identical in all three. That's why the watch can be a first-class relay client.

Two real-world gotchas. A freshly Xcode-installed independent watch app can come up with `Wifi policy: kDeny / Cellular policy: kDeny` and no network until the paired iPhone is rebooted (acknowledged Apple bug, no fix shipped) — symptom is "internet connection appears offline" on a watch that clearly isn't. And the watch commonly loses Wi-Fi the moment the iPhone leaves range. Set `waitsForConnectivity = true` on every request and make the Worker idempotent on retry.

### Credentials

**The watch keychain is a completely separate store.** It does not sync with the iPhone keychain, there is no cross-device keychain-sharing entitlement, and Apple Watch does not participate in iCloud Keychain. Your `PendantSecureStoragePlugin.swift` (service `<bundleid>.device-auth`) is invisible to it.

Do **not** ship the phone's bearer token to the wrist. Instead:

1. Watch launches, finds nothing in its keychain, shows "Pairing…".
2. Watch requests a short-lived pairing code from the phone via `WCSession.sendMessage` (if reachable) or `transferUserInfo` (queued). Use `transferUserInfo` — a guaranteed-delivery FIFO queue — not `applicationContext`, which keeps only the latest value and coalesces.
3. Watch calls `POST /v1/devices/pair` with `deviceType: 'watch'`, `deviceId` = `WKInterfaceDevice.current().identifierForVendor`, and the pairing code, minting its **own** `pdt_` token.
4. `SecItemAdd` with `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlock` so background tasks can read it.
5. On any 401, re-run the bootstrap automatically — unpair/re-pair wipes the watch keychain.

Relay change: `cloud-relay/deviceAuth.js` currently has exactly three keys in `DEVICE_SCOPES` (`mobile`, `mac_bridge`, `nrf_pendant`), with `SUPPORTED_DEVICE_TYPES` derived from it. Add:

```js
watch: ['device:heartbeat:self','device:status:read','speech:transcribe',
        'mac:plan','mac:execute','mac:jobs:read','pendant:event:write','state:read']
```

Check `cloudflare-worker/schema.sql` for a CHECK constraint on `device_type` before deploying.

### Voice trigger

Two input modes; ship both.

**Audio.** `AVAudioApplication.requestRecordPermission` (watchOS 10+; not the deprecated `AVAudioSession` variant) → `AVAudioSession.setCategory(.record)` → `AVAudioRecorder` with `kAudioFormatMPEG4AAC`, 16 kHz mono, ~24 kbps ≈ 3 KB/s, so 30 seconds is ~90 KB. Cap at 60 s. Upload via a background `URLSession` to `/v1/transcribe`, then `/v1/mac/plan`. Historically, a missing usage string made the watch record *silence* rather than error — if you get a valid file full of zeros, that's why.

`UIBackgroundModes: [audio]` (watchOS 4+) lets a foreground-started session survive a wrist drop mid-sentence. Be honest about the limit: Apple's wording for that mode is "play extended audio files," recording is on the soft edge of intent, and watchOS interruption handling is aggressive — after an interruption ends while backgrounded, you frequently **cannot** resume. Assume background resume is broken; post a local notification asking the user to reopen, and design so a truncated capture still uploads what it got.

**Text, and it's cheaper.** `TextFieldLink` (watchOS 9+) presents the system input sheet with Siri dictation and Scribble and hands you a `String`. No mic permission, no audio file, no upload, no Whisper cost. For "lock my Mac" or "what's on my calendar," this beats the audio round trip decisively.

`HKWorkoutSession` gives genuinely unbounded background runtime and is the only thing that does — but only one workout session exists system-wide (a real workout kills yours), it writes junk into Activity rings, and it burns battery hard. Put it behind an explicit "long capture mode" toggle, never the default path.

`WKExtendedRuntimeSession` has exactly four types with hard limits: self-care (frontmost, 10 min), mindfulness (frontmost, 1 hr), physical-therapy (background, 1 hr), smart-alarm (background, schedulable 36 hrs ahead, 30 min). Only the last two run in the background, only one per app, and a session can only be *started* from the foreground. The `alarm` type's `notifyUser(hapticType:repeatHandler:)` is the only watchOS API that can wake the watch at a chosen time and buzz repeatedly until acknowledged — and if you start an alarm session and never call `notifyUser`, watchOS warns the user and offers to disable your future sessions.

> **Unresolved, verify before designing the escalation tier:** whether AlarmKit is available on watchOS 26. Sources conflict and none cited an availability line. Check the `@available` annotations directly — `import AlarmKit` in a watchOS target, or grep the SDK `.swiftinterface`. If it's iOS-only, the wrist escalation path is the smart-alarm `WKExtendedRuntimeSession`, which is a materially different contract.

### Approve/deny — the highest-value watch surface

1. `WKApplication.shared().registerForRemoteNotifications()`; the watch gets its **own** APNs device token. Register it with the relay.
2. Worker pushes to `apns-topic: com.aipendant.app.watchkitapp` with a `category` in the payload.
3. Register `UNNotificationCategory("agent.approval")` with `APPROVE` / `DENY` actions — `.destructive` on DENY, `.authenticationRequired` on APPROVE for anything irreversible.
4. Rich long look: add `WKNotificationScene(controller: ApprovalNotificationController.self, category: "agent.approval")` to your `App` scene body; subclass `WKUserNotificationHostingController<ApprovalView>`, override `didReceive(_:)` to parse the payload and `notificationActions` to set buttons per-notification.
5. The action handler runs on the watch and POSTs the decision to the relay, unblocking the Mac agent. `.success` / `.failure` haptic on the outcome.

Keep it to two or three actions — more forces scrolling and the UX collapses. The system's Dismiss button is always appended and tapping it does **not** inform your app, so never treat dismissal as a deny. Send to the watch token explicitly rather than relying on phone→watch mirroring, which is a system routing decision.

Haptics: `WKInterfaceDevice.current().play(_:)` with `.start` on record begin, `.stop` on end, `.click` per pipeline stage, `.success`/`.failure` on outcome, `.notification` for a pending approval. Muted in Silent Mode with Taptic Chimes off, and in Theater Mode / Sleep Focus — never the only signal for anything critical.

### Complications, Smart Stack, Double Tap, Action Button

- **Complications are not optional infrastructure.** "Your app must have a complication on the active watch face to receive background execution time." No complication → effectively no background refresh budget → your background uploads and polling silently break. Build `accessoryCircular` / `accessoryRectangular` / `accessoryInline` / `accessoryCorner` early, reading last-known state from a shared App Group container. Gate rendering on `@Environment(\.isLuminanceReduced)` for always-on: drop color, animation, and anything sensitive (the agent's proposed shell command should not stay legible on a dimmed wrist in a meeting).
- **Smart Stack with RelevanceKit** (watchOS 26): `RelevanceConfiguration` + `RelevanceEntriesProvider` returning `WidgetRelevance([WidgetRelevanceAttribute(configuration:context:)])` with `RelevantContext` values — `.date(interval:kind:)`, sleep schedule, fitness state, MapKit POI categories. Return an **empty** array from `recommendations()` on watchOS 26+ for AppIntent-configurable widgets; relevance drives surfacing now.
- **Push-updating the complication.** `WidgetPushHandler` is available on watchOS 26. Conform a type, implement `pushTokenDidChange(_:widgets:)`, attach with `.pushHandler(MyHandler.self)` on the `WidgetConfiguration`, ship the token to the relay, and the Worker sends `apns-topic: com.aipendant.app.watchkitapp.push-type.widgets`, `apns-push-type: widgets`, body `{"aps":{"content-changed":true}}`. Budgeted by the system for battery — not a real-time channel. Anything that *must* reach you goes as a real notification.
- **Double Tap.** `.handGestureShortcut(.primaryAction)` on exactly one Button or Toggle in the frontmost scene (watchOS 11+, Series 9 / Ultra 2 and later). The system outlines the target so you can see what a double tap will hit. Bind it contextually: record button on the idle screen, and on an approval screen make it **open the detail**, not confirm — a stray gesture should not approve a destructive action.
- **Ultra Action Button.** On watchOS 26, build a native `ControlWidget`; users assign any control to the Action button directly. The pre-26 route required conforming to `StartWorkoutIntent`/`StartDiveIntent` — don't. (Long-press is permanently Emergency SOS.)
- **The free win, before any watch code exists:** any control already in the **iPhone's** Control Center gallery automatically becomes available on the Apple Watch — Control Center, Smart Stack, and Ultra Action Button — *even if there is no watch app*. So one `ControlWidget` added to the existing Capacitor iOS app (widget extension + an AppIntent that POSTs to `/v1/mac/plan`) gives you a wrist button days before the SwiftUI watch app is finished. Mirrored controls execute on the iPhone, so they fail when the phone is out of range, and they cannot record audio.
- **Live Activities mirror for free.** iOS Live Activities appear at the top of the watchOS 26 Smart Stack with zero work; add `.supplementalActivityFamilies([.small])` and read `@Environment(\.activityFamily)` to tailor the layout. Note the watch **cannot start** a Live Activity — ActivityKit isn't available on watchOS — so the phone must be present for that surface. Use a native Smart Stack widget as the phone-free equivalent.

### TestFlight

The watch app is embedded in the iOS `.ipa`; you upload one build of `com.aipendant.app` and the watch app rides along. Tester flow: install TestFlight on the **iPhone**, install the iOS app first, then open the app's TestFlight detail page and scroll to the Information section, where a compatible watch app shows an explicit Install button for Apple Watch.

**Internal testers (up to 100 App Store Connect team members — you're the account holder) get builds in minutes with no Beta App Review.** So the `audio` background mode, an `HKWorkoutSession` long-capture path, and anything else guideline 2.5.4 would flag ships to you without a reviewer ever seeing it. Both new bundle IDs must exist as App IDs with provisioning before upload validates. Builds expire after 90 days.

**Correction to a common claim: development signing is not "strictly more capable" than TestFlight.** The only thing it adds is `.development` entitlement variants — in practice just `com.apple.developer.family-controls.development`. Everything else (Push, Push to Talk, Location Push Service Extension, Time Sensitive, Communication Notifications, HealthKit, App Groups, Associated Domains, Broadcast Upload Extension, HomeKit, CloudKit) is a self-serve Xcode capability that works identically on internal TestFlight. Meanwhile dev-signed builds **stop launching** when the provisioning profile expires, with no over-the-air refresh — for an always-available agent endpoint that's a scheduled outage requiring you to be physically at your Mac with Xcode.

**Plan: internal TestFlight is the primary channel for everything, including the aggressive parts. A development-signed sibling bundle ID exists solely to carry Family Controls / ManagedSettings, and nothing else depends on it.** Restricted entitlements (Critical Alerts, notification filtering, Family Controls Distribution) are validated against the provisioning profile on *both* channels — dev signing cannot self-grant them. `PrivacyInfo.xcprivacy` is checked at upload even for internal TestFlight; you already have one at `ios/App/App/PrivacyInfo.xcprivacy`, extend it as you add extensions.

---

## 5. Workflows and automation

### The three layers and how they compose

**App Intents** is the RPC surface. One `struct DoThing: AppIntent` with `@Parameter` properties and `perform() async throws -> some IntentResult` automatically lights up: the Shortcuts app, Siri, Spotlight (including macOS 26 Spotlight Actions and Quick Keys), the Action Button, Back Tap, Control Center controls, widgets, Live Activities, Focus filters, and watchOS 26. No entitlement, no plist key. SiriKit was formally deprecated at WWDC26 with a 2–3 year runway, so this is the only Siri path now.

Model your data as `AppEntity` + an `EntityQuery` so the system can resolve objects by name. `AppShortcutsProvider` declares up to 10 phrases containing `\(.applicationName)`. Put intents in an **App Intents Extension** target so Siri/Shortcuts execute in a lightweight process and never spin up the Capacitor WebView — and conform a shared framework or SPM package to `AppIntentsPackage` so app, App Intents extension, and widget extension share one definition.

Prerequisite most people hit: intents and widgets run in *separate processes* from your app. Add a `keychain-access-groups` entitlement and set `kSecAttrAccessGroup` on the pairing credential, or every intent and extension gets `errSecItemNotFound`.

`@AssistantIntent(schema: .mail.sendDraft)` and friends constrain an intent to an Apple-defined shape so Apple Intelligence routes semantically rather than by exact phrase. On iOS 27, App Intents 2.0 adds streaming responses, multi-turn follow-ups, and on-screen awareness, plus `LongRunningIntent` with `performBackgroundTask(work:onCancel:)` that breaks the 30-second ceiling and renders progress as a Live Activity for free.

**Shortcuts** is the only Apple-blessed way to make your app drive *another* app. One app cannot invoke another app's AppIntent — Apple DTS is explicit and there is no cross-app `perform`. But a user-authored Shortcut can contain any installed app's donated actions, and you invoke it with `shortcuts://x-callback-url/run-shortcut?name=NAME&input=text&text=…&x-success=pendant://done`, getting the shortcut's textual output back as a `result=` parameter. Note `OpenURLIntent` accepts only Universal Links, not `shortcuts://`, so a widget or Live Activity button must route through a `pendant.<yourdomain>/x/…` universal link into your app first. Serve `/.well-known/apple-app-site-association` from your Worker (you already own the origin) and add `applinks:` to `com.apple.developer.associated-domains`.

**Personal automations** are the triggers. Full iOS 26 inventory: Time of Day (incl. sunrise/sunset ±15m–4h), Alarm (snoozed/stopped), Sleep (wind down / bedtime / waking), Apple Watch Workout start/end, Sound Recognition, **Email**, **Message**, Apple Pay Transaction, Wi-Fi, Bluetooth, Focus on/off, Low Power Mode, Airplane Mode, Battery Level, Charger, NFC tag, App Opened/Closed, Arrive/Leave/Before I Commute/CarPlay. Most support **Run Immediately**; location triggers still force confirmation. macOS 26 finally gained automations too (folder change, external drive, Wi-Fi, display, app launch), and `shortcuts run "Name" -i in -o out` means your Express agent can run any shortcut from bash today.

**The banner problem, and the fix.** Since iOS 17, choosing Run Immediately *removes* the "Notify When Run" toggle and forces a banner every single time. That's the fatal flaw of a Shortcuts-based control plane — and **HomeKit routes around it.** HomeKit automations execute on the **home hub** (HomePod / Apple TV), 24/7, with your phone off or absent, and **without a banner**. Run a HAP bridge on the Mac agent (`hap-nodejs` or Homebridge — a natural sibling to the Express server on :8000) exposing virtual switches named "Focus Mode," "Run Morning Brief," "Approve Pending Action." Those switches appear in the Home app, on the Watch, in Control Center, to Siri on any HomePod, and as HomeKit automation triggers. So: **Mac flips its own virtual switch → hub fires a Home automation → which runs a Shortcut → silently, with no phone in the loop.** Inbound, presence/motion/contact/temperature sensors become real-world context for the planner. `HMHomeManager` is asynchronous and famously returns an empty home list on first access — always wait for `homeManagerDidUpdateHomes(_:)`.

Third-party force multipliers worth installing: **Scriptable** (arbitrary ES6 with its own x-callback-url, for logic Shortcuts can't express — request signing, JSON manipulation), **Pushcut** (Automation Server on a spare device exposes `https://api.pushcut.io/{secret}/execute?shortcut=Name`, turning "the Worker wants the phone to do X" into a plain HTTPS POST), **Data Jar** (persistent state across runs), **Actions**.

### Twelve workflows worth building

1. **Screenshot → memory.** Screenshot-taken automation → Get Contents of URL → Worker → Vision/Claude OCR → context graph. Two actions, no Swift, no entitlement. Screenshots are what you already decided were worth remembering, so this populates the agent's memory before any native work lands. *(Version-verify: sources disagree whether the screenshot trigger is a 26.x point release or 27; open Shortcuts and check.)*
2. **Inbound mail trip-wire.** Email automation filtered on your five highest-value senders → POST sender + subject + **content** to the Worker → D1. This is the entitlement-free answer to "read my email on the phone."
3. **Inbound message feed.** Message automation (blank Sender matches all) → POST to Worker. Combined with the Message Filter Extension (unknown senders, real-time, no user action, `ILMessageFilterExtensionNetworkURL` pointing at your Worker with a valid TLS cert), you get near-complete incoming coverage on the phone — the filter extension handles OTPs and short codes, this handles people.
4. **Silent Mac→phone command channel.** Mac flips a virtual HomeKit switch → hub automation → Shortcut → Get Contents of URL / App Intent. No banner, no push infrastructure, phone-independent. (The older iMessage-token trick — Mac texts your own number, a Message automation matches the token — works too and needs no hub, but banners on every fire.)
5. **Morning brief.** Managed Agents cron deployment (§6) or a launchd job on the Mac at 06:55 → reads Calendar + Envelope Index + HealthKit sleep from the phone's last sync → drafts the brief → 07:00 Time of Day automation on the phone runs Get Contents of URL and Speak Text; simultaneously updates the Wallet pass and the watch complication.
6. **Arrive-at-desk work session.** iBeacon on the desk → ~1 s app relaunch → POST arrival → Mac agent closes Slack, opens the repo, sets Focus; Focus-turning-on automation confirms back to the Worker. GPS geofences cannot do this indoors.
7. **Geofenced reminder as an OS-enforced trigger.** Pendant: "remind me to grab the charger when I leave the office" → `EKReminder` + `EKAlarm` with `EKStructuredLocation` and `.proximity = .leave`. The Reminders daemon owns the geofence; it fires with your app force-quit and costs you nothing. Your app needs no CoreLocation permission at all.
8. **Zero-tap send with a review sheet.** Pendant: "text Sarah I'm running 20 late" → Worker plans → if `risk: high` push an alert with the drafted text and a Live Activity Approve button; on approve, the **Mac** sends it via Messages AppleScript from your real identity. One tap, or zero if you pre-authorize that contact.
9. **Prefilled calendar sheet as the approval UI.** Pendant: "dinner with Sam Friday 7pm" → push → tap → `EKEventEditViewController` opens with the event prefilled. No permission prompt, no entitlement, one plugin method, and the human-in-the-loop step is Apple's own sheet.
10. **NFC control surface.** Tag on the desk = "start work session." Tag in the car = "flush today's transcripts and read me the summary." Write the tags from your own app with `NFCNDEFReaderSession` + `tag.writeNDEF` (self-serve `com.apple.developer.nfc.readersession.formats` capability), and make the NDEF URI a Universal Link on your Worker domain so background tag reading works from the Lock Screen with the app not running.
11. **Low-power backpressure.** Battery Level Falls Below 20% automation → POST to Worker → relay stops dispatching phone jobs and routes everything to the Mac; pendant announces the handoff. Same rule keyed on `thermalState == .serious`.
12. **On-device triage before spending a token.** Message or Email automation → Shortcuts `Use Model` (On Device) with a schema-constrained output classifying urgency → only escalate to the Worker/Claude when it matters. Free, offline, and it cuts your API bill on the highest-volume trigger.

---

## 6. AI services — where each piece of intelligence runs

### Does the Claude API help? Yes, in four specific places.

**1. The planner, in the Worker.** `POST https://api.anthropic.com/v1/messages`, headers `x-api-key` + `anthropic-version: 2023-06-01`. Current models: `claude-opus-5` $5/$25 per MTok, `claude-sonnet-5` $2/$10 introductory through 2026-08-31 then $3/$15, `claude-haiku-4-5` $1/$5. All 4.6+ models have a 1M context window at standard pricing. Use `thinking: {type: 'adaptive'}` with `output_config: {effort: 'low'|'medium'|'high'|'xhigh'|'max'}` — `budget_tokens`, `temperature`, `top_p`, `top_k` are **removed** on Opus 5 / Sonnet 5 and return 400.

Your existing `local-agent/llmPlanner.js` points at an OpenAI-compatible endpoint (`LLM_API_BASE_URL` defaults to `api.openai.com/v1`, `LLM_MODEL` to `deepseek/deepseek-v4-flash-0731`, vision to `google/gemini-3.6-flash`). Its `FULL_CONTROL_ACTION_SCHEMA` is already exactly the shape of a Claude `tools` array — porting is a client swap plus renaming `input_schema`, not a redesign. One 1M-context model does both planning and screenshot vision, collapsing the two-model split.

Two traps: models 4.7+ use a newer tokenizer producing ~30% more tokens for the same text, so re-baseline any budget with `/v1/messages/count_tokens`. And on Opus 5 thinking is **on by default** and `max_tokens` caps thinking plus response text together — a `max_tokens` sized for a short answer can truncate mid-response.

**2. The agent loop, on the Mac.** `@anthropic-ai/claude-agent-sdk` is Claude Code as a library: built-in Read/Write/Edit/Bash/Glob/Grep tools, the loop, context compaction, subagents, hooks (`PreToolUse`, `PostToolUse`, `SessionStart`, …), permission modes, and MCP client support via `mcpServers`. Locked-down headless pattern is an explicit `allowedTools` list plus `permissionMode: 'dontAsk'`.

This is the natural replacement for the hand-rolled `orchestrator.js` + `planner.js` + `executor.js` + `jobControl.js` stack, and **running the loop on the Mac eliminates the 800 ms-per-hop relay penalty entirely** — the Worker's job becomes "deliver the transcript, stream the result back," one round trip instead of N. `PreToolUse` hooks are exactly where the iOS approval push belongs. Cost note: Opus 5 delegates to subagents more readily than 4.8; cap spawn count explicitly in the system prompt.

**3. Directly from the phone, with no key in the binary.** `ClaudeForFoundationModels` (SPM: `https://github.com/anthropics/ClaudeForFoundationModels.git`) conforms Claude to Apple's `LanguageModel` protocol, so `ClaudeLanguageModel(name: .opus5, auth: .appAttest(clientID: "clid_…"), fixedEffort: .xhigh, serverTools: [.webSearch(maxUses: 5)])` drops into a normal `LanguageModelSession` alongside `respond(to:)`, `streamResponse(to:)`, and `@Generable` guided generation. App Attest means you register team ID + bundle ID in the Anthropic Console and ship a public `clid_` — no key in the binary, no proxy hop, device-bound credentials.

**But it is OS 27 only** (public beta now, GA ~mid-September), with no iOS 26 fallback path in the package. On iOS 26 today you call the Messages API with plain `URLSession`. Also, Apple's provider protocol can't express prompt-caching controls, stop sequences, Batch, Files, token counting, or beta headers — so **no MCP connector through this package**. `.proxied(headers:baseURL:)` pointed at your Worker is the today-compatible fallback.

**4. Server tools.** `{type: 'web_search_20260209'}` and `{type: 'web_fetch_20260209'}` give current information with no Mac involvement. Web search is $10/1,000 searches; **web fetch is free** beyond tokens; code execution is free when used with either. Do **not** separately declare `code_execution` alongside the `_20260209` search variants — they run it internally for result filtering and two execution environments confuse the model. Set `max_content_tokens` on fetch (a 100 kB doc page is ~25,000 tokens). Server-tool errors return **HTTP 200** with an error object inside the result block; and long turns can return `stop_reason: 'pause_turn'`, which the SDK tool runners do **not** auto-resume — a paused turn silently ends the loop with a truncated answer.

What Claude buys you in iOS *capability* terms: **zero**. It cannot read Messages, notifications, or photos, and grants no entitlements. Its value is planning, vision, and language — the permissions come from where the code runs.

### Cost levers, in order of impact

| Lever | Mechanism | Effect |
|---|---|---|
| **Prompt caching** | `cache_control: {type:'ephemeral'}` | Cache read is **0.1×** base input. Your Mac tool schema + `machineContext.js` block is the frozen prefix. Break-even at two requests on the 5 m TTL |
| Batch API | `POST /v1/messages/batches` | Flat **50% off** input and output; stacks with caching. Nightly transcript summarization into `contextGraph`/`projectMemory` should never run at interactive prices |
| Effort dial | `output_config: {effort: …}` | Opus 5 at `low`/`medium` is unusually strong; reserve `xhigh` for Mac-side agentic runs where nobody is waiting |
| Free on-device | Apple `SystemLanguageModel` | Triage and formatting at zero cost |
| Free transcription | `SpeechAnalyzer` on the Mac | Deletes the Whisper line item entirely |

Caching detail that will bite you: it's a strict **prefix** match, rendered `tools` → `system` → `messages`. The minimum cacheable prefix is model-dependent and **not monotonic** — 512 tokens on Opus 5, 1024 on Opus 4.8 / Sonnet 5, 2048 on Opus 4.7, 4096 on Opus 4.6 and Haiku 4.5 — and below the minimum it silently doesn't cache with no error. Verify with `usage.cache_read_input_tokens`; zero across identical-prefix requests means a silent invalidator. The invalidator to hunt for here is a **timestamp**: if `getMachineContext()` interpolates a clock reading ahead of the tool list, you pay full price on every single pendant press. Tools render at position 0, so adding, removing, or reordering a tool invalidates everything — serialize tools deterministically, sorted by name.

### Where each AI capability should run

| Capability | Runs where | Why |
|---|---|---|
| Utterance classification, triage, "is this urgent" | **Phone**, Apple `SystemLanguageModel` | Free, offline, zero latency. 4,096-token context covering input **and** output combined (~3,000 words) — this is the binding constraint. Requires iPhone 15 Pro+, iOS 26, Apple Intelligence on. Training cutoff Oct 2023, no world knowledge; rate-limited in the background and on battery, and Apple recommends one-shot `respond` over streaming there |
| Result summarization for TTS | **Phone** on-device, or `PrivateCloudComputeLanguageModel` on OS 27 | PCC is 32K context, a real reasoning model (`ContextOptions(reasoningLevel: .light/.moderate/.deep)`), **free to you** — metered against the *user's* iCloud account. Needs a self-serve-ish Apple approval (granted under 2M downloads) and requires network, so always wire a `SystemLanguageModel` fallback |
| Transcription of pendant audio | **Mac**, `SpeechAnalyzer` + `SpeechTranscriber` | iOS/macOS 26, no entitlement, on-device, 2.12% WER on LibriSpeech clean — beats Whisper Small on both speed and accuracy, at zero marginal cost. This deletes the relay's Whisper job and its bill. Needs `NSSpeechRecognitionUsageDescription` (missing string = hard crash) and a first-run language-asset download. **Not available on watchOS** |
| Planning / tool selection | **Worker** or **Mac**, Claude Opus 5 | Mac if you adopt the Agent SDK (no relay hops); Worker if you want to own the request shape and use the MCP connector |
| Screenshot / GUI vision | **Mac**, Claude Opus 5 | Opus 5 is in the high-resolution vision tier (2576 px long edge) with coordinates mapping **1:1 to actual pixels** — which lets you delete the normalization math in `local-agent/coordinates.js` that exists to work around Gemini's 0-999 space. Send screenshots at 1080p for the best cost/quality balance; full-res on 4.7+ can hit ~4,784 tokens each |
| Nightly memory consolidation | **Worker**, Batch API | 50% off, nobody waiting |
| Scheduled autonomous runs | **Anthropic Managed Agents** | `POST /v1/agents` once, then `POST /v1/deployments` with a cron schedule. Tokens at standard rates plus $0.08 per session-*hour* of running time (idle is free). Beta header `managed-agents-2026-04-01`. Caveats: execution is jittered up to 15% of the interval (capped at 9 minutes), rate-limited runs are recorded and **not retried**, and archiving an agent is permanent |
| Structured output for the job queue | **Worker** | `output_config: {format: {type:'json_schema', schema}}`, or `strict: true` on tool definitions with `additionalProperties: false`. Schema subset: no recursion, no numeric or string-length constraints. Check `stop_reason == 'max_tokens'` — truncated JSON is invalid JSON |

### One intent catalog, seven consumers

You already have `local-agent/actionRisk.js` and `local-agent/undo.js` — risk classification and reversibility are modeled, but only inside the Mac's executor where no user-facing surface can see them.

Promote `FULL_CONTROL_ACTION_SCHEMA` out of `llmPlanner.js` into a shared, versioned artifact, with `risk` and `reversible` as first-class fields. Then every surface inherits gating automatically:

- **Claude tool schema** — destructive operations get split out of the opaque `run_shell` string into named tools. You cannot gate on a shell command string; you can gate on `send_imessage(recipient, body)`.
- **Swift `AppIntent` definitions** — generated, so Siri/Spotlight/Shortcuts/Watch all stay in sync.
- **MCP tool definitions** for the Mac server.
- **Live Activity** — renders Approve/Deny only for `risk: high`.
- **Watch notification category** — attaches `.authenticationRequired` to destructive actions.
- **AlarmKit `secondaryIntent`** — populated only for escalation-worthy entries.
- **Broadcast-extension OCR uploader** and the **MDM/DDM command allowlist** — generated from the same denylist.

The failure mode this prevents is the most likely way this system does something you didn't want: a destructive action that skipped the human gate on one surface but not another. Keep intent and parameter names stable — they're simultaneously a Siri phrase surface, a Claude tool schema (renames invalidate prompt caches, since tools render at cache position 0), and a persisted job-queue format.

---

## 7. Genuinely impossible, and the nearest thing that works

| Impossible on iOS | Nearest thing that works |
|---|---|
| Reading the Messages database from an app | Mac reads `~/Library/Messages/chat.db` — the same iCloud-synced history, plus attachments, plus write access via AppleScript |
| Reading Mail bodies from an app (no iOS MailKit exists — don't look for the entitlement) | Mac reads the Envelope Index + `.emlx`; or Shortcuts Email trigger for live content; or JMAP/IMAP/Graph from the Worker |
| A notification-listener API (`UNUserNotificationCenter` is scoped to your own bundle; `usernotifications.filtering` only *suppresses* your own) | ANCS on the pendant over BLE — full body text, no app, no entitlement. Or the Mac's `usernoted` DB fed by iPhone Mirroring forwarding. Or (iOS 27) the Shortcuts notification-received automation |
| Sending iMessage/SMS with zero taps from the phone | Mac `osascript` to Messages, from your real identity. Or a Shortcuts Send Message action inside an automation with Ask Before Running off |
| Programmatically invoking another app's AppIntent | A user-authored Shortcut containing that app's action, run via `shortcuts://x-callback-url/run-shortcut` with `x-success` return |
| Injecting into another app's process, reading its container, or a system-wide accessibility API | Ladder: (1) its App Intents via Shortcuts; (2) its URL scheme (`LSApplicationQueriesSchemes` caps at 50 entries — budget them); (3) Scriptable + Pushcut; (4) **custom keyboard with Full Access** — the only in-process foothold Apple grants, giving `textDocumentProxy.documentContextBeforeInput/AfterInput` to *read* the draft and `insertText` to write it back, in any app; (5) Voice Control custom gestures (voice-triggered only); (6) **iPhone Mirroring + CGEvent from the Mac**; (7) WebDriverAgent/XCUITest on a dev-signed device for a structured tree |
| Photos search by person (no `PHAssetCollectionSubtype` for People/Places, and there never has been) | `osxphotos` on the Mac: `photo.persons` gives Apple's own clustering with the names you already assigned, `photo.labels` gives Apple's scene classification, both already computed over the whole library. Or `PHPickerViewController`, whose search field searches by person name, for a one-tap human-in-the-loop |
| Reading Screen Time usage from `DeviceActivityReport` (its extension sandbox blocks network, App Group writes, and notifications — intentionally) | Mac's `knowledgeC.db` with device-attributed rows (verify first). Failing that, `DeviceActivityMonitorExtension` threshold ladders — but only if the knowledgeC route doesn't pan out |
| Journaling Suggestions as a data source (`com.apple.developer.journal.allow` gives you only what the user hand-picks in a system picker) | Reconstruct it: PhotoKit creationDate window + `CLVisit` + HealthKit workouts + `MusicRecentlyPlayedRequest` gets ~80%, fully programmatically, using frameworks you need anyway |
| Cold-starting audio recording on the phone from a backgrounded intent (iOS 26's `AudioRecordingIntent` can only pause/resume a foreground-started session) | This is exactly why the pendant exists — it owns the mic and the button. Watch backup: foreground-started `AVAudioRecorder` under `UIBackgroundModes: [audio]` |
| Critical Alerts entitlement for a personal assistant | **AlarmKit** — same audible effect through the mute switch and Focus, zero approval |
| `content-available` as a reliable command channel | `.passive` alert push into a Notification Service Extension — force-quit-proof, unthrottled, one silent Notification Center row |
| Starting a Live Activity from the watch (ActivityKit has no watchOS availability) | Watch → relay → push to the phone, which starts it; or a native watchOS Smart Stack widget driven by `RelevanceConfiguration` + `WidgetPushHandler`, which occupies the same real estate and works phone-free |
| Foundation Models on watchOS 26 | Doesn't exist there. Watch talks HTTPS to the Worker; all intelligence is remote. Changes in watchOS 27 with PCC and `ClaudeLanguageModel` |
| A developer API for the watchOS 26 wrist-flick gesture | Deliberately none — a flick inside an app would clear the app. Double Tap (`.handGestureShortcut(.primaryAction)`) is the only app-addressable gesture. Free consolation: flick already dismisses agent notifications system-wide |
| Deriving app names from Screen Time `ApplicationToken`s | The tokens are opaque by design. Label them once by hand via `FamilyActivityPicker`, or use knowledgeC on the Mac, which has real bundle IDs |

---

## 8. Build order

### Phase 1 — no Swift required, or nearly none

Deliverables:

1. **Mac MCP server** wrapping Calendar (EventKit), Reminders, Notes, Mail (Envelope Index), Messages (chat.db read + AppleScript send, with the `any;-;` fix and the attributedBody decoder), Photos (`osxphotos`), Find My (`Items.data`), Safari `CloudTabs.db`, knowledgeC, and shell. Grant Full Disk Access to the actual `node` binary or ship the agent as a signed `.app`.
2. **Promote the intent catalog** out of `llmPlanner.js` into a shared versioned artifact with `risk` and `reversible` fields; split destructive operations out of `run_shell` into named tools.
3. **Port the planner to Claude** (`claude-opus-5`, adaptive thinking, `effort: medium` for interactive turns), with prompt caching on the tool schema + machine context. Verify `cache_read_input_tokens > 0`.
4. **Move transcription to `SpeechAnalyzer` on the Mac.**
5. **Wallet pass** with a Worker-hosted web service — agent status on the Lock Screen and in the Watch's Wallet app.
6. **Shortcuts automations**: screenshot → OCR pipeline; Email trip-wire; Message feed; battery/thermal backpressure; morning brief at 07:00.
7. **HomeKit HAP bridge** on the Mac with virtual switches, for the banner-free Mac→phone trigger channel.
8. **Fix the 800 ms long-poll** in `server.js:1350`, or adopt the Agent SDK on the Mac so it stops mattering.

What you can newly do: read your full iMessage and Mail history and send iMessages by voice from the pendant, anywhere; search photos by person and by Apple's scene labels; know where your phone is without any app; see agent status on your Lock Screen and wrist; get every screenshot and every important email into the agent's memory automatically; stop paying for Whisper.

### Phase 2 — the native iOS app becomes real

Prerequisites: raise `IPHONEOS_DEPLOYMENT_TARGET` 15.0 → 18.0, create an `.entitlements` file (there is none today), add `keychain-access-groups` with `kSecAttrAccessGroup` on the pairing credential, and extend `PrivacyInfo.xcprivacy`. Commit the `.xcodeproj` and re-verify after every `npx cap sync` — Capacitor does not manage extension targets or entitlement edits.

New targets: Notification Service Extension, Widget Extension (Live Activities + Controls), App Intents Extension, Broadcast Upload Extension, Message Filter Extension. Capabilities (all self-serve): Push Notifications, Time Sensitive Notifications, Communication Notifications, Associated Domains (`applinks:` + `messagefilter:`), App Groups, HealthKit, HomeKit, NFC Tag Reading.

Deliverables:

1. **APNs from the Worker.** Workers' Web Crypto does ECDSA P-256 natively: `crypto.subtle.importKey('pkcs8', der, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign'])`, sign `{alg:'ES256', kid}` + `{iss: teamID, iat}`, POST to `api.push.apple.com`. Cache the JWT (valid 1 h) and never regenerate more than once per ~20 min or you get `TooManyProviderTokenUpdates`. Note sandbox vs production tokens are not interchangeable — Xcode debug builds get sandbox, TestFlight gets production.
2. **The `.passive` alert-push + NSE wake path** as the canonical relay→phone channel, with `apns-collapse-id`.
3. **Live Activity** with push-to-start, `LiveActivityIntent` Approve/Deny buttons, and `.supplementalActivityFamilies([.small])`.
4. **AlarmKit** for the one or two things that genuinely warrant escalation, with `stopIntent` wired back to the relay.
5. **EventKit plugin** (calendar + reminders CRUD, recurrence, `EKStructuredLocation` geofenced alarms) and the zero-permission `EKEventEditViewController` confirmation sheet. Watch the iOS 17 trap: if Info.plist has only the legacy `NSCalendarsUsageDescription`, iOS **silently auto-denies** with no prompt.
6. **App Intents** — `AskPendant(text:)`, `RunMacCommand(command:)`, `GetPendantStatus()` — plus one `ControlWidget`, which immediately gives you a wrist button via mirroring with no watch app.
7. **Broadcast Upload Extension** with in-extension Vision OCR, 50 MB-safe downscaling, and an app-identifier denylist.
8. **Message Filter Extension** for OTPs and unknown senders.
9. **PhotoKit + HealthKit + CoreMotion + battery/thermal** reporting into the relay heartbeat.

What you can newly do: approve or deny any agent action from the Lock Screen without unlocking; get a reliable, force-quit-proof relay→phone channel; have the agent see what's on your phone screen in any app; capture every OTP and bank alert automatically; ground the morning brief in sleep and HRV; get an unmissable alert through silent mode and Focus; create OS-enforced location reminders by voice.

### Phase 3 — the wrist, and the aggressive tier

1. **watchOS 26 app** per §4: independent, own `pdt_` token minted via `/v1/devices/pair` with the new `watch` scope, record button with `.handGestureShortcut(.primaryAction)`, `TextFieldLink` for the low-latency text path, background `URLSession` uploads, `.accessoryCircular` complication **built early** (it buys the background budget), `RelevanceConfiguration` Smart Stack widget, `WidgetPushHandler` driven by the Worker, and the `agent.approval` notification category with a `WKUserNotificationHostingController` long look.
2. **ANCS companion SoC** on the pendant (nRF52840/nRF53), prototyped on the nRF9160-DK's onboard nRF52840, using Nordic's `peripheral_ancs_client` sample — every notification from every app, arriving in your ear.
3. **iBeacon** advertising from the same companion, for ~1 s indoor proximity wake.
4. **iPhone Mirroring + CGEvent** on the Mac as the actuation tool for apps with no API, reusing `computerUseLoop.js` and Claude Opus 5's 1:1 pixel coordinates (delete `coordinates.js`'s normalization).
5. **OS 27 migration** when it ships (~mid-September): `ClaudeForFoundationModels` with `.appAttest` so the phone and watch call Claude directly with no key and no relay hop; `PrivateCloudComputeLanguageModel` as the free 32K reasoning tier; `LongRunningIntent`; Foundation Models on watchOS.
6. **Optional, in order of blast radius:** development-signed sibling bundle for Family Controls / ManagedSettings shielding; self-hosted NanoMDM behind Cloudflare Access for OS-level telemetry and location (accepting the device erase); WebDriverAgent for deterministic third-party app automation.

What you can newly do: talk to the agent from your wrist with the phone in another room and approve its actions with a double tap; hear the one notification out of forty that matters, from any app, while the phone stays in your pocket; drive apps that have no API; run the whole intelligence layer with model selection as a runtime policy across on-device, PCC, and Opus 5.

---

### Two things to verify before you build on them

- **knowledgeC device attribution.** Run a probe query for iPhone-attributed `/app/inFocus` rows on your Mac with Screen Time "Share Across Devices" on. If present, the entire Family Controls read-side plan is unnecessary. Private unversioned schema — pin queries, add a version guard.
- **AlarmKit on watchOS 26.** Check `@available` in the SDK directly. It determines whether the watch is an independent escalation endpoint or a mirror of the phone's alert, which changes the wrist design.

Lower-confidence items flagged in the research and worth a quick empirical check rather than a design commitment: the current macOS 26 paths for `Items.data` and Voice Memos recordings; MicroMDM's free vendor-cert signing service; whether the iOS 26 force-quit relaunch regression applies to `CLBeaconRegion` as well as `CLCircularRegion`; and whether the Shortcuts screenshot and notification triggers are on your installed OS version or still 27-only.