import Foundation
import ApplicationServices
import CoreGraphics

public struct AXNode: Sendable {
    /// Assigned only to actionable nodes — this is the handle an agent clicks by.
    public let index: Int?
    public let role: String
    public let label: String
    public let frame: CGRect?
    public let actions: [String]
    public let depth: Int
    public let enabled: Bool
    /// True only when SpaceO shortened the accessible name or value for this label.
    public let labelTruncated: Bool
    /// The accessible name alone — `label` without the composed ` · value: …` half. Nil for
    /// nodes built without a separate name, which then match on `label`.
    public let name: String?
    /// Rendered state tokens such as `checked`, `expanded`, `selected`, `focused`.
    public let states: [String]

    init(index: Int?, role: String, label: String, frame: CGRect?, actions: [String],
         depth: Int, enabled: Bool, labelTruncated: Bool = false,
         name: String? = nil, states: [String] = []) {
        self.index = index
        self.role = role
        self.label = label
        self.frame = frame
        self.actions = actions
        self.depth = depth
        self.enabled = enabled
        self.labelTruncated = labelTruncated
        self.name = name
        self.states = states
    }

    public var isActionable: Bool { index != nil }

    /// What label matching compares against: the accessible name when the node has one, and
    /// the label otherwise — a static text or bare field whose only content is its value.
    var matchText: String {
        if let name, !name.isEmpty { return name }
        return label
    }
}

/// How `wait element_label|element_gone` and `click label:` compare a requested label with
/// the tree. Matching the whole rendered `name · value: …` string meant `element_label "Name"`
/// never matched the field it names; the accessible name is what an agent reads and repeats.
public struct AXLabelMatcher: Equatable, Sendable {
    /// Longest accessible label, label query, or label-like wait value, in UTF-8 bytes. Reads
    /// clip labels to it, so nothing can be asked for that a read could not show.
    public static let maximumTextBytes = 480

    public enum Mode: String, Sendable, CaseIterable {
        /// The name (or, for a nameless node, the label) equals the text exactly.
        case exact
        /// The name (or label) contains the text, case-insensitively.
        case contains
    }

    public var text: String
    public var mode: Mode
    /// Normalised `AX…` role, or nil for any role.
    public var role: String?

    public init(text: String, mode: Mode = .exact, role: String? = nil) {
        self.text = text
        self.mode = mode
        self.role = role.map { $0.hasPrefix("AX") ? $0 : "AX" + $0 }
    }

    /// Validate the wire `match` and `role` fields: bounded, known mode, plain role name.
    public static func parse(text: String, match: String?, role: String?) throws -> AXLabelMatcher {
        var mode = Mode.exact
        if let match {
            guard let parsed = Mode(rawValue: match) else {
                throw SpaceOError.badRequest("match must be " + alternatives(Mode.allCases.map(\.rawValue)))
            }
            mode = parsed
        }
        if let role {
            guard !role.isEmpty, role.utf8.count <= 64,
                  role.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) }) else {
                throw SpaceOError.badRequest(
                    "role must be 1 through 64 letters or digits, such as Button or AXTextField")
            }
        }
        return AXLabelMatcher(text: text, mode: mode, role: role)
    }

    public func matches(_ node: AXNode) -> Bool {
        if let role, node.role.lowercased() != role.lowercased() { return false }
        switch mode {
        case .exact:
            // The full rendered label still matches too, so text copied verbatim from a read
            // keeps working.
            return node.matchText == text || node.label == text
        case .contains:
            return node.matchText.range(of: text, options: [.caseInsensitive]) != nil
        }
    }
}

public struct FocusedWindowObservation: Equatable, Sendable {
    public let windowID: CGWindowID
    public let modal: Bool

    public init(windowID: CGWindowID, modal: Bool) {
        self.windowID = windowID
        self.modal = modal
    }
}

/// A walked accessibility tree with stable indices for its actionable elements.
///
/// Indexed AX addressing is SpaceO's primary interaction channel. `click --element 7` beats
/// pixel coordinates on every axis: no HiDPI maths, no occlusion sensitivity, no near-misses,
/// and it keeps working if the window moves between the screenshot and the click.
public struct AXSnapshot {
    public let pid: pid_t
    public let windowID: CGWindowID
    public let processIdentity: ProcessIdentity
    public let generation: UUID
    public let nodes: [AXNode]
    private let elements: [Int: AXUIElement]
    /// Which budget stopped the walk early, or nil when the whole tree was read.
    public let truncatedBy: AXTraversalStopReason?

