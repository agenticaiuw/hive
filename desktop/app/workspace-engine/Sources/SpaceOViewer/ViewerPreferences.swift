import CoreGraphics
import Foundation
import SpaceOKit

/// How the console scales the stream. `fit` is the default so a 2560-wide tile is visible on a
/// laptop; `actualSize` shows one display point per view point.
enum ViewerZoomMode: Codable, Equatable, Sendable {
    case fit
    case actualSize
    case custom(Double)

    private enum CodingKeys: String, CodingKey { case mode, zoom }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .mode) {
        case "actualSize": self = .actualSize
        case "custom":
            let zoom = try container.decodeIfPresent(Double.self, forKey: .zoom) ?? 1
            self = zoom.isFinite && zoom > 1 ? .custom(min(ViewerZoom.maximum, zoom)) : .fit
        default: self = .fit
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .fit: try container.encode("fit", forKey: .mode)
        case .actualSize: try container.encode("actualSize", forKey: .mode)
        case let .custom(zoom):
            try container.encode("custom", forKey: .mode)
            try container.encode(zoom, forKey: .zoom)
        }
    }
}

enum ViewerZoom {
    static let minimum: Double = 1
    static let maximum: Double = 8
    static let step: Double = 0.25

    /// The zoom at which one display point is one view point, relative to aspect-fit. Never
    /// below 1: a display smaller than the console is already shown at its actual size when fit.
    static func actualSizeZoom(displayBounds: CGRect, viewSize: CGSize) -> Double {
        guard displayBounds.width > 0, displayBounds.height > 0,
              viewSize.width > 0, viewSize.height > 0,
              [displayBounds.width, displayBounds.height, viewSize.width, viewSize.height]
                  .allSatisfy(\.isFinite) else { return 1 }
        let fitScale = min(viewSize.width / displayBounds.width,
                           viewSize.height / displayBounds.height)
        guard fitScale > 0, fitScale.isFinite else { return 1 }
        return min(maximum, max(minimum, 1 / fitScale))
    }

    static func clamp(_ zoom: Double) -> Double {
        guard zoom.isFinite else { return minimum }
        return min(maximum, max(minimum, zoom))
    }

    static func zoom(for mode: ViewerZoomMode, displayBounds: CGRect, viewSize: CGSize) -> Double {
        switch mode {
        case .fit: return 1
        case .actualSize: return actualSizeZoom(displayBounds: displayBounds, viewSize: viewSize)
        case let .custom(zoom): return clamp(zoom)
        }
    }
}

/// Which notification classes the person opted into (SPAO-215). Off by default, with one
/// exception below; the Viewer only asks macOS for notification authorization when a class is
/// switched on, or when the default-on class first has something to say.
struct ViewerNotificationPreferences: Codable, Equatable, Sendable {
    /// On by default, unlike every other class. The others report something that already
    /// happened and can be reviewed later in Health; this one reports an agent that has stopped
    /// and will stay stopped until a person acts — a 2FA code, a CAPTCHA, a confirmation. With
    /// several agents running and the Viewer in the background, a silent default here means a
    /// blocked task nobody notices. It never fires for routine work: only for an agent's own
    /// explicit pause-with-a-reason, once per reason.
    var agentNeedsHuman = true
    var isolationBreach = false
    var sessionAbandoned = false
    var teardownIncomplete = false
    var leaseExpiring = false

    var anyEnabled: Bool {
        agentNeedsHuman || isolationBreach || sessionAbandoned || teardownIncomplete
            || leaseExpiring
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Absent from files written before the class existed: take the default, not "off".
        agentNeedsHuman = try container.decodeIfPresent(Bool.self, forKey: .agentNeedsHuman) ?? true
        isolationBreach = try container.decodeIfPresent(Bool.self, forKey: .isolationBreach) ?? false
        sessionAbandoned = try container.decodeIfPresent(Bool.self, forKey: .sessionAbandoned) ?? false
        teardownIncomplete = try container.decodeIfPresent(Bool.self, forKey: .teardownIncomplete) ?? false
        leaseExpiring = try container.decodeIfPresent(Bool.self, forKey: .leaseExpiring) ?? false
    }
}

/// What the Viewer remembers between launches (SPAO-161).
///
/// Deliberately absent: anything about Control. Human input capture is a live arbitration with
/// the agent that pauses its session; restoring it from a file would take over a Mac and pause
/// agents before the person has touched anything. Control is only ever entered by an action in
/// the running app.
struct ViewerPreferences: Codable, Equatable, Sendable {
    var selectedSessionID: String?
    var selectedDisplayID: UInt32?
    var canvasMode: ViewerCanvasMode = .session
    var zoomMode: ViewerZoomMode = .fit
    var inspectorSection: ViewerInspectorSection = .overview
    var sidebarVisible = true
    var inspectorVisible = false
    var lastDensity: Int?
    var showAgentActions = true
    var walkthroughDismissed = false
    var notifications = ViewerNotificationPreferences()
    var launchAsMenuBarItemOnly = false
    var miniMonitorClickThrough = false

