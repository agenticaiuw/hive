import Foundation
import CoreGraphics

extension SessionManager {
    /// `menu`: list the menu bar of one of the session's applications, list a menu, or press
    /// an item — through Accessibility on the application element, never by activating it.
    ///
    /// Listing reveals application state, so it needs the lease like any covered read. Pressing
    /// is input: it honours pause and known-breach gates, is bracketed by isolation snapshots
    /// exactly like `click`, and sweeps containment afterwards because a menu command is the
    /// usual way a new window or dialog appears.
    func executeMenu(_ request: Request) async throws -> Response {
        let pressing = request.press == true
        let session = pressing
            ? try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            : try resolveForRead(request.session, leaseID: request.controllerLeaseID)
        let path = try AXMenu.validatedPath(request.menuPath)
        if pressing {
            try session.requireAgentInputAllowed(action: "menu")
            try requireNoKnownIsolationBreach(session)
        }
        let lifecycleLease = try session.beginOperation()
        defer { lifecycleLease.finish() }

        let window: WindowRef?
        let pid: pid_t
        if let requested = request.pid {
            guard requested > 0, session.apps.contains(where: { $0.pid == requested && $0.identity.isAlive }) else {
                throw SpaceOError.badRequest("menu pid must be a live application in this session")
            }
            pid = requested
            _ = try? session.refreshWindowsChecked()
            window = session.primaryWindow.flatMap { $0.pid == requested ? $0 : nil }
                ?? session.windows.first { $0.pid == requested }
        } else {
            let resolved = try session.resolveWindow(request.window)
            window = resolved
            pid = resolved.pid
        }
        guard let identity = session.apps.first(where: { $0.pid == pid && $0.identity.isAlive })?.identity else {
            throw SpaceOError.applicationExited("the application behind this menu is no longer running")
        }

        let before = pressing ? IsolationSnapshot.capture() : nil
        let result = try AXMenu.perform(pid: pid, path: path, press: pressing)
        // A recycled pid must not have its menu attributed to the session's application.
        guard pressing || ProcessIdentity.current(of: pid) == identity else {
            throw SpaceOError.applicationExited("the application exited while its menu was read")
        }

        var response = Response(ok: true)
        response.menu = result.items
        response.outline = AXMenu.outline(result.items)
        response.truncated = result.truncated ? true : nil
        let place = result.path.isEmpty ? "menu bar" : result.path.joined(separator: " › ")
        var message: String
        if let pressed = result.pressed {
            message = "pressed \(place) in pid \(pid)"
                + (pressed.shortcut.map { " (\($0))" } ?? "")
        } else {
            message = "\(result.items.count) item(s) in \(place) of pid \(pid)"
        }
        if result.truncated {
            message += "; more items exist than were listed (limit \(AXMenu.maximumListedItems))"
        }
        if result.withheld > 0 {
            message += "; \(result.withheld) session-wide item(s) such as the Apple menu are never offered"
        }
        response.message = message
        guard pressing, let before else { return response }

        // The item may have opened a window, a sheet, or a panel; pull it into the tile now and
        // expire indices that described the previous hierarchy.
        session.invalidateAXSnapshot()
        session.sweepStrayWindows()
        session.reparkUnwatchedWindows()
        response.action = ActionReceipt(
            command: "menu", windowID: window?.windowID, route: "accessibility-menu",
            completion: "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
        let now = IsolationSnapshot.capture()
        response.isolation = now.report(comparedTo: before)
        response.drift = response.isolation?.legacyDrift
        response.ambient = now.ambientChanges(from: before)
        failOnIsolationBreach(&response, action: "menu", before: before)
        // The application accepted AXPress for this exact item; what the command then does is
        // the postcondition the receipt does not assert.
        response.action?.outcome = response.ok ? "confirmed" : "refused"
        let target = result.path.joined(separator: " › ")
        if response.ok {
            session.recordAgentInputAction("menu", point: nil, windowID: window?.windowID,
                                           outcome: "confirmed", target: String(target.prefix(160)))
            emit("agent.action", session: session.id, [
                "cmd": "menu", "outcome": "confirmed",
                "window": window.map { String($0.windowID) } ?? "", "target": String(target.prefix(160)),
            ])
            try renewAfterSuccessfulMutation(session, leaseID: request.controllerLeaseID)
        } else {
            session.recordAgentInputAction("menu", point: nil, windowID: window?.windowID,
                                           outcome: "refused", target: String(target.prefix(160)))
            emit("isolation.verdict", session: session.id, ["verdict": "breached", "action": "menu"])
        }
        return response
    }
}
