import Foundation
import ApplicationServices
import CoreGraphics

/// Hard limits for one accessibility-tree request.
///
/// Accessibility providers live in another process. A node limit alone is not enough: a
/// provider can be slow, expose an enormous child array, or return unusually large strings.
/// These limits therefore cover elapsed monotonic time, remote calls, retained nodes, and
/// aggregate data copied from the provider.
public struct AXTraversalLimits: Sendable, Equatable {
    public var maxDepth: Int
    public var maxNodes: Int
    public var timeout: TimeInterval
    public var maxAXCalls: Int
    public var maxAllocatedBytes: Int
    public var childPageSize: Int
    public var maxCallDuration: TimeInterval

    public init(
        maxDepth: Int = 22,
        maxNodes: Int = 1_500,
        timeout: TimeInterval = 3,
        maxAXCalls: Int = 20_000,
        maxAllocatedBytes: Int = 8 * 1_024 * 1_024,
        childPageSize: Int = 32,
        maxCallDuration: TimeInterval = 0.25
    ) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.timeout = timeout
        self.maxAXCalls = maxAXCalls
        self.maxAllocatedBytes = maxAllocatedBytes
        self.childPageSize = childPageSize
        self.maxCallDuration = maxCallDuration
    }

    func validate() throws {
        guard (0...64).contains(maxDepth) else {
            throw SpaceOError.badRequest("AX tree depth must be from 0 through 64")
        }
        guard (1...5_000).contains(maxNodes) else {
            throw SpaceOError.badRequest("AX tree node limit must be from 1 through 5000")
        }
        guard timeout.isFinite, (0.01...30).contains(timeout) else {
            throw SpaceOError.badRequest(
                "AX traversal timeout must be a finite value from 0.01 through 30 seconds")
        }
        guard (1...100_000).contains(maxAXCalls) else {
            throw SpaceOError.badRequest("AX call limit must be from 1 through 100000")
        }
        guard (1...64 * 1_024 * 1_024).contains(maxAllocatedBytes) else {
            throw SpaceOError.badRequest(
                "AX allocation limit must be from 1 byte through 64 MiB")
        }
        guard (1...256).contains(childPageSize) else {
            throw SpaceOError.badRequest("AX child page size must be from 1 through 256")
        }
        guard maxCallDuration.isFinite, (0.001...5).contains(maxCallDuration),
              maxCallDuration <= timeout else {
            throw SpaceOError.badRequest(
                "AX per-call timeout must be finite, from 0.001 through 5 seconds, "
                + "and no greater than the traversal timeout")
        }
    }
}

public enum AXTraversalStopReason: String, Sendable, Equatable {
    case deadline
    case axCalls
    case nodes
    case depth
    case allocation
    case cancelled
    case provider
}

/// A truthful failure when a provider cannot be read inside the request's safety envelope.
public struct AXTraversalStopped: Error, LocalizedError, CustomStringConvertible, Sendable, Equatable {
    public let reason: AXTraversalStopReason
    public let detail: String

    public init(reason: AXTraversalStopReason, detail: String) {
        self.reason = reason
        self.detail = detail
    }

    public var description: String {
        "accessibility traversal stopped (\(reason.rawValue)): \(detail)"
    }

    public var errorDescription: String? {
        description + ". Narrow the target window or retry after the application responds."
    }
}

/// One-call-at-a-time surface used by the bounded walker and its deterministic tests.
///
/// Each method below corresponds to at most one provider IPC. Keeping that boundary explicit
/// makes the AX-call budget meaningful instead of charging a multi-call convenience helper once.
protocol AXTraversalProviding {
    /// Hashable so a walk can keep a visited set. An application is free to list an element
    /// that is already an ancestor inside `AXChildren`; without identity the walker cannot tell
    /// that cycle from a deep tree, and a depth cap alone lets it expand combinatorially.
    associatedtype Element: Hashable

    func setMessagingTimeout(_ element: Element, seconds: Float) -> Bool
    func string(_ element: Element, attribute: String) -> String?
    /// Unclipped text for callers that enforce output/allocation limits themselves.
    func text(_ element: Element, attribute: String) -> String?
    func bool(_ element: Element, attribute: String) -> Bool?
    func actions(_ element: Element) -> [String]
    func point(_ element: Element, attribute: String) -> CGPoint?
    func size(_ element: Element, attribute: String) -> CGSize?
    func arrayCount(_ element: Element, attribute: String) -> Int
    func elements(
        _ element: Element,
        attribute: String,
        start: Int,
        maxValues: Int
    ) -> [Element]
    func windowID(_ element: Element) -> CGWindowID
    /// One element-valued attribute such as `AXFocusedWindow` or `AXMenuBar`. Defaulted to nil
    /// so fakes that only model a child hierarchy keep compiling and read as "not exposed".
    func element(_ element: Element, attribute: String) -> Element?
    /// Perform one accessibility action. Defaulted to a refusal for the same reason.
    func perform(_ element: Element, action: String) -> Bool
}

extension AXTraversalProviding {
    func text(_ element: Element, attribute: String) -> String? {
        string(element, attribute: attribute)
    }