    init() {}

    /// Every key is optional on read so a file from an older or newer Viewer still loads; an
    /// unknown enum value falls back to its default rather than discarding the whole file.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        selectedSessionID = try container.decodeIfPresent(String.self, forKey: .selectedSessionID)
        selectedDisplayID = try container.decodeIfPresent(UInt32.self, forKey: .selectedDisplayID)
        if let raw = try container.decodeIfPresent(String.self, forKey: .canvasMode),
           let mode = ViewerCanvasMode(rawValue: raw) {
            canvasMode = mode
        }
        zoomMode = (try? container.decodeIfPresent(ViewerZoomMode.self, forKey: .zoomMode)) ?? .fit
        if let raw = try container.decodeIfPresent(String.self, forKey: .inspectorSection),
           let section = ViewerInspectorSection(rawValue: raw) {
            inspectorSection = section
        }
        sidebarVisible = try container.decodeIfPresent(Bool.self, forKey: .sidebarVisible) ?? true
        inspectorVisible = try container.decodeIfPresent(Bool.self, forKey: .inspectorVisible) ?? false
        if let density = try container.decodeIfPresent(Int.self, forKey: .lastDensity),
           (1...64).contains(density) {
            lastDensity = density
        }
        showAgentActions = try container.decodeIfPresent(Bool.self, forKey: .showAgentActions) ?? true
        walkthroughDismissed =
            try container.decodeIfPresent(Bool.self, forKey: .walkthroughDismissed) ?? false
        notifications = (try? container.decodeIfPresent(
            ViewerNotificationPreferences.self, forKey: .notifications)) ?? ViewerNotificationPreferences()
        launchAsMenuBarItemOnly =
            try container.decodeIfPresent(Bool.self, forKey: .launchAsMenuBarItemOnly) ?? false
        miniMonitorClickThrough =
            try container.decodeIfPresent(Bool.self, forKey: .miniMonitorClickThrough) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(selectedSessionID, forKey: .selectedSessionID)
        try container.encodeIfPresent(selectedDisplayID, forKey: .selectedDisplayID)
        try container.encode(canvasMode.rawValue, forKey: .canvasMode)
        try container.encode(zoomMode, forKey: .zoomMode)
        try container.encode(inspectorSection.rawValue, forKey: .inspectorSection)
        try container.encode(sidebarVisible, forKey: .sidebarVisible)
        try container.encode(inspectorVisible, forKey: .inspectorVisible)
        try container.encodeIfPresent(lastDensity, forKey: .lastDensity)
        try container.encode(showAgentActions, forKey: .showAgentActions)
        try container.encode(walkthroughDismissed, forKey: .walkthroughDismissed)
        try container.encode(notifications, forKey: .notifications)
        try container.encode(launchAsMenuBarItemOnly, forKey: .launchAsMenuBarItemOnly)
        try container.encode(miniMonitorClickThrough, forKey: .miniMonitorClickThrough)
    }

    private enum CodingKeys: String, CodingKey {
        case selectedSessionID, selectedDisplayID, canvasMode, zoomMode, inspectorSection
        case sidebarVisible, inspectorVisible, lastDensity, showAgentActions
        case walkthroughDismissed, notifications, launchAsMenuBarItemOnly, miniMonitorClickThrough
    }
}

/// A JSON file next to `HostCaptureBreadcrumb`, for the reason documented there: `cfprefsd` can
/// lose an unflushed `UserDefaults` write when the process is killed, and the Viewer is a process
/// that gets killed while holding machine-wide state. Written atomically and owner-only.
struct ViewerPreferencesStore: Sendable {
    let url: URL

    static let shared = ViewerPreferencesStore(url: defaultURL())

    /// Missing, unreadable or malformed files all load as defaults. Preferences are convenience;
    /// nothing here may block the console from opening.
    func load() -> ViewerPreferences {
        guard let data = try? Data(contentsOf: url), data.count <= 64 * 1_024,
              let preferences = try? Wire.decoder.decode(ViewerPreferences.self, from: data) else {
            return ViewerPreferences()
        }
        return preferences
    }

    func save(_ preferences: ViewerPreferences) {
        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        guard let data = try? Wire.encoder.encode(preferences) else { return }
        do {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // A failed write leaves the previous file intact; the next save retries.
        }
    }

    private static func defaultURL() -> URL {
        let root = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return root
            .appendingPathComponent("SpaceO", isDirectory: true)
            .appendingPathComponent("Viewer", isDirectory: true)
            .appendingPathComponent("preferences.json", isDirectory: false)
    }
}
