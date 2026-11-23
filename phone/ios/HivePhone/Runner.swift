import UIKit
import notify
import XCTest

/// Hive's phone calls (the server's phone/src/phone.rs), answered as WebDriverAgent answers them, so the server's phone
/// crate is unchanged, but with public XCUITest calls and only the calls the server makes. Link hands each call here in
/// this process; nothing listens on a port.
final class Runner {
    static let shared = Runner()
    static let springboard = "com.apple.springboard"
    /// Apple's apps, asked whether they're in front after the ones Hive opened: XCUITest can't name the app in front.
    static let system = ["com.apple.mobilesafari", "com.apple.Preferences", "com.apple.MobileSMS", "com.apple.mobilemail",
        "com.apple.mobileslideshow", "com.apple.camera", "com.apple.Maps", "com.apple.mobilenotes", "com.apple.mobilecal",
        "com.apple.reminders", "com.apple.AppStore", "com.apple.mobilephone", "com.apple.facetime", "com.apple.Music",
        "com.apple.weather", "com.apple.mobiletimer", "com.apple.DocumentsApp", "com.apple.Health", "com.apple.Passbook",
        "com.apple.MobileAddressBook", "com.apple.shortcuts", "com.apple.Home", "com.apple.calculator"]

    /// An element a search found, to find again for typing into it.
    struct Found { let bundle: String; let type: UInt; let name: String; let frame: CGRect }

    private var session = UUID().uuidString
    private var found: [String: Found] = [:]
    private var queue: [(String, String, String, (Int, String) -> Void)] = []
    private var busy = false
    private var failure: String?
    /// Apps that said they were in front when Home was pressed: iOS can keep saying so after they've left.
    private var stale = Set<String>()
    private(set) var inCall = false

    /// A failed XCUITest call (HivePhone.record) becomes the error of the call that made it.
    func failed(_ message: String) { if failure == nil { failure = message } }

    /// Answers one call on the main thread, one at a time: XCUITest calls run the main run loop while they wait, so a
    /// call that arrives meanwhile would otherwise start inside the one before.
    func handle(_ method: String, _ path: String, _ body: String, reply: @escaping (Int, String) -> Void) {
        queue.append((method, path, body, reply))
        guard !busy else { return }
        busy = true
        while !queue.isEmpty {
            let (m, p, b, r) = queue.removeFirst()
            failure = nil
            inCall = true
            var (status, value) = answer(m, p, b)
            inCall = false
            if let f = failure, status < 400 { (status, value) = Runner.fail(500, "unknown error", f) }
            let data = (try? JSONSerialization.data(withJSONObject: ["value": value, "sessionId": session])) ?? Data()
            r(status, String(decoding: data, as: UTF8.self))
        }
        busy = false
    }

    private static func fail(_ status: Int, _ error: String, _ message: String) -> (Int, Any) {
        (status, ["error": error, "message": message, "traceback": ""])
    }