    func element(_ element: Element, attribute: String) -> Element? { nil }

    func perform(_ element: Element, action: String) -> Bool { false }
}

struct SystemAXTraversalProvider: AXTraversalProviding {
    typealias Element = AXUIElement

    func setMessagingTimeout(_ element: AXUIElement, seconds: Float) -> Bool {
        AX.setTimeout(element, seconds: seconds)
    }

    func string(_ element: AXUIElement, attribute: String) -> String? {
        AX.string(element, attribute)
    }

    func text(_ element: AXUIElement, attribute: String) -> String? {
        AX.rawString(element, attribute)
    }

    func bool(_ element: AXUIElement, attribute: String) -> Bool? {
        AX.bool(element, attribute)
    }

    func actions(_ element: AXUIElement) -> [String] {
        AX.actions(element)
    }

    func point(_ element: AXUIElement, attribute: String) -> CGPoint? {
        AX.point(element, attribute)
    }

    func size(_ element: AXUIElement, attribute: String) -> CGSize? {
        AX.size(element, attribute)
    }

    func arrayCount(_ element: AXUIElement, attribute: String) -> Int {
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(
            element, attribute as CFString, &count
        ) == .success, count > 0 else {
            return 0
        }
        return Int(count)
    }

    func elements(
        _ element: AXUIElement,
        attribute: String,
        start: Int,
        maxValues: Int
    ) -> [AXUIElement] {
        guard start >= 0, maxValues > 0 else { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(
            element,
            attribute as CFString,
            CFIndex(start),
            CFIndex(maxValues),
            &values
        ) == .success, let values else {
            return []
        }
        return values as? [AXUIElement] ?? []
    }

    func windowID(_ element: AXUIElement) -> CGWindowID {
        AX.windowID(element)
    }

    func element(_ element: AXUIElement, attribute: String) -> AXUIElement? {
        AX.element(element, attribute)
    }

    func perform(_ element: AXUIElement, action: String) -> Bool {
        AX.perform(element, action)
    }
}

struct AXTraversalOutput<Element> {
    let nodes: [AXNode]
    let elements: [Int: Element]
    /// Set when a budget (nodes, calls, deadline, allocation) stopped the walk before the tree
    /// ended. `nodes` then holds everything read so far, which is more useful to an agent than
    /// an error — as long as the response says so. Nil means the whole tree was read.
    var truncatedBy: AXTraversalStopReason? = nil
}

/// Mutable request accounting for one synchronous operation and its bounded nested scopes.
final class AXTraversalBudget {
    private static let nanosecondsPerSecond = 1_000_000_000.0

    let limits: AXTraversalLimits
    private let now: () -> UInt64
    private let isCancelled: () -> Bool
    private let deadline: UInt64
    private let parent: AXTraversalBudget?

    private(set) var axCalls = 0
    private(set) var nodes = 0
    private(set) var allocatedBytes = 0

    convenience init(
        limits: AXTraversalLimits,
        now: @escaping () -> UInt64,
        isCancelled: @escaping () -> Bool
    ) throws {
        try self.init(limits: limits, now: now, isCancelled: isCancelled, parent: nil)
    }

    private init(
        limits: AXTraversalLimits,
        now: @escaping () -> UInt64,
        isCancelled: @escaping () -> Bool,
        parent: AXTraversalBudget?
    ) throws {
        try limits.validate()
        self.limits = limits
        self.now = now
        self.isCancelled = isCancelled
        self.parent = parent

        let start = now()
        let duration = UInt64(limits.timeout * Self.nanosecondsPerSecond)
        let (candidate, overflow) = start.addingReportingOverflow(duration)
        self.deadline = min(overflow ? UInt64.max : candidate, parent?.deadline ?? UInt64.max)
    }

    /// A bounded sub-operation shares the original clock, cancellation, and aggregate counters.
    /// It may tighten the deadline/call envelope, but can never renew the enclosing operation.
    func child(limits: AXTraversalLimits) throws -> AXTraversalBudget {
        try check()
        return try AXTraversalBudget(limits: limits, now: now, isCancelled: { false }, parent: self)
    }

    var remainingNodes: Int {
        min(max(0, limits.maxNodes - nodes), parent?.remainingNodes ?? Int.max)
    }

    var remainingNanoseconds: UInt64 {
        let current = now()
        return current < deadline ? deadline - current : 0
    }

    func check() throws {
        try parent?.check()
        if isCancelled() {
            throw AXTraversalStopped(
                reason: .cancelled,
                detail: "the requesting task was cancelled")
        }
        if now() >= deadline {
            throw AXTraversalStopped(
                reason: .deadline,
                detail: "the \(limits.timeout)-second monotonic deadline expired")
        }
    }

