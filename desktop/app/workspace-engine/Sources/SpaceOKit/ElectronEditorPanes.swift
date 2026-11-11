import ApplicationServices
import CoreGraphics
import Foundation

/// Resolving which VS Code editor pane a screen point landed in.
///
/// `editorScroll` acts on whichever pane holds focus, so a split window needs the pane addressed
/// explicitly. VS Code's extension API exposes no pixel geometry, and macOS Accessibility exposes
/// no view-column number, so neither side can answer this alone: Accessibility supplies the
/// frames, and their order supplies the view column.
///
/// That correspondence is only sound while the panes form a single row or a single column. VS
/// Code's own numbering of a two-dimensional grid is row-major in some layouts and column-major
/// in others, and guessing wrong scrolls a pane the caller did not aim at while reporting a real
/// visible-range change — a silent wrong action, which this project treats as worse than a
/// refusal. A grid is therefore refused by name instead.
public enum ElectronEditorPanes {
    /// Frames thinner than this are screen-reader proxies and layout artifacts, not panes.
    public static let minimumPaneSide: CGFloat = 8

    /// Frame edges within this many points count as aligned. Editor groups share an exact edge
    /// in principle; in practice AX rounds and borders intrude.
    public static let alignmentTolerance: CGFloat = 4

    public enum Resolution: Equatable, Sendable {
        /// Accessibility reported no pane at all, so it cannot narrow anything.
        case unknownLayout
        /// One pane. The caller should use the active-editor path, whose behaviour is unchanged.
        case single
        /// A 1-based VS Code view column.
        case column(Int)
        /// Several panes are visible and the point is inside none of them.
        case noPaneAtPoint
        /// Panes form a two-dimensional grid, where pane order does not determine view column.
        case ambiguousLayout
    }

    /// Panes in view-column order, or nil when their arrangement does not determine that order.
    public static func ordered(_ frames: [CGRect]) -> [CGRect]? {
        orderDistinct(distinctPanes(frames))
    }

    private static func orderDistinct(_ panes: [CGRect]) -> [CGRect]? {
        guard panes.count > 1 else { return panes }

        let sameRow = panes.allSatisfy {
            abs($0.minY - panes[0].minY) <= alignmentTolerance
                && abs($0.height - panes[0].height) <= alignmentTolerance
        }
        if sameRow { return panes.sorted { $0.minX < $1.minX } }

        let sameColumn = panes.allSatisfy {
            abs($0.minX - panes[0].minX) <= alignmentTolerance
                && abs($0.width - panes[0].width) <= alignmentTolerance
        }
        if sameColumn { return panes.sorted { $0.minY < $1.minY } }

        return nil
    }

    public static func resolve(point: CGPoint, in frames: [CGRect]) -> Resolution {
        let panes = distinctPanes(frames)
        guard !panes.isEmpty else { return .unknownLayout }
        // Containment is not re-checked for a lone pane. The caller reaches this only after the
        // hit-test ancestry has already proved the point is inside a code editor in this window,
        // and discovery must have completed before this resolution is used for an action.
        if panes.count == 1 { return .single }
        guard let order = orderDistinct(panes) else { return .ambiguousLayout }
        guard let index = order.firstIndex(where: { $0.contains(point) }) else {
            return .noPaneAtPoint
        }
        return .column(index + 1)
    }

    private static func distinctPanes(_ frames: [CGRect]) -> [CGRect] {
        var kept: [CGRect] = []
        for frame in frames {
            guard frame.width >= minimumPaneSide, frame.height >= minimumPaneSide else { continue }
            let duplicate = kept.contains {
                abs($0.minX - frame.minX) <= alignmentTolerance
                    && abs($0.minY - frame.minY) <= alignmentTolerance
                    && abs($0.width - frame.width) <= alignmentTolerance
                    && abs($0.height - frame.height) <= alignmentTolerance
            }
            if !duplicate { kept.append(frame) }
        }
        return kept
    }
}

/// The routing decision SpaceO makes before handing a scroll to the semantic editor channel.
enum ElectronEditorRouter {
    /// The view column to address, or nil to use the single-pane active-editor path.
    static func column(
        forPoint point: CGPoint,
        pid: pid_t,
        windowID: CGWindowID
    ) throws -> Int? {
        try column(forPoint: point) {
            try AXEditorPaneDiscovery.liveFrames(pid: pid, windowID: windowID)
        }
    }

    static func column(forPoint point: CGPoint, discover: () throws -> [CGRect]) throws -> Int? {
        let frames = try discover()
        switch ElectronEditorPanes.resolve(point: point, in: frames) {
        case .single, .unknownLayout:
            // No pane, or exactly one. The caller has already proved the point is inside a code
            // editor, so keep the single-pane path rather than refusing a window that worked.
            return nil
        case .column(let column):
            return column
        case .noPaneAtPoint:
            // Several panes, and the point is in none of them. Falling back to the active editor
            // here would scroll a pane the caller did not aim at and report a real range change.
            throw SpaceOError.unsupportedTarget(
                "the Electron control point is not inside any visible editor pane")
        case .ambiguousLayout:
            throw SpaceOError.unsupportedTarget(
                "this window's editor panes form a grid, and SpaceO cannot tell which view "
                    + "column a point belongs to in a grid layout. Scrolling is supported for "
                    + "panes split in a single row or a single column.")
        }
    }
}
