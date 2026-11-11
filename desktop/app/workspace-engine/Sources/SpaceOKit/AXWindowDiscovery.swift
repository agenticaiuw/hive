import Foundation
import ApplicationServices
import CoreGraphics
import SpaceOPrivate

/// Unlike the best-effort AX helpers, discovery must distinguish an empty list from failure.
protocol AXWindowDiscoveryProviding: AXTraversalProviding {
    func windowCount(_ app: Element) throws -> Int
    func windowElements(_ app: Element, start: Int, count: Int) throws -> [Element]
    func identifiedWindowID(_ element: Element) throws -> CGWindowID
}

extension AXWindowDiscoveryProviding {
    func identifiedWindowID(_ element: Element) throws -> CGWindowID { windowID(element) }
}

extension SystemAXTraversalProvider: AXWindowDiscoveryProviding {
    func identifiedWindowID(_ element: AXUIElement) throws -> CGWindowID {
        var id: CGWindowID = 0
        let status = SPOGetWindowIDForAXElement(element, &id)
        guard status == .success else {
            throw AXWindowDiscovery.ProviderFailure(status: status, operation: "window identity")
        }
        return id
    }

    func windowCount(_ app: AXUIElement) throws -> Int {
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count)
        guard status == .success, count >= 0 else {
            throw AXWindowDiscovery.ProviderFailure(status: status, operation: "window count")
        }
        return count
    }

    func windowElements(_ app: AXUIElement, start: Int, count: Int) throws -> [AXUIElement] {
        var values: CFArray?
        let status = AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, start, count, &values)
        guard status == .success, let elements = values as? [AXUIElement] else {
            throw AXWindowDiscovery.ProviderFailure(status: status, operation: "window page")
        }
        return elements
    }
}

enum AXWindowDiscovery {
    struct Result<Element> {
        let windows: [WindowRef]
        let elements: [CGWindowID: Element]
    }
    static func incomplete(_ detail: String) -> AXTraversalStopped {
        AXTraversalStopped(reason: .provider, detail: "incomplete window discovery: " + detail)
    }

    struct ProviderFailure: Error {
        let status: AXError
        let operation: String
    }

    /// Busy apps can recover, but every retry is a separate IPC: charge it to the shared call
    /// budget and recompute its timeout. A retry must not reuse an expired messaging timeout.
    static func boundedProviderCall<P: AXTraversalProviding, T>(
        _ app: P.Element, provider: P, budget: AXTraversalBudget,
        preserveInvalidUIElement: Bool = false,
        pause: (useconds_t) -> Void = { usleep($0) }, _ call: () throws -> T
    ) throws -> T {
        for attempt in 0..<3 {
            do {
                return try AXTraversal.boundedCall(app, provider: provider, budget: budget, call)
            } catch let failure as ProviderFailure {
                // A thrown IPC result still consumes time, and cancellation wins over retries.
                try budget.check()
                if preserveInvalidUIElement, failure.status == .invalidUIElement {
                    throw failure
                }
                guard failure.status == .cannotComplete, attempt < 2 else {
                    throw incomplete("\(failure.operation) is unavailable (AXError \(failure.status.rawValue))")
                }
                let microseconds = min(UInt64(40_000), budget.remainingNanoseconds / 1_000)
                if microseconds > 0 { pause(useconds_t(microseconds)) }
            }
        }
        throw incomplete("provider retries exhausted")
    }

    static func limits(remaining: TimeInterval?) throws -> AXTraversalLimits {
        var limits = try WaitPolicy.axTraversalLimits(remaining: remaining)
        limits.timeout = min(limits.timeout, 2)
        limits.maxDepth = 0
        limits.maxNodes = 256
        limits.maxAXCalls = 2_048
        limits.maxAllocatedBytes = 2 * 1_024 * 1_024
        return limits
    }

    /// Presence checks need a trustworthy count, not pages, titles, or geometry.
    static func hasWindows<P: AXWindowDiscoveryProviding>(
        app: P.Element, provider: P, budget: AXTraversalBudget
    ) throws -> Bool {
        try checkedCount(app: app, provider: provider, budget: budget) > 0
    }

    private static func checkedCount<P: AXWindowDiscoveryProviding>(
        app: P.Element, provider: P, budget: AXTraversalBudget
    ) throws -> Int {
        let count = try boundedProviderCall(app, provider: provider, budget: budget) {
            try provider.windowCount(app)
        }
        guard count >= 0 else { throw incomplete("negative window count") }
        return count
    }