    /// Reserve one provider call and return the timeout that must be applied to its element.
    func beginAXCall() throws -> Float {
        try check()
        guard axCalls < limits.maxAXCalls else {
            throw AXTraversalStopped(
                reason: .axCalls,
                detail: "the \(limits.maxAXCalls)-call budget was exhausted")
        }
        let parentTimeout = try parent?.beginAXCall()
        axCalls += 1

        let remainingSeconds = Double(remainingNanoseconds) / Self.nanosecondsPerSecond
        let bounded = min(limits.maxCallDuration, remainingSeconds)
        guard bounded > 0 else {
            throw AXTraversalStopped(
                reason: .deadline,
                detail: "the \(limits.timeout)-second monotonic deadline expired")
        }
        // AX requires a positive timeout. The preceding deadline check keeps this floor from
        // extending a request materially beyond its own deadline.
        return min(Float(max(0.001, bounded)), parentTimeout ?? Float.greatestFiniteMagnitude)
    }

    func finishAXCall() throws {
        try check()
    }

    func consumeNode() throws {
        try check()
        guard nodes < limits.maxNodes else {
            throw AXTraversalStopped(
                reason: .nodes,
                detail: "the \(limits.maxNodes)-node budget was exhausted")
        }
        try parent?.consumeNode()
        nodes += 1
    }

    func consumeAllocation(_ bytes: Int) throws {
        try check()
        guard bytes >= 0,
              bytes <= limits.maxAllocatedBytes,
              allocatedBytes <= limits.maxAllocatedBytes - bytes
        else {
            throw AXTraversalStopped(
                reason: .allocation,
                detail: "the \(limits.maxAllocatedBytes)-byte aggregate allocation budget "
                    + "was exhausted")
        }
        try parent?.consumeAllocation(bytes)
        allocatedBytes += bytes
    }
}

enum AXTraversal {
    private static let retainedNodeBytes = 192
    private static let retainedElementBytes = 64
    private static let copiedElementReferenceBytes = 16
    private static let maximumActionCount = 128
    private static let maximumActionBytes = 256
    private static let maximumRoleBytes = 256
    static let maximumLabelBytes = AXLabelMatcher.maximumTextBytes

    static func boundedCall<P: AXTraversalProviding, T>(
        _ element: P.Element,
        provider: P,
        budget: AXTraversalBudget,
        _ operation: () throws -> T
    ) throws -> T {
        let timeout = try budget.beginAXCall()
        guard provider.setMessagingTimeout(element, seconds: timeout) else {
            throw AXTraversalStopped(
                reason: .provider,
                detail: "the descendant provider rejected its bounded messaging timeout")
        }
        try budget.check()
        let value = try operation()
        try budget.finishAXCall()
        return value
    }

    static func root(
        pid: pid_t,
        window: WindowRef?,
        provider: SystemAXTraversalProvider,
        budget: AXTraversalBudget
    ) throws -> AXUIElement {
        try root(app: AX.application(pid), window: window, provider: provider, budget: budget)
    }

    /// Resolve only the requested identity, using the snapshot's shared budget. Provider
    /// failures must not masquerade as a successfully enumerated list with no matching window.
    static func root<P: AXWindowDiscoveryProviding>(
        app: P.Element, window: WindowRef?, provider: P, budget: AXTraversalBudget
    ) throws -> P.Element {
        guard let window else { return app }
        func checkedCount() throws -> Int {
            let count = try AXWindowDiscovery.boundedProviderCall(app, provider: provider, budget: budget) {
                try provider.windowCount(app)
            }
            guard count >= 0 else { throw AXWindowDiscovery.incomplete("negative window count") }
            return count
        }
        let count = try checkedCount()
        guard count <= budget.remainingNodes else {
            throw AXTraversalStopped(reason: .nodes, detail: "window root discovery exceeds its window limit")
        }
        var seen = Set<CGWindowID>()
        var start = 0
        while start < count {
            let requested = min(budget.limits.childPageSize, count - start)
            let page = try AXWindowDiscovery.boundedProviderCall(app, provider: provider, budget: budget) {
                try provider.windowElements(app, start: start, count: requested)
            }
            guard page.count == requested else {
                throw AXWindowDiscovery.incomplete("window list changed during paging")
            }
            try budget.consumeAllocation(multiplied(page.count, by: copiedElementReferenceBytes))
            for element in page {
                try budget.consumeNode()
                let foundID = try AXWindowDiscovery.boundedProviderCall(element, provider: provider, budget: budget) {
                    try provider.identifiedWindowID(element)
                }
                guard foundID != 0 else { throw AXWindowDiscovery.incomplete("window identity is unavailable") }
                guard seen.insert(foundID).inserted else {
                    throw AXWindowDiscovery.incomplete("window identity is repeated")
                }
                try budget.consumeAllocation(MemoryLayout<CGWindowID>.stride + 32)
                if foundID == window.windowID { return element }
            }
            start += page.count
        }
        guard try checkedCount() == count else {
            throw AXWindowDiscovery.incomplete("window list changed during discovery")
        }
        throw SpaceOError.windowNotFound("window \(window.windowID)")
    }

