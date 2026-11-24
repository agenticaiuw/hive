import XCTest

/// Hive Phone. iOS lets an app see and touch the whole screen only as a UI test, so Hive Phone is one, run by Xcode's
/// test runner app, which starts from its icon (build.sh): testRun never ends. It keeps the link to its Hive (Link.swift)
/// and answers the server's phone calls (Runner.swift). It has no window: iOS keeps a running UI test's own app in the
/// background, so the dashboard is the Hive app's (phone/ios/Hive).
final class HivePhone: XCTestCase {
    /// `build.sh test` sets HIVE_SMOKE: testSmoke checks the runner on a simulator, and testRun stands aside.
    static let smoke = ProcessInfo.processInfo.environment["HIVE_SMOKE"] != nil

    override func setUp() { continueAfterFailure = true }

    /// A failed XCUITest call becomes the error of the server's call that made it, never a failed test, which would end
    /// Hive Phone.
    override func record(_ issue: XCTIssue) {
        if Runner.shared.inCall || !HivePhone.smoke { Runner.shared.failed(issue.compactDescription) } else { super.record(issue) }
    }

    func testRun() throws {
        try XCTSkipIf(HivePhone.smoke, "the smoke test runs instead")
        // With no window of its own, Hive Phone signs its Tailscale node in by opening the sign-in page in Safari, once
        // for each new link.
        var opened: URL?
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { _ in
            guard let url = Tailnet.shared.loginURL, url != opened, !Runner.locked() else { return }
            opened = url
            XCUIDevice.shared.system.open(url)
        }
        Link.shared.start()
        while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
    }

    /// Every call the server makes, on a simulator, and that the Hive app starts on its pairing screen.
    func testSmoke() throws {
        try XCTSkipUnless(HivePhone.smoke, "only for build.sh test")
        func call(_ m: String, _ p: String, _ b: [String: Any]? = nil, _ want: Int = 200) -> [String: Any] {
            var out: (Int, String)?
            let body = b.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
            Runner.shared.handle(m, p, body) { out = ($0, $1) }
            XCTAssertEqual(out?.0, want, "\(m) \(p): \(out.map { String($0.1.prefix(300)) } ?? "no answer")")
            return (out.flatMap { try? JSONSerialization.jsonObject(with: Data($0.1.utf8)) } as? [String: Any]) ?? [:]
        }
        func shot(_ name: String) {
            let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            a.name = name
            a.lifetime = .keepAlways
            add(a)
        }
        func spin(_ secs: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(secs)) }
        func front() -> String? { (call("GET", "/wda/activeAppInfo")["value"] as? [String: Any])?["bundleId"] as? String }

