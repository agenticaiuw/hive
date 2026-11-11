import Foundation
import ApplicationServices

/// Selection edits use Accessibility so an inactive AppKit document cannot silently append
/// after an ignored synthetic Command-A. No shared pasteboard or global focus is used.
enum NativeTextInput {
    static let maximumDocumentBytes = 1_048_576

    /// One envelope for qualifying the focused field and for every target check, read, and
    /// write of the edit that follows. A slow or deep provider is stopped by this aggregate
    /// deadline and call count instead of each step starting a fresh timeout of its own.
    static let limits = AXTraversalLimits(
        maxDepth: 1, maxNodes: 256, timeout: 3, maxAXCalls: 1_024,
        maxAllocatedBytes: 8 * maximumDocumentBytes, childPageSize: 1, maxCallDuration: 0.25)

    static let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

    struct Driver {
        let canSelect: Bool
        let canInsert: Bool
        var allowsMultiline = true
        let value: () throws -> String
        let selection: () throws -> CFRange
        let select: (CFRange) throws -> Void
        let insert: (String) throws -> Void
        /// Re-proves that the qualified element still has focus in the qualified window. Run
        /// before every decline, so a keystroke fallback is never aimed at a target that moved.
        var verifyTarget: () throws -> Void = {}
    }

    /// The focused element is no longer the qualified target. Kept distinct from an unsupported
    /// read, which may fall back to keys; this never does. Converted to `unsupported_target`
    /// before it leaves this type.
    struct TargetChanged: Error {
        let detail: String
    }

    struct Qualified<Element> {
        let element: Element
        let canSelect: Bool
        let canInsert: Bool
        let allowsMultiline: Bool
    }

    /// Nil means the focused element is not a native text field this module edits, and the
    /// caller's key route stays in force. Throws when the target moved or the budget ran out.
    static func driver(for window: WindowRef) throws -> Driver? {
        guard AX.isTrusted, let identity = ProcessIdentity.current(of: window.pid) else { return nil }
        let provider = SystemAXTraversalProvider()
        let app = AX.application(window.pid)
        return try publicErrors { () throws -> Driver? in
            let budget = try AXTraversalBudget(
                limits: limits, now: { DispatchTime.now().uptimeNanoseconds },
                isCancelled: { Task.isCancelled })
            guard let target = try qualify(app: app, windowID: window.windowID,
                                           provider: provider, budget: budget) else { return nil }
            let element = target.element
            let requireTarget = { () throws -> Void in
                guard ProcessIdentity.current(of: window.pid) == identity else {
                    throw TargetChanged(detail: "focused text target's process changed")
                }
                try verifyTarget(element, app: app, windowID: window.windowID,
                                 provider: provider, budget: budget)
            }
            return Driver(canSelect: target.canSelect, canInsert: target.canInsert,
                          allowsMultiline: target.allowsMultiline, value: {
                try requireTarget()
                guard let text = try call(element, provider, budget, {
                    provider.text(element, attribute: kAXValueAttribute as String)
                }) else {
                    throw SpaceOError.unsupportedTarget("focused field did not expose its current text value")
                }
                guard text.utf8.count <= maximumDocumentBytes else {
                    throw SpaceOError.unsupportedTarget("focused text exceeds the \(maximumDocumentBytes)-byte edit budget")
                }
                try budget.consumeAllocation(text.utf8.count)
                return text
            }, selection: {
                try requireTarget()
                let raw = try call(element, provider, budget) {
                    AX.copyValue(element, kAXSelectedTextRangeAttribute as String)
                }
                guard let raw, CFGetTypeID(raw) == AXValueGetTypeID() else {
                    throw SpaceOError.unsupportedTarget("focused field has no readable text selection")
                }
                var range = CFRange()
                guard AXValueGetValue(raw as! AXValue, .cfRange, &range) else {
                    throw SpaceOError.unsupportedTarget("focused field returned an invalid text selection")
                }
                return range
            }, select: { range in
                try requireTarget()
                var range = range
                guard let value = AXValueCreate(.cfRange, &range),
                      try call(element, provider, budget, {
                          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
                      }) else {
                    throw SpaceOError.unsupportedTarget("focused field rejected text selection; nothing typed")
                }
            }, insert: { text in
                try requireTarget()
                guard try call(element, provider, budget, {
                    AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success
                }) else {
                    throw SpaceOError.unsupportedTarget("focused field rejected selected-text replacement; delivery unconfirmed")
                }
            }, verifyTarget: requireTarget)
        }
    }