    /// With `keepPartial`, a budget stop (nodes, calls, deadline, allocation) returns the tree
    /// read so far flagged `truncatedBy` instead of throwing. A 3 000-node web page used to fail
    /// the whole `read_screen` with "the 1500-node budget was exhausted", which taught agents to
    /// fall back to screenshots; the first 1 500 nodes *marked as truncated* are strictly more
    /// useful. Cancellation and provider faults still throw: they are not partial answers.
    static func walk<P: AXTraversalProviding>(
        root: P.Element,
        provider: P,
        budget: AXTraversalBudget,
        keepPartial: Bool = false
    ) throws -> AXTraversalOutput<P.Element> {
        var nodes: [AXNode] = []
        var elements: [Int: P.Element] = [:]
        var nextIndex = 0
        var visited = Set<P.Element>()
        var depthLimited = false

        func readString(_ element: P.Element, _ attribute: String) throws -> String? {
            try boundedCall(element, provider: provider, budget: budget) {
                provider.string(element, attribute: attribute)
            }
        }

        func walkElement(_ element: P.Element, depth: Int) throws {
            try budget.check()
            guard !visited.contains(element) else { return }
            try budget.consumeNode()
            try budget.consumeAllocation(retainedElementBytes)
            visited.insert(element)

            let rawRole = try readString(element, kAXRoleAttribute as String) ?? "AXUnknown"
            let role = utf8Prefix(rawRole, maximumBytes: maximumRoleBytes)

            let rawActions = try boundedCall(element, provider: provider, budget: budget) {
                provider.actions(element)
            }
            let actions = rawActions.prefix(maximumActionCount).map {
                utf8Prefix($0, maximumBytes: maximumActionBytes)
            }

            var label = ""
            var labelTruncated = false
            for attribute in [
                kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute,
                kAXPlaceholderValueAttribute,
            ] {
                if let candidate = try readString(element, attribute as String),
                   !candidate.isEmpty {
                    label = utf8Prefix(candidate, maximumBytes: maximumLabelBytes,
                                       truncated: &labelTruncated)
                    break
                }
            }

            // An accessible name and the value it describes are separate information. Taking
            // the first non-empty attribute used to make a description such as "Edit field"
            // hide Calculator's distinct AXValue (for example, "63"). Preserve the established
            // one-string AXNode contract, but compose both values within the same bounded field.
            // Secure fields remain value-free even if a provider happens to return their value.
            let exposesValue: Bool
            if role == "AXSecureTextField" {
                exposesValue = false
            } else if role == kAXTextFieldRole as String {
                let subrole = try readString(element, kAXSubroleAttribute as String)
                exposesValue = subrole != "AXSecureTextField"
            } else {
                exposesValue = true
            }
            // The name alone, before any value is composed into the label, so a wait or a
            // click-by-label can match "Name" against a field rendered "Name · value: Bob".
            let name = label
            var states: [String] = []
            if exposesValue,
               let value = try readString(element, kAXValueAttribute as String),
               !value.isEmpty {
                // A toggle's AXValue is 0/1/2, which read as "value: 1" told an agent nothing it
                // could act on. Render the state it encodes instead; any other value is composed.
                if let state = AXTree.toggleState(role: role, value: value) {
                    states.append(state)
                } else {
                    label = semanticLabel(primary: label, value: value, truncated: &labelTruncated)
                }
            }

            let enabled = try boundedCall(element, provider: provider, budget: budget) {
                provider.bool(element, attribute: kAXEnabledAttribute as String)
            } ?? true
            let origin = try boundedCall(element, provider: provider, budget: budget) {
                provider.point(element, attribute: kAXPositionAttribute as String)
            }
            let size = try boundedCall(element, provider: provider, budget: budget) {
                provider.size(element, attribute: kAXSizeAttribute as String)
            }
            let frame = origin.flatMap { origin in size.map { CGRect(origin: origin, size: $0) } }

            let pressable = actions.contains(kAXPressAction as String)
                || actions.contains(kAXConfirmAction as String)
            let interesting = AXTree.actionableRoles.contains(role) || pressable

            var assigned: Int?
            if interesting && (!label.isEmpty || pressable) {
                assigned = nextIndex
            }

            // Control state an agent otherwise has to infer from a screenshot. Each read is one
            // bounded call, and only for the roles that carry it, so a large static page pays
            // nothing extra: expansion on disclosable controls, selection on rows and cells,
            // and keyboard focus on the controls that can hold it.
            if let attribute = AXTree.expansionAttribute(role: role),
               let expanded = try boundedCall(element, provider: provider, budget: budget, {
                   provider.bool(element, attribute: attribute)
               }) {
                states.append(expanded ? "expanded" : "collapsed")
            }
            if AXTree.selectableRoles.contains(role),
               try boundedCall(element, provider: provider, budget: budget, {
                   provider.bool(element, attribute: kAXSelectedAttribute as String)
               }) == true {
                states.append("selected")
            }
            if interesting,
               try boundedCall(element, provider: provider, budget: budget, {
                   provider.bool(element, attribute: kAXFocusedAttribute as String)
               }) == true {
                states.append("focused")
            }

            let actionBytes = actions.reduce(0) {
                adding($0, adding($1.utf8.count, 24))
            }
            var retainedBytes = retainedNodeBytes
            retainedBytes = adding(retainedBytes, role.utf8.count)
            retainedBytes = adding(retainedBytes, label.utf8.count)
            retainedBytes = adding(retainedBytes, actionBytes)
            retainedBytes = states.reduce(retainedBytes) { adding($0, adding($1.utf8.count, 16)) }
            if assigned != nil {
                retainedBytes = adding(retainedBytes, retainedElementBytes)
            }
            try budget.consumeAllocation(retainedBytes)
            // Publish a handle only after its corresponding node fits. Partial snapshots must
            // not retain an extra actionable element that is absent from the returned outline.
            if let assigned {
                elements[assigned] = element
                nextIndex += 1
            }

            nodes.append(AXNode(
                index: assigned,
                role: role,
                label: label,
                frame: frame,
                actions: actions,
                depth: depth,
                enabled: enabled,
                labelTruncated: labelTruncated,
                name: name,
                states: states))

            let attribute = kAXChildrenAttribute as String
            let childCount = try boundedCall(element, provider: provider, budget: budget) {
                provider.arrayCount(element, attribute: attribute)
            }
            guard depth < budget.limits.maxDepth else {
                if childCount > 0 { depthLimited = true }
                return
            }
            var start = 0
            while start < childCount {
                try budget.check()
                guard budget.remainingNodes > 0 else {
                    throw AXTraversalStopped(
                        reason: .nodes,
                        detail: "the \(budget.limits.maxNodes)-node budget was exhausted")
                }

                let requested = min(
                    budget.limits.childPageSize,
                    childCount - start,
                    budget.remainingNodes)
                let page = try boundedCall(element, provider: provider, budget: budget) {
                    provider.elements(
                        element,
                        attribute: attribute,
                        start: start,
                        maxValues: requested)
                }
                try budget.consumeAllocation(
                    multiplied(page.count, by: copiedElementReferenceBytes))
                guard !page.isEmpty else { break }

                let boundedPage = page.prefix(requested)
                for child in boundedPage {
                    try walkElement(child, depth: depth + 1)
                }
                start += boundedPage.count
                if page.count < requested { break }
            }
        }

        do {
            try walkElement(root, depth: 0)
        } catch let stopped as AXTraversalStopped
            where keepPartial && [.nodes, .deadline, .axCalls, .allocation].contains(stopped.reason) {
            return AXTraversalOutput(nodes: nodes, elements: elements, truncatedBy: stopped.reason)
        }
        return AXTraversalOutput(nodes: nodes, elements: elements,
                                 truncatedBy: depthLimited ? .depth : nil)
    }

