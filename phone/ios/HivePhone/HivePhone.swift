import UIKit
import XCTest
@testable import HiveApp

/// Phone control in Hive, the iPhone app. iOS lets an app see and touch the whole screen only as a UI test, so phone control
/// is one, which the app (Launcher/Main.m, with its dashboard and link already up: HiveApp) starts once the developer image
/// is mounted: testRun never ends. It answers the server's phone calls (Runner.swift) that the app's link takes.
final class HivePhone: XCTestCase {
    /// `build.sh test` sets HIVE_SMOKE: testSmoke checks the runner on a simulator, and testRun stands aside.
    static let smoke = ProcessInfo.processInfo.environment["HIVE_SMOKE"] != nil

    override func setUp() { continueAfterFailure = true }

    /// A failed XCUITest call becomes the error of the server's call that made it, never a failed test, which would end
    /// Hive.
    override func record(_ issue: XCTIssue) {
        if Runner.shared.inCall || !HivePhone.smoke { Runner.shared.failed(issue.compactDescription) } else { super.record(issue) }
    }

    func testRun() throws {
        try XCTSkipIf(HivePhone.smoke, "the smoke test runs instead")
        // UI-test initialization can background its runner. Opening Hive ends
        // with its dashboard in front, before the server starts sending calls.
        if UIApplication.shared.applicationState != .active {
            XCUIApplication(bundleIdentifier: Bundle.main.bundleIdentifier ?? "").activate()
        }
        let probe = ProcessInfo.processInfo.environment["HIVE_PROBE"] != nil
        // The dashboard's button signs Tailscale in; when Hive isn't in front to show it, the sign-in opens in Safari, once
        // for each new link.
        var opened: URL?
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { _ in
            guard let url = Tailnet.shared.loginURL, url != opened, !probe, !Runner.locked(),
                  UIApplication.shared.applicationState == .background else { return }
            opened = url
            XCUIDevice.shared.system.open(url)
        }
        Link.shared.calls = Runner.shared.handle
        if probe { Probe.icon() }
        // The main run loop, as an app's own: the window takes touches, and the link and the server's calls run.
        while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
    }

    /// Every call the server makes, on a simulator, and what iOS says about Hive's window meanwhile (Probe.swift).
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
        // Hive's window under xcodebuild, which starts the runner its own way: what iOS says, at each step.
        func note(_ step: String) {
            let a = XCTAttachment(string: Probe.log(step, "smoke"))
            a.name = step
            a.lifetime = .keepAlways
            add(a)
        }
        Dashboard.show()
        Dashboard.preview()
        spin(2)
        note("started by xcodebuild")

        // The pairing the Hive Server gives over Tailscale, and its dashboard.
        let p = Pairing.checked(["url": "ws://hive.example.ts.net/phone/device", "token": String(repeating: "t", count: 40)])
        XCTAssertEqual(p?.dashboard.absoluteString, "http://hive.example.ts.net/")
        XCTAssertNil(Pairing.checked(["url": "ws://hive.example.com/phone/device", "token": String(repeating: "t", count: 40)]))

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
        note("Settings in front (an agent's action)")
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
        note("home screen (an agent's action)")

        // Hive back in front, as an agent or the owner would bring it: does its window show and take a tap?
        XCUIApplication(bundleIdentifier: Bundle.main.bundleIdentifier ?? "").activate()
        spin(3)
        note("back in front via XCUIApplication.activate()")
        XCTAssertGreaterThan(Dashboard.reloadFrame.width, 20, "Reload isn't laid out: \(Dashboard.reloadFrame)")
        XCTAssertGreaterThan(Dashboard.webFrame.height, 200, "the web view isn't laid out: \(Dashboard.webFrame)")
        Probe.tapReload()
        spin(1)
        note("after a tap on Reload")
        XCTAssertEqual(Dashboard.taps, 1, "Hive's window didn't take the tap")
    }
}
