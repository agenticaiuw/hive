import Foundation
import ApplicationServices
import CoreGraphics
import SpaceOPrivate

/// Thin, typed helpers over the C accessibility API.
///
/// AX is SpaceO's preferred channel for everything: it is coordinate-free, needs no focus,
/// and keeps working when a window is occluded. Synthetic events are the fallback.
public enum AX {

    public static var isTrusted: Bool { AXIsProcessTrusted() }

    public static func application(_ pid: pid_t) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    // MARK: - Attribute access

    public static func copyValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    public static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let string = rawString(element, attribute) else { return nil }
        guard string.utf8.count > 32_768 else { return string }
        return String(decoding: string.utf8.prefix(32_768), as: UTF8.self) + "…"
    }

    /// Only for callers that apply their own text/output budget. AX returns an attribute
    /// atomically; avoid an intermediate clipped copy that loses completeness evidence.
    static func rawString(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let raw = copyValue(element, attribute) else { return nil }
        return stringValue(raw)
    }

    static func stringValue(_ raw: CFTypeRef) -> String? {
        if let string = raw as? String { return string }
        if CFGetTypeID(raw) == AXValueGetTypeID() { return nil }
        return (raw as? NSNumber)?.stringValue
    }

    public static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        copyValue(element, attribute) as? Bool
    }

    public static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        guard let raw = copyValue(element, attribute) else { return [] }
        guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
        return (raw as! CFArray) as? [AXUIElement] ?? []
    }

    public static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let raw = copyValue(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }

    public static func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let raw = copyValue(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var out = CGPoint.zero
        guard AXValueGetValue((raw as! AXValue), .cgPoint, &out) else { return nil }
        return out
    }

    public static func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let raw = copyValue(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var out = CGSize.zero
        guard AXValueGetValue((raw as! AXValue), .cgSize, &out) else { return nil }
        return out
    }

    public static func frame(_ element: AXUIElement) -> CGRect? {
        guard let origin = point(element, kAXPositionAttribute as String),
              let size = size(element, kAXSizeAttribute as String) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// The application's accessibility element under a global screen point.
    ///
    /// `AXUIElementCopyElementAtPosition` hit-tests *every* window of the application in z-order
    /// and takes no window filter, so a caller that aimed at one particular window must use the
    /// `windowID:` overload below rather than this one.
    public static func element(at point: CGPoint, in pid: pid_t) -> AXUIElement? {
        guard point.x.isFinite, point.y.isFinite else { return nil }
        let app = application(pid)
        setTimeout(app, seconds: 1.0)
        var found: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            app, Float(point.x), Float(point.y), &found
        ) == .success else {
            return nil
        }
        return found
    }

    /// The accessibility element under a global screen point **inside one exact window**.
    ///
    /// Without the window id an app with two stacked windows — TextEdit with a document and an
    /// empty Untitled at identical frames — answers with the frontmost one. Pressing that element
    /// succeeds and reports a *confirmed* action for a control in a window the caller never
    /// addressed, which is the "agent believes it clicked" failure this module exists to prevent.
    /// Walking the hit result's ancestry to its `AXWindow` and requiring the id to match makes
    /// that impossible, the same way `textEditor(at:in:windowID:)` does.
    public static func element(
        at point: CGPoint,
        in pid: pid_t,
        windowID: CGWindowID
    ) -> AXUIElement? {
        element(element(at: point, in: pid),
                inWindow: windowID,
                provider: SystemAXAncestryProvider())
    }

    /// The window-scoped answer for a hit-test result: the element itself when its ancestry ends
    /// at `windowID`, and nil when it belongs to another window of the same application.
    ///
    /// Split out and generic over the provider so the scoping decision — the part that keeps a
    /// press inside the window the caller asked for — is testable against a stubbed hierarchy
    /// rather than only against a live application.
    static func element<P: AXAncestryProviding>(
        _ hit: P.Element?,
        inWindow windowID: CGWindowID,
        provider: P
    ) -> P.Element? {
        guard let hit, belongs(hit, toWindow: windowID, provider: provider) else { return nil }
        return hit
    }

    /// Whether an element sits inside the window with `windowID`, by walking `AXParent` to the
    /// enclosing `AXWindow`. Ancestry that cannot be resolved — a broken chain, a cycle, or a tree
    /// deeper than the walk allows — is a no, never a yes: an unproven window is exactly the case
    /// that must not be reported as a confirmed press.
    static func belongs<P: AXAncestryProviding>(
        _ element: P.Element,
        toWindow windowID: CGWindowID,
        provider: P
    ) -> Bool {
        var current = element
        var seen = Set<P.Element>()
        for _ in 0..<maxAncestryDepth {
            guard seen.insert(current).inserted else { return false }
            if provider.role(current) == kAXWindowRole as String {
                return provider.windowID(current) == windowID
            }
            guard let parent = provider.parent(current) else { return false }
            current = parent
        }
        return false
    }

    /// How far up an ancestry walk climbs before giving up.
    ///
    /// Not a round number picked for comfort: an Electron window's hit-test result was measured
    /// 30 levels below its `AXWindow` on a live host, and web content nests deeper than that
    /// routinely. Stopping short is not a harmless miss — it makes a press that could have been
    /// confirmed fall back to unverified synthetic delivery — so the ceiling only exists to bound
    /// a malformed or cyclic tree, and sits far above real ones. A wedged app is bounded by the
    /// per-application messaging timeout instead, which the hit test sets before walking.
    static let maxAncestryDepth = 128

    // MARK: - Mutation

    @discardableResult
    public static func setPoint(_ element: AXUIElement, _ attribute: String, _ value: CGPoint) -> Bool {
        guard value.x.isFinite, value.y.isFinite else { return false }
        var v = value
        guard let boxed = AXValueCreate(.cgPoint, &v) else { return false }
        return AXUIElementSetAttributeValue(element, attribute as CFString, boxed) == .success
    }

    @discardableResult
    public static func setSize(_ element: AXUIElement, _ attribute: String, _ value: CGSize) -> Bool {
        guard value.width.isFinite, value.height.isFinite,
              value.width > 0, value.height > 0 else { return false }
        var v = value
        guard let boxed = AXValueCreate(.cgSize, &v) else { return false }
        return AXUIElementSetAttributeValue(element, attribute as CFString, boxed) == .success
    }

    @discardableResult
    public static func setBool(_ element: AXUIElement, _ attribute: String, _ value: Bool) -> Bool {
        AXUIElementSetAttributeValue(
            element, attribute as CFString, (value ? kCFBooleanTrue : kCFBooleanFalse)!) == .success
    }

    @discardableResult
    public static func setString(_ element: AXUIElement, _ attribute: String, _ value: String) -> Bool {
        guard value.count <= 8_000, value.unicodeScalars.count <= 8_000,
              value.utf8.count <= 32_000 else { return false }
        return AXUIElementSetAttributeValue(
            element, attribute as CFString, value as CFTypeRef) == .success
    }

    @discardableResult
    public static func perform(_ element: AXUIElement, _ action: String) -> Bool {
        AXUIElementPerformAction(element, action as CFString) == .success
    }

    public static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let list = names as? [String] else { return [] }
        return list
    }

    // MARK: - Scrolling

    /// The scroll area at a global point **inside a specific window**.
    ///
    /// The window id is not optional decoration. `AXUIElementCopyElementAtPosition` hit-tests the
    /// whole application and answers with the frontmost window, so an app with two stacked
    /// windows — TextEdit with a document and an empty Untitled, which occupy identical frames —
    /// returns the wrong one. Scrolling it succeeds, reports success, and moves nothing the
    /// caller asked about. Resolving within the requested window makes that impossible.
    public static func scrollArea(
        at point: CGPoint,
        in pid: pid_t,
        windowID: CGWindowID
    ) -> AXUIElement? {
        try? scrollArea(
            at: point, in: pid, windowID: windowID, limits: scrollAreaLimits)
    }

    /// The safety envelope a scroll-area resolution runs under.
    ///
    /// Deliberately tighter than a snapshot's. This walk happens inside one `scroll` command
    /// while the daemon actor is held, so its ceiling is what *every other session* waits for in
    /// the worst case — a wedged or enormous accessibility graph must cost a bounded pause, not a
    /// stalled daemon. A second and a half is an order of magnitude above the tens of
    /// milliseconds a healthy application needs to answer, and well inside a client's own timeout.
    /// The node budget is what actually bounds a cyclic or million-row tree; the depth of 16
    /// matches the reach this resolution has always had.
    public static let scrollAreaLimits = AXTraversalLimits(
        maxDepth: 16,
        maxNodes: 1_200,
        timeout: 1.5,
        maxAXCalls: 6_000,
        maxAllocatedBytes: 2 * 1_024 * 1_024,
        childPageSize: 32,
        maxCallDuration: 0.25)

    /// Throwing form, so a caller can distinguish "this window exposes no scroll area under the
    /// point" (nil) from "the application could not be read inside the safety envelope"
    /// (`AXTraversalStopped`) — the second is a wedged or hostile provider, not an answer.
    static func scrollArea(
        at point: CGPoint,
        in pid: pid_t,
        windowID: CGWindowID,
        limits: AXTraversalLimits
    ) throws -> AXUIElement? {
        guard point.x.isFinite, point.y.isFinite else { return nil }
        let provider = SystemAXTraversalProvider()
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds },
            isCancelled: { Task.isCancelled })
        let window = try AXTraversal.root(
            pid: pid,
            window: WindowRef(windowID: windowID, pid: pid, title: "", frame: .zero),
            provider: provider,
            budget: budget)
        return try AXTraversal.deepestScrollArea(
            root: window, containing: point, provider: provider, budget: budget)
    }

    /// Whether a point is inside a semantic code editor in one exact application window.
    ///
    /// Chromium exposes Monaco's editor surface as an `AXCodeStyleGroup` ancestor of the element
    /// under the point. The editor's separate AXTextArea is a 1×1 screen-reader proxy, so using
    /// its frame would reject the entire visible editor. Routing every point in the window to
    /// `activeTextEditor` would be worse: a wheel over the sidebar or terminal would move the
    /// document. Walk the hit-test ancestry and require both the code marker and exact window.
    public static func textEditor(
        at point: CGPoint,
        in pid: pid_t,
        windowID: CGWindowID
    ) -> AXUIElement? {
        guard var current = element(at: point, in: pid) else { return nil }
        var seen = Set<CFHashCode>()
        var editor: AXUIElement?
        for _ in 0..<maxAncestryDepth {
            guard seen.insert(CFHash(current)).inserted else { return nil }
            if role(current) == kAXTextAreaRole as String
                || string(current, kAXSubroleAttribute as String) == "AXCodeStyleGroup" {
                editor = current
            }
            if role(current) == kAXWindowRole as String {
                return self.windowID(current) == windowID ? editor : nil
            }
            guard let parent = element(current, kAXParentAttribute as String) else {
                return nil
            }
            current = parent
        }
        return nil
    }

    /// Move a scroll area by a pixel delta, expressed through its scroll bar's documented
    /// 0...1 `AXValue`.
    ///
    /// This is the *primary* scroll path, not a fallback. Synthetic scroll wheel events posted
    /// with `CGEventPostToPid` do not reach AppKit on a host without the private
    /// focus-without-raise record: measured against TextEdit on macOS 27, pixel and line units,
    /// stamped and unstamped, with and without an explicit location, all reported success and
    /// moved nothing. A scroll bar's value is public API, is settable, and can be read back to
    /// confirm the scroll actually happened.
    ///
    /// Returns the achieved value when the position changed, or nil when this element cannot be
    /// scrolled — never a silent success.
    @discardableResult
    public static func scroll(
        _ scrollArea: AXUIElement,
        byPixels delta: CGFloat,
        horizontal: Bool = false
    ) -> Double? {
        let barAttribute = horizontal
            ? kAXHorizontalScrollBarAttribute
            : kAXVerticalScrollBarAttribute
        guard let raw = copyValue(scrollArea, barAttribute as String),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let bar = (raw as! AXUIElement)

        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable)
        guard settable.boolValue,
              let current = number(bar, kAXValueAttribute as String) else { return nil }

        // AXValue is a fraction of the scrollable range, so a pixel delta needs the range to
        // convert. The scrollable extent is the content's overflow beyond the viewport.
        guard let viewport = size(scrollArea, kAXSizeAttribute as String) else { return nil }
        let extent = horizontal ? viewport.width : viewport.height
        guard extent > 0 else { return nil }
        let contentExtent = contentSize(of: scrollArea, horizontal: horizontal) ?? (extent * 2)
        let scrollable = max(1, contentExtent - extent)

        let target = min(1, max(0, current + Double(delta / scrollable)))
        guard AXUIElementSetAttributeValue(
            bar, kAXValueAttribute as CFString, target as NSNumber) == .success else {
            return nil
        }
        // Compare the read-back against where we started, not merely against nil. A scroll area
        // pinned at its limit accepts the assignment and does not move, and an element that
        // ignores the write reports success too — returning the new value without checking it
        // changed is how a scroll that did nothing still reported that it scrolled.
        guard let achieved = number(bar, kAXValueAttribute as String),
              abs(achieved - current) > 0.0001 else { return nil }
        return achieved
    }

    private static func contentSize(
        of scrollArea: AXUIElement,
        horizontal: Bool
    ) -> CGFloat? {
        guard let children = copyValue(scrollArea, kAXChildrenAttribute as String)
                as? [AXUIElement] else { return nil }
        var largest: CGFloat = 0
        for child in children.prefix(16) {
            guard let childSize = size(child, kAXSizeAttribute as String) else { continue }
            largest = max(largest, horizontal ? childSize.width : childSize.height)
        }
        return largest > 0 ? largest : nil
    }

    public static func number(_ element: AXUIElement, _ attribute: String) -> Double? {
        guard let raw = copyValue(element, attribute) else { return nil }
        if let value = raw as? Double { return value }
        if let value = raw as? NSNumber { return value.doubleValue }
        return nil
    }

    // MARK: - Identity

    public static func windowID(_ element: AXUIElement) -> CGWindowID {
        SPOWindowIDForAXElement(element)
    }

    public static func role(_ element: AXUIElement) -> String {
        string(element, kAXRoleAttribute as String) ?? "AXUnknown"
    }

    public static func label(_ element: AXUIElement) -> String {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                     kAXHelpAttribute, kAXPlaceholderValueAttribute] {
            if let s = string(element, attr as String), !s.isEmpty {
                let limit = AXLabelMatcher.maximumTextBytes
                return s.utf8.count > limit
                    ? String(decoding: s.utf8.prefix(limit), as: UTF8.self) + "…"
                    : s
            }
        }
        return ""
    }

    /// Set the per-application timeout so a wedged app cannot stall the agent.
    @discardableResult
    public static func setTimeout(_ element: AXUIElement, seconds: Float) -> Bool {
        AXUIElementSetMessagingTimeout(element, seconds) == .success
    }
}

/// The three reads an ancestry walk needs: role, parent, and window id.
///
/// Deliberately narrow, and generic over the element type, so window scoping can be exercised
/// against an in-memory hierarchy of stacked windows instead of only against a live application.
protocol AXAncestryProviding {
    associatedtype Element: Hashable

    func role(_ element: Element) -> String
    func parent(_ element: Element) -> Element?
    func windowID(_ element: Element) -> CGWindowID
}

struct SystemAXAncestryProvider: AXAncestryProviding {
    func role(_ element: AXUIElement) -> String { AX.role(element) }

    func parent(_ element: AXUIElement) -> AXUIElement? {
        AX.element(element, kAXParentAttribute as String)
    }

    func windowID(_ element: AXUIElement) -> CGWindowID { AX.windowID(element) }
}