    /// The focused native text element of `windowID`, read entirely inside `budget`. Nil when
    /// the application will not name a focused window or element, or the element is not an
    /// editable native field; an application that now names another window is a moved target.
    static func qualify<P: NativeTextProviding>(
        app: P.Element, windowID: CGWindowID, provider: P, budget: AXTraversalBudget
    ) throws -> Qualified<P.Element>? {
        guard windowID != 0,
              try focusedWindowMatches(app: app, windowID: windowID, provider: provider, budget: budget)
        else { return nil }
        // Qualification may consume most of the deadline. Re-prove the window before
        // declining to the caller's key route rather than using the earlier focus proof.
        func keyRoute() throws -> Qualified<P.Element>? {
            guard try focusedWindowMatches(app: app, windowID: windowID, provider: provider, budget: budget) else {
                throw TargetChanged(detail: "window \(windowID) stopped reporting focus")
            }
            return nil
        }
        guard let element = try call(app, provider, budget, {
            provider.element(app, attribute: kAXFocusedUIElementAttribute as String)
        }) else { return try keyRoute() }
        let role = try call(element, provider, budget) {
            provider.string(element, attribute: kAXRoleAttribute as String)
        }
        guard let role, editableRoles.contains(role),
              try call(element, provider, budget, {
                  provider.string(element, attribute: kAXSubroleAttribute as String)
              }) != "AXSecureTextField",
              try isNativeTextElement(element, inWindow: windowID, provider: provider, budget: budget)
        else { return try keyRoute() }
        return Qualified(
            element: element,
            canSelect: try call(element, provider, budget) {
                provider.isSettable(element, attribute: kAXSelectedTextRangeAttribute as String)
            },
            canInsert: try call(element, provider, budget) {
                provider.isSettable(element, attribute: kAXSelectedTextAttribute as String)
            },
            allowsMultiline: role == "AXTextArea")
    }

    private static func focusedWindowMatches<P: AXTraversalProviding>(
        app: P.Element, windowID: CGWindowID, provider: P, budget: AXTraversalBudget
    ) throws -> Bool {
        guard let window = try call(app, provider, budget, {
            provider.element(app, attribute: kAXFocusedWindowAttribute as String)
        }) else { return false }
        let focusedID = try call(window, provider, budget) { provider.windowID(window) }
        guard focusedID != 0 else { return false }
        guard focusedID == windowID else {
            throw TargetChanged(detail: "window \(windowID) is no longer this application's focused window")
        }
        return true
    }

    static func verifyTarget<P: AXTraversalProviding>(
        _ element: P.Element, app: P.Element, windowID: CGWindowID, provider: P,
        budget: AXTraversalBudget
    ) throws {
        let window = try call(app, provider, budget) {
            provider.element(app, attribute: kAXFocusedWindowAttribute as String)
        }
        let focusedID = try window.map { window in
            try call(window, provider, budget) { provider.windowID(window) }
        }
        guard focusedID == windowID,
              try call(app, provider, budget, {
                  provider.element(app, attribute: kAXFocusedUIElementAttribute as String)
              }) == element else {
            throw TargetChanged(detail: "focused text target changed")
        }
    }

    static func isNativeTextElement<P: AXTraversalProviding>(
        _ element: P.Element, inWindow windowID: CGWindowID, provider: P, budget: AXTraversalBudget
    ) throws -> Bool {
        var current = element
        var seen = Set<P.Element>()
        for _ in 0..<AX.maxAncestryDepth {
            guard seen.insert(current).inserted else { return false }
            let role = try call(current, provider, budget) {
                provider.string(current, attribute: kAXRoleAttribute as String)
            }
            if role == "AXWebArea" { return false }
            if role == "AXWindow" {
                guard windowID != 0 else { return false }
                return try call(current, provider, budget) { provider.windowID(current) } == windowID
            }
            guard let parent = try call(current, provider, budget, {
                provider.element(current, attribute: kAXParentAttribute as String)
            }) else { return false }
            current = parent
        }
        return false
    }

    private static func call<P: AXTraversalProviding, T>(
        _ element: P.Element, _ provider: P, _ budget: AXTraversalBudget, _ operation: () throws -> T
    ) throws -> T {
        try AXTraversal.boundedCall(element, provider: provider, budget: budget, operation)
    }

    /// Internal refusals leave this type as the public `unsupported_target` code.
    private static func publicErrors<T>(_ body: () throws -> T) throws -> T {
        do { return try body() }
        catch let changed as TargetChanged {
            throw SpaceOError.unsupportedTarget("\(changed.detail); edit refused, nothing typed")
        } catch let stopped as AXTraversalStopped {
            throw SpaceOError.unsupportedTarget(
                "focused text target could not be verified within its Accessibility budget "
                + "(\(stopped.reason.rawValue)); edit refused, nothing typed")
        }
    }

