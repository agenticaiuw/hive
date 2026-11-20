# Hive for iPhone

A Capacitor shell (`com.evanliu.hive`) around the Hive dashboard. The app carries no one's cloud
address. Its first page (`index.html`) asks for the member's dashboard address
(`<worker>.<account>.workers.dev`), keeps it on the phone, and opens it in the app's WKWebView from
then on. `capacitor.config.json` keeps `*.*.workers.dev` inside the app; any other site opens in
Safari. `public/offline.html` shows when the dashboard can't be reached, with **Open a different
Hive** to change the address. Nothing secret goes into the bundle: the app signs in to the
dashboard the way the website does, and the microphone is granted only to the dashboard page itself
(`ios/App/App/HiveBridgeViewController.swift`).

```sh
npm install            # the Capacitor CLI
npm run ios:sync       # build dist/ and copy it into ios/
npm run ios            # ...and open the project in Xcode
npm run ios:archive    # signed archive under build/ios/
npm run ios:testflight # archive and upload to TestFlight
```

The archive is signed with the Apple team of this Mac's signing certificate, so the repository
names no team. `HIVE_APPLE_TEAM_ID` picks one when the Mac has several; `HIVE_BUNDLE_ID` and
`HIVE_BUILD_NUMBER` override the bundle ID and build number (a timestamp). Minimum iOS is 15.0.
Automatic signing is on; Xcode may ask for Apple-account authorization the first time it needs a
distribution profile.

The privacy manifest declares app-functionality use of audio, command content and the random
device identifier, none for tracking. `ITSAppUsesNonExemptEncryption` is false (system TLS only).
Update both before adding analytics, crash reporting or other native SDKs.

Hive Phone, the app that lets Hive's agents use the iPhone, is separate: `relay/README.md`.
