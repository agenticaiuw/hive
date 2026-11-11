import ApplicationServices
import CoreGraphics
import Foundation

/// Missing optional attributes are different from failed IPC. Only checked reads can establish
/// a complete layout before routing an action to a numbered or active editor.
protocol AXEditorPaneDiscoveryProviding: AXWindowDiscoveryProviding {
    func paneSubrole(_ element: Element) throws -> String?
    func childCount(_ element: Element) throws -> Int
    func childElements(_ element: Element, start: Int, count: Int) throws -> [Element]
}

extension SystemAXTraversalProvider: AXEditorPaneDiscoveryProviding {
    func paneSubrole(_ element: AXUIElement) throws -> String? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value)
        if status == .attributeUnsupported || status == .noValue { return nil }
        guard status == .success, let subrole = value as? String else {
            throw AXEditorPaneDiscovery.incomplete("subrole is unavailable")
        }
        return subrole
    }

    func childCount(_ element: AXUIElement) throws -> Int {
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        if status == .attributeUnsupported || status == .noValue { return 0 }
        guard status == .success, count >= 0 else {
            throw AXEditorPaneDiscovery.incomplete("child count is unavailable")
        }
        return count
    }

    func childElements(_ element: AXUIElement, start: Int, count: Int) throws -> [AXUIElement] {
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString,
                                            start, count, &values) == .success,
              let elements = values as? [AXUIElement] else {
            throw AXEditorPaneDiscovery.incomplete("child page is unavailable")
        }
        return elements
    }
}

enum AXEditorPaneDiscovery {
    static let limits = AXTraversalLimits(maxDepth: 24, maxNodes: 1_500, timeout: 2,
        maxAXCalls: 8_000, maxAllocatedBytes: 2 * 1_024 * 1_024)

    static func incomplete(_ detail: String) -> AXTraversalStopped {
        AXTraversalStopped(reason: .provider, detail: "incomplete editor pane discovery: " + detail)
    }

    static func liveFrames(pid: pid_t, windowID: CGWindowID) throws -> [CGRect] {
        guard let identity = ProcessIdentity.current(of: pid) else {
            throw incomplete("the process exited before discovery")
        }
        let budget = try AXTraversalBudget(limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        let found = try frames(app: AX.application(pid), windowID: windowID,
                               provider: SystemAXTraversalProvider(), budget: budget)
        guard identity.isAlive else { throw incomplete("the process changed during discovery") }
        try budget.check()
        return found
    }

    /// Pages are short-lived and every distinct element is visited once, even for cyclic or
    /// shared AX subtrees. No partial frame list escapes any provider or budget failure.
    static func frames<P: AXEditorPaneDiscoveryProviding>(
        app: P.Element, windowID: CGWindowID, provider: P, budget: AXTraversalBudget
    ) throws -> [CGRect] {
        guard windowID != 0 else { throw incomplete("the requested window has no identity") }
        let window = try root(app: app, windowID: windowID, provider: provider, budget: budget)
        var seen = Set<P.Element>()
        var found: [CGRect] = []

        func collect(_ element: P.Element, depth: Int) throws {
            try budget.check()
            guard !seen.contains(element) else { return }
            try budget.consumeNode()
            try budget.consumeAllocation(MemoryLayout<P.Element>.stride + 32)
            seen.insert(element)
            let subrole = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                try provider.paneSubrole(element)
            }
            if let subrole { try budget.consumeAllocation(subrole.utf8.count) }
            if subrole == "AXCodeStyleGroup" {
                let point = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                    provider.point(element, attribute: kAXPositionAttribute as String)
                }
                let size = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                    provider.size(element, attribute: kAXSizeAttribute as String)
                }
                guard let point, let size, point.x.isFinite, point.y.isFinite,
                      size.width.isFinite, size.height.isFinite, size.width >= 0, size.height >= 0,
                      (point.x + size.width).isFinite, (point.y + size.height).isFinite else {
                    throw incomplete("editor geometry is unavailable or invalid")
                }
                if size.width >= ElectronEditorPanes.minimumPaneSide,
                   size.height >= ElectronEditorPanes.minimumPaneSide {
                    guard found.count < 64 else {
                        throw incomplete("more than 64 editor surfaces were reported")
                    }
                    try budget.consumeAllocation(MemoryLayout<CGRect>.stride)
                    found.append(CGRect(origin: point, size: size))
                    // A Monaco surface's inner content groups are not additional panes.
                    return
                }
            }
            let count = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                try provider.childCount(element)
            }
            guard count >= 0 else { throw incomplete("negative child count") }
            guard count <= budget.limits.maxNodes else {
                throw AXTraversalStopped(reason: .nodes, detail: "editor child list exceeds its node limit")
            }
            guard count == 0 || depth < budget.limits.maxDepth else {
                throw AXTraversalStopped(reason: .depth, detail: "editor discovery reached its depth limit")
            }
            var start = 0
            while start < count {
                let size = min(budget.limits.childPageSize, count - start)
                try budget.consumeAllocation(size * MemoryLayout<P.Element>.stride)
                let page = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                    try provider.childElements(element, start: start, count: size)
                }
                guard page.count == size else { throw incomplete("child list changed during paging") }
                for child in page { try collect(child, depth: depth + 1) }
                start += size
            }
        }

        try collect(window, depth: 0)
        let finalID = try AXWindowDiscovery.boundedProviderCall(window, provider: provider, budget: budget) {
            try provider.identifiedWindowID(window)
        }
        guard finalID == windowID else { throw incomplete("the window changed during discovery") }
        return found
    }

    private static func root<P: AXEditorPaneDiscoveryProviding>(
        app: P.Element, windowID: CGWindowID, provider: P, budget: AXTraversalBudget
    ) throws -> P.Element {
        let count = try AXWindowDiscovery.boundedProviderCall(app, provider: provider, budget: budget) {
            try provider.windowCount(app)
        }
        guard count >= 0 else { throw incomplete("negative window count") }
        guard count <= 256 else {
            throw AXTraversalStopped(reason: .nodes, detail: "editor discovery exceeds its window limit")
        }
        var start = 0
        while start < count {
            let size = min(budget.limits.childPageSize, count - start)
            try budget.consumeAllocation(size * MemoryLayout<P.Element>.stride)
            let page = try AXWindowDiscovery.boundedProviderCall(app, provider: provider, budget: budget) {
                try provider.windowElements(app, start: start, count: size)
            }
            guard page.count == size else { throw incomplete("window list changed during paging") }
            for element in page {
                let id = try AXWindowDiscovery.boundedProviderCall(element, provider: provider, budget: budget) {
                    try provider.identifiedWindowID(element)
                }
                if id == windowID { return element }
            }
            start += size
        }
        throw SpaceOError.windowNotFound("the requested editor window could not be resolved")
    }
}
