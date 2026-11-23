import XCTest

/// Hive Phone. iOS lets an app see and touch the whole screen only as a UI test, so Hive Phone is one, run by Xcode's
/// test runner app, which starts from its icon (build.sh): testRun never ends. In this one process it shows its window
/// (Dashboard.swift), keeps the link to its Hive (Link.swift) and answers the server's phone calls (Runner.swift).
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
        Dashboard.show()
        Link.shared.start()
        while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
    }

    /// Every call the server makes, on a simulator, plus whether Hive Phone's own window stays usable while the runner works.
    func testSmoke() throws {
        try XCTSkipUnless(HivePhone.smoke, "only for build.sh test")
        Dashboard.show()
        spin(1)
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

        // The pairing the dashboard copies.
        let pairing = "hive-phone:" + Data(#"{"url":"wss://hive.example.ts.net/phone/device","token":"\#(String(repeating: "t", count: 40))"}"#.utf8)
            .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let p = Link.pairing(from: pairing)
        XCTAssertEqual(p?.tailnet, true)
        XCTAssertEqual(p?.dashboard.absoluteString, "https://hive.example.ts.net/")
        XCTAssertNil(Link.pairing(from: "hive-phone:e30"))

        // Hive Phone's window is in front when the test starts: does a tap the runner makes reach it?
        shot("Hive Phone's window")
        let r = Dashboard.reloadFrame
        XCTAssertFalse(r.isEmpty, "the window's Reload button isn't laid out")
        let tap = { (x: CGFloat, y: CGFloat) -> [String: Any] in
            ["actions": [["type": "pointer", "id": "finger", "parameters": ["pointerType": "touch"], "actions": [
                ["type": "pointerMove", "duration": 0, "x": x, "y": y], ["type": "pointerDown", "button": 0],
                ["type": "pause", "duration": 60], ["type": "pointerUp", "button": 0]]]]]
        }

        let sid = call("GET", "/status")["sessionId"] as? String ?? ""
        XCTAssertFalse(sid.isEmpty)
        _ = call("POST", "/session/\(sid)/actions", tap(r.midX, r.midY))
        spin(1)
        XCTAssertEqual(Dashboard.taps, 1, "Hive Phone's window didn't take the runner's tap")

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
        XCTAssertEqual((call("GET", "/wda/activeAppInfo")["value"] as? [String: Any])?["bundleId"] as? String, "com.apple.Preferences")
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
        XCTAssertEqual((call("GET", "/wda/activeAppInfo")["value"] as? [String: Any])?["bundleId"] as? String, Runner.springboard)
        shot("Home screen")

        // Back to Hive Phone from another app: is its window still there and does it still take touches?
        XCUIApplication(bundleIdentifier: Bundle.main.bundleIdentifier ?? "").activate()
        spin(2)
        shot("Hive Phone again")
        _ = call("POST", "/session/\(sid)/actions", tap(r.midX, r.midY))
        spin(1)
        XCTAssertEqual(Dashboard.taps, 2, "Hive Phone's window didn't take a tap after coming back to the front")
    }

    private func spin(_ secs: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(secs)) }
}
