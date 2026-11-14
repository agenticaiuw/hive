// Mouse and keyboard events for one app at a time. They are posted to the app's process rather
// than through the system's input stream, so the user's pointer stays where it is and their keys
// keep going to their own app. The mouse events name the window under the point (event fields 91
// and 92), which is how an app that isn't in front knows which of its windows they're for.
import ApplicationServices
import CoreGraphics
import Foundation
import WorkspaceCore

enum Input {
    static let source = CGEventSource(stateID: .privateState)

    static func stamp(_ event: CGEvent, window: CGWindowID) {
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    }

    static func mouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left, clicks: Int = 1,
                      pid: pid_t, window: CGWindowID) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        stamp(event, window: window)
        event.postToPid(pid)
    }

    static func click(at point: CGPoint, button: CGMouseButton, count: Int, pid: pid_t, window: CGWindowID) {
        let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        mouse(.mouseMoved, at: point, pid: pid, window: window)
        usleep(20_000)
        for clicks in 1...max(1, min(count, 3)) {
            mouse(down, at: point, button: button, clicks: clicks, pid: pid, window: window)
            usleep(30_000)
            mouse(up, at: point, button: button, clicks: clicks, pid: pid, window: window)
            usleep(40_000)
        }
    }

    static func move(to point: CGPoint, pid: pid_t, window: CGWindowID) {
        mouse(.mouseMoved, at: point, pid: pid, window: window)
    }

    static func drag(from start: CGPoint, to end: CGPoint, pid: pid_t, window: CGWindowID) {
        mouse(.mouseMoved, at: start, pid: pid, window: window)
        usleep(20_000)
        mouse(.leftMouseDown, at: start, pid: pid, window: window)
        usleep(60_000)
        let steps = 12
        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
            mouse(.leftMouseDragged, at: point, pid: pid, window: window)
            usleep(16_000)
        }
        mouse(.leftMouseUp, at: end, pid: pid, window: window)
    }

    static func scroll(at point: CGPoint, dx: Int32, dy: Int32, pid: pid_t, window: CGWindowID) {
        // Scroll-wheel lines are positive upward; the tool's dy is positive downward.
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                                  wheel1: -dy, wheel2: -dx, wheel3: 0) else { return }
        event.location = point
        stamp(event, window: window)
        event.postToPid(pid)
    }

    static func key(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.postToPid(pid)
            usleep(12_000)
        }
    }

    /// Types characters as they are, whatever the keyboard layout.
    static func type(_ text: String, pid: pid_t) {
        let units = Array(text.utf16)
        var index = 0
        while index < units.count {
            let chunk = Array(units[index..<min(index + 16, units.count)])
            index += chunk.count
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event.postToPid(pid)
            }
            usleep(8_000)
        }
    }

    static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "forward_delete": 117, "forwarddelete": 117, "home": 115, "end": 119, "page_up": 116, "pageup": 116,
        "page_down": 121, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
        "f10": 109, "f11": 103, "f12": 111,
    ]

    /// The ANSI layout's key for each character on it.
    static let characters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    ]

    /// "shift+cmd+t" → the key and its modifiers.
    static func chord(_ text: String) throws -> (CGKeyCode, CGEventFlags) {
        let parts = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = parts.last, !last.isEmpty else {
            throw WorkspaceError("bad_request", "\"key\" names a key, such as \"return\" or \"cmd+s\"")
        }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            switch modifier {
            case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: throw WorkspaceError("bad_request", "unknown modifier \"\(modifier)\" (use cmd, shift, option, control or fn)")
            }
        }
        if let code = named[last] { return (code, flags) }
        if last.count == 1, let code = characters[last.first!] { return (code, flags) }
        throw WorkspaceError("bad_request", "unknown key \"\(last)\"")
    }
}
