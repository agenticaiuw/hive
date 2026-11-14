// The accessibility calls the engine uses: reading an app's windows and controls, pressing them,
// typing into them and moving windows. Every call has a short timeout, so an app that hangs can't
// hang the engine.
import ApplicationServices
import CoreGraphics
import Foundation
import WorkspaceCore

enum AX {
    static func trusted() -> Bool { AXIsProcessTrusted() }

    static func app(_ pid: pid_t) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 1.5)
        return element
    }

    static func raw(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func string(_ element: AXUIElement, _ name: String) -> String? {
        raw(element, name) as? String
    }

    static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = raw(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    static func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let value = raw(element, name) as? [AnyObject] else { return [] }
        return value.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
        }
    }

    static func role(_ element: AXUIElement) -> String { string(element, kAXRoleAttribute) ?? "" }

    static func children(_ element: AXUIElement) -> [AXUIElement] { elements(element, kAXChildrenAttribute) }

    static func windows(_ pid: pid_t) -> [AXUIElement] { elements(app(pid), kAXWindowsAttribute) }

    static func frontWindow(_ pid: pid_t) -> AXUIElement? {
        let application = app(pid)
        return element(application, kAXFocusedWindowAttribute) ?? element(application, kAXMainWindowAttribute)
            ?? elements(application, kAXWindowsAttribute).first
    }

    static func focused(_ pid: pid_t) -> AXUIElement? { element(app(pid), kAXFocusedUIElementAttribute) }

    static func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    static func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
        guard let value = raw(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
    }

    static func size(_ element: AXUIElement) -> CGSize? {
        guard let value = raw(element, kAXSizeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
    }

    /// Global, top-left origin, points.
    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let origin = point(element, kAXPositionAttribute), let size = size(element) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    @discardableResult
    static func move(_ element: AXUIElement, to frame: CGRect) -> Bool {
        var origin = frame.origin
        var size = frame.size
        guard let position = AXValueCreate(.cgPoint, &origin), let extent = AXValueCreate(.cgSize, &size) else { return false }
        let moved = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, position) == .success
        _ = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, extent)
        return moved
    }

    static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    static func press(_ element: AXUIElement) -> Bool {
        AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    static func settable(_ element: AXUIElement, _ name: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success && settable.boolValue
    }

    static func set(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) -> Bool {
        AXUIElementSetAttributeValue(element, name as CFString, value) == .success
    }

    /// The deepest control of this app at a global point.
    static func element(at point: CGPoint, pid: pid_t) -> AXUIElement? {
        var found: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app(pid), Float(point.x), Float(point.y), &found) == .success else { return nil }
        return found
    }

    /// What a person would call the control: its title, description, value or placeholder.
    static func label(_ element: AXUIElement) -> String {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXPlaceholderValueAttribute,
                     kAXHelpAttribute] {
            if let text = string(element, name)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return text
            }
        }
        if let title = AX.element(element, kAXTitleUIElementAttribute), let text = string(title, kAXValueAttribute), !text.isEmpty {
            return text
        }
        return ""
    }

    /// Chromium and Electron apps build their accessibility tree only when asked.
    static func enableWebAccessibility(_ pid: pid_t) {
        let application = app(pid)
        _ = set(application, "AXManualAccessibility", kCFBooleanTrue)
        _ = set(application, "AXEnhancedUserInterface", kCFBooleanTrue)
    }

    struct Node {
        let element: AXUIElement
        let role: String
        let label: String
        let frame: CGRect?
        let depth: Int
    }

    /// The controls under `root`, depth first, at most `limit` of them.
    static func walk(_ root: AXUIElement, limit: Int, maxDepth: Int = 40) -> [Node] {
        var nodes: [Node] = []
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        while let (element, depth) = stack.popLast(), nodes.count < limit {
            nodes.append(Node(element: element, role: role(element), label: label(element), frame: frame(element), depth: depth))
            if depth < maxDepth {
                for child in children(element).reversed() { stack.append((child, depth + 1)) }
            }
        }
        return nodes
    }

    /// The window's text in reading order: what static text, fields and headings hold.
    static func text(_ root: AXUIElement, maxChars: Int) -> String {
        let textual: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXHeading", "AXLink", "AXButton",
                                    "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXCell"]
        var parts: [String] = []
        var total = 0
        for node in walk(root, limit: 4000) where textual.contains(node.role) && !node.label.isEmpty {
            if parts.last == node.label { continue }
            parts.append(node.label)
            total += node.label.count + 1
            if total >= maxChars { break }
        }
        let joined = parts.joined(separator: "\n")
        return joined.count > maxChars ? String(joined.prefix(maxChars)) + "…" : joined
    }
}