    public var actionableCount: Int { elements.count }

    init(
        pid: pid_t,
        windowID: CGWindowID,
        processIdentity: ProcessIdentity,
        generation: UUID,
        nodes: [AXNode],
        elements: [Int: AXUIElement],
        truncatedBy: AXTraversalStopReason? = nil
    ) {
        self.pid = pid
        self.windowID = windowID
        self.processIdentity = processIdentity
        self.generation = generation
        self.nodes = nodes
        self.elements = elements
        self.truncatedBy = truncatedBy
    }

    /// The machine-readable footer every screen read ends with. `value_clipped` covers labels
    /// shortened by SpaceO, which is a milder truncation than a stopped walk. The optional
    /// outline argument is retained for source compatibility; rendered punctuation is not evidence.
    public func truncationReport(shown: Int? = nil, outline _: String? = nil) -> TruncationReport {
        let count = shown ?? actionableCount
        if let truncatedBy {
            return TruncationReport(
                shown: count, truncated: true, reason: "traversal_budget",
                hint: "the walk stopped at the \(truncatedBy.rawValue) budget; use spaceo_find for a specific control, or scroll and read again")
        }
        // A diff may omit unchanged clipped values. Consult the original snapshot's evidence
        // so an empty delta stays partial, without mistaking ordinary UI ellipses for clipping.
        if nodes.contains(where: { $0.labelTruncated }) {
            return TruncationReport(
                shown: count, truncated: true, reason: "value_clipped",
                hint: "long values were clipped (…); use spaceo_read_text for the full text")
        }
        return TruncationReport(shown: count, truncated: false)
    }

    /// A partial tree cannot prove absence, and visible static labels count as elements too.
    func waitProbe(_ condition: WaitCondition, matcher supplied: AXLabelMatcher? = nil) -> WaitProbeResult {
        let id = generation.uuidString.lowercased()
        let matcher = supplied ?? AXLabelMatcher(text: condition.value ?? "")
        // Prefer an actionable match so the receipt carries an index the agent can click.
        let match = nodes.first { $0.isActionable && matcher.matches($0) }
            ?? nodes.first { matcher.matches($0) }
        if case .elementLabel = condition {
            return match.map { .met(WaitProbe(matchedIndex: $0.index, snapshotID: id)) }
                ?? .notYet(WaitProbe(snapshotID: id))
        }
        return match == nil && !truncationReport().truncated
            ? .met(WaitProbe(snapshotID: id)) : .notYet(WaitProbe(snapshotID: id))
    }

    public func element(at index: Int) -> AXUIElement? { elements[index] }

    public func node(at index: Int) -> AXNode? { nodes.first { $0.index == index } }

    public func uniqueIndex(label: String) throws -> Int {
        try uniqueIndex(matching: AXLabelMatcher(text: label))
    }

    /// Resolve exactly one enabled actionable node the matcher accepts, or refuse and name the
    /// candidates so the agent can narrow the request instead of re-reading the screen.
    public func uniqueIndex(matching matcher: AXLabelMatcher) throws -> Int {
        var matches: [AXNode] = []
        for node in nodes where node.index != nil && node.enabled && matcher.matches(node) {
            matches.append(node)
            if matches.count > 5 { break }
        }
        guard let index = matches.first?.index else {
            let kind = matcher.mode == .exact ? "exact label" : "label containing that text"
            let role = matcher.role.map { " and role \($0)" } ?? ""
            throw SpaceOError.windowNotReady(
                "no enabled control with that \(kind)\(role); refresh ax after the transition")
        }
        guard matches.count == 1 else {
            let shown = matches.prefix(5).map { $0.renderedLine() }.joined(separator: "; ")
            let more = matches.count > 5 ? "; …" : ""
            throw SpaceOError.badRequest(
                "accessible label is ambiguous (\(shown)\(more)); add a role, use match exact, "
                    + "or choose an indexed target from a fresh snapshot")
        }
        return index
    }