    /// One text attribute under the same provider/cancellation/allocation envelope as a walk.
    /// A nil character limit requests complete text, subject to the byte budget; callers must
    /// refuse a truncated result before using it as input to a mutation.
    static func textAttribute<P: AXTraversalProviding>(
        element: P.Element, attribute: String, provider: P, budget: AXTraversalBudget,
        maxChars: Int?, maximumBytes: Int, requireValue: Bool = false
    ) throws -> (text: String, truncated: Bool) {
        guard maxChars.map({ (1...20_000).contains($0) }) ?? true,
              (0...8 * 1_048_576).contains(maximumBytes) else {
            throw SpaceOError.badRequest("invalid accessibility text limits")
        }
        func read(_ attribute: String, fullText: Bool = false) throws -> String? {
            try boundedCall(element, provider: provider, budget: budget) {
                fullText ? provider.text(element, attribute: attribute)
                    : provider.string(element, attribute: attribute)
            }
        }
        do {
            try budget.consumeNode()
            let role = try read(kAXRoleAttribute as String)
            var secure = role == "AXSecureTextField"
            if role == kAXTextFieldRole as String {
                secure = try read(kAXSubroleAttribute as String) == "AXSecureTextField"
            }
            guard !secure else {
                throw SpaceOError.unsupportedTarget("secure field text is unavailable")
            }
            guard let value = try read(attribute, fullText: true) else {
                if requireValue { throw SpaceOError.unsupportedTarget("element did not expose its current text value") }
                return ("", false)
            }
            let piece = maxChars.map { value.prefix($0) } ?? value[...]
            guard piece.utf8.count <= maximumBytes else { return ("", true) }
            try budget.consumeAllocation(piece.utf8.count)
            return (String(piece), piece.endIndex != value.endIndex)
        } catch let stopped as AXTraversalStopped
            where [.nodes, .deadline, .axCalls, .allocation].contains(stopped.reason) {
            return ("", true)
        }
    }