    /// A positive count can precede resolvable window identities during application startup.
    /// Readiness needs one real ID, but no titles or geometry; placement verifies the full set.
    static func hasIdentifiedWindow<P: AXWindowDiscoveryProviding>(
        app: P.Element, provider: P, budget: AXTraversalBudget,
        observedCount: (Int) -> Void = { _ in }
    ) throws -> Bool {
        let count = try checkedCount(app: app, provider: provider, budget: budget)
        observedCount(count)
        guard count <= budget.limits.maxNodes - budget.nodes else {
            throw AXTraversalStopped(reason: .nodes, detail: "window discovery exceeds its window limit")
        }
        var identityFailure: ProviderFailure?
        var start = 0
        while start < count {
            let size = min(budget.limits.childPageSize, count - start)
            let page = try boundedProviderCall(app, provider: provider, budget: budget) {
                try provider.windowElements(app, start: start, count: size)
            }
            guard page.count == size else { throw incomplete("window list changed during paging") }
            try budget.consumeAllocation(page.count * MemoryLayout<P.Element>.stride)
            for element in page {
                try budget.consumeNode()
                do {
                    let id = try boundedProviderCall(element, provider: provider, budget: budget,
                                                     preserveInvalidUIElement: true) {
                        try provider.identifiedWindowID(element)
                    }
                    if id != 0 { return true }
                } catch let failure as ProviderFailure where failure.status == .invalidUIElement {
                    // Readiness is existential; a stale member does not rule out a later ID.
                    if identityFailure == nil { identityFailure = failure }
                }
            }
            start += page.count
        }
        if let failure = identityFailure {
            throw incomplete("\(failure.operation) is unavailable (AXError \(failure.status.rawValue))")
        }
        return false
    }

    /// All apps in a discovery operation share this budget. Nothing partial escapes as an empty list.
    static func windows<P: AXWindowDiscoveryProviding>(
        of pid: pid_t, app: P.Element, provider: P, budget: AXTraversalBudget,
        liveBounds: (CGWindowID) -> CGRect?, includeTitles: Bool = true
    ) throws -> [WindowRef] {
        try discover(of: pid, app: app, provider: provider, budget: budget,
                     liveBounds: liveBounds, includeTitles: includeTitles).windows
    }

    /// Retain handles only for a caller that needs to act on the complete discovery result.
    /// A failed discovery returns neither its partial windows nor its partial handle map.
    static func discover<P: AXWindowDiscoveryProviding>(
        of pid: pid_t, app: P.Element, provider: P, budget: AXTraversalBudget,
        liveBounds: (CGWindowID) -> CGRect?, includeTitles: Bool = true,
        retainingElements: Bool = false
    ) throws -> Result<P.Element> {
        let count = try checkedCount(app: app, provider: provider, budget: budget)
        guard count <= budget.limits.maxNodes - budget.nodes else {
            throw AXTraversalStopped(reason: .nodes, detail: "window discovery exceeds its window limit")
        }
        var windows: [WindowRef] = []
        var elements: [CGWindowID: P.Element] = [:]
        var seen = Set<CGWindowID>()
        var start = 0
        while start < count {
            let size = min(budget.limits.childPageSize, count - start)
            let page = try boundedProviderCall(app, provider: provider, budget: budget) {
                try provider.windowElements(app, start: start, count: size)
            }
            guard page.count == size else { throw incomplete("window list changed during paging") }
            try budget.consumeAllocation(page.count * MemoryLayout<P.Element>.stride)
            for element in page {
                try budget.consumeNode()
                let id = try boundedProviderCall(element, provider: provider, budget: budget) {
                    try provider.identifiedWindowID(element)
                }
                guard id != 0 else {
                    throw incomplete("window identity is unavailable")
                }
                guard seen.insert(id).inserted else {
                    throw incomplete("window identity is repeated")
                }
                var frame = liveBounds(id)
                try budget.check()
                if frame == nil {
                    let origin = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                        provider.point(element, attribute: kAXPositionAttribute as String)
                    }
                    let size = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                        provider.size(element, attribute: kAXSizeAttribute as String)
                    }
                    if let origin, let size { frame = CGRect(origin: origin, size: size) }
                }
                guard let frame, frame.origin.x.isFinite, frame.origin.y.isFinite,
                      frame.width.isFinite, frame.height.isFinite, frame.width >= 0, frame.height >= 0 else {
                    throw incomplete("window geometry is unavailable")
                }
                let title: String
                if includeTitles {
                    title = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                        provider.text(element, attribute: kAXTitleAttribute as String)
                    } ?? ""
                } else { title = "" }
                try budget.consumeAllocation(title.utf8.count)
                try budget.consumeAllocation(256)
                windows.append(WindowRef(windowID: id, pid: pid,
                    title: BoundedDiagnosticText.prefix(title, maximumBytes: 32_768), frame: frame))
                if retainingElements {
                    try budget.consumeAllocation(MemoryLayout<P.Element>.stride + 32)
                    elements[id] = element
                }
            }
            start += page.count
        }
        // AXWindows is not an atomic snapshot. An app can add or remove windows after the
        // initial count (even while the last page's geometry is read). A full-sized page alone
        // does not prove completeness; never publish that stale prefix as the complete set.
        guard try checkedCount(app: app, provider: provider, budget: budget) == count else {
            throw incomplete("window list changed during discovery")
        }
        return Result(windows: windows, elements: elements)
    }

    static func liveWindows(of pid: pid_t, budget: AXTraversalBudget, includeTitles: Bool = true) throws -> [WindowRef] {
        try windows(of: pid, app: AX.application(pid), provider: SystemAXTraversalProvider(),
                    budget: budget, liveBounds: { try? WindowPlacement.liveBounds(of: $0) },
                    includeTitles: includeTitles)
    }
}