    public func find(_ text: String) -> [AXNode] {
        find(text, role: nil, limit: Int.max)
    }

    /// Case-insensitive substring search over label and role, optionally filtered by role
    /// (`Button` and `AXButton` both match), bounded to `limit` hits in tree order.
    public func find(_ text: String, role: String?, limit: Int) -> [AXNode] {
        guard limit > 0 else { return [] }
        let needle = text.lowercased()
        let wantedRole = role.map { $0.hasPrefix("AX") ? $0 : "AX" + $0 }?.lowercased()
        var hits: [AXNode] = []
        for node in nodes where node.isActionable {
            if let wantedRole, node.role.lowercased() != wantedRole { continue }
            guard needle.isEmpty
                || node.label.lowercased().contains(needle)
                || node.role.lowercased().contains(needle) else { continue }
            hits.append(node)
            if hits.count >= limit { break }
        }
        return hits
    }

    /// One outline line for a single node, in the same shape `outline()` prints, plus its frame
    /// so a `find` hit can be clicked by coordinate as well as by index.
    public func line(for node: AXNode, includeFrame: Bool = false) -> String {
        var line = node.renderedLine()
        if includeFrame, let center = node.renderedCenter() {
            line += "  at \(center) global"
        }
        return line
    }

    /// Markdown-ish outline. Actionable nodes carry their index in brackets.
    public func outline(includeNonActionable: Bool = false) -> String {
        var result = ""
        let maximumReservation = 4 * 1_024 * 1_024
        var reservation = 0
        for node in nodes where node.isActionable || includeNonActionable {
            reservation += min(node.label.utf8.count, maximumReservation - reservation)
            reservation += min(node.role.utf8.count, maximumReservation - reservation)
            reservation += min(64, maximumReservation - reservation)
            if reservation == maximumReservation { break }
        }
        result.reserveCapacity(reservation)
        var hasLines = false
        for node in nodes where node.isActionable || includeNonActionable {
            if hasLines { result += "\n" }
            node.appendRenderedLine(to: &result, indented: true)
            hasLines = true
        }
        return hasLines ? result : "(no actionable elements found)"
    }
}

public enum AXTree {

    /// Roles that are worth handing an agent an index for.
    static let actionableRoles: Set<String> = [
        "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXMenuItem", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider",
        "AXTabGroup", "AXRow", "AXCell", "AXDisclosureTriangle", "AXIncrementor", "AXStepper",
        "AXColorWell", "AXSegmentedControl", "AXToolbarButton",
    ]

    /// Walk an app's tree, or a single window's subtree.
    ///
    /// Bounded on purpose: a runaway tree (a big web page) would otherwise stall the agent.
    public static func snapshot(
        pid: pid_t,
        window: WindowRef? = nil,
        maxDepth: Int = 22,
        maxNodes: Int = 1500,
        generation: UUID = UUID()
    ) throws -> AXSnapshot {
        try snapshot(
            pid: pid,
            window: window,
            limits: AXTraversalLimits(maxDepth: maxDepth, maxNodes: maxNodes),
            generation: generation)
    }

    public static func snapshot(
        pid: pid_t,
        window: WindowRef? = nil,
        limits: AXTraversalLimits,
        generation: UUID = UUID()
    ) throws -> AXSnapshot {
        try limits.validate()
        guard AX.isTrusted else { throw SpaceOError.accessibilityDenied }
        guard let processIdentity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.windowNotFound("pid \(pid) exited before accessibility traversal")
        }