    private func answer(_ method: String, _ path: String, _ body: String) -> (Int, Any) {
        var c = (path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "").split(separator: "/").map(String.init)
        let b = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] ?? [:]
        if c.first == "session", c.count >= 2 {
            guard c[1] == session else { return Runner.fail(404, "invalid session id", "Session does not exist") }
            if c.count == 2 {
                if method == "DELETE" { session = UUID().uuidString; found = [:] }
                return (200, NSNull())
            }
            c.removeFirst(2)
        }
        let screen = UIScreen.main.bounds
        switch (method, c.joined(separator: "/")) {
        case ("GET", "status"):
            return (200, ["ready": true, "message": "Hive Phone is ready", "state": "success",
                          "os": ["name": "iOS", "version": UIDevice.current.systemVersion]])
        case ("POST", "session"):
            session = UUID().uuidString
            found = [:]
            return (200, ["sessionId": session, "capabilities": ["device": "iphone"]])
        case ("GET", "screenshot"):
            return (200, XCUIScreen.main.screenshot().pngRepresentation.base64EncodedString())
        case ("GET", "window/size"):
            return (200, ["width": Int(screen.width), "height": Int(screen.height)])
        case ("GET", "source"):
            do { return (200, Tree.xml(try tree(target().1), screen)) } catch { return Runner.fail(500, "unknown error", "\(error)") }
        case ("POST", "elements"):
            return search(b, screen)
        case ("POST", _) where c.count == 3 && c[0] == "element" && c[2] == "value":
            return type(into: c[1], Runner.text(b))
        case ("POST", "actions"):
            return touch(b)
        case ("POST", "wda/pressButton"):
            switch b["name"] as? String {
            case "home": XCUIDevice.shared.press(.home)
            #if !targetEnvironment(simulator)
            case "volumeUp": XCUIDevice.shared.press(.volumeUp)
            case "volumeDown": XCUIDevice.shared.press(.volumeDown)
            #endif
            default: return Runner.fail(400, "invalid argument", "Hive Phone can't press \(b["name"] ?? "that")")
            }
            return (200, NSNull())
        case ("POST", "wda/homescreen"):
            stale = Set(candidates.filter { XCUIApplication(bundleIdentifier: $0).state == .runningForeground })
            XCUIDevice.shared.press(.home)
            return (200, NSNull())
        case ("POST", "wda/keys"):
            target().1.typeText(Runner.text(b))
            return (200, NSNull())
        case ("POST", "wda/apps/activate"):
            guard let id = b["bundleId"] as? String, !id.isEmpty else { return Runner.fail(400, "invalid argument", "no bundleId") }
            XCUIApplication(bundleIdentifier: id).activate()
            stale.remove(id)
            if failure == nil { remember(id) }
            return (200, NSNull())
        case ("GET", "wda/locked"):
            return (200, Runner.locked())
        case ("GET", "wda/activeAppInfo"):
            return (200, ["bundleId": front(), "name": "", "pid": 0, "processArguments": [String: Any]()])
        case ("GET", "wda/device/info"):
            let d = UIDevice.current
            #if targetEnvironment(simulator)
            let simulator = true
            #else
            let simulator = false
            #endif
            return (200, ["uuid": d.identifierForVendor?.uuidString ?? "", "name": d.name, "model": d.model, "os": d.systemVersion,
                          "locale": Locale.current.identifier, "timeZone": TimeZone.current.identifier, "isSimulator": simulator])
        default:
            return Runner.fail(404, "unknown command", "Hive Phone has no \(method) \(path)")
        }
    }

    // MARK: Apps

    private var candidates: [String] { recent + ["app.hive"] + Runner.system }
    private var recent: [String] { UserDefaults.standard.stringArray(forKey: "recentApps") ?? [] }

    private func remember(_ id: String) {
        UserDefaults.standard.set(Array(([id] + recent.filter { $0 != id }).prefix(20)), forKey: "recentApps")
    }

    /// The app in front: SpringBoard when its home screen shows; else an app Hive opened, Hive, or one of Apple's;
    /// otherwise, and whenever the iPhone is locked, SpringBoard (lock screen, system prompts). Another app opened from
    /// its icon reads as SpringBoard: XCUITest's public calls can't name it.
    private func front() -> String {
        if Runner.locked() { return Runner.springboard }
        for id in candidates {
            let up = XCUIApplication(bundleIdentifier: id).state == .runningForeground
            // An app left by Home can keep saying it's in front; once it stops saying so, it's believed again.
            if !up { stale.remove(id); continue }
            if !stale.contains(id) { return id }
        }
        return Runner.springboard
    }

    /// The app whose tree Hive reads and types into.
    private func target() -> (String, XCUIApplication) {
        let id = front()
        return (id, XCUIApplication(bundleIdentifier: id))
    }

    /// Locked: SpringBoard's lock state, or, if iOS doesn't say, this app's protected data being locked away.
    static func locked() -> Bool {
        var token: Int32 = 0, state: UInt64 = 0
        if notify_register_check("com.apple.springboard.lockstate", &token) == 0 {
            defer { notify_cancel(token) }
            if notify_get_state(token, &state) == 0, state != 0 { return true }
        }
        return !UIApplication.shared.isProtectedDataAvailable
    }

    // MARK: Elements

    private func tree(_ app: XCUIApplication) throws -> Node {
        func node(_ s: XCUIElementSnapshot) -> Node {
            Node(type: s.elementType.rawValue, name: s.identifier, label: s.label, value: s.value.map { "\($0)" } ?? "",
                 enabled: s.isEnabled, frame: s.frame, children: s.children.map(node))
        }
        return node(try app.snapshot())
    }

    private func search(_ b: [String: Any], _ screen: CGRect) -> (Int, Any) {
        let v = b["value"] as? String ?? ""
        let format: String
        switch b["using"] as? String {
        case "predicate string": format = v
        case "accessibility id", "id", "name": format = NSPredicate(format: "name == %@", v).predicateFormat
        case "class name": format = NSPredicate(format: "type == %@", v).predicateFormat
        default: return Runner.fail(400, "invalid selector", "Hive Phone searches by predicate string, accessibility id or class name")
        }
        let (id, app) = target()
        let root: Node
        do { root = try tree(app) } catch { return Runner.fail(500, "unknown error", "\(error)") }
        let (nodes, why) = Tree.find(root, format, screen)
        guard let nodes else { return Runner.fail(400, "invalid selector", why ?? "bad predicate") }
        if found.count > 1000 { found = [:] }
        return (200, nodes.map { n -> [String: String] in
            let e = UUID().uuidString
            found[e] = Found(bundle: id, type: n.type, name: n.name, frame: n.frame)
            return ["ELEMENT": e, "element-6066-11e4-a52e-4f735466cecf": e]
        })
    }

    /// Types into an element a search found: the one of its type (and identifier) at the same place.
    private func type(into id: String, _ text: String) -> (Int, Any) {
        let stale = Runner.fail(404, "stale element reference", "The element is no longer on the screen")
        guard let f = found[id], let kind = XCUIElement.ElementType(rawValue: f.type) else { return stale }
        var q = XCUIApplication(bundleIdentifier: f.bundle).descendants(matching: kind)
        if !f.name.isEmpty { q = q.matching(identifier: f.name) }
        let near = { (a: CGRect) in abs(a.minX - f.frame.minX) < 1 && abs(a.minY - f.frame.minY) < 1 && abs(a.width - f.frame.width) < 1 }
        guard let e = q.allElementsBoundByIndex.prefix(40).first(where: { near($0.frame) }) else { return stale }
        e.typeText(text)
        // Not focused: nothing was typed, so focus it and type once more.
        if let why = failure, why.lowercased().contains("focus") { failure = nil; e.tap(); e.typeText(text) }
        return (200, NSNull())
    }

    private static func text(_ b: [String: Any]) -> String {
        (b["value"] as? [Any])?.map { "\($0)" }.joined() ?? b["text"] as? String ?? ""
    }

    // MARK: Touch

    /// One finger's W3C pointer actions, as the server sends them (points): a tap, a long press, or a press and drag.
    private func touch(_ b: [String: Any]) -> (Int, Any) {
        guard let steps = (b["actions"] as? [[String: Any]])?.first?["actions"] as? [[String: Any]] else {
            return Runner.fail(400, "invalid argument", "no pointer actions")
        }
        // Points on the screen, measured from SpringBoard, which always covers it.
        let origin = XCUIApplication(bundleIdentifier: Runner.springboard).coordinate(withNormalizedOffset: .zero)
        let at = { (p: CGPoint) in origin.withOffset(CGVector(dx: p.x, dy: p.y)) }
        var start: CGPoint?, end: CGPoint?, down = false, hold = 0.0, glide = 0.0
        for a in steps {
            let x = (a["x"] as? NSNumber)?.doubleValue, y = (a["y"] as? NSNumber)?.doubleValue
            let secs = ((a["duration"] as? NSNumber)?.doubleValue ?? 0) / 1000
            switch a["type"] as? String {
            case "pointerMove":
                guard let x, let y else { continue }
                if down { end = CGPoint(x: x, y: y); glide += secs } else { start = CGPoint(x: x, y: y) }
            case "pointerDown":
                down = true
            case "pause":
                if down && end == nil { hold += secs }
            case "pointerUp":
                guard down, let s = start else { continue }
                if let e = end {
                    let speed = max(hypot(e.x - s.x, e.y - s.y) / max(glide, 0.05), 100)
                    at(s).press(forDuration: max(hold, 0.05), thenDragTo: at(e), withVelocity: XCUIGestureVelocity(rawValue: speed), thenHoldForDuration: 0)
                } else if hold >= 0.5 {
                    at(s).press(forDuration: hold)
                } else {
                    at(s).tap()
                }
                (down, start, end, hold, glide) = (false, end ?? s, nil, 0, 0)
            default:
                break
            }
        }
        return (200, NSNull())
    }
}