    /// Reading-order text without retaining a node array or querying geometry/actions.
    /// Values take precedence over accessible names, so a document is not reduced to its
    /// screen-outline label. All remote calls use the same safety envelope as `walk`.
    static func allText<P: AXTraversalProviding>(
        root: P.Element,
        provider: P,
        budget: AXTraversalBudget,
        maxChars: Int
    ) throws -> (text: String, truncated: Bool) {
        guard (1...20_000).contains(maxChars) else {
            throw SpaceOError.badRequest("text character limit must be from 1 through 20000")
        }
        var text = ""
        var characters = 0
        var truncated = false
        var visited = Set<P.Element>()

        func readString(_ element: P.Element, _ attribute: String, fullText: Bool = false) throws -> String? {
            try boundedCall(element, provider: provider, budget: budget) {
                fullText ? provider.text(element, attribute: attribute)
                    : provider.string(element, attribute: attribute)
            }
        }

        // True means no further subtree is needed: output is already known to be truncated.
        func visit(_ element: P.Element, depth: Int) throws -> Bool {
            try budget.check()
            guard !visited.contains(element) else { return false }
            try budget.consumeNode()
            try budget.consumeAllocation(retainedElementBytes)
            visited.insert(element)
            let role = try readString(element, kAXRoleAttribute as String) ?? "AXUnknown"
            var secure = role == "AXSecureTextField"
            if role == kAXTextFieldRole as String {
                secure = try readString(element, kAXSubroleAttribute as String) == "AXSecureTextField"
            }
            // Treat the secure field's descendants as part of the protected control too.
            guard !secure else { return false }
            if AXTree.textRoles.contains(role) {
                // A checkbox's or radio button's value is its 0/1/2 state, not text a reader would
                // recognise; its accessible name is the readable part.
                var value = AXTree.stateValuedRoles.contains(role)
                    ? nil : try readString(element, kAXValueAttribute as String, fullText: true)
                if value?.isEmpty != false {
                    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute,
                                      kAXHelpAttribute, kAXPlaceholderValueAttribute] {
                        if let candidate = try readString(element, attribute as String, fullText: true), !candidate.isEmpty {
                            value = candidate
                            break
                        }
                    }
                }
                if let value, !value.isEmpty {
                    let separator = text.isEmpty ? 0 : 1
                    let remaining = maxChars - characters - separator
                    guard remaining > 0 else { return true }
                    // Substring slicing avoids copying an oversized value before charging it
                    // to the allocation budget, and preserves complete grapheme clusters.
                    let piece = value.prefix(remaining)
                    try budget.consumeAllocation(adding(piece.utf8.count, separator))
                    if separator > 0 { text.append("\n") }
                    text.append(contentsOf: piece)
                    characters += piece.count + separator
                    if piece.endIndex != value.endIndex { return true }
                }
            }

            let attribute = kAXChildrenAttribute as String
            let childCount = try boundedCall(element, provider: provider, budget: budget) {
                provider.arrayCount(element, attribute: attribute)
            }
            guard childCount > 0 else { return false }
            guard depth < budget.limits.maxDepth else {
                truncated = true
                return false
            }
            var start = 0
            while start < childCount {
                try budget.check()
                guard budget.remainingNodes > 0 else {
                    throw AXTraversalStopped(reason: .nodes,
                        detail: "the \(budget.limits.maxNodes)-node budget was exhausted")
                }
                let requested = min(budget.limits.childPageSize, childCount - start, budget.remainingNodes)
                let page = try boundedCall(element, provider: provider, budget: budget) {
                    provider.elements(element, attribute: attribute, start: start, maxValues: requested)
                }
                try budget.consumeAllocation(multiplied(page.count, by: copiedElementReferenceBytes))
                guard !page.isEmpty else { truncated = true; break }
                let boundedPage = page.prefix(requested)
                for child in boundedPage {
                    if try visit(child, depth: depth + 1) { return true }
                }
                start += boundedPage.count
                if page.count < requested { truncated = true; break }
            }
            return false
        }

        do {
            let outputClipped = try visit(root, depth: 0)
            truncated = truncated || outputClipped
        } catch let stopped as AXTraversalStopped
            where [.nodes, .deadline, .axCalls, .allocation].contains(stopped.reason) {
            truncated = true
        }
        return (text, truncated)
    }

    /// A bounded text-only traversal used by integration checks that do not need a full
    /// actionable snapshot. It shares the exact same deadline, call, node, allocation, paging,
    /// descendant-timeout, and cancellation rules as `walk`.
    static func firstText<P: AXTraversalProviding>(
        root: P.Element,
        provider: P,
        budget: AXTraversalBudget,
        roles: Set<String>
    ) throws -> String? {
        var visited = Set<P.Element>()
        func readString(_ element: P.Element, _ attribute: String) throws -> String? {
            try boundedCall(element, provider: provider, budget: budget) {
                provider.string(element, attribute: attribute)
            }
        }

        func visit(_ element: P.Element, depth: Int) throws -> String? {
            try budget.check()
            guard !visited.contains(element) else { return nil }
            try budget.consumeNode()
            try budget.consumeAllocation(retainedElementBytes)
            visited.insert(element)
            let rawRole = try readString(element, kAXRoleAttribute as String) ?? "AXUnknown"
            let role = utf8Prefix(rawRole, maximumBytes: maximumRoleBytes)
            try budget.consumeAllocation(adding(retainedNodeBytes, role.utf8.count))

            if roles.contains(role),
               let rawValue = try readString(element, kAXValueAttribute as String) {
                let value = utf8Prefix(rawValue, maximumBytes: 32_768)
                try budget.consumeAllocation(value.utf8.count)
                if !value.isEmpty { return value }
            }

            guard depth < budget.limits.maxDepth else { return nil }
            let attribute = kAXChildrenAttribute as String
            let childCount = try boundedCall(element, provider: provider, budget: budget) {
                provider.arrayCount(element, attribute: attribute)
            }
            var start = 0
            while start < childCount {
                try budget.check()
                guard budget.remainingNodes > 0 else {
                    throw AXTraversalStopped(
                        reason: .nodes,
                        detail: "the \(budget.limits.maxNodes)-node budget was exhausted")
                }
                let requested = min(
                    budget.limits.childPageSize,
                    childCount - start,
                    budget.remainingNodes)
                let page = try boundedCall(element, provider: provider, budget: budget) {
                    provider.elements(
                        element,
                        attribute: attribute,
                        start: start,
                        maxValues: requested)
                }
                try budget.consumeAllocation(
                    multiplied(page.count, by: copiedElementReferenceBytes))
                guard !page.isEmpty else { break }

                let boundedPage = page.prefix(requested)
                for child in boundedPage {
                    if let found = try visit(child, depth: depth + 1) { return found }
                }
                start += boundedPage.count
                if page.count < requested { break }
            }
            return nil
        }

        return try visit(root, depth: 0)
    }

