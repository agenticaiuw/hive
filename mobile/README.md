# Hive for iPhone

A Capacitor shell (`com.evanliu.hive`) around the Hive dashboard. The app's WKWebView loads the
deployed dashboard (`capacitor.config.json` `server.url`); the local bundle is only three static
files: `index.html` (a redirect to the dashboard), `public/offline.html` (shown when the network
is down) and `public/favicon.svg`. Nothing secret goes into the bundle, and the app carries no
relay administrator key: it pairs with the relay for its own scoped device credential.

```sh
npm install            # the Capacitor CLI
npm run ios:sync       # build dist/ and copy it into ios/
npm run ios            # ...and open the project in Xcode
npm run ios:archive    # signed archive under build/ios/
npm run ios:testflight # archive and upload to TestFlight
```

`PENDANT_APPLE_TEAM_ID`, `PENDANT_BUNDLE_ID` and `PENDANT_BUILD_NUMBER` override the team
(`9684Z8GZ26`), bundle ID and build number (a timestamp) without editing the project.
Minimum iOS is 15.0. Automatic signing is on; Xcode may ask for Apple-account authorization the
first time it needs a distribution profile.

The privacy manifest declares app-functionality use of audio, command content and the random
device identifier, none for tracking. `ITSAppUsesNonExemptEncryption` is false (system TLS only).
Update both before adding analytics, crash reporting or other native SDKs.
