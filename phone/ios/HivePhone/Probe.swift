import UIKit
import XCTest

/// What iOS says about Hive's own window while the runner works, for the simulator runs in build.sh test: the app's state,
/// its scenes and windows, and the taps the window took, one JSON line per step in Documents/probe-<run>.log with a
/// screenshot beside it. phone.yml turns the lines into annotations, readable without signing in.
enum Probe {
    private static var count = 0

    static func state() -> [String: Any] {
        let app = UIApplication.shared
        let appState = [UIApplication.State.active: "active", .inactive: "inactive", .background: "background"][app.applicationState] ?? "?"
        let names: [UIScene.ActivationState: String] = [.unattached: "unattached", .foregroundActive: "foregroundActive",
                                                         .foregroundInactive: "foregroundInactive", .background: "background"]
        let scenes = app.connectedScenes.map { s -> [String: Any] in
            let ws = s as? UIWindowScene
            return ["class": String(describing: type(of: s)), "state": names[s.activationState] ?? "?", "role": s.session.role.rawValue,
                    "windows": ws?.windows.count ?? 0, "keyWindow": ws?.keyWindow.map { w in w.rootViewController.map { String(describing: type(of: $0)) } ?? "no controller" } ?? "none"]
        }
        var window: Any = "none"
        if let w = Dashboard.window {
            let sceneState: String = w.windowScene.map { names[$0.activationState] ?? "?" } ?? "none"
            window = ["inScene": w.windowScene != nil, "sceneState": sceneState, "hidden": w.isHidden, "key": w.isKeyWindow,
                      "frame": NSCoder.string(for: w.frame), "reload": NSCoder.string(for: Dashboard.reloadFrame)]
        }
        let delegate: String = app.delegate.map { String(describing: type(of: $0)) } ?? "none"
        return ["app": appState, "delegate": delegate, "scenes": scenes, "window": window, "taps": Dashboard.taps,
                "sceneManifest": Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") != nil]
    }

    /// Notes a step: its state as one line, and a screenshot. Returns the line.
    @discardableResult
    static func log(_ step: String, _ run: String) -> String {
        count += 1
        var s = state()
        s["step"] = step
        s["n"] = count
        let line = (try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? step
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = docs.appendingPathComponent("probe-\(run).log")
        if let h = try? FileHandle(forWritingTo: file) { h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close() }
        else { try? Data((line + "\n").utf8).write(to: file) }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: docs.appendingPathComponent(String(format: "probe-%@-%02d.png", run, count)))
        return line
    }

    /// An agent's call, through the runner as the server's would go.
    @discardableResult
    static func call(_ m: String, _ p: String, _ b: [String: Any]? = nil) -> Int {
        var status = 0
        let body = b.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
        Runner.shared.handle(m, p, body) { s, _ in status = s }
        return status
    }

    /// A tap on the window's Reload button, synthesized by the runner as an agent's tap would be.
    static func tapReload() {
        let r = Dashboard.reloadFrame
        guard !r.isEmpty else { return }
        call("POST", "/actions".withSession, ["actions": [["type": "pointer", "id": "finger", "parameters": ["pointerType": "touch"], "actions": [
            ["type": "pointerMove", "duration": 0, "x": r.midX, "y": r.midY], ["type": "pointerDown", "button": 0],
            ["type": "pause", "duration": 60], ["type": "pointerUp", "button": 0]]]]])
    }

    /// Launched from its icon (build.sh test, with HIVE_PROBE): a person's first minute, as steps on the main run loop
    /// while the runner and its link carry on. The host launches it from its icon again at about 30 seconds.
    static func icon() {
        let run = "icon"
        for n in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification,
                  UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification,
                  UIScene.willConnectNotification, UIScene.didActivateNotification, UIScene.didEnterBackgroundNotification] {
            NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { _ in log("event: \(n.rawValue)", run) }
        }
        let own = Bundle.main.bundleIdentifier ?? ""
        let steps: [(TimeInterval, () -> Void)] = [
            (3, { log("launched from the icon", run) }),
            (4, { tapReload() }),
            (6, { log("after a tap on Reload", run) }),
            (8, { call("POST", "/wda/apps/activate".withSession, ["bundleId": "com.apple.Preferences"]) }),
            (11, { log("Settings in front (an agent's action)", run) }),
            (13, { XCUIApplication(bundleIdentifier: own).activate() }),
            (16, { log("back in front via XCUIApplication.activate()", run) }),
            (17, { tapReload() }),
            (19, { log("after a tap on Reload", run) }),
            (21, { call("POST", "/wda/homescreen", [:]) }),
            (24, { log("home screen (an agent's action)", run) }),
            (36, { log("after the host launched it from its icon again", run) }),
            (37, { tapReload() }),
            (39, { log("after a tap on Reload", run) }),
            (40, { log("done", run) }),
        ]
        let start = Date()
        for (at, step) in steps {
            Timer.scheduledTimer(withTimeInterval: max(0, at - Date().timeIntervalSince(start)), repeats: false) { _ in step() }
        }
    }
}

private extension String {
    /// The path within the runner's current session, as the server sends it.
    var withSession: String {
        var sid = ""
        Runner.shared.handle("GET", "/status", "") { _, body in
            sid = ((try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any])?["sessionId"] as? String ?? ""
        }
        return "/session/\(sid)\(self)"
    }
}
