import CoreGraphics
import Foundation
import SpaceOKit

/// Where each session tile draws on top of a display stream.
///
/// `MirrorInput.ViewportMapping` hands back top-left-origin view rects, but the console is a
/// plain `ZStack` — its children are centered before any `.offset` applies, so an offset by
/// `rect.origin` lands every tile half a console away from the pixels it describes. These are
/// live buttons, so that displacement costs clicks, not just looks. `.position` is absolute, so
/// the overlay publishes a placement point and the view body carries no layout math.
///
/// Geometry validity (finite, on this display, inside its bounds) is already settled upstream by
/// `ViewerSessionPresentation.overlayFrame`, which filters `sessionsOnSelectedDisplay`.
enum SessionOverlayLayout {

    /// One session's overlay, in top-left-origin view coordinates.
    struct Tile {
        let session: SessionInfo
        /// The rect the tile covers — both its outline and its click target.
        let frame: CGRect

        /// The point `.position` needs in order to land `frame` where it belongs.
        var center: CGPoint { CGPoint(x: frame.midX, y: frame.midY) }
    }

    /// Tiles for the sessions on a display, in the order given. Empty when the console or the
    /// display is degenerate, so no NaN frame reaches SwiftUI's layout.
    static func tiles(
        for sessions: [SessionInfo],
        displayBounds: CGRect,
        viewSize: CGSize,
        zoom: CGFloat = 1,
        pan: CGPoint = .zero
    ) -> [Tile] {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds,
            viewSize: viewSize,
            zoom: zoom,
            pan: pan
        )
        return sessions.compactMap { session in
            let global = CGRect(
                x: session.x,
                y: session.y,
                width: session.width,
                height: session.height
            )
            guard let frame = mapping.viewRect(fromGlobalRect: global) else { return nil }
            return Tile(session: session, frame: frame)
        }
    }

    /// Whether the overlay may take clicks. The tiles keep drawing during an input capture — they
    /// are the operator's map of the display — but their buttons sit directly over the pixels the
    /// capture forwards to the agent, so while it is on, a click there belongs underneath.
    static func acceptsClicks(interactionEnabled: Bool) -> Bool {
        !interactionEnabled
    }
}

// MARK: - Agent actions (SPAO-158 follow-up)

/// The daemon's verdict on the agent's last input, in the receipt vocabulary.
enum AgentActionOutcome: String, Equatable, Sendable {
    case confirmed
    case unconfirmed
    case refused

    init(wire: String?) {
        self = wire.flatMap(AgentActionOutcome.init(rawValue:)) ?? .unconfirmed
    }
}

extension SessionOverlayLayout {

    /// Where the agent's last action lands on the console, in top-left-origin view coordinates.
    struct ActionMarker: Equatable {
        let sessionID: String
        /// The point `.position` needs.
        let center: CGPoint
        let outcome: AgentActionOutcome
        let action: String
        /// Role and label of the element the action addressed, when the daemon knew one.
        let target: String?
        /// When the action happened. Keying the ripple on this re-triggers it for a repeated,
        /// otherwise identical action.
        let at: Date
    }

    /// The marker for a session's last agent action, or nil when the action had no point, its
    /// window is no longer in the session's window list, or the console is degenerate.
    ///
    /// `lastAgentActionX/Y` are window-local; the daemon reports the window's frame in the same
    /// global space as the tile, so global = window origin + local point, and the same
    /// `ViewportMapping` the tiles use projects it into the view. Clicks and ripples therefore
    /// cannot drift apart at any zoom.
    static func actionMarker(
        for session: SessionInfo,
        displayBounds: CGRect,
        viewSize: CGSize,
        zoom: CGFloat = 1,
        pan: CGPoint = .zero
    ) -> ActionMarker? {
        guard let action = session.lastAgentAction,
              let at = session.lastAgentActionAt,
              let localX = session.lastAgentActionX,
              let localY = session.lastAgentActionY,
              let windowID = session.lastAgentActionWindowID,
              let window = session.windows.first(where: { $0.windowID == windowID }),
              [localX, localY, window.x, window.y].allSatisfy(\.isFinite) else { return nil }
        let global = CGPoint(x: window.x + localX, y: window.y + localY)
        guard displayBounds.insetBy(dx: -0.5, dy: -0.5).contains(global) else { return nil }
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds,
            viewSize: viewSize,
            zoom: zoom,
            pan: pan
        )
        guard let rect = mapping.viewRect(
            fromGlobalRect: CGRect(origin: global, size: .zero)) else { return nil }
        return ActionMarker(
            sessionID: session.id,
            center: rect.origin,
            outcome: AgentActionOutcome(wire: session.lastAgentActionOutcome),
            action: action,
            target: session.lastAgentActionTarget,
            at: at
        )
    }

    static func actionMarkers(
        for sessions: [SessionInfo],
        displayBounds: CGRect,
        viewSize: CGSize,
        zoom: CGFloat = 1,
        pan: CGPoint = .zero
    ) -> [ActionMarker] {
        sessions.compactMap {
            actionMarker(for: $0, displayBounds: displayBounds, viewSize: viewSize,
                         zoom: zoom, pan: pan)
        }
    }
}

/// The navigator's 60-second activity sparkline, from the action timestamps the model keeps.
enum ViewerActivitySparkline {
    static let window: TimeInterval = 60
    static let bucketCount = 12

    /// Actions per bucket, oldest first; the last bucket ends at `now`.
    static func buckets(
        timestamps: [Date],
        now: Date,
        window: TimeInterval = ViewerActivitySparkline.window,
        count: Int = ViewerActivitySparkline.bucketCount
    ) -> [Int] {
        guard count > 0, window > 0 else { return [] }
        var buckets = Array(repeating: 0, count: count)
        let bucketLength = window / Double(count)
        for timestamp in timestamps {
            let age = now.timeIntervalSince(timestamp)
            guard age >= 0, age < window else { continue }
            let index = count - 1 - Int(age / bucketLength)
            buckets[max(0, min(count - 1, index))] += 1
        }
        return buckets
    }
}
