import ApplicationServices
import CoreGraphics
import Foundation

protocol AXWindowMovementProviding: AXTraversalProviding {
    func setPosition(_ element: Element, _ point: CGPoint) -> Bool
    func setDimensions(_ element: Element, _ size: CGSize) -> Bool
}

extension SystemAXTraversalProvider: AXWindowMovementProviding {
    func setPosition(_ element: AXUIElement, _ point: CGPoint) -> Bool {
        AX.setPoint(element, kAXPositionAttribute as String, point)
    }
    func setDimensions(_ element: AXUIElement, _ size: CGSize) -> Bool {
        AX.setSize(element, kAXSizeAttribute as String, size)
    }
}

/// One synchronous movement keeps its native authority through mutation and observation.
/// The returned rectangle is the last timely observation, never an echo of the request.
enum WindowMovement {
    static let limits = AXTraversalLimits(maxDepth: 0, maxNodes: 1, timeout: 1,
        maxAXCalls: 256, maxAllocatedBytes: 1_024)

    static func budget(parent: AXTraversalBudget?) throws -> AXTraversalBudget {
        if let parent { return try parent.child(limits: limits) }
        // Independent retained-handle cleanup remains usable during cancelled rollback.
        return try AXTraversalBudget(limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { false })
    }

    static func perform<P: AXWindowMovementProviding>(
        windowID: CGWindowID, target: CGRect, element: P.Element, provider: P,
        budget: AXTraversalBudget, validate: () throws -> Void,
        liveBounds: () -> CGRect?, sleep: (UInt64) -> Void
    ) throws -> CGRect {
        try WindowPlacement.validate(frame: target)
        var lastBounds: CGRect?
        do {
            try budget.check()
            try validate()
            let observedID = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                provider.windowID(element)
            }
            guard windowID != 0, observedID == windowID else {
                throw SpaceOError.windowNotFound("the discovered window identity changed before placement")
            }
            // Launch settle/reveal passes often find the requested geometry already in place.
            // Avoid redundant AX setters only on an exact authoritative observation; ordinary
            // containment or an AX fallback does not prove this particular request is satisfied.
            try validate()
            try budget.check()
            let initialBounds = liveBounds()
            try validate()
            try budget.check()
            if let initialBounds, validGeometry(initialBounds), initialBounds == target {
                return initialBounds
            }
            // Position is repeated after size because apps can clamp the first position to
            // the old display. Setter return values alone never confirm the requested effect.
            _ = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                provider.setPosition(element, target.origin)
            }
            _ = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                provider.setDimensions(element, target.size)
            }
            _ = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                provider.setPosition(element, target.origin)
            }

            while true {
                try budget.check()
                try validate()
                try budget.check()
                var bounds = liveBounds()
                try budget.check()
                if bounds.map(validGeometry) != true {
                    let point = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                        provider.point(element, attribute: kAXPositionAttribute as String)
                    }
                    if let point, point.x.isFinite, point.y.isFinite {
                        let size = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                            provider.size(element, attribute: kAXSizeAttribute as String)
                        }
                        bounds = size.map { CGRect(origin: point, size: $0) }
                    } else {
                        // A size cannot produce usable geometry without a valid position.
                        bounds = nil
                    }
                }
                try validate()
                try budget.check()
                if let bounds, validGeometry(bounds) {
                    lastBounds = bounds
                    if WindowPlacement.hasLanded(bounds, at: target) { return bounds }
                }
                let remaining = budget.remainingNanoseconds
                if remaining > 0 { sleep(min(20_000_000, remaining)) }
            }
        } catch let stopped as AXTraversalStopped where stopped.reason == .deadline {
            if let lastBounds { return lastBounds }
            throw AXTraversalStopped(reason: .deadline,
                detail: "no window geometry was confirmed within the movement budget")
        }
    }

    private static func validGeometry(_ frame: CGRect) -> Bool {
        frame.origin.x.isFinite && frame.origin.y.isFinite
            && frame.size.width.isFinite && frame.size.height.isFinite
            && frame.size.width > 0 && frame.size.height > 0
            && (frame.origin.x + frame.size.width).isFinite
            && (frame.origin.y + frame.size.height).isFinite
    }
}
