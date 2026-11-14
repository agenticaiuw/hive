// The tools themselves: each takes the session's holder's arguments and answers with MCP content.
// Refusals come back as `[code] message` with isError set; the engine never answers a call by
// doing something other than what was asked.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import WorkspaceCore

public final class Workspace {
    public let manager: SessionManager
    let state: URL
    let events: EventLog
    /// A stand-in display (tests): nothing real to look at or act on.
    let simulated: Bool

    public init(manager: SessionManager, state: URL, simulated: Bool) {
        self.manager = manager
        self.state = state
        self.simulated = simulated
        events = EventLog(state: state)
    }

    public func call(_ name: String, _ arguments: [String: Any], client: ClientID?) -> [String: Any] {
        do {
            let result = try run(name, arguments, client: client)
            if name != "workspace_events" { events.add(name, ok: true, note: "") }
            return result
        } catch let error as WorkspaceError {
            events.add(name, ok: false, note: error.code)
            return MCP.failure(error)
        } catch {
            events.add(name, ok: false, note: "internal")
            return MCP.failure(WorkspaceError("internal", "\(error)"))
        }
    }

    func run(_ name: String, _ arguments: [String: Any], client: ClientID?) throws -> [String: Any] {
        let client = client ?? -1
        switch name {
        case "workspace_session_list": return MCP.text(manager.listing(for: client))
        case "workspace_session_claim": return MCP.text(try manager.claim(try Arguments.string(arguments, "session"), by: client))
        case "workspace_session_create": return MCP.text(try manager.create(arguments, by: client))
        case "workspace_session_destroy": return MCP.text(try manager.destroy(try Arguments.string(arguments, "session"), by: client))
        default: break
        }
        guard Catalog.names.contains(name) else { throw WorkspaceError("unknown_tool", "there is no tool \(name)") }
        let sessionName = try Arguments.string(arguments, "session")
        if !simulated { manager.pruneApps(alive: Apps.alive) }
        let live = try manager.session(sessionName, for: client, acting: Catalog.actions.contains(name))
        switch name {
        case "workspace_events": return recentEvents(arguments)
        case "workspace_list_windows": return listWindows(live)
        case "workspace_list_targets": return try listTargets(live)
        default: break
        }
        try requireReal()
        switch name {
        case "workspace_launch_app": return try launch(live, arguments)
        case "workspace_visit_url": return try visit(live, arguments)
        case "workspace_attach_target": return try attach(live, arguments)
        case "workspace_screenshot": return try screenshot(live, arguments)
        case "workspace_verify_isolation":
            return MCP.text(Reports.isolation(Isolation.audit(pids: Set(live.record.apps.map(\.pid)), stage: live.stage)))
        default: break
        }
        try requireAccessibility()
        switch name {
        case "workspace_wait_for": return try waitFor(live, arguments)
        case "workspace_find": return try find(live, arguments)
        case "workspace_read_text": return try readText(live, arguments)
        case "workspace_read_screen": return try readScreen(live, arguments)
        case "workspace_click": return try click(live, arguments)
        case "workspace_scroll": return try scroll(live, arguments)
        case "workspace_select_text": return try selectText(live, arguments)
        case "workspace_move": return try move(live, arguments)
        case "workspace_drag": return try drag(live, arguments)
        case "workspace_type": return try type(live, arguments)
        case "workspace_press_key": return try pressKey(live, arguments)
        default: throw WorkspaceError("unknown_tool", "there is no tool \(name)")
        }
    }

    func requireReal() throws {
        if simulated { throw WorkspaceError("unsupported", "this engine runs on a stand-in display for tests; it can't see or act on apps") }
    }

    func requireAccessibility() throws {
        if !AX.trusted() { throw WorkspaceError("permission", "Hive doesn't have Accessibility permission, so it can't read or operate the workspace's apps") }
    }

    // MARK: which app