    /// The deepest scroll area whose frame contains `point`, so nested scrollers resolve to the
    /// inner one — which is what the wheel would have hit.
    ///
    /// Bounded exactly like `walk`: paged child reads, the same monotonic deadline, AX-call,
    /// node, allocation and per-call-timeout accounting, and the same cancellation checks. That
    /// is not defensive decoration here — this resolution runs inside a single `scroll` command
    /// while the daemon actor is held, so an unbounded walk does not merely make one scroll slow,
    /// it queues every other session's screenshot, click and stop behind it.
    ///
    /// The visited set is load-bearing for the same reason: a toolkit that lists a parent inside
    /// `AXChildren` is a cycle, and a depth cap alone permits an exponential number of visits
    /// through it rather than terminating.
    static func deepestScrollArea<P: AXTraversalProviding>(
        root: P.Element,
        containing point: CGPoint,
        provider: P,
        budget: AXTraversalBudget
    ) throws -> P.Element? {
        guard point.x.isFinite, point.y.isFinite else { return nil }
        var visited = Set<P.Element>()

        func role(_ element: P.Element) throws -> String {
            let raw = try boundedCall(element, provider: provider, budget: budget) {
                provider.string(element, attribute: kAXRoleAttribute as String)
            }
            return utf8Prefix(raw ?? "AXUnknown", maximumBytes: maximumRoleBytes)
        }

        func frame(_ element: P.Element) throws -> CGRect? {
            let origin = try boundedCall(element, provider: provider, budget: budget) {
                provider.point(element, attribute: kAXPositionAttribute as String)
            }
            guard let origin else { return nil }
            let size = try boundedCall(element, provider: provider, budget: budget) {
                provider.size(element, attribute: kAXSizeAttribute as String)
            }
            guard let size else { return nil }
            return CGRect(origin: origin, size: size)
        }

        /// The deepest scroll area strictly *below* `element`. An element is judged by the level
        /// that already established the point falls inside its frame, so the root — the window
        /// the caller named — is never itself the answer.
        func visit(_ element: P.Element, depth: Int) throws -> P.Element? {
            try budget.consumeNode()
            guard visited.insert(element).inserted else { return nil }
            try budget.consumeAllocation(retainedElementBytes)
            guard depth < budget.limits.maxDepth else { return nil }

            let attribute = kAXChildrenAttribute as String
            let childCount = try boundedCall(element, provider: provider, budget: budget) {
                provider.arrayCount(element, attribute: attribute)
            }
            var match: P.Element?
            var start = 0
            while start < childCount {
                try budget.check()
                guard budget.remainingNodes > 0 else {
                    throw AXTraversalStopped(
                        reason: .nodes,
                        detail: "the \(budget.limits.maxNodes)-node budget was exhausted")
                }
                let requested = min(
                    budget.limits.childPageSize,
                    childCount - start,
                    budget.remainingNodes)
                let page = try boundedCall(element, provider: provider, budget: budget) {
                    provider.elements(
                        element,
                        attribute: attribute,
                        start: start,
                        maxValues: requested)
                }
                try budget.consumeAllocation(
                    multiplied(page.count, by: copiedElementReferenceBytes))
                guard !page.isEmpty else { break }

                let boundedPage = page.prefix(requested)
                for child in boundedPage {
                    // A child that reports a frame not containing the point cannot contain the
                    // scroller the wheel would have hit. One that reports no frame at all is
                    // descended into rather than skipped: a missing frame is unknown, not absent.
                    if let childFrame = try frame(child), !childFrame.contains(point) { continue }
                    if let deeper = try visit(child, depth: depth + 1) { return deeper }
                    if try role(child) == kAXScrollAreaRole as String { match = child }
                }
                start += boundedPage.count
                if page.count < requested { break }
            }
            return match
        }

        return try visit(root, depth: 0)
    }