    /// The keystroke route stays available only for a field that cannot be edited semantically,
    /// and only after the same target is re-proven. A moved target or exhausted budget refuses.
    private static func decline(_ driver: Driver, after error: Error? = nil) throws -> Bool {
        if let error, error is TargetChanged || error is AXTraversalStopped { throw error }
        try driver.verifyTarget()
        return false
    }

    static func normalizedText(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    static func isSelectAll(_ combo: KeyCombo) -> Bool {
        combo.keyCode == 0 && combo.flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn]) == .maskCommand
    }

    static func expectedValue(_ value: String, selection: CFRange, text: String) throws -> String {
        guard value.utf8.count <= maximumDocumentBytes,
              selection.location >= 0, selection.length >= 0,
              selection.location <= value.utf16.count,
              selection.length <= value.utf16.count - selection.location,
              let range = Range(NSRange(location: selection.location, length: selection.length), in: value) else {
            throw SpaceOError.unsupportedTarget("text selection is invalid or exceeds the edit budget; nothing typed")
        }
        let units = Array(value.utf16)
        for boundary in [selection.location, selection.location + selection.length] {
            if boundary < units.count, (0xDC00...0xDFFF).contains(units[boundary]) {
                throw SpaceOError.unsupportedTarget("text selection splits a Unicode scalar; nothing typed")
            }
        }
        let result = value.replacingCharacters(in: range, with: text)
        guard result.utf8.count <= maximumDocumentBytes else {
            throw SpaceOError.unsupportedTarget("resulting text exceeds the edit budget; nothing typed")
        }
        return result
    }

    @discardableResult
    static func selectAll(_ driver: Driver) throws -> Bool {
        try publicErrors { try performSelectAll(driver) }
    }

    /// False means no semantic edit was attempted; a rejected/ignored write throws and must
    /// never fall through to synthetic delivery, which could insert the payload twice.
    static func type(_ text: String, replace: Bool, driver: Driver) throws -> Bool {
        try publicErrors { try performType(text, replace: replace, driver: driver) }
    }

    private static func performSelectAll(_ driver: Driver) throws -> Bool {
        guard driver.canSelect else { return try decline(driver) }
        // Unsupported pre-write reads leave the existing key route available. Once selection is
        // attempted, failure must throw rather than deliver a second operation.
        let before: String
        do { before = try driver.value() } catch { return try decline(driver, after: error) }
        guard before.utf8.count <= maximumDocumentBytes else { return try decline(driver) }
        let range = CFRange(location: 0, length: before.utf16.count)
        try driver.select(range)
        let selected = try driver.selection()
        guard selected.location == range.location, selected.length == range.length,
              try driver.value() == before else {
            throw SpaceOError.unsupportedTarget("select-all was not confirmed; nothing typed")
        }
        return true
    }

    private static func performType(_ text: String, replace: Bool, driver: Driver) throws -> Bool {
        guard driver.canInsert else {
            if replace { throw SpaceOError.unsupportedTarget("replace requires a focused field that supports Accessibility selected-text editing; nothing typed") }
            return try decline(driver)
        }
        let text = normalizedText(text)
        if !driver.allowsMultiline && text.contains("\n") {
            if replace { throw SpaceOError.unsupportedTarget("multiline replacement requires a multiline text field; nothing typed") }
            return try decline(driver)
        }
        if !replace {
            if text.isEmpty { return try decline(driver) }
            let selected: CFRange
            do { selected = try driver.selection() } catch { return try decline(driver, after: error) }
            guard selected.location >= 0, selected.length >= 0 else {
                throw SpaceOError.unsupportedTarget("focused text selection is invalid; nothing typed")
            }
            if selected.length == 0 { return try decline(driver) }
        }
        if replace, try !performSelectAll(driver) {
            throw SpaceOError.unsupportedTarget("replace requires a confirmable select-all; nothing typed")
        }
        let before: String
        do { before = try driver.value() }
        catch {
            if !replace { return try decline(driver, after: error) }
            throw error
        }
        if !replace, before.utf8.count > maximumDocumentBytes { return try decline(driver) }
        let selected = try driver.selection()
        let expected = try expectedValue(before, selection: selected, text: text)
        do {
            try driver.insert(text)
            guard try driver.value() == expected else {
                throw SpaceOError.unsupportedTarget("selected-text readback did not match")
            }
        } catch {
            throw SpaceOError.unsupportedTarget("selected-text edit could not be confirmed; delivery unconfirmed, do not retry blindly")
        }
        return true
    }
}

/// The traversal surface plus the one settability probe that qualifying an editable field needs.
protocol NativeTextProviding: AXTraversalProviding {
    func isSettable(_ element: Element, attribute: String) -> Bool
}

extension SystemAXTraversalProvider: NativeTextProviding {
    func isSettable(_ element: AXUIElement, attribute: String) -> Bool {
        var answer = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &answer) == .success && answer.boolValue
    }
}