    func target(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> SessionApp {
        let apps = live.record.apps
        guard let last = apps.last else {
            throw WorkspaceError("no_app", "the workspace has no apps yet; open one with workspace_launch_app or workspace_visit_url")
        }
        if let wanted = Arguments.optionalString(arguments, "app")?.lowercased() {
            if let match = apps.last(where: { $0.bundleID.lowercased() == wanted || $0.name.lowercased() == wanted })
                ?? apps.last(where: { $0.name.lowercased().contains(wanted) }) {
                return match
            }
            throw WorkspaceError("unknown_app", "no workspace app matches \"\(wanted)\"; it has \(apps.map(\.name).joined(separator: ", "))")
        }
        if let active = live.activePID, let app = apps.first(where: { $0.pid == active }) { return app }
        return last
    }

    /// The apps a search covers: the one named, or all of them.
    func scope(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [SessionApp] {
        if Arguments.optionalString(arguments, "app") != nil { return [try target(live, arguments)] }
        guard !live.record.apps.isEmpty else {
            throw WorkspaceError("no_app", "the workspace has no apps yet; open one with workspace_launch_app or workspace_visit_url")
        }
        return live.record.apps
    }

    func window(at point: CGPoint, _ live: SessionManager.Live) throws -> WindowInfo {
        guard let window = Windows.under(point, pids: Set(live.record.apps.map(\.pid))) else {
            let local = live.stage.local(point)
            throw WorkspaceError("no_window", "none of the workspace's windows is at (\(Int(local.x)), \(Int(local.y)))")
        }
        return window
    }

    func describe(_ rect: CGRect, _ stage: Stage) -> String {
        let local = stage.local(rect)
        return "(\(Int(local.minX)),\(Int(local.minY)) \(Int(local.width))x\(Int(local.height)))"
    }

    func quoted(_ text: String, _ limit: Int = 80) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return "'" + (flat.count > limit ? String(flat.prefix(limit)) + "…" : flat) + "'"
    }

    // MARK: apps and the browser

    func launch(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let url = try Apps.resolve(try Arguments.string(arguments, "app"))
        if Browser.isChromium(url) { return try browser(live, url: url, page: nil) }
        let running = try Apps.launch(url)
        let name = running.localizedName ?? url.deletingPathExtension().lastPathComponent
        manager.addApp(SessionApp(name: name, bundleID: running.bundleIdentifier ?? "", pid: running.processIdentifier))
        let placed = Apps.settle(running.processIdentifier, onto: live.stage, others: live.record.apps.map(\.pid))
        return MCP.text("Opened \(name) (pid \(running.processIdentifier)) in the workspace"
            + (placed ? "." : "; none of its windows is on the workspace yet (workspace_list_windows shows where they are)."))
    }

    func browser(_ live: SessionManager.Live, url: URL, page: String?) throws -> [String: Any] {
        if let existing = live.record.apps.first(where: \.managedBrowser), let port = live.record.browserPort {
            let tab = try Browser.open(page ?? "about:blank", port: port)
            manager.setActive(existing.pid)
            manager.setBrowser(port: port, target: tab["id"])
            return MCP.text("The workspace browser (pid \(existing.pid)) opened \(page ?? "a new tab") in tab \(tab["id"] ?? "?").")
        }
        let profile = Paths.engineDir(state: state).appendingPathComponent("browser-profile", isDirectory: true)
        let (running, port) = try Browser.start(url, profile: profile, page: page)
        AX.enableWebAccessibility(running.processIdentifier)
        let name = running.localizedName ?? "Browser"
        manager.addApp(SessionApp(name: name, bundleID: running.bundleIdentifier ?? "", pid: running.processIdentifier, managedBrowser: true))
        let target = (try? Browser.tabs(port: port))?.first?["id"]
        manager.setBrowser(port: port, target: target)
        let placed = Apps.settle(running.processIdentifier, onto: live.stage, others: live.record.apps.map(\.pid))
        return MCP.text("Started the workspace's own \(name) (pid \(running.processIdentifier), private profile)"
            + (page.map { " on \($0)" } ?? "") + (placed ? "." : "; its window isn't on the workspace yet."))
    }

    func visit(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let page = try Arguments.string(arguments, "url")
        guard let parsed = URL(string: page), let scheme = parsed.scheme?.lowercased(), ["http", "https"].contains(scheme),
              parsed.host != nil else {
            throw WorkspaceError("bad_request", "\"url\" must be an http or https address")
        }
        guard let url = Browser.installed() else {
            throw WorkspaceError("browser_unavailable", "no Chrome-family browser is installed for the workspace to use")
        }
        return try browser(live, url: url, page: page)
    }

    func listTargets(_ live: SessionManager.Live) throws -> [String: Any] {
        guard let port = live.record.browserPort, live.record.apps.contains(where: \.managedBrowser) else {
            throw WorkspaceError("no_browser", "the workspace browser isn't running; workspace_visit_url starts it")
        }
        let tabs = try Browser.tabs(port: port)
        if tabs.isEmpty { return MCP.text("The workspace browser has no tabs.") }
        return MCP.text(tabs.map {
            "- \($0["id"] ?? "") \(quoted($0["title"] ?? "")) \($0["url"] ?? "")\($0["id"] == live.record.attachedTarget ? " (in front)" : "")"
        }.joined(separator: "\n"))
    }

    func attach(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        guard let port = live.record.browserPort, let browser = live.record.apps.first(where: \.managedBrowser) else {
            throw WorkspaceError("no_browser", "the workspace browser isn't running; workspace_visit_url starts it")
        }
        let id = try Arguments.string(arguments, "target")
        try Browser.activate(id, port: port)
        manager.setActive(browser.pid)
        manager.setBrowser(port: port, target: id)
        return MCP.text("Tab \(id) is in front in the workspace browser.")
    }

    // MARK: seeing

    func screenshot(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let png = Arguments.optionalString(arguments, "format")?.lowercased() == "png"
        let stage = live.stage
        let image = try Capture.image(displayID: live.record.displayID, size: stage.bounds.size)
        let data = try Capture.encode(image, png: png)
        return ["content": [
            ["type": "image", "data": data.base64EncodedString(), "mimeType": png ? "image/png" : "image/jpeg"],
            ["type": "text", "text": "The workspace, \(stage.width)x\(stage.height) points; tools take points from its top-left corner."],
        ]]
    }

    func allText(_ pid: Int32) -> String {
        AX.windows(pid).map { AX.text($0, maxChars: 20000) }.joined(separator: "\n")
    }

    func waitFor(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let text = try Arguments.string(arguments, "text")
        let gone = Arguments.bool(arguments, "gone", default: false)
        let timeout = Arguments.number(arguments, "timeout_seconds", default: 10, range: 0.5...30)
        let pids = try scope(live, arguments).map(\.pid)
        let needle = text.lowercased()
        let started = Date()
        while true {
            let present = pids.contains { allText($0).lowercased().contains(needle) }
            if present != gone {
                let waited = String(format: "%.1f", Date().timeIntervalSince(started))
                return MCP.text(gone ? "\(quoted(text)) is gone (after \(waited)s)." : "\(quoted(text)) is there (after \(waited)s).")
            }
            if Date().timeIntervalSince(started) >= timeout {
                return MCP.failure(WorkspaceError("timeout", gone ? "\(quoted(text)) was still there after \(Int(timeout))s"
                                                    : "\(quoted(text)) didn't appear within \(Int(timeout))s"))
            }
            usleep(400_000)
        }
    }

    struct Match {
        let node: AX.Node
        let app: SessionApp
    }

    func matches(_ text: String, in apps: [SessionApp], stage: Stage, limit: Int) -> [Match] {
        let needle = text.lowercased()
        var found: [Match] = []
        for app in apps {
            for window in AX.windows(app.pid) {
                for node in AX.walk(window, limit: 3000) where node.label.lowercased().contains(needle) {
                    guard let frame = node.frame, stage.holds(frame) || stage.bounds.contains(CGPoint(x: frame.midX, y: frame.midY)) else { continue }
                    found.append(Match(node: node, app: app))
                    if found.count >= limit { return found }
                }
            }
        }
        return found
    }

    func find(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let text = try Arguments.string(arguments, "text")
        let limit = Int(Arguments.number(arguments, "limit", default: 20, range: 1...100))
        let stage = live.stage
        let found = matches(text, in: try scope(live, arguments), stage: stage, limit: limit)
        if found.isEmpty { return MCP.text("Nothing on the workspace matches \(quoted(text)).") }
        return MCP.text(found.map { match in
            let frame = stage.local(match.node.frame!)
            return "- \(match.node.role) \(quoted(match.node.label)) centre (\(Int(frame.midX)), \(Int(frame.midY))) size \(Int(frame.width))x\(Int(frame.height)) in \(match.app.name)"
        }.joined(separator: "\n"))
    }

    func frontWindow(_ app: SessionApp) throws -> AXUIElement {
        guard let window = AX.frontWindow(app.pid) else {
            throw WorkspaceError("no_window", "\(app.name) has no window open")
        }
        return window
    }

    func readText(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let app = try target(live, arguments)
        let window = try frontWindow(app)
        let limit = Int(Arguments.number(arguments, "max_chars", default: 8000, range: 200...100000))
        let title = AX.string(window, kAXTitleAttribute) ?? ""
        let body = AX.text(window, maxChars: limit)
        return MCP.text("\(app.name) — \(quoted(title))\n\(body.isEmpty ? "(no readable text)" : body)")
    }

    func readScreen(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let app = try target(live, arguments)
        let window = try frontWindow(app)
        let limit = Int(Arguments.number(arguments, "max_nodes", default: 300, range: 20...2000))
        let stage = live.stage
        let interesting: Set<String> = [kAXPressAction, kAXShowMenuAction, kAXConfirmAction, kAXIncrementAction,
                                        kAXDecrementAction, kAXPickAction]
        var lines = ["\(app.name) (pid \(app.pid)), workspace \(stage.width)x\(stage.height):"]
        for node in AX.walk(window, limit: limit) {
            let actions = AX.actions(node.element).filter(interesting.contains).map { $0.replacingOccurrences(of: "AX", with: "").lowercased() }
            let frame = node.frame.map { describe($0, stage) } ?? ""
            let label = node.label.isEmpty ? "" : " " + quoted(node.label, 100)
            lines.append(String(repeating: "  ", count: min(node.depth, 20)) + "- \(node.role)\(label) \(frame)"
                + (actions.isEmpty ? "" : " [\(actions.joined(separator: ", "))]"))
        }
        return MCP.text(lines.joined(separator: "\n"))
    }

    // MARK: acting

    func point(_ arguments: [String: Any], _ x: String, _ y: String, _ stage: Stage) throws -> CGPoint {
        try stage.global(try Arguments.requiredNumber(arguments, x), try Arguments.requiredNumber(arguments, y))
    }

    /// The control at a point or one of its parents, if it can be pressed.
    func pressable(_ element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0..<3 {
            guard let candidate = current else { return nil }
            if AX.actions(candidate).contains(kAXPressAction) { return candidate }
            current = AX.element(candidate, kAXParentAttribute)
        }
        return nil
    }

    func click(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let stage = live.stage
        let button: CGMouseButton = Arguments.optionalString(arguments, "button")?.lowercased() == "right" ? .right : .left
        let count = Int(Arguments.number(arguments, "count", default: 1, range: 1...3))
        let global: CGPoint
        if let text = Arguments.optionalString(arguments, "text") {
            let found = matches(text, in: try scope(live, arguments), stage: stage, limit: 50)
            guard let best = found.first(where: { AX.actions($0.node.element).contains(kAXPressAction) }) ?? found.first,
                  let frame = best.node.frame else {
                throw WorkspaceError("not_found", "nothing on the workspace matches \(quoted(text))")
            }
            manager.setActive(best.app.pid)
            if button == .left && count == 1 && AX.actions(best.node.element).contains(kAXPressAction) && AX.press(best.node.element) {
                return MCP.text("Pressed \(best.node.role) \(quoted(best.node.label)) in \(best.app.name).")
            }
            global = CGPoint(x: frame.midX, y: frame.midY)
        } else {
            global = try point(arguments, "x", "y", stage)
        }
        let window = try window(at: global, live)
        manager.setActive(window.pid)
        let local = stage.local(global)
        if button == .left && count == 1, let element = AX.element(at: global, pid: window.pid),
           let control = pressable(element), AX.role(control) != "AXWindow", AX.press(control) {
            return MCP.text("Pressed \(AX.role(control)) \(quoted(AX.label(control))) at (\(Int(local.x)), \(Int(local.y))) in \(window.owner).")
        }
        Input.click(at: global, button: button, count: count, pid: window.pid, window: window.windowID)
        return MCP.text("\(count == 2 ? "Double-clicked" : button == .right ? "Right-clicked" : "Clicked") at (\(Int(local.x)), \(Int(local.y))) in \(window.owner).")
    }

    func scroll(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let global = try point(arguments, "x", "y", live.stage)
        var dx = Int32(Arguments.number(arguments, "dx", default: 0, range: -50...50))
        var dy = Int32(Arguments.number(arguments, "dy", default: 0, range: -50...50))
        if dx == 0 && dy == 0 { dy = 3; dx = 0 }
        let window = try window(at: global, live)
        Input.scroll(at: global, dx: dx, dy: dy, pid: window.pid, window: window.windowID)
        return MCP.text("Scrolled \(dy) line(s) down and \(dx) right in \(window.owner).")
    }

    func selectText(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        if let text = Arguments.optionalString(arguments, "text") {
            let app = try target(live, arguments)
            guard let field = AX.focused(app.pid), let value = AX.string(field, kAXValueAttribute) else {
                throw WorkspaceError("no_field", "\(app.name) has no focused text field to select in")
            }
            guard let range = value.range(of: text, options: .caseInsensitive) else {
                throw WorkspaceError("not_found", "the focused field doesn't contain \(quoted(text))")
            }
            var span = CFRange(location: value.utf16.distance(from: value.utf16.startIndex, to: range.lowerBound.samePosition(in: value.utf16)!),
                               length: value.utf16.distance(from: range.lowerBound.samePosition(in: value.utf16)!,
                                                             to: range.upperBound.samePosition(in: value.utf16)!))
            guard let selection = AXValueCreate(.cfRange, &span), AX.set(field, kAXSelectedTextRangeAttribute, selection) else {
                throw WorkspaceError("unsupported", "\(app.name) didn't let its field's selection be set")
            }
            return MCP.text("Selected \(quoted(text)) in \(app.name).")
        }
        let start = try point(arguments, "from_x", "from_y", live.stage)
        let end = try point(arguments, "to_x", "to_y", live.stage)
        let window = try window(at: start, live)
        Input.drag(from: start, to: end, pid: window.pid, window: window.windowID)
        return MCP.text("Selected by dragging in \(window.owner).")
    }

    func move(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let global = try point(arguments, "x", "y", live.stage)
        let window = try window(at: global, live)
        Input.move(to: global, pid: window.pid, window: window.windowID)
        let local = live.stage.local(global)
        return MCP.text("The workspace pointer is at (\(Int(local.x)), \(Int(local.y))) over \(window.owner).")
    }

    func drag(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let start = try point(arguments, "from_x", "from_y", live.stage)
        let end = try point(arguments, "to_x", "to_y", live.stage)
        let window = try window(at: start, live)
        manager.setActive(window.pid)
        Input.drag(from: start, to: end, pid: window.pid, window: window.windowID)
        return MCP.text("Dragged in \(window.owner).")
    }

    func type(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        guard let text = arguments["text"] as? String else {
            throw WorkspaceError("bad_request", "\"text\" is required and must be a string")
        }
        let replace = Arguments.bool(arguments, "replace", default: false)
        let app = try target(live, arguments)
        // Web pages only notice keystrokes, so the browser always gets those.
        if !app.managedBrowser, let field = AX.focused(app.pid) {
            let before = AX.string(field, kAXValueAttribute)
            let attribute = replace ? kAXValueAttribute : kAXSelectedTextAttribute
            if AX.settable(field, attribute), AX.set(field, attribute, text as CFString),
               AX.string(field, kAXValueAttribute) != before || text.isEmpty {
                return MCP.text("\(replace ? "Replaced the field's contents with" : "Typed") \(text.count) character(s) in \(app.name).")
            }
        }
        if replace, let (code, flags) = try? Input.chord("cmd+a") { Input.key(code, flags: flags, pid: app.pid) }
        Input.type(text, pid: app.pid)
        return MCP.text("Typed \(text.count) character(s) in \(app.name) (as keystrokes to that app).")
    }

    func pressKey(_ live: SessionManager.Live, _ arguments: [String: Any]) throws -> [String: Any] {
        let key = try Arguments.string(arguments, "key")
        let (code, flags) = try Input.chord(key)
        let app = try target(live, arguments)
        Input.key(code, flags: flags, pid: app.pid)
        return MCP.text("Pressed \(key) in \(app.name).")
    }

    // MARK: looking around

    func listWindows(_ live: SessionManager.Live) -> [String: Any] {
        let stage = live.stage
        let windows = simulated ? [] : Windows.list(pids: Set(live.record.apps.map(\.pid))).filter { $0.layer == 0 }
        if windows.isEmpty { return MCP.text("The workspace's apps have no windows open.") }
        return MCP.text(windows.map {
            "- window \($0.windowID): \($0.owner) \(quoted($0.title)) \(describe($0.bounds, stage)), "
                + (stage.holds($0.bounds) ? "on the workspace" : "NOT on the workspace") + " (pid \($0.pid))"
        }.joined(separator: "\n"))
    }

    func recentEvents(_ arguments: [String: Any]) -> [String: Any] {
        let limit = Int(Arguments.number(arguments, "limit", default: 30, range: 1...300))
        let entries = events.recent(limit)
        if entries.isEmpty { return MCP.text("No workspace events yet.") }
        return MCP.text(entries.map { entry in
            let note = (entry["note"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return "\(entry["at"] as? String ?? "") \(entry["tool"] as? String ?? "") \((entry["ok"] as? Bool) == true ? "ok" : "failed")"
                + (note.map { " (\($0))" } ?? "")
        }.joined(separator: "\n"))
    }

    // MARK: the operator, from the viewer

    /// Input the user gives through the viewer while they hold control.
    public func operatorInput(_ request: [String: Any]) throws {
        guard let live = manager.live else { throw WorkspaceError("unknown_session", "there is no workspace session") }
        guard live.record.inputPaused, live.record.pauseReason == "operator" else {
            throw WorkspaceError("not_in_control", "take control in the viewer first")
        }
        try requireReal()
        let stage = live.stage
        switch request["kind"] as? String {
        case "click":
            let global = try point(request, "x", "y", stage)
            let window = try window(at: global, live)
            let right = (request["button"] as? String) == "right"
            Input.click(at: global, button: right ? .right : .left, count: Int(Arguments.number(request, "count", default: 1, range: 1...3)),
                        pid: window.pid, window: window.windowID)
            manager.setActive(window.pid)
        case "scroll":
            let global = try point(request, "x", "y", stage)
            let window = try window(at: global, live)
            Input.scroll(at: global, dx: Int32(Arguments.number(request, "dx", default: 0, range: -50...50)),
                         dy: Int32(Arguments.number(request, "dy", default: 0, range: -50...50)), pid: window.pid, window: window.windowID)
        case "key":
            let (code, flags) = try Input.chord(try Arguments.string(request, "key"))
            Input.key(code, flags: flags, pid: try target(live, [:]).pid)
        case "type":
            Input.type(try Arguments.string(request, "text"), pid: try target(live, [:]).pid)
        default:
            throw WorkspaceError("bad_request", "unknown operator input")
        }
    }
}