    /// The window an application reports as focused, and whether it is modal, in a handful of
    /// bounded calls. This is where a per-pid keystroke will land, so it — not the largest
    /// window — is what a command that omits `window` means when an alert or sheet is up.
    ///
    /// Modal means the window says so (`AXModal`), is itself a sheet or dialog, or carries an
    /// attached `AXSheet` child among its first page of children. Nil when the application
    /// will not name a focused window or names one without an identity.
    static func focusedWindow<P: AXTraversalProviding>(
        app: P.Element,
        provider: P,
        budget: AXTraversalBudget
    ) throws -> FocusedWindowObservation? {
        guard let window = try boundedCall(app, provider: provider, budget: budget, {
            provider.element(app, attribute: kAXFocusedWindowAttribute as String)
        }) else { return nil }
        try budget.consumeNode()
        try budget.consumeAllocation(retainedElementBytes)
        let windowID = try boundedCall(window, provider: provider, budget: budget) {
            provider.windowID(window)
        }
        guard windowID != 0 else { return nil }
        func read(_ element: P.Element, _ attribute: String) throws -> String? {
            let raw = try boundedCall(element, provider: provider, budget: budget) {
                provider.string(element, attribute: attribute)
            }
            return raw.map { utf8Prefix($0, maximumBytes: maximumRoleBytes) }
        }
        let role = try read(window, kAXRoleAttribute as String)
        let subrole = try read(window, kAXSubroleAttribute as String)
        if role == "AXSheet" || subrole == "AXDialog" || subrole == "AXSystemDialog" {
            return FocusedWindowObservation(windowID: windowID, modal: true)
        }
        if try boundedCall(window, provider: provider, budget: budget, {
            provider.bool(window, attribute: "AXModal")
        }) == true {
            return FocusedWindowObservation(windowID: windowID, modal: true)
        }
        let attribute = kAXChildrenAttribute as String
        let childCount = try boundedCall(window, provider: provider, budget: budget) {
            provider.arrayCount(window, attribute: attribute)
        }
        let requested = min(childCount, budget.limits.childPageSize, budget.remainingNodes)
        guard requested > 0 else { return FocusedWindowObservation(windowID: windowID, modal: false) }
        let page = try boundedCall(window, provider: provider, budget: budget) {
            provider.elements(window, attribute: attribute, start: 0, maxValues: requested)
        }
        try budget.consumeAllocation(multiplied(page.count, by: copiedElementReferenceBytes))
        for child in page.prefix(requested) {
            try budget.consumeNode()
            if try read(child, kAXRoleAttribute as String) == "AXSheet" {
                return FocusedWindowObservation(windowID: windowID, modal: true)
            }
        }
        return FocusedWindowObservation(windowID: windowID, modal: false)
    }

    static func utf8Prefix(_ value: String, maximumBytes: Int) -> String {
        var truncated = false
        return utf8Prefix(value, maximumBytes: maximumBytes, truncated: &truncated)
    }

    private static func utf8Prefix(
        _ value: String, maximumBytes: Int, truncated: inout Bool
    ) -> String {
        guard value.utf8.count > maximumBytes else { return value }
        truncated = true
        let ellipsis = "…"
        guard maximumBytes >= ellipsis.utf8.count else { return "" }
        let contentLimit = maximumBytes - ellipsis.utf8.count
        var prefix = ""
        var bytes = 0
        for character in value {
            let characterBytes = String(character).utf8.count
            guard characterBytes <= contentLimit - bytes else { break }
            prefix.append(character)
            bytes += characterBytes
        }
        return prefix + ellipsis
    }

    /// Join an accessible name and a distinct value without allowing either half to consume the
    /// entire retained label budget. Short halves give their unused space to the longer half;
    /// two long halves split the budget. `utf8Prefix` preserves the existing disclosure marker.
    private static func semanticLabel(
        primary: String, value: String, truncated: inout Bool
    ) -> String {
        guard !primary.isEmpty else {
            return utf8Prefix(value, maximumBytes: maximumLabelBytes, truncated: &truncated)
        }
        guard primary != value else { return primary }

        let separator = " · value: "
        let available = maximumLabelBytes - separator.utf8.count
        let half = available / 2
        let primaryBudget: Int
        let valueBudget: Int
        if primary.utf8.count <= half {
            primaryBudget = primary.utf8.count
            valueBudget = available - primaryBudget
        } else if value.utf8.count <= half {
            valueBudget = value.utf8.count
            primaryBudget = available - valueBudget
        } else {
            primaryBudget = half
            valueBudget = available - primaryBudget
        }
        return utf8Prefix(primary, maximumBytes: primaryBudget, truncated: &truncated)
            + separator
            + utf8Prefix(value, maximumBytes: valueBudget, truncated: &truncated)
    }

    private static func adding(_ lhs: Int, _ rhs: Int) -> Int {
        let (value, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? Int.max : value
    }

    private static func multiplied(_ lhs: Int, by rhs: Int) -> Int {
        let (value, overflow) = lhs.multipliedReportingOverflow(by: rhs)
        return overflow ? Int.max : value
    }
}
