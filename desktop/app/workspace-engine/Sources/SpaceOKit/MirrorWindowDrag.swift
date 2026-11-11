import ApplicationServices
import CoreGraphics
import Foundation

extension MirrorInput {

    /// A window the person is dragging by its title bar in the Viewer.
    ///
    /// Per-PID pointer events reach the app but never the WindowServer's own title-bar drag, so a
    /// drag on window chrome would otherwise do nothing. The Viewer moves the window itself,
    /// through Accessibility, and keeps it inside the session's area.
    public struct WindowDrag {
        public let element: AXUIElement
        public let windowID: CGWindowID
        /// The window's frame when the drag began, in global coordinates.
        public let startFrame: CGRect
        /// Where the pointer went down, in global coordinates.
        public let startPoint: CGPoint

        public init(element: AXUIElement, windowID: CGWindowID, startFrame: CGRect,
                    startPoint: CGPoint) {
            self.element = element
            self.windowID = windowID
            self.startFrame = startFrame
            self.startPoint = startPoint
        }

        /// The window origin for a pointer at `point`, kept inside `bounds`. A window larger than
        /// `bounds` is pinned to its leading and top edges so its title bar stays reachable.
        public func origin(for point: CGPoint, within bounds: CGRect) -> CGPoint {
            Self.clampedOrigin(
                CGPoint(x: startFrame.minX + point.x - startPoint.x,
                        y: startFrame.minY + point.y - startPoint.y),
                size: startFrame.size, within: bounds)
        }

        static func clampedOrigin(_ origin: CGPoint, size: CGSize, within bounds: CGRect) -> CGPoint {
            guard bounds.width > 0, bounds.height > 0,
                  origin.x.isFinite, origin.y.isFinite else { return origin }
            let maxX = max(bounds.minX, bounds.maxX - size.width)
            let maxY = max(bounds.minY, bounds.maxY - size.height)
            return CGPoint(x: min(max(origin.x, bounds.minX), maxX),
                           y: min(max(origin.y, bounds.minY), maxY))
        }
    }

    /// Only this far below a window's top edge counts as its title bar or toolbar.
    public static let windowChromeDepth: CGFloat = 80

    /// Roles that are window chrome rather than content when they are what the pointer hit.
    static let chromeRoles: Set<String> = ["AXWindow", "AXToolbar"]

    public static func startsWindowDrag(hitRole: String, parentRole: String?,
                                        depthBelowTop: CGFloat) -> Bool {
        guard depthBelowTop >= 0, depthBelowTop <= windowChromeDepth else { return false }
        if chromeRoles.contains(hitRole) { return true }
        // The window's title text, and empty groups inside a toolbar, are chrome too.
        if let parentRole, chromeRoles.contains(parentRole) {
            return hitRole == "AXStaticText" || hitRole == "AXGroup" || hitRole == "AXUnknown"
        }
        return false
    }

    public static func windowDrag(at global: CGPoint, candidate: WindowCandidate) -> WindowDrag? {
        guard AXIsProcessTrusted(),
              let hit = AX.element(at: global, in: candidate.pid, windowID: candidate.windowID)
        else { return nil }
        let role = AX.role(hit)
        let parentRole = AX.element(hit, kAXParentAttribute as String).map(AX.role)
        guard startsWindowDrag(hitRole: role, parentRole: parentRole,
                               depthBelowTop: global.y - candidate.bounds.minY) else { return nil }
        var window: AXUIElement? = hit
        var hops = 0
        while let current = window, AX.role(current) != "AXWindow", hops < 8 {
            window = AX.element(current, kAXParentAttribute as String)
            hops += 1
        }
        guard let window, AX.role(window) == "AXWindow",
              AX.windowID(window) == candidate.windowID else { return nil }
        return WindowDrag(element: window, windowID: candidate.windowID,
                          startFrame: candidate.bounds, startPoint: global)
    }

    /// Move a dragged window. Returns false when the app refused the position.
    @discardableResult
    public static func moveWindow(_ drag: WindowDrag, to origin: CGPoint) -> Bool {
        AX.setPoint(drag.element, kAXPositionAttribute as String, origin)
    }
}
