// The workspace display's place among the Mac's screens, and the windows on it. Every point the
// agent gives or gets is relative to the workspace display's top-left corner, in points, the same
// as in its screenshots; macOS's global coordinates stay inside the engine.
import CoreGraphics
import Foundation

public struct Stage: Equatable {
    /// The display in global coordinates (top-left origin, points).
    public let bounds: CGRect

    public init(bounds: CGRect) {
        self.bounds = bounds
    }

    public var width: Int { Int(bounds.width) }
    public var height: Int { Int(bounds.height) }

    public func global(_ x: Double, _ y: Double) throws -> CGPoint {
        guard x >= 0, y >= 0, x < Double(bounds.width), y < Double(bounds.height) else {
            throw WorkspaceError("out_of_bounds", "(\(Int(x)), \(Int(y))) is outside the \(width)x\(height) workspace")
        }
        return CGPoint(x: bounds.minX + x, y: bounds.minY + y)
    }

    public func local(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
    }

    public func local(_ rect: CGRect) -> CGRect {
        rect.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
    }

    /// A window counts as on stage when most of it is on the workspace display.
    public func holds(_ rect: CGRect) -> Bool {
        guard rect.width > 0, rect.height > 0 else { return false }
        let inside = rect.intersection(bounds)
        return !inside.isNull && inside.width * inside.height >= 0.5 * rect.width * rect.height
    }

    /// Where the `index`th window that has to be brought onto the stage goes, and its largest size.
    public func slot(_ index: Int, size: CGSize) -> CGRect {
        let step = CGFloat(index % 8) * 28
        let origin = CGPoint(x: bounds.minX + 24 + step, y: bounds.minY + 32 + step)
        let fitted = CGSize(width: min(size.width, bounds.maxX - origin.x - 24),
                            height: min(size.height, bounds.maxY - origin.y - 24))
        return CGRect(origin: origin, size: fitted)
    }
}

public struct WindowInfo {
    public let windowID: CGWindowID
    public let pid: pid_t
    public let owner: String
    public let title: String
    public let bounds: CGRect
    public let layer: Int
}

public enum Windows {
    /// On-screen windows, front to back, optionally only those of some processes.
    public static func list(pids: Set<pid_t>? = nil) -> [WindowInfo] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return raw.compactMap { entry in
            guard let number = entry[kCGWindowNumber as String] as? Int,
                  let pid = entry[kCGWindowOwnerPID as String] as? Int,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            if let pids, !pids.contains(pid_t(pid)) { return nil }
            return WindowInfo(windowID: CGWindowID(number), pid: pid_t(pid),
                              owner: entry[kCGWindowOwnerName as String] as? String ?? "",
                              title: entry[kCGWindowName as String] as? String ?? "",
                              bounds: bounds, layer: entry[kCGWindowLayer as String] as? Int ?? 0)
        }
    }

    /// The frontmost window of these processes under a global point, ordinary windows first.
    public static func under(_ point: CGPoint, pids: Set<pid_t>) -> WindowInfo? {
        let windows = list(pids: pids)
        return windows.first { $0.layer == 0 && $0.bounds.contains(point) } ?? windows.first { $0.bounds.contains(point) }
    }
}
