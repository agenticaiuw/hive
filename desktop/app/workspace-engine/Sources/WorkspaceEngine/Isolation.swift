// Whether the workspace is staying out of the user's way, from what macOS reports right now. Each
// check says what it saw; a check it couldn't make is "unknown", never assumed to have passed.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import WorkspaceCore

enum Isolation {
    static func audit(pids: Set<Int32>, stage: Stage) -> [IsolationCheck] {
        func ownership(_ name: String, _ pid: Int32?, _ what: String) -> IsolationCheck {
            guard let pid else { return IsolationCheck(name, .unknown, .unknown, "macOS didn't say which app \(what)") }
            if pids.contains(pid) { return IsolationCheck(name, .failed, .observed, "a workspace app (pid \(pid)) \(what)") }
            return IsolationCheck(name, .passed, .observed, "the user's own app (pid \(pid)) \(what)")
        }
        let (menuBar, front) = Apps.runOnMain {
            (NSWorkspace.shared.menuBarOwningApplication?.processIdentifier, NSWorkspace.shared.frontmostApplication?.processIdentifier)
        }
        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, 1)
        let trusted = AX.trusted()
        let keyApp = trusted ? AX.element(systemWide, kAXFocusedApplicationAttribute).flatMap(AX.pid) : nil
        let textOwner = trusted ? AX.element(systemWide, kAXFocusedUIElementAttribute).flatMap(AX.pid) : nil

        var checks = [
            ownership("menu_bar_owner", menuBar, "owns the menu bar"),
            ownership("window_server_front_process", front, "is in front"),
            trusted ? ownership("key_input_route", keyApp, "receives the keyboard")
                : IsolationCheck("key_input_route", .unknown, .unknown, "no Accessibility permission to ask"),
            trusted ? ownership("text_input_route", textOwner, "has the focused text field")
                : IsolationCheck("text_input_route", .unknown, .unknown, "no Accessibility permission to ask"),
        ]
        if let pointer = CGEvent(source: nil)?.location {
            checks.append(stage.bounds.contains(pointer)
                ? IsolationCheck("cursor_location", .failed, .observed, "the user's pointer is on the workspace display")
                : IsolationCheck("cursor_location", .passed, .observed, "the user's pointer is on their own screens"))
        } else {
            checks.append(IsolationCheck("cursor_location", .unknown, .unknown, "the pointer's position couldn't be read"))
        }
        let spansDisplays = UserDefaults(suiteName: "com.apple.spaces")?.bool(forKey: "spans-displays") ?? false
        checks.append(spansDisplays
            ? IsolationCheck("active_space", .unknown, .inferred, "displays share one Space, so Space switches can reach the workspace")
            : IsolationCheck("active_space", .passed, .inferred, "the workspace is a display of its own, with its own Space"))
        return checks
    }
}
