import Foundation
import CoreGraphics

/// Operation-local movement capability. Handles must never become part of the session cache:
/// a later operation discovers and validates a fresh set under its own resource budget.
struct SessionWindowMovement {
    let windows: [WindowRef]
    let move: (WindowRef, CGRect) throws -> Void

    init(windows: [WindowRef], move: @escaping (WindowRef, CGRect) throws -> Void) {
        self.windows = windows
        self.move = move
    }

    init<Element>(pid: pid_t, result: AXWindowDiscovery.Result<Element>,
                  validate: @escaping () throws -> Void,
                  move: @escaping (WindowRef, Element, CGRect) throws -> Void,
                  fallback: @escaping (WindowRef, CGRect) throws -> Void) throws {
        guard result.windows.allSatisfy({ $0.pid == pid && result.elements[$0.windowID] != nil }) else {
            throw AXWindowDiscovery.incomplete("movement handles do not cover the discovered windows")
        }
        windows = result.windows
        self.move = { [elements = result.elements] window, frame in
            guard window.pid == pid else {
                throw SpaceOError.windowNotFound("window belongs to another movement process")
            }
            try validate()
            if let element = elements[window.windowID] {
                try move(window, element, frame)
            } else {
                // Transactional refresh also retains cached windows with live owner/bounds
                // through AX blackouts. Preserve their bounded recovery attempt.
                try fallback(window, frame)
            }
        }
    }

    static func live(identity: ProcessIdentity, budget: AXTraversalBudget) throws -> Self {
        let result = try AXWindowDiscovery.discover(of: identity.pid, app: AX.application(identity.pid),
            provider: SystemAXTraversalProvider(), budget: budget,
            liveBounds: { try? WindowPlacement.liveBounds(of: $0) }, retainingElements: true)
        return try Self(pid: identity.pid, result: result, validate: {
            guard identity.isAlive else {
                throw SpaceOError.windowNotFound("movement process exited or changed")
            }
        }, move: { window, element, frame in
            _ = try WindowPlacement.move(window, to: frame, element: element, identity: identity)
        }, fallback: { window, frame in
            _ = try WindowPlacement.move(window, to: frame, identity: identity)
        })
    }
}