        // The pairing the dashboard copies.
        let pairing = "hive-phone:" + Data(#"{"url":"wss://hive.example.ts.net/phone/device","token":"\#(String(repeating: "t", count: 40))"}"#.utf8)
            .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let p = Pairing.from(pairing)
        XCTAssertEqual(p?.tailnet, true)
        XCTAssertEqual(p?.dashboard.absoluteString.hasPrefix("https://hive.example.ts.net/#key="), true)
        XCTAssertNil(Pairing.from("hive-phone:e30"))

        // Finding the Hive Server among the node's peers (ipnstate.Status, as /localapi/v0/status has it).
        let status = try JSONSerialization.jsonObject(with: Data(#"""
            {"BackendState": "Running", "Peer": {
              "nodekey:a": {"HostName": "hive", "DNSName": "hive.tail1234.ts.net.", "TailscaleIPs": ["100.101.1.2"], "Online": true},
              "nodekey:b": {"HostName": "hive-app", "DNSName": "hive-app.tail1234.ts.net.", "Online": true},
              "nodekey:c": {"HostName": "hive-old", "DNSName": "", "TailscaleIPs": ["100.101.1.3"], "Online": true},
              "nodekey:d": {"HostName": "hive-2", "DNSName": "hive-2.tail1234.ts.net.", "Online": false},
              "nodekey:e": {"HostName": "laptop", "DNSName": "laptop.tail1234.ts.net.", "Online": true}}}
            """#.utf8)) as? [String: Any] ?? [:]
        XCTAssertEqual(Tailnet.hives(in: status), ["hive.tail1234.ts.net", "100.101.1.3"])
        XCTAssertNotNil(Pairing.checked(["url": "ws://hive.tail1234.ts.net/phone/device", "token": String(repeating: "t", count: 40)]))

        let sid = call("GET", "/status")["sessionId"] as? String ?? ""
        XCTAssertFalse(sid.isEmpty)
        let png = Data(base64Encoded: call("GET", "/screenshot")["value"] as? String ?? "") ?? Data()
        XCTAssertGreaterThan(png.count, 24)
        let size = call("GET", "/session/\(sid)/window/size")["value"] as? [String: Any]
        XCTAssertGreaterThan(size?["width"] as? Int ?? 0, 0)
        XCTAssertEqual(call("GET", "/wda/locked")["value"] as? Bool, false)
        XCTAssertFalse((call("GET", "/wda/device/info")["value"] as? [String: Any])?["uuid"] as? String ?? "" == "")
        _ = call("GET", "/session/nope/source", nil, 404)
        _ = call("GET", "/nothing", nil, 404)

        _ = call("POST", "/session/\(sid)/wda/apps/activate", ["bundleId": "com.apple.Preferences"])
        spin(2)
        XCTAssertEqual(front(), "com.apple.Preferences")
        let source = call("GET", "/session/\(sid)/source")["value"] as? String ?? ""
        XCTAssertTrue(source.contains("<XCUIElementTypeApplication"), String(source.prefix(300)))
        let texts = call("POST", "/session/\(sid)/elements", ["using": "predicate string", "value": "type == 'XCUIElementTypeStaticText' AND visible == 1"])
        XCTAssertFalse((texts["value"] as? [Any] ?? []).isEmpty)
        _ = call("POST", "/session/\(sid)/elements", ["using": "predicate string", "value": "this is (( not a predicate"], 400)
        let w = CGFloat(size?["width"] as? Int ?? 0), h = CGFloat(size?["height"] as? Int ?? 0)
        _ = call("POST", "/session/\(sid)/actions", ["actions": [["type": "pointer", "id": "finger", "parameters": ["pointerType": "touch"], "actions": [
            ["type": "pointerMove", "duration": 0, "x": w / 2, "y": h * 0.7], ["type": "pointerDown", "button": 0],
            ["type": "pointerMove", "duration": 300, "x": w / 2, "y": h * 0.3], ["type": "pointerUp", "button": 0]]]]])
        shot("Settings, swiped")
        // Settings' search field, then typing into whatever has focus.
        let fields = call("POST", "/session/\(sid)/elements", ["using": "class name", "value": "XCUIElementTypeSearchField"])["value"] as? [[String: String]] ?? []
        if let f = fields.first?["ELEMENT"] {
            _ = call("POST", "/session/\(sid)/element/\(f)/value", ["value": ["Wi"]])
            _ = call("POST", "/session/\(sid)/wda/keys", ["value": ["-", "F", "i"]])
            shot("Settings, typed")
        }

        _ = call("POST", "/wda/homescreen", [:])
        spin(2)
        XCTAssertEqual(front(), Runner.springboard)
        shot("Home screen")

        // The Hive app (build.sh test installs it): it starts unpaired, on its pairing screen.
        let hive = XCUIApplication(bundleIdentifier: "app.hive")
        hive.activate()
        XCTAssertTrue(hive.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Sign in with Tailscale'")).firstMatch.waitForExistence(timeout: 10),
                      "the Hive app didn't show its pairing screen")
        XCTAssertEqual(front(), "app.hive")
        shot("Hive app")
    }
}