        let provider = SystemAXTraversalProvider()
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds },
            isCancelled: { Task.isCancelled })
        let root = try AXTraversal.root(
            pid: pid, window: window, provider: provider, budget: budget)
        let output = try AXTraversal.walk(
            root: root, provider: provider, budget: budget, keepPartial: true)
        guard ProcessIdentity.current(of: pid) == processIdentity else {
            throw SpaceOError.windowNotFound(
                "pid \(pid) changed identity during accessibility traversal")
        }
        return AXSnapshot(
            pid: pid,
            windowID: window?.windowID ?? 0,
            processIdentity: processIdentity,
            generation: generation,
            nodes: output.nodes,
            elements: output.elements,
            truncatedBy: output.truncatedBy)
    }

    /// The focused element's selected text, attributable to `windowID` only. Nil when the app
    /// will not say which window is focused, when it is another window, or when nothing is
    /// selected — never another window's selection.
    public static func selectedText(pid: pid_t, inWindow windowID: CGWindowID) -> String? {
        try? completeSelectedText(pid: pid, inWindow: windowID)
    }

    static func completeSelectedText(pid: pid_t, inWindow windowID: CGWindowID) throws -> String? {
        guard let element = focusedSelectionElement(pid: pid, inWindow: windowID) else { return nil }
        let text = try completeText(of: element, attribute: kAXSelectedTextAttribute as String,
                                    maximumBytes: SessionClipboard.maximumBytes)
        return text.isEmpty ? nil : text
    }

    static func selectedTextPreview(pid: pid_t, inWindow windowID: CGWindowID) throws -> String? {
        guard let element = focusedSelectionElement(pid: pid, inWindow: windowID) else { return nil }
        let read = try readTextAttribute(element, attribute: kAXSelectedTextAttribute as String,
                                        maxChars: 200, maximumBytes: 4096)
        return read.truncated ? read.text + "…" : (read.text.isEmpty ? nil : read.text)
    }

    private static func focusedSelectionElement(pid: pid_t, inWindow windowID: CGWindowID) -> AXUIElement? {
        guard focusedValueIsAttributable(
            focusedWindowID: focusedWindowID(pid: pid), to: windowID) else { return nil }
        let app = AX.application(pid)
        AX.setTimeout(app, seconds: 1.5)
        return AX.element(app, kAXFocusedUIElementAttribute as String)
    }

    static func valueText(of element: AXUIElement, maxChars: Int) throws -> (text: String, truncated: Bool) {
        try readTextAttribute(element, attribute: kAXValueAttribute as String,
                              maxChars: maxChars, maximumBytes: 8 * 1_048_576)
    }

    static func completeText(of element: AXUIElement, attribute: String,
                             maximumBytes: Int, requireValue: Bool = false) throws -> String {
        let read = try readTextAttribute(element, attribute: attribute, maxChars: nil,
                                        maximumBytes: maximumBytes, requireValue: requireValue)
        guard !read.truncated else {
            throw SpaceOError.unsupportedTarget("complete accessibility text could not be read within the \(maximumBytes)-byte and traversal budgets")
        }
        return read.text
    }

    private static func readTextAttribute(
        _ element: AXUIElement, attribute: String, maxChars: Int?, maximumBytes: Int,
        requireValue: Bool = false
    ) throws -> (text: String, truncated: Bool) {
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(maxDepth: 0, maxNodes: 1, maxAXCalls: 8),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        return try AXTraversal.textAttribute(element: element, attribute: attribute,
            provider: SystemAXTraversalProvider(), budget: budget, maxChars: maxChars,
            maximumBytes: maximumBytes, requireValue: requireValue)
    }

    /// The focused text element inside `windowID`, when the app agrees that window has focus and
    /// the element accepts a value assignment. This is the paste broker's fast path.
    public static func settableFocusedElement(pid: pid_t, inWindow windowID: CGWindowID) -> AXUIElement? {
        guard focusedValueIsAttributable(
            focusedWindowID: focusedWindowID(pid: pid), to: windowID) else { return nil }
        let app = AX.application(pid)
        AX.setTimeout(app, seconds: 1.5)
        guard let element = AX.element(app, kAXFocusedUIElementAttribute as String) else { return nil }
        let role = AX.role(element)
        guard ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) else { return nil }
        return element
    }

    /// Characters a whole-window text read may return.
    public static let textCharacterRange = 1...20_000

    /// Reading-order text of a whole window: every text-bearing node's value, joined by newlines,
    /// bounded to `maxChars`. Unlike `text(in:)` this does not stop at the first hit, so a
    /// document body, a terminal pane, or a settings page reads as a whole.
    public static func allText(
        in window: WindowRef,
        maxChars: Int,
        maxDepth: Int = 22
    ) throws -> (text: String, truncated: Bool) {
        guard textCharacterRange.contains(maxChars) else {
            throw SpaceOError.badRequest("text character limit must be from \(textCharacterRange.lowerBound) through \(textCharacterRange.upperBound)")
        }
        guard AX.isTrusted else { throw SpaceOError.accessibilityDenied }
        let limits = AXTraversalLimits(maxDepth: maxDepth, maxNodes: 4_000)
        let provider = SystemAXTraversalProvider()
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds },
            isCancelled: { Task.isCancelled })
        let root = try AXTraversal.root(
            pid: window.pid, window: window, provider: provider, budget: budget)
        return try AXTraversal.allText(root: root, provider: provider, budget: budget, maxChars: maxChars)
    }

    /// State a toggle's `AXValue` encodes: 0/1/2 for checkboxes and radio buttons (a tab is a
    /// radio button in a tab group), 0/1 for a disclosure triangle. Nil keeps the raw value.
    static func toggleState(role: String, value: String) -> String? {
        switch (role, value) {
        case ("AXCheckBox", "0"), ("AXRadioButton", "0"): return "unchecked"
        case ("AXCheckBox", "1"), ("AXRadioButton", "1"): return "checked"
        case ("AXCheckBox", "2"), ("AXRadioButton", "2"): return "mixed"
        case ("AXDisclosureTriangle", "0"): return "collapsed"
        case ("AXDisclosureTriangle", "1"): return "expanded"
        default: return nil
        }
    }

    /// The attribute that says whether a control is open: outline rows disclose, pop-ups and
    /// combo boxes expand. Disclosure triangles already said so through their value.
    static func expansionAttribute(role: String) -> String? {
        switch role {
        case "AXRow": return "AXDisclosing"
        case "AXComboBox", "AXPopUpButton", "AXMenuButton": return "AXExpanded"
        default: return nil
        }
    }

    /// Roles whose `AXSelected` is meaningful list or table selection.
    static let selectableRoles: Set<String> = ["AXRow", "AXCell"]

    /// Bounded read of the application's focused window and whether it is modal. Nil when
    /// Accessibility is unavailable or the application will not say — never a guess.
    public static func focusedWindowObservation(pid: pid_t) -> FocusedWindowObservation? {
        guard AX.isTrusted,
              let budget = try? AXTraversalBudget(
                  limits: AXTraversalLimits(
                      maxDepth: 1, maxNodes: 64, timeout: 0.5, maxAXCalls: 48,
                      maxAllocatedBytes: 64 * 1_024, childPageSize: 32, maxCallDuration: 0.25),
                  now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        else { return nil }
        return try? AXTraversal.focusedWindow(
            app: AX.application(pid), provider: SystemAXTraversalProvider(), budget: budget)
    }

    static let textRoles: Set<String> = [
        "AXStaticText", "AXTextArea", "AXTextField", "AXSearchField", "AXHeading", "AXLink",
        "AXCell", "AXRow", "AXMenuItem", "AXButton", "AXCheckBox", "AXRadioButton", "AXTab",
    ]

    /// Text roles whose AXValue is always a 0/1/2 state rather than readable text.
    static let stateValuedRoles: Set<String> = ["AXCheckBox", "AXRadioButton"]

    public static func focusedElement(pid: pid_t) -> AXUIElement? {
        let app = AX.application(pid)
        AX.setTimeout(app, seconds: 1.5)
        return AX.element(app, kAXFocusedUIElementAttribute as String)
    }

    /// Text of the focused element — but only when the application's focused window is the one
    /// the caller means, and `nil` otherwise.
    ///
    /// The focused element is the precise answer to "what did my keystrokes land in": it is the
    /// control that actually received them, which a positional walk of the window cannot
    /// identify. It is only *attributable* to a window when the app agrees that window has
    /// focus. Typing is delivered per-pid after a focus attempt this host cannot verify, so on
    /// an app with two documents open the unqualified app-wide read confirms `type --window A`
    /// by printing window B's text, with nothing in the response to say so. Returning `nil`
    /// instead lets the caller fall back to a window-scoped read rather than misattribute
    /// another window's content to this one.
    public static func focusedValue(pid: pid_t, inWindow windowID: CGWindowID) -> String? {
        guard focusedValueIsAttributable(
            focusedWindowID: focusedWindowID(pid: pid), to: windowID) else { return nil }
        let app = AX.application(pid)
        AX.setTimeout(app, seconds: 1.5)
        guard let element = AX.element(app, kAXFocusedUIElementAttribute as String)
        else { return nil }
        return AX.string(element, kAXValueAttribute as String)
    }

    /// The window an application itself considers focused, or nil when it will not say.
    ///
    /// This is the only answer available about where a per-pid keystroke will actually land:
    /// `CGEventPostToPid` addresses a *process*, and the process routes to its own key window.
    public static func focusedWindowID(pid: pid_t) -> CGWindowID? {
        let app = AX.application(pid)
        AX.setTimeout(app, seconds: 1.5)
        guard let window = AX.element(app, kAXFocusedWindowAttribute as String) else { return nil }
        let id = AX.windowID(window)
        return id == 0 ? nil : id
    }

    /// Ask an application to make one of its own windows the key window, without activating the
    /// application or raising it to the user's Space.
    ///
    /// Public Accessibility only: setting `AXMain`/`AXFocused` on a window element is an
    /// in-process request to the app, not `SLPSSetFrontProcessWithOptions`. It is best effort and
    /// deliberately unverified here — the caller re-reads `focusedWindowID` and decides. On a host
    /// with no focus-without-raise record this is the only lever that moves key focus at all, so
    /// without it an explicit `--window` on a multi-window app could never be honoured.
    @discardableResult
    public static func focusWindow(_ window: WindowRef) -> Bool {
        guard let element = WindowPlacement.element(for: window) else { return false }
        let main = AX.setBool(element, kAXMainAttribute as String, true)
        let focused = AX.setBool(element, kAXFocusedAttribute as String, true)
        return main || focused
    }

    /// Pure attribution rule, kept separate from the AX query the way
    /// `InputRouter.routeIdentityMatches` is, so it has deterministic regression coverage.
    ///
    /// An unknown focused window (`nil`, or the `0` that `_AXUIElementGetWindow` returns when it
    /// cannot answer) is not a match: "we could not tell" must not be read as "yes", or the
    /// misattribution this rule exists to prevent comes straight back.
    public static func focusedValueIsAttributable(
        focusedWindowID: CGWindowID?,
        to requestedWindowID: CGWindowID
    ) -> Bool {
        guard let focusedWindowID, focusedWindowID != 0, requestedWindowID != 0 else {
            return false
        }
        return focusedWindowID == requestedWindowID
    }

    /// Text content of the first text-bearing element inside a *specific* window.
    ///
    /// Scoped deliberately, and the fallback for `focusedValue(pid:inWindow:)`: asking the
    /// application for its focused element without qualifying the window answers about whichever
    /// window it currently considers focused. If the user (or another session) already had that
    /// app open, that is not necessarily our window, and a caller built on it reports nonsense.
    public static func text(in window: WindowRef, maxDepth: Int = 12) -> String? {
        guard (0...64).contains(maxDepth) else { return nil }
        return try? text(
            in: window,
            limits: AXTraversalLimits(
                maxDepth: maxDepth,
                maxNodes: 1_500,
                timeout: 2,
                maxAXCalls: 8_000,
                maxAllocatedBytes: 4 * 1_024 * 1_024,
                childPageSize: 32,
                maxCallDuration: 0.25))
    }

    /// Throwing text traversal for callers that need to distinguish "no text" from a provider
    /// that exceeded the safety envelope.
    public static func text(
        in window: WindowRef,
        limits: AXTraversalLimits
    ) throws -> String? {
        try limits.validate()
        guard AX.isTrusted else { throw SpaceOError.accessibilityDenied }

        let provider = SystemAXTraversalProvider()
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds },
            isCancelled: { Task.isCancelled })
        let root = try AXTraversal.root(
            pid: window.pid, window: window, provider: provider, budget: budget)
        return try AXTraversal.firstText(
            root: root,
            provider: provider,
            budget: budget,
            roles: ["AXTextArea", "AXTextField", "AXStaticText", "AXSearchField"])
    }
}
