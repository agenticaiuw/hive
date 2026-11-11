import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import ScreenCaptureKit
import SpaceOKit
import SwiftUI

struct DisplayEntry: Identifiable, Equatable, Sendable {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let isSpaceO: Bool
    let isActive: Bool
    let name: String

    /// Rect equality at capture resolution. Anything non-finite counts as a change so a bad
    /// reading can never be mistaken for "nothing moved".
    static func rectsMatch(_ lhs: CGRect,
                           _ rhs: CGRect,
                           tolerance: CGFloat = 0.5) -> Bool {
        let deltas = [
            abs(lhs.minX - rhs.minX),
            abs(lhs.minY - rhs.minY),
            abs(lhs.width - rhs.width),
            abs(lhs.height - rhs.height),
        ]
        return !deltas.contains { !$0.isFinite || $0 >= tolerance }
    }
}

struct PermissionState: Equatable {
    var screenRecording = false
    var accessibility = false
}

enum ViewerStreamState: Equatable {
    case idle
    case starting
    case live
    case failed(String)

    var isLive: Bool {
        if case .live = self { return true }
        return false
    }

    var statusText: String {
        switch self {
        case .idle: "idle"
        case .starting: "starting"
        case .live: "live"
        case .failed: "failed"
        }
    }
}

enum ViewerSessionBadge: Equatable, Sendable {
    case owned
    case abandoned
    case reclaimable
    case cleanupPending

    var title: String {
        switch self {
        case .owned: "Owned"
        case .abandoned: "Abandoned"
        case .reclaimable: "Reclaimable"
        case .cleanupPending: "Cleanup pending"
        }
    }

    var systemImage: String {
        switch self {
        case .owned: "person.crop.circle.fill"
        case .abandoned: "exclamationmark.triangle.fill"
        case .reclaimable: "arrow.uturn.backward.circle.fill"
        case .cleanupPending: "hourglass.circle.fill"
        }
    }
}

/// A small, deterministic presentation model keeps lifecycle precedence, duration wording, and
/// overlay admission consistent without making the Viewer's read-only polling path stateful.
struct ViewerSessionPresentation: Equatable, Sendable {
    let badge: ViewerSessionBadge?
    let ownerText: String?
    let timingText: String?

    init(session: SessionInfo, now: Date = Date()) {
        self.init(
            teardownPending: session.teardownPending,
            controllerOwner: session.controllerOwner,
            ageSeconds: session.ageSeconds,
            lastActivityAt: session.lastActivityAt,
            abandoned: session.abandoned,
            reclaimable: session.reclaimable,
            now: now
        )
    }

    init(
        teardownPending: Bool,
        controllerOwner: DurableSessionOwner?,
        ageSeconds: TimeInterval?,
        lastActivityAt: Date?,
        abandoned: Bool?,
        reclaimable: Bool?,
        now: Date = Date()
    ) {
        if teardownPending {
            badge = .cleanupPending
        } else if reclaimable == true {
            badge = .reclaimable
        } else if abandoned == true {
            badge = .abandoned
        } else if controllerOwner != nil {
            badge = .owned
        } else {
            // Older daemons do not send controller metadata. Absence is not abandonment.
            badge = nil
        }

        if let controllerOwner {
            let trimmedLabel = controllerOwner.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = trimmedLabel.isEmpty ? controllerOwner.id : trimmedLabel
            ownerText = "Owner: \(displayName) · \(Self.ownerKindName(controllerOwner.kind))"
        } else {
            ownerText = nil
        }

        var timingParts: [String] = []
        if let lastActivityAt {
            let elapsed = max(0, now.timeIntervalSince(lastActivityAt))
            if elapsed.isFinite {
                let relative = elapsed < 10
                    ? "just now"
                    : "\(Self.compactDuration(elapsed)) ago"
                timingParts.append("Last activity \(relative)")
            }
        }
        if let ageSeconds, ageSeconds.isFinite {
            timingParts.append("Age \(Self.compactDuration(max(0, ageSeconds)))")
        }
        timingText = timingParts.isEmpty ? nil : timingParts.joined(separator: " · ")
    }

    func accessibilityDescription(sessionID: String) -> String {
        var parts = ["Session \(sessionID)."]
        if let badge {
            parts.append("Status: \(badge.title).")
        }
        if let ownerText {
            parts.append("\(ownerText).")
        }
        if let timingText {
            parts.append("\(timingText).")
        }
        return parts.joined(separator: " ")
    }

    /// Only live SpaceO geometry is eligible for an overlay. An omitted attachment flag is
    /// accepted for compatibility with older daemons, whose lists contained only live sessions.
    static func overlayFrame(
        displayID: UInt32,
        frame: CGRect,
        runtimeAttached: Bool? = nil,
        on display: DisplayEntry
    ) -> CGRect? {
        guard runtimeAttached != false,
              display.isSpaceO,
              display.isActive,
              display.id == displayID else {
            return nil
        }
        let values = [
            display.bounds.minX, display.bounds.minY,
            display.bounds.width, display.bounds.height,
            frame.minX, frame.minY, frame.width, frame.height,
        ]
        guard values.allSatisfy(\.isFinite),
              display.bounds.width > 0,
              display.bounds.height > 0,
              frame.width > 0,
              frame.height > 0 else {
            return nil
        }

        // WindowServer geometry can differ by a sub-point during a display transition. Admit
        // that rounding only; records whose old tiles no longer belong to this display stay out.
        let liveBounds = display.bounds.insetBy(dx: -0.5, dy: -0.5)
        guard liveBounds.contains(frame) else { return nil }
        return frame
    }

    private static func compactDuration(_ seconds: TimeInterval) -> String {
        let totalSeconds = Int(seconds.rounded(.down))
        if totalSeconds < 60 {
            return "\(totalSeconds)s"
        }
        if totalSeconds < 3_600 {
            return "\(totalSeconds / 60)m"
        }
        if totalSeconds < 86_400 {
            let hours = totalSeconds / 3_600
            let minutes = (totalSeconds % 3_600) / 60
            return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
        }
        let days = totalSeconds / 86_400
        let hours = (totalSeconds % 86_400) / 3_600
        return hours == 0 ? "\(days)d" : "\(days)d \(hours)h"
    }

    private static func ownerKindName(_ kind: DurableSessionOwnerKind) -> String {
        switch kind {
        case .cli: "CLI"
        case .mcp: "MCP"
        case .viewer: "Viewer"
        case .other: "Other"
        @unknown default: "Other"
        }
    }
}

@MainActor
@Observable
final class ViewerModel {

    typealias DiscoverySnapshot = (displays: [DisplayEntry], permissions: PermissionState)
    typealias DiscoveryProvider = @MainActor () -> DiscoverySnapshot
    typealias DaemonTransport = @Sendable (Request) throws -> Response
    /// Raising the system permission prompts is the one Viewer action a test must never take:
    /// it puts a modal panel on the machine running the suite.
    typealias PermissionPrompt = @MainActor (PermissionState) -> Void
    typealias FrontWindowProvider = @MainActor (_ displayBounds: CGRect) -> WindowRef?

    struct StreamTarget: Equatable, Sendable {
        let display: DisplayEntry
        let sourceRect: CGRect?
        let interactionDisplay: DisplayEntry

        /// The part of a target only a fresh `SCStream` can change: which display is captured
        /// and at what size. Deliberately narrower than `Equatable`, which also covers
        /// `DisplayEntry`'s cosmetic fields — `name` lags behind `CGGetOnlineDisplayList`
        /// because AppKit only refreshes `NSScreen.screens` on its own reconfiguration pass, so
        /// treating a rename as a restart would tear down a healthy capture on a routine poll.
        func sameIdentity(as other: StreamTarget) -> Bool {
            display.id == other.display.id
                && interactionDisplay.id == other.interactionDisplay.id
                && DisplayEntry.rectsMatch(display.bounds, other.display.bounds)
        }

        /// The part a running stream can take in place (SPAO-162): which region of the display
        /// is shown and, in step with it, where clicks land.
        func sameCrop(as other: StreamTarget) -> Bool {
            guard DisplayEntry.rectsMatch(
                interactionDisplay.bounds,
                other.interactionDisplay.bounds
            ) else { return false }
            switch (sourceRect, other.sourceRect) {
            case (nil, nil): return true
            case let (lhs?, rhs?): return DisplayEntry.rectsMatch(lhs, rhs)
            default: return false
            }
        }
    }

    /// What a poll did to the stream target, decided once so discovery and control-plane
    /// updates cannot disagree about which changes restart the capture.
    enum StreamTargetChange: Equatable {
        case none
        /// Same display, same size; only the tile region moved. Reconfigure in place.
        case crop
        /// A different display, size, or presence. Start over.
        case identity

        static func classify(from previous: StreamTarget?,
                                         to current: StreamTarget?) -> StreamTargetChange {
            switch (previous, current) {
            case (nil, nil):
                return .none
            case let (previous?, current?):
                guard previous.sameIdentity(as: current) else { return .identity }
                return previous.sameCrop(as: current) ? .none : .crop
            default:
                return .identity
            }
        }
    }

    private(set) var displays: [DisplayEntry] = []
    var selectedID: CGDirectDisplayID? {
        didSet {
            if oldValue != selectedID {
                restartStreamForCurrentSelection()
            }
        }
    }
    private(set) var interactionEnabled = false {
        didSet {
            input.interactionEnabled = interactionEnabled
                && interactionDisplay != nil
                && streamState.isLive
            if !interactionEnabled { note = nil }
            guard oldValue != interactionEnabled else { return }
            controlStartedAt = interactionEnabled ? Date() : nil
            if interactionEnabled {
                resolveKeyDestination()
            } else {
                keyDestination = nil
                pendingPasteConfirmation = nil
            }
            accessibilityAnnouncement(
                ViewerAccessibility.controlAnnouncement(
                    enabled: interactionEnabled,
                    displayName: interactionDisplay?.name
                )
            )
        }
    }
    private(set) var streamState: ViewerStreamState = .idle
    private(set) var streamError: String?
    private(set) var permissions = PermissionState()
    private(set) var sessions: [SessionInfo] = []
    var note: InputNote?
    private(set) var selectedSessionID: String?
    var searchText = ""
    private(set) var canvasMode: ViewerCanvasMode = .session
    var viewportZoom: CGFloat = 1
    var viewportPan: CGPoint = .zero
    var zoomMode: ViewerZoomMode = .fit
    var surfaceSize: CGSize = .zero
    var inspectorSection: ViewerInspectorSection = .overview {
        didSet { if oldValue != inspectorSection { updatePreferences { $0.inspectorSection = inspectorSection } } }
    }
    var columnVisibility: NavigationSplitViewVisibility = .all {
        didSet { updatePreferences { $0.sidebarVisible = columnVisibility != .detailOnly } }
    }
    var inspectorVisible = false {
        didSet { updatePreferences { $0.inspectorVisible = inspectorVisible } }
    }
    /// What the Viewer remembers between launches. Mutate through `updatePreferences`.
    var preferences = ViewerPreferences()
    private(set) var connectivity: ViewerConnectivityState = .connecting
    private(set) var infrastructure = ViewerInfrastructureSnapshot()
    private(set) var events: [ViewerEvent] = []
    private(set) var daemonError: String?
    private(set) var screenshotResult: ViewerScreenshotResult?
    /// When the running capture was last re-cropped in place, for the brief "tile moved" cue.
    private(set) var tileMovedAt: Date?
    /// Recent agent action times per session, newest last, bounded. Built from the poll delta;
    /// feeds the navigator sparkline.
    private(set) var agentActivity: [String: [Date]] = [:]
    static let agentActivityLimit = 120
    /// SPAO-219. Sessions this Viewer paused for Control whose resume is waiting on the
    /// person's hand-back note. Nil when no hand-back is in progress.
    private(set) var pendingHandoff: PendingHandoff?
    @ObservationIgnored private var controlStartedAt: Date?
    /// A destructive action (Destroy, Clean Up) waiting for the person's confirmation. One
    /// model-owned slot, so the Health list, the sidebar, the toolbar and the Session menu all
    /// reach the same dialog.
    private(set) var pendingConfirmation: ViewerHealthAction?
    /// Where keystrokes go while Control is on ("Safari — Sign in"). Nil without Control.
    /// Written by `resolveKeyDestination` and `keyTargetChanged` only.
    var keyDestination: ViewerKeyDestination?
    /// Set when the daemon answering is a different instance from the one this Viewer saw
    /// before: every session the person was looking at ended with the old process.
    private(set) var daemonRestarted = false

    func clearDaemonRestarted() { daemonRestarted = false }
    @ObservationIgnored private(set) var knownDaemonInstanceID: UUID?
    /// A notification click (or anything else outside a window) asked for the console to be
    /// shown. The always-present menu bar label observes it and opens a window.
    var windowRequested = false
    var eventsFilter: ViewerEventFilter = .all
    /// Take Control asked for a session that was not on the canvas yet. Control begins once the
    /// stream for `generation` is live, unless the selection moves or `expires` passes first.
    @ObservationIgnored private var pendingControl: (sessionID: String, generation: UInt64, expires: Date)?
    static let pendingControlLifetime: TimeInterval = 5
    var pendingControlSessionID: String? { pendingControl?.sessionID }
    /// Sessions paused for this Control that had paused *themselves* to ask for a person. A
    /// forced release (stream loss, selection change) does not resume them: they are still
    /// waiting for exactly the help the person has not finished giving.
    @ObservationIgnored private var sessionsAwaitingHuman: Set<String> = []
    /// Help requests already announced to VoiceOver, keyed `id|reason`.
    @ObservationIgnored var announcedHelpRequestKeys: Set<String> = []
    @ObservationIgnored var lastDockBadgeValue: String?
    /// Stream health bookkeeping. Deliberately untracked: frames arrive at up to 30 Hz
    /// and the status bar samples health on its own one-second timeline instead.
    @ObservationIgnored private(set) var lastSampleAt: Date?
    @ObservationIgnored private(set) var liveSince: Date?
    @ObservationIgnored private(set) var recentFrameTimes: [Date] = []
    static let recentFrameLimit = 90

    struct PendingHandoff: Identifiable, Equatable {
        let id = UUID()
        let sessionIDs: [String]
        let controlDuration: TimeInterval
    }
    /// SPAO-215. Poll-delta notification state and the sessions whose last `verify` reported a
    /// breach. The Viewer does not run `verify` on its own; `recordIsolationVerdict` is the
    /// entry point for a future event stream or an explicit check.
    @ObservationIgnored var notificationPolicy = NotificationPolicy()
    var isolationBreaches: Set<String> = []
    let notificationPoster: (any ViewerNotificationPosting)?
    /// SPAO-160. Explicit-action pasteboard seams; production reads and writes
    /// `NSPasteboard.general`, tests record. The Viewer never touches the pasteboard otherwise.
    let pasteboardWriter: (String) -> Void
    let pasteboardReader: () -> String?
    var pendingFileDrop: PendingFileDrop?
    var pendingPasteConfirmation: PendingPaste?
    @ObservationIgnored var pasteConfirmedSessions: Set<String> = []
    /// SPAO-217. Mirrors the mini monitor panel so the Window menu label can follow it.
    var miniMonitorVisible = false
    /// SPAO-205. Walkthrough progress for this run, and whether Help asked to show it again.
    var walkthroughSessionCreated = false
    var walkthroughLaunchInFlight = false
    var walkthroughPresented = false
    /// The Settings route. Nil shows the console; a pane replaces it with Settings.
    var settingsPane: ViewerSettingsPane?
    /// A permission the person is being walked through granting. Shown as a sheet that closes
    /// itself once the grant lands.
    var permissionGuide: ViewerPermissionKind?
    /// Preview scenarios draw the Control frame without taking Control (see `ViewerPreview`).
    var previewControlChrome = false
    /// One-click MCP client registration, shared by the welcome guide and Settings.
    @ObservationIgnored lazy var agentConnections = ViewerAgentConnections()

    let input = ViewerInputController()

    /// Frame consumers keyed by surface. Every open console window and the mini monitor gets
    /// each frame; one shared closure meant the newest window silently blanked the others.
    var performanceFrameSinkCount: Int { frameSinks.count }
    @ObservationIgnored private var frameSinks: [AnyHashable: (CMSampleBuffer) -> Void] = [:]
    @ObservationIgnored private var frameDemandTask: Task<Void, Never>?
    private static let defaultFrameSinkID = "default"

    /// The default surface's sink; kept for callers with one surface.
    var onFrame: ((CMSampleBuffer) -> Void)? {
        get { frameSinks[Self.defaultFrameSinkID] }
        set {
            if let newValue { addFrameSink(Self.defaultFrameSinkID, newValue) }
            else { removeFrameSink(Self.defaultFrameSinkID) }
        }
    }

    func addFrameSink(_ id: AnyHashable, _ sink: @escaping (CMSampleBuffer) -> Void) {
        let wasEmpty = frameSinks.isEmpty
        frameSinks[id] = sink
        if wasEmpty { reconcileFrameDemand() }
    }

    func removeFrameSink(_ id: AnyHashable) {
        guard frameSinks.removeValue(forKey: id) != nil else { return }
        if frameSinks.isEmpty { reconcileFrameDemand() }
    }

    private func reconcileFrameDemand() {
        guard frameDemandTask == nil else { return }
        // Surface creation/destruction can happen inside a SwiftUI update. Defer observable
        // state changes and coalesce a same-update surface replacement into no stream restart.
        frameDemandTask = Task { @MainActor [weak self] in
            guard let self else { return }
            frameDemandTask = nil
            if frameSinks.isEmpty {
                if streamState != .idle { restartStreamForCurrentSelection() }
            } else if streamState == .idle, currentStreamTarget != nil {
                restartStreamForCurrentSelection()
            }
        }
    }

    let preferencesStore: ViewerPreferencesStore?
    @ObservationIgnored var preferencesSaveTask: Task<Void, Never>?
    @ObservationIgnored var selectionRestored = false

    private let streamEngine: any ViewerDisplayStreaming
    private let discoveryProvider: DiscoveryProvider
    let daemonTransport: DaemonTransport
    let permissionPrompt: PermissionPrompt
    let accessibilityAnnouncement: (String) -> Void
    /// Resolves the stage's front window for the key-destination banner. Nil in tests and
    /// previews: resolving it reads the WindowServer window list.
    let frontWindowProviderForDestination: FrontWindowProvider?
    let appNameForDestination: (pid_t) -> String?
    /// The Dock badge seam: production sets `NSApp.dockTile.badgeLabel`; tests record.
    let setDockBadge: (String?) -> Void
    @ObservationIgnored private var refreshTimer: Timer?
    /// Live daemon events (SPAO-214). The 2 s poll stays as the fallback when the stream drops.
    @ObservationIgnored var eventSubscription: Transport.EventSubscription?
    /// True between the stream's first delivered batch and its close. While it is up, agent
    /// actions reach the feed from the stream, and the poll delta must not add them again.
    @ObservationIgnored var eventStreamConnected = false
    @ObservationIgnored var eventStreamReconnectAttempts = 0
    @ObservationIgnored var eventStreamGeneration: UInt64 = 0
    @ObservationIgnored var eventStreamMailbox: ViewerEventMailbox?
    @ObservationIgnored var eventStreamReconnectTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var teardownTask: Task<Void, Never>?
    @ObservationIgnored private var activeStream: (
        generation: UInt64,
        target: StreamTarget,
        session: any ViewerDisplayStreamSession
    )?
    @ObservationIgnored private(set) var streamGeneration: UInt64 = 0
    @ObservationIgnored private var daemonFailureStartedAt: Date?
    @ObservationIgnored private var daemonProcess: Process?
    @ObservationIgnored private var controlPlaneRefreshInFlight = false
    @ObservationIgnored private var controlPlaneRefreshPending = false
    @ObservationIgnored private var controlPlaneRevision: UInt64 = 0
    @ObservationIgnored private var sessionsPausedForHumanControl: Set<String> = []
    /// Bumped whenever Control is taken or released. A pause round-trip that completes after
    /// the token moved on belongs to a Control the person no longer holds.
    @ObservationIgnored private var humanControlRequestToken: UInt64 = 0
    private var humanControlPauseInFlight = false
    private var humanControlResumesInFlight = 0
    private var agentPauseChangeInFlight = false
    /// Sessions created by this Viewer retain their controller lease here so the two-second
    /// control-plane poll can heartbeat them instead of letting them become abandoned.
    @ObservationIgnored var viewerOwnedLeases: [String: UUID] = [:]

    /// ScreenCaptureKit owns the sample while its callback is running. The receiving surface
    /// keeps the buffer alive once this immutable reference reaches the main actor.
    private struct FrameDelivery: @unchecked Sendable {
        let sample: CMSampleBuffer
    }

    var streamRunning: Bool { streamState.isLive }
    var selected: DisplayEntry? { displays.first { $0.id == selectedID } }
    var selectedSession: SessionInfo? {
        guard let selectedSessionID else { return nil }
        return sessions.first { $0.id == selectedSessionID }
    }
    var stages: [DisplayEntry] { displays.filter(\.isSpaceO) }
    var attachedSessions: [SessionInfo] {
        sessions
            .filter { $0.runtimeAttached != false }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id < $1.id
            }
    }
    var filteredSessions: [SessionInfo] {
        attachedSessions.filter { ViewerSessionSearch.matches($0, query: searchText) }
    }
    var detachedSessions: [SessionInfo] {
        Self.detachedSessions(from: sessions)
    }

    static func detachedSessions(from sessions: [SessionInfo]) -> [SessionInfo] {
        sessions
            .filter { $0.runtimeAttached == false }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.id < $1.id
            }
    }
    var sessionsOnSelectedDisplay: [SessionInfo] {
        guard let selected else { return [] }
        return sessions.filter { session in
            // A daemon-restart record keeps its last placement only for diagnosis. Display ids
            // are recyclable, so even an apparently matching live display must not turn that
            // stale record into an input or rendering overlay.
            let frame = CGRect(
                x: session.x,
                y: session.y,
                width: session.width,
                height: session.height
            )
            return ViewerSessionPresentation.overlayFrame(
                displayID: session.displayID,
                frame: frame,
                runtimeAttached: session.runtimeAttached,
                on: selected
            ) != nil
        }
    }

    /// Input capture is deliberately narrower than display inspection. Physical displays are
    /// visible in the sidebar for topology diagnosis, but letting the toolbar or its keyboard
    /// shortcut arm Control there would route events onto the user's original monitor. An empty
    /// SpaceO display retained for the short reuse grace is also not a meaningful control target.
    var controlTargetAvailable: Bool {
        selected?.isSpaceO == true && !sessionsOnSelectedDisplay.isEmpty
    }

    var selectedSessionInputPaused: Bool {
        selectedSession?.inputPaused == true
    }

    nonisolated static func agentActionDetail(_ session: SessionInfo) -> String {
        var parts = [session.lastAgentAction ?? "action"]
        if let outcome = session.lastAgentActionOutcome, !outcome.isEmpty {
            parts.append(outcome)
        }
        if let target = session.lastAgentActionTarget, !target.isEmpty {
            parts.append(target)
        }
        return parts.joined(separator: " · ")
    }

    /// Ripple markers for the console at its current size, honouring the View menu toggle.
    /// Session scope maps against the tile; Display scope shows every session on the display.
    func agentActionMarkers(viewSize: CGSize) -> [SessionOverlayLayout.ActionMarker] {
        guard showAgentActions else { return [] }
        if canvasMode == .session {
            guard let session = selectedSession, let bounds = interactionDisplay?.bounds else {
                return []
            }
            return SessionOverlayLayout.actionMarkers(
                for: [session], displayBounds: bounds, viewSize: viewSize,
                zoom: viewportZoom, pan: viewportPan)
        }
        guard let display = selected else { return [] }
        return SessionOverlayLayout.actionMarkers(
            for: sessionsOnSelectedDisplay, displayBounds: display.bounds, viewSize: viewSize,
            zoom: viewportZoom, pan: viewportPan)
    }

    /// Recent agent input shown directly on the canvas, where arbitration happens.
    var selectedAgentActivityText: String? {
        guard let session = selectedSession,
              session.inputPaused != true,
              let action = session.lastAgentAction,
              let at = session.lastAgentActionAt,
              Date().timeIntervalSince(at) <= 5 else { return nil }
        return "Agent active · \(action)"
    }

    private var currentStreamTarget: StreamTarget? {
        guard let selected else { return nil }
        guard canvasMode == .session,
              let session = selectedSession,
              session.runtimeAttached != false,
              session.displayID == selected.id else {
            return StreamTarget(
                display: selected,
                sourceRect: nil,
                interactionDisplay: selected
            )
        }
        let globalFrame = CGRect(
            x: session.x,
            y: session.y,
            width: session.width,
            height: session.height
        )
        guard ViewerSessionPresentation.overlayFrame(
            displayID: session.displayID,
            frame: globalFrame,
            runtimeAttached: session.runtimeAttached,
            on: selected
        ) != nil else {
            return StreamTarget(
                display: selected,
                sourceRect: nil,
                interactionDisplay: selected
            )
        }
        let sourceRect = CGRect(
            x: globalFrame.minX - selected.bounds.minX,
            y: globalFrame.minY - selected.bounds.minY,
            width: globalFrame.width,
            height: globalFrame.height
        )
        return StreamTarget(
            display: selected,
            sourceRect: sourceRect,
            interactionDisplay: DisplayEntry(
                id: selected.id,
                bounds: globalFrame,
                isSpaceO: selected.isSpaceO,
                isActive: selected.isActive,
                name: "Session \(session.id)"
            )
        )
    }

    var interactionDisplay: DisplayEntry? {
        currentStreamTarget?.interactionDisplay
    }

    var healthAlerts: [ViewerHealthAlert] {
        var alerts: [ViewerHealthAlert] = []
        if connectivity == .disconnected {
            alerts.append(ViewerHealthAlert(
                id: "daemon-offline",
                severity: .critical,
                title: "SpaceO daemon is offline",
                detail: daemonError ?? "No control-plane response is available.",
                actionTitle: "Start daemon",
                action: .startDaemon
            ))
        } else if connectivity == .degraded {
            alerts.append(ViewerHealthAlert(
                id: "daemon-degraded",
                severity: .warning,
                title: "Daemon connection is interrupted",
                detail: daemonError ?? "The Viewer will continue retrying.",
                actionTitle: "Retry now",
                action: .refreshDaemon
            ))
        }
        if !permissions.screenRecording {
            alerts.append(ViewerHealthAlert(
                id: "screen-recording",
                severity: .critical,
                title: "Display capture is blocked",
                detail: "Grant Screen Recording permission to view agent sessions.",
                actionTitle: "Open Settings",
                action: .openScreenRecordingSettings
            ))
        }
        if !permissions.accessibility {
            alerts.append(ViewerHealthAlert(
                id: "accessibility",
                severity: .warning,
                title: "Full control is unavailable",
                detail: "Grant Accessibility permission to forward keyboard and pointer input.",
                actionTitle: "Open Settings",
                action: .openAccessibilitySettings
            ))
        }
        if infrastructure.daemon?.accessibilityGranted == false {
            alerts.append(ViewerHealthAlert(
                id: "daemon-accessibility",
                severity: .critical,
                title: "Agent computer use is blocked",
                detail: "The daemon lacks Accessibility permission. Grant it to the terminal or "
                    + "app that started the daemon, then restart the daemon.",
                actionTitle: "Show Me How",
                action: .guidePermission(.daemonAccessibility)
            ))
        }
        if infrastructure.daemon?.screenRecordingGranted == false {
            alerts.append(ViewerHealthAlert(
                id: "daemon-screen-recording",
                severity: .warning,
                title: "Agent screenshots are blocked",
                detail: "The daemon lacks Screen Recording permission. Grant it to the terminal "
                    + "or app that started the daemon, then restart the daemon.",
                actionTitle: "Show Me How",
                action: .guidePermission(.daemonScreenRecording)
            ))
        }
        if case let .failed(message) = streamState {
            alerts.append(ViewerHealthAlert(
                id: "stream",
                severity: .critical,
                title: "Session stream failed",
                detail: message,
                actionTitle: "Retry stream",
                action: .retryStream
            ))
        }
        for session in sessions where session.runtimeAttached != false {
            let presentation = ViewerSessionPresentation(session: session)
            if presentation.badge == .cleanupPending
                || presentation.badge == .abandoned
                || presentation.badge == .reclaimable {
                alerts.append(ViewerHealthAlert(
                    id: "session-\(session.id)",
                    severity: presentation.badge == .cleanupPending ? .critical : .warning,
                    title: "\(session.id): \(presentation.badge?.title ?? "Needs attention")",
                    detail: presentation.timingText
                        ?? "Review the session ownership and runtime state.",
                    actionTitle: presentation.badge == .reclaimable ? "Clean Up…" : "End Session…",
                    action: presentation.badge == .reclaimable
                        ? .reclaimSession(session.id)
                        : .destroySession(session.id)
                ))
            }
        }
        for session in detachedSessions {
            alerts.append(ViewerHealthAlert(
                id: "recovery-\(session.id)",
                severity: session.reclaimable == true ? .warning : .critical,
                title: "\(session.id): detached recovery",
                detail: session.recoveryBlockers?.map(\.message).joined(separator: "; ")
                    ?? "The prior daemon left recoverable resources.",
                actionTitle: session.reclaimable == true ? "Clean Up…" : "Retry Cleanup…",
                action: .reclaimSession(session.id)
            ))
        }
        return alerts.sorted { $0.severity > $1.severity }
    }

    /// The entry point for every button that offers a health or maintenance action. Anything
    /// that quits apps waits in `pendingConfirmation` for the person's answer; the rest runs.
    func request(_ action: ViewerHealthAction) {
        if action.requiresConfirmation {
            pendingConfirmation = action
        } else {
            perform(action)
        }
    }

    func confirmPendingAction() {
        guard let action = pendingConfirmation else { return }
        pendingConfirmation = nil
        perform(action)
    }

    func cancelPendingAction() {
        pendingConfirmation = nil
    }

    func confirmationTitle(for action: ViewerHealthAction) -> String {
        if case let .removeDisplay(displayID) = action {
            let name = displays.first { $0.id == displayID }
                .map { ViewerStyle.displayTitle($0, among: stages) } ?? "display \(displayID)"
            return action.confirmationTitle(sessionTitle: name)
        }
        let id = action.sessionID ?? ""
        let title = sessions.first { $0.id == id }.map(ViewerSessionGrouping.displayTitle) ?? id
        return action.confirmationTitle(sessionTitle: title)
    }

    /// Runs an action immediately. Destructive actions reach here only through
    /// `confirmPendingAction`; call `request` from UI.
    func perform(_ action: ViewerHealthAction) {
        switch action {
        case .requestPermissions:
            requestPermissions()
        case .openScreenRecordingSettings:
            openPrivacySettings(pane: "Privacy_ScreenCapture")
        case .openAccessibilitySettings:
            openPrivacySettings(pane: "Privacy_Accessibility")
        case .retryStream:
            retryStream()
        case .refreshDaemon:
            refreshControlPlane()
        case .startDaemon:
            startDaemon()
        case let .selectSession(id):
            selectSession(id)
        case let .destroySession(id):
            destroySession(id)
        case let .reclaimSession(id):
            reclaimSession(id)
        case let .pauseSession(id):
            setSessionPaused(id, paused: true)
        case let .resumeSession(id):
            setSessionPaused(id, paused: false)
        case let .removeDisplay(displayID):
            removeDisplay(displayID)
        case let .guidePermission(kind):
            guidePermission(kind)
        }
    }

    init(
        automaticRefresh: Bool = true,
        initialDisplays: [DisplayEntry] = [],
        initialSelectedID: CGDirectDisplayID? = nil,
        initialPermissions: PermissionState = PermissionState(),
        initialSessions: [SessionInfo] = [],
        initialStreamRunning: Bool = false,
        streamEngine: any ViewerDisplayStreaming = DisplayStream(),
        discoveryProvider: @escaping DiscoveryProvider = ViewerModel.productionDiscovery,
        daemonTransport: @escaping DaemonTransport = { request in
            try Transport.send(request, to: Wire.socketPath(),
                               timeout: ViewerModel.transportTimeout(for: request.cmd))
        },
        permissionPrompt: @escaping PermissionPrompt = ViewerModel.productionPermissionPrompt,
        accessibilityAnnouncement: @escaping (String) -> Void = {
            AccessibilityNotification.Announcement($0).post()
        },
        preferencesStore: ViewerPreferencesStore? = nil,
        notificationPoster: (any ViewerNotificationPosting)? = nil,
        pasteboardWriter: @escaping (String) -> Void = { value in
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(value, forType: .string)
        },
        pasteboardReader: @escaping () -> String? = {
            NSPasteboard.general.string(forType: .string)
        },
        frontWindowProvider: FrontWindowProvider? = nil,
        appNameProvider: @escaping (pid_t) -> String? = {
            NSRunningApplication(processIdentifier: $0)?.localizedName
        },
        dockBadge: @escaping (String?) -> Void = { _ in }
    ) {
        self.pasteboardWriter = pasteboardWriter
        self.pasteboardReader = pasteboardReader
        self.frontWindowProviderForDestination = frontWindowProvider
        self.appNameForDestination = appNameProvider
        self.setDockBadge = dockBadge
        displays = initialDisplays
        selectedID = initialSelectedID
        permissions = initialPermissions
        sessions = initialSessions
        streamState = initialStreamRunning ? .live : .idle
        self.preferencesStore = preferencesStore
        self.notificationPoster = notificationPoster
        self.streamEngine = streamEngine
        self.discoveryProvider = discoveryProvider
        self.daemonTransport = daemonTransport
        self.permissionPrompt = permissionPrompt
        self.accessibilityAnnouncement = accessibilityAnnouncement
        input.onNote = { [weak self] value in
            Task { @MainActor [weak self] in
                self?.note = value
                if let value, value.isWarning {
                    self?.accessibilityAnnouncement(
                        "Viewer input blocked. \(value.text)"
                    )
                }
            }
        }
        input.display = selected
        input.onKeyTargetChange = { [weak self] target in
            Task { @MainActor [weak self] in self?.keyTargetChanged(target) }
        }
        input.keyInterceptor = { [weak self] down, keyCode, modifiers in
            guard ViewerPastePolicy.isBrokeredPaste(keyCode: keyCode, modifiers: modifiers) else {
                return false
            }
            // Called on the main thread by the surface; the model is main-actor bound.
            return MainActor.assumeIsolated {
                guard let self else { return false }
                if down { return self.requestBrokeredPaste() }
                return self.interactionEnabled && self.selectedSession != nil
            }
        }
        if let preferencesStore {
            applyLoadedPreferences(preferencesStore.load())
        }
        if automaticRefresh {
            pollDiscovery(restartSelected: false)
            startEventStream()
            refreshTimer = Timer.scheduledTimer(
                withTimeInterval: 2.0,
                repeats: true
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.pollDiscovery(restartSelected: false)
                }
            }
        }
    }

    /// Reads and quick mutations answer within two seconds or the daemon is in trouble. Teardown
    /// quits apps, which can wait on a save prompt or a slow app for much longer; failing those
    /// at two seconds reported "cleanup failed" for work the daemon went on to finish.
    nonisolated static func transportTimeout(for command: String) -> TimeInterval {
        switch command {
        case "session.destroy", "pool.remove", "daemon.stop": 60
        case "session.create", "run": 30
        default: 2
        }
    }

    deinit {
        if let refreshTimer {
            // The timer was installed on the main run loop; deinit need not run there.
            Task { @MainActor in refreshTimer.invalidate() }
        }
        startTask?.cancel()
        eventStreamMailbox?.stop()
        eventStreamReconnectTask?.cancel()
        eventSubscription?.cancel()
        // ScreenCaptureKit may retain its output while capture runs. Releasing the model's
        // reference is not a stop; transfer cleanup to a task that retains only the resources.
        if let session = activeStream?.session {
            let precedingTeardown = teardownTask
            Task {
                await precedingTeardown?.value
                await session.stop()
            }
        }
    }

    // MARK: - Discovery

    /// User-initiated Refresh always restarts the selected stream, even when discovery returns
    /// the same display. The periodic poll uses `restartSelected: false`.
    func refresh() {
        pollDiscovery(restartSelected: true)
    }

    private func pollDiscovery(restartSelected: Bool) {
        let snapshot = discoveryProvider()
        applyDiscovery(
            displays: snapshot.displays,
            permissions: snapshot.permissions,
            restartSelected: restartSelected
        )
        refreshControlPlane()
    }

    func applyDiscovery(
        displays newDisplays: [DisplayEntry],
        permissions newPermissions: PermissionState,
        restartSelected: Bool = false
    ) {
        let previousTarget = currentStreamTarget
        let previousPermissions = permissions

        // The poll repeats these every two seconds. Assigning an equal value would still
        // invalidate every view that reads it, so only a real change is written.
        let sortedDisplays = newDisplays.sorted { left, right in
            if left.isSpaceO != right.isSpaceO { return left.isSpaceO }
            return left.id < right.id
        }
        if displays != sortedDisplays { displays = sortedDisplays }
        if permissions != newPermissions { permissions = newPermissions }

        guard let selectedID else { return }
        guard displays.contains(where: { $0.id == selectedID }) else {
            selectedSessionID = nil
            self.selectedID = nil
            return
        }

        // Compare the whole stream target, not just the selected display's geometry. The two
        // must agree: whatever this check calls immaterial keeps streaming, so any field that
        // moves a captured pixel or a routed click has to be represented here.
        let change = StreamTargetChange.classify(from: previousTarget, to: currentStreamTarget)
        let capturePermissionChanged =
            previousPermissions.screenRecording != newPermissions.screenRecording

        if restartSelected || change == .identity || capturePermissionChanged {
            restartStreamForCurrentSelection()
            return
        }
        if change == .crop, let target = currentStreamTarget {
            updateStreamCrop(to: target)
        }

        if (interactionEnabled || humanControlPauseInFlight) && !newPermissions.accessibility {
            releaseHumanControl(resumeAgents: true)
            let warning = "Control disabled because Accessibility permission is unavailable."
            note = InputNote(text: warning, isWarning: true)
            accessibilityAnnouncement(warning)
        }
    }

    private static func productionDiscovery() -> DiscoverySnapshot {
        let spaceO = Set(Stage.spaceODisplayIDs())
        let active = Set(Stage.activeDisplayIDs())
        let displays = Stage.onlineDisplayIDs().map { id in
            DisplayEntry(
                id: id,
                bounds: CGDisplayBounds(id),
                isSpaceO: spaceO.contains(id),
                isActive: active.contains(id),
                name: displayName(for: id, isSpaceO: spaceO.contains(id))
            )
        }
        return (
            displays,
            PermissionState(
                screenRecording: CGPreflightScreenCaptureAccess(),
                accessibility: AXIsProcessTrusted()
            )
        )
    }

    private static func displayName(for id: CGDirectDisplayID, isSpaceO: Bool) -> String {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        if let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[key] as? NSNumber)?.uint32Value == id
        }) {
            return isSpaceO ? "Stage — \(screen.localizedName)" : screen.localizedName
        }
        return isSpaceO ? "SpaceO stage \(id)" : "Display \(id)"
    }

    // MARK: - Viewer control plane

    /// A session and infrastructure read are treated as one Viewer refresh. The daemon's wire
    /// format remains deliberately plain; this typed boundary prevents a missing socket or a
    /// partial response from silently becoming an empty, healthy-looking navigator.
    func refreshControlPlane(afterMutation: Bool = false) {
        if afterMutation { controlPlaneRevision &+= 1 }
        guard !controlPlaneRefreshInFlight else {
            controlPlaneRefreshPending = true
            return
        }
        controlPlaneRefreshInFlight = true
        let revision = controlPlaneRevision
        let transport = daemonTransport
        let ownedLeases = viewerOwnedLeases
        Task.detached(priority: .utility) { [weak self] in
            do {
                // The Viewer is the human operator's console: it shows every agent's work
                // by design, so its inventory read is operator-scoped and unredacted.
                var listRequest = Request(cmd: "session.list")
                listRequest.operatorScope = true
                let sessionsResponse = try transport(listRequest)
                guard sessionsResponse.ok else {
                    throw SpaceOError.badRequest(
                        sessionsResponse.error ?? "session.list failed")
                }
                let attachedIDs = Set((sessionsResponse.sessions ?? []).compactMap {
                    $0.runtimeAttached == false ? nil : $0.id
                })
                // A refused heartbeat is one session's lease problem (rotated by a reclaim,
                // rejected by an operator), not the daemon's: the daemon just answered
                // `session.list`. Failing the whole poll here read as "daemon disconnected"
                // after five seconds and emptied the navigator, every two seconds, forever.
                var heartbeatFailures: [(id: String, error: String)] = []
                for (id, leaseID) in ownedLeases where attachedIDs.contains(id) {
                    var heartbeat = Request(cmd: "session.heartbeat")
                    heartbeat.session = id
                    heartbeat.controllerLeaseID = leaseID
                    let response = try transport(heartbeat)
                    if !response.ok {
                        heartbeatFailures.append(
                            (id, response.error ?? "session.heartbeat failed for \(id)"))
                    }
                }
                let poolResponse = try transport(Request(cmd: "pool"))
                guard poolResponse.ok else {
                    throw SpaceOError.badRequest(poolResponse.error ?? "pool failed")
                }
                let refusedHeartbeats = heartbeatFailures
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    defer { self.finishControlPlaneRefresh() }
                    // A create/destroy/control response is newer than a poll already in flight.
                    // In particular, an old empty list must not discard a newly created lease.
                    guard self.controlPlaneRevision == revision else { return }
                    self.recordHeartbeatFailures(refusedHeartbeats)
                    self.applyControlPlane(
                        sessions: sessionsResponse.sessions ?? [],
                        poolResponse: poolResponse
                    )
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    defer { self.finishControlPlaneRefresh() }
                    guard self.controlPlaneRevision == revision else { return }
                    self.applyControlPlaneFailure(error)
                }
            }
        }
    }

    /// Coalesce timer ticks and action refreshes into one follow-up read. Slow daemons must
    /// not accumulate detached polls whose out-of-order replies can rewind the navigator.
    private func finishControlPlaneRefresh() {
        controlPlaneRefreshInFlight = false
        guard controlPlaneRefreshPending else { return }
        controlPlaneRefreshPending = false
        refreshControlPlane()
    }

    /// Drop a lease the daemon no longer honours, and say so once rather than on every poll.
    private func recordHeartbeatFailures(_ failures: [(id: String, error: String)]) {
        for failure in failures where viewerOwnedLeases[failure.id] != nil {
            viewerOwnedLeases.removeValue(forKey: failure.id)
            appendEvent(
                severity: .warning,
                title: "Viewer lease no longer accepted",
                detail: failure.error,
                sessionID: failure.id)
        }
    }

    func applyControlPlane(sessions newSessions: [SessionInfo], poolResponse: Response) {
        let oldTarget = currentStreamTarget
        let previousConnectivity = connectivity
        let previousSessionIDs = Set(sessions.map(\.id))
        let previousActions = Dictionary(
            uniqueKeysWithValues: sessions.compactMap { session in
                session.lastAgentActionAt.map { (session.id, $0) }
            })
        let previousDensity = infrastructure.configuredDensity
        let previousSessions = sessions

        sessions = newSessions
        postNotifications(previous: previousSessions, current: newSessions)
        let presentSessionIDs = Set(newSessions.map(\.id))
        viewerOwnedLeases = viewerOwnedLeases.filter {
            presentSessionIDs.contains($0.key)
        }
        infrastructure = ViewerInfrastructureSnapshot(
            displays: poolResponse.displays ?? [],
            sessionsPerDisplay: poolResponse.sessionsPerDisplay,
            usage: poolResponse.usage,
            limits: poolResponse.limits,
            message: poolResponse.message,
            daemon: poolResponse.daemon
        )
        if daemonError != nil { daemonError = nil }
        daemonFailureStartedAt = nil
        if connectivity != .connected { connectivity = .connected }

        if previousConnectivity != .connected {
            appendEvent(
                severity: .info,
                title: "Daemon connected",
                detail: "Session and display-pool telemetry are live."
            )
        }
        if let instanceID = poolResponse.daemon?.instanceID {
            if let known = knownDaemonInstanceID, known != instanceID {
                daemonRestarted = true
                appendEvent(
                    severity: .warning,
                    title: "Daemon restarted",
                    detail: "A new daemon process answered; sessions from the previous one ended.")
            }
            knownDaemonInstanceID = instanceID
        }

        let currentSessionIDs = Set(newSessions.map(\.id))
        for id in currentSessionIDs.subtracting(previousSessionIDs).sorted() {
            appendEvent(
                severity: .info,
                title: "Session appeared",
                detail: "The daemon attached a new session.",
                sessionID: id
            )
        }
        for id in previousSessionIDs.subtracting(currentSessionIDs).sorted() {
            appendEvent(
                severity: .warning,
                title: "Session ended",
                detail: "The session is no longer attached to this daemon.",
                sessionID: id
            )
        }
        if agentActivity.keys.contains(where: { !currentSessionIDs.contains($0) }) {
            agentActivity = agentActivity.filter { currentSessionIDs.contains($0.key) }
        }
        for session in newSessions where session.runtimeAttached != false {
            guard let actionAt = session.lastAgentActionAt,
                  previousActions[session.id] != actionAt,
                  session.lastAgentAction != nil else { continue }
            var history = agentActivity[session.id] ?? []
            history.append(actionAt)
            if history.count > Self.agentActivityLimit {
                history.removeFirst(history.count - Self.agentActivityLimit)
            }
            agentActivity[session.id] = history
            // The event stream already reported this action, with more detail; the poll delta
            // is only the fallback for when the stream is down.
            guard !eventStreamConnected else { continue }
            appendEvent(
                severity: AgentActionOutcome(wire: session.lastAgentActionOutcome) == .refused
                    ? .warning : .info,
                title: "Agent action",
                detail: Self.agentActionDetail(session),
                sessionID: session.id,
                isAgentAction: true)
        }
        updateAttentionSignals(previous: previousSessions)
        if previousDensity != infrastructure.configuredDensity, !infrastructure.displays.isEmpty {
            appendEvent(
                severity: .info,
                title: "Display density changed",
                detail: "New displays host \(infrastructure.configuredDensity) session(s)."
            )
        }

        var endedSelectionTitle: String?
        if let selectedSessionID,
           !newSessions.contains(where: {
               $0.id == selectedSessionID && $0.runtimeAttached != false
           }) {
            endedSelectionTitle = previousSessions.first { $0.id == selectedSessionID }
                .map(ViewerSessionGrouping.displayTitle) ?? selectedSessionID
            self.selectedSessionID = nil
            releaseHumanControl(resumeAgents: true)
        }
        defer {
            // The canvas changed under a VoiceOver user without them doing anything; say so.
            if let endedSelectionTitle {
                accessibilityAnnouncement(ViewerAccessibility.selectionEndedAnnouncement(
                    endedTitle: endedSelectionTitle,
                    replacementTitle: selectedSession.map(ViewerSessionGrouping.displayTitle)))
            }
        }
        if restoreRememberedSelectionIfNeeded() { return }
        // Session mode must never strand the canvas on a display after a transient empty poll or
        // the selected session ending. Prefer the session the person last chose — a reconnect
        // after a daemon outage empties the list, and the first session on the display is not
        // the one they were looking at — then another session on the same display, then the most
        // recent attached session. Display mode remains an explicit human choice and is left alone.
        if selectedSessionID == nil, canvasMode == .session {
            let remembered = preferences.selectedSessionID.flatMap { id in
                attachedSessions.first { $0.id == id }
            }
            let replacement = remembered ?? sessionsOnSelectedDisplay.first ?? attachedSessions.first
            if let replacement {
                selectSession(replacement.id)
                return
            }
        }
        switch StreamTargetChange.classify(from: oldTarget, to: currentStreamTarget) {
        case .none:
            break
        case .crop:
            if let target = currentStreamTarget { updateStreamCrop(to: target) }
        case .identity:
            restartStreamForCurrentSelection()
        }
    }

    func applyControlPlaneFailure(_ error: Error, now: Date = Date()) {
        let previous = connectivity
        let started = daemonFailureStartedAt ?? now
        daemonFailureStartedAt = started
        if daemonError != error.localizedDescription { daemonError = error.localizedDescription }
        let failedState: ViewerConnectivityState =
            now.timeIntervalSince(started) >= 5 ? .disconnected : .degraded
        if connectivity != failedState { connectivity = failedState }

        if previous != connectivity {
            appendEvent(
                severity: connectivity == .disconnected ? .critical : .warning,
                title: connectivity.title,
                detail: error.localizedDescription
            )
        }
        if connectivity == .disconnected {
            // Transport failure does not prove the daemon exited. Release pauses we placed;
            // if it is still unreachable, keep that uncertainty visible through resume errors.
            releaseHumanControl(resumeAgents: true)
            completeHandoff(note: nil)
            let previousSessions = sessions
            if selectedSessionID != nil { selectedSessionID = nil }
            if !sessions.isEmpty { sessions = [] }
            if infrastructure.daemon != nil || !infrastructure.displays.isEmpty {
                infrastructure = ViewerInfrastructureSnapshot()
            }
            // Nothing is known to be waiting any more; clear the Dock badge with the list.
            updateAttentionSignals(previous: previousSessions)
        }
    }

    func selectSession(_ id: String) {
        guard let session = sessions.first(where: {
            $0.id == id && $0.runtimeAttached != false
        }) else { return }
        let selectionChanged = selectedSessionID != id || canvasMode != .session
        if pendingControl?.sessionID != id { pendingControl = nil }
        selectedSessionID = id
        canvasMode = .session
        viewportPan = .zero
        if selectionChanged { inspectorSection = .overview }
        rememberSelection()
        if selectedID != session.displayID {
            selectedID = session.displayID
        } else if selectionChanged {
            restartStreamForCurrentSelection()
        }
        applyZoomMode()
    }

    func selectDisplay(_ id: CGDirectDisplayID) {
        let selectionChanged = selectedID != id || canvasMode != .display
        pendingControl = nil
        selectedSessionID = nil
        canvasMode = .display
        viewportPan = .zero
        rememberSelection()
        if selectedID != id {
            selectedID = id
        } else if selectionChanged {
            restartStreamForCurrentSelection()
        }
        applyZoomMode()
    }

    /// Whether Session/Display scope can be switched right now.
    ///
    /// Session scope needs a session on the selected display to switch *to* — not one already
    /// selected. `setCanvasMode` picks the first one, which is only reachable if the control
    /// that calls it stays enabled after `selectDisplay` clears the session selection.
    var canSwitchCanvasMode: Bool {
        selected != nil && (selectedSession != nil || !sessionsOnSelectedDisplay.isEmpty)
    }

    func setCanvasMode(_ mode: ViewerCanvasMode) {
        guard canvasMode != mode else { return }
        if mode == .session, selectedSession == nil {
            guard let first = sessionsOnSelectedDisplay.first else { return }
            selectSession(first.id)
            return
        }
        canvasMode = mode
        viewportPan = .zero
        rememberSelection()
        restartStreamForCurrentSelection()
        applyZoomMode()
    }

    func setZoom(_ value: CGFloat) {
        let clamped = ViewerZoom.clamp(Double(value))
        setZoomMode(clamped <= 1 ? .fit : .custom(clamped))
    }

    func pan(by delta: CGPoint) {
        guard viewportZoom > 1 else { return }
        viewportPan = CGPoint(
            x: min(1, max(-1, viewportPan.x + delta.x)),
            y: min(1, max(-1, viewportPan.y + delta.y))
        )
    }

    func startDaemon() {
        guard connectivity != .connected, ViewerPreviewScenario.current == nil else { return }
        guard let executable = ViewerDaemonExecutable.resolve() else {
            daemonError = "The SpaceO daemon helper is not available in this build."
            appendEvent(
                severity: .critical,
                title: "Daemon could not start",
                detail: daemonError ?? "Helper unavailable"
            )
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["daemon"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshControlPlane(afterMutation: true) }
        }
        do {
            try process.run()
            daemonProcess = process
            connectivity = .connecting
            appendEvent(
                severity: .info,
                title: "Starting daemon",
                detail: "Waiting for the SpaceO control socket."
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.refreshControlPlane(afterMutation: true)
            }
        } catch {
            applyControlPlaneFailure(error)
        }
    }

    func stopDaemon() {
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var stop = Request(cmd: "daemon.stop")
                stop.operatorScope = true
                let response = try transport(stop)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "daemon.stop failed")
                }
                await MainActor.run { [weak self] in
                    self?.refreshControlPlane(afterMutation: true)
                    self?.releaseHumanControl(resumeAgents: false)
                    self?.pendingHandoff = nil
                    self?.sessions = []
                    self?.connectivity = .disconnected
                    self?.appendEvent(
                        severity: .warning,
                        title: "Daemon stopped",
                        detail: "All daemon-owned sessions were asked to clean up."
                    )
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.applyControlPlaneFailure(error)
                }
            }
        }
    }

    func configureSessionsPerDisplay(_ count: Int) {
        guard count > 0 else { return }
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var request = Request(cmd: "pool.configure")
                request.count = count
                request.operatorScope = true
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "pool.configure failed")
                }
                await MainActor.run { [weak self] in
                    self?.updatePreferences { $0.lastDensity = count }
                    self?.refreshControlPlane(afterMutation: true)
                    self?.infrastructure = ViewerInfrastructureSnapshot(
                        displays: response.displays ?? [],
                        sessionsPerDisplay: response.sessionsPerDisplay ?? count,
                        usage: response.usage,
                        limits: response.limits,
                        message: response.message,
                        daemon: response.daemon ?? self?.infrastructure.daemon
                    )
                    self?.appendEvent(
                        severity: .info,
                        title: "Display density updated",
                        detail: "New displays will host \(count) session(s)."
                    )
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.daemonError = error.localizedDescription
                    self?.appendEvent(
                        severity: .warning,
                        title: "Density update failed",
                        detail: error.localizedDescription
                    )
                }
            }
        }
    }

    func createSession() {
        let transport = daemonTransport
        let pid = getpid()
        let owner = DurableSessionOwner(
            id: "viewer-\(pid)",
            kind: .viewer,
            label: "SpaceO Viewer",
            processIdentity: ProcessIdentity.current(of: pid))
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var request = Request(cmd: "session.create")
                request.controllerOwner = owner
                let leaseID = UUID()
                request.controllerLeaseID = leaseID
                let response = try transport(request)
                guard response.ok, let session = response.session else {
                    throw SpaceOError.badRequest(response.error ?? "session.create failed")
                }
                await MainActor.run { [weak self] in
                    self?.viewerOwnedLeases[session.id] = leaseID
                    self?.appendEvent(
                        severity: .info,
                        title: "Session created",
                        detail: response.message ?? "Created from SpaceO Viewer.",
                        sessionID: session.id)
                    self?.refreshControlPlane(afterMutation: true)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure("Session creation failed", error: error)
                }
            }
        }
    }

    func destroySession(_ id: String) {
        performDestroy(id: id, title: "Session destroyed")
    }

    func reclaimSession(_ id: String) {
        performDestroy(id: id, title: "Recovery cleanup completed")
    }

    private func performDestroy(id: String, title: String) {
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var request = Request(cmd: "session.destroy")
                request.session = id
                request.operatorScope = true
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "session.destroy failed")
                }
                await MainActor.run { [weak self] in
                    self?.viewerOwnedLeases.removeValue(forKey: id)
                    self?.appendEvent(
                        severity: .warning,
                        title: title,
                        detail: response.message ?? "Cleanup completed.",
                        sessionID: id)
                    self?.refreshControlPlane(afterMutation: true)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure("Session cleanup failed", error: error, sessionID: id)
                }
            }
        }
    }

    var canChangeAgentPause: Bool {
        !interactionEnabled && !humanControlPauseInFlight
            && humanControlResumesInFlight == 0 && !agentPauseChangeInFlight
    }

    func setSessionPaused(_ id: String, paused: Bool) {
        guard canChangeAgentPause else {
            note = InputNote(
                text: "Release Input and wait for the Control transition to finish before changing agent pause state.",
                isWarning: true)
            return
        }
        agentPauseChangeInFlight = true
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try Self.sendSessionControl(id: id, paused: paused, transport: transport)
                await MainActor.run { [weak self] in
                    self?.agentPauseChangeInFlight = false
                    self?.appendEvent(
                        severity: .info,
                        title: paused ? "Agent paused" : "Agent resumed",
                        detail: paused
                            ? "Human input has priority; agent input commands are refused."
                            : "Agent input commands are accepted again.",
                        sessionID: id)
                    self?.refreshControlPlane(afterMutation: true)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.agentPauseChangeInFlight = false
                    self?.recordControlPlaneActionFailure(
                        paused ? "Pause failed" : "Resume failed",
                        error: error,
                        sessionID: id)
                }
            }
        }
    }

    /// Human Control is an arbitration transition, not merely a local input toggle. Pause every
    /// session reachable on the canvas first; if any pause fails, roll back those already paused
    /// and leave Control off.
    func beginHumanControl() {
        guard !interactionEnabled else { return }
        // A preview runs on fixtures; capturing the person's real input for it would be wrong.
        guard ViewerPreviewScenario.current == nil else {
            note = InputNote(text: "Control is off in previews.", isWarning: true)
            return
        }
        guard pendingHandoff == nil else {
            note = InputNote(
                text: "Send or skip the hand-back note before taking Control again.",
                isWarning: true)
            return
        }
        guard !humanControlPauseInFlight, humanControlResumesInFlight == 0,
              !agentPauseChangeInFlight else {
            note = InputNote(text: "Finishing the previous Control transition. Try again in a moment.",
                isWarning: true)
            return
        }
        switch ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: selected != nil,
            selectedDisplayIsSpaceO: selected?.isSpaceO == true,
            hasActiveSession: !sessionsOnSelectedDisplay.isEmpty,
            streamRunning: streamState.isLive,
            screenRecordingGranted: permissions.screenRecording,
            accessibilityGranted: permissions.accessibility
        ) {
        case let .blocked(message):
            setInteractionEnabled(true)
            note = InputNote(text: message, isWarning: true)
            // A missing permission is the one refusal the person can fix, so walk them to it.
            if !permissions.accessibility {
                permissionGuide = .accessibility
            } else if !permissions.screenRecording {
                permissionGuide = .screenRecording
            }
            return
        case .disable:
            return
        case .enable:
            break
        }

        let ids = Set(sessionsOnSelectedDisplay.map(\.id))
        // Includes agents that paused themselves to ask for help: see `pausesForControl`.
        let toPause = Set(sessionsOnSelectedDisplay.compactMap {
            ViewerControlPolicy.pausesForControl($0) ? $0.id : nil
        })
        let askedForHelp = Set(sessionsOnSelectedDisplay.compactMap {
            $0.inputPaused == true && $0.agentPauseReason != nil ? $0.id : nil
        })
        humanControlRequestToken &+= 1
        let token = humanControlRequestToken
        guard !toPause.isEmpty else {
            interactionEnabled = true
            return
        }
        humanControlPauseInFlight = true
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            var paused: [String] = []
            do {
                for id in toPause.sorted() {
                    try Self.sendSessionControl(id: id, paused: true, transport: transport)
                    paused.append(id)
                }
                let pausedIDs = paused
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    // Control was released, the selection or stream changed, or the daemon
                    // went away while the pauses were in flight. Enabling input now would
                    // capture the person's keystrokes for a Control they no longer hold, and
                    // the pauses just placed would belong to nobody; hand them back instead.
                    // An agent that asked for help keeps waiting for it (see
                    // `releaseHumanControl`), so it is left paused and said so.
                    self.humanControlPauseInFlight = false
                    guard self.humanControlRequestToken == token,
                          self.permissions.accessibility, self.permissions.screenRecording,
                          self.streamState.isLive, self.controlTargetAvailable,
                          Set(self.sessionsOnSelectedDisplay.map(\.id)) == ids else {
                        self.handBack(Set(pausedIDs), awaitingHuman: askedForHelp)
                        return
                    }
                    self.sessionsPausedForHumanControl.formUnion(pausedIDs)
                    self.sessionsAwaitingHuman.formUnion(askedForHelp.intersection(pausedIDs))
                    self.interactionEnabled = true
                    self.note = InputNote(
                        text: "Agent input paused while you have Control.",
                        isWarning: false)
                    self.appendEvent(
                        severity: .info,
                        title: "Human control took priority",
                        detail: "Paused agent input for \(pausedIDs.joined(separator: ", ")).")
                    self.refreshControlPlane(afterMutation: true)
                }
            } catch {
                let takeoverFailure = error
                var rollbackFailures: [String] = []
                // Rolling back an operator pause over an agent that had paused itself would
                // resume it past the thing it asked a person to do; it stays paused and asking.
                for id in paused where !askedForHelp.contains(id) {
                    do {
                        try Self.sendSessionControl(id: id, paused: false, transport: transport)
                    } catch {
                        rollbackFailures.append("\(id): \(error.localizedDescription)")
                    }
                }
                let reportedFailure: Error = rollbackFailures.isEmpty ? takeoverFailure :
                    SpaceOError.badRequest(
                        "\(takeoverFailure.localizedDescription) Agent input may still be paused: " +
                        rollbackFailures.joined(separator: "; ") +
                        ". Use Resume for these sessions when the daemon is reachable.")
                await MainActor.run { [weak self] in
                    self?.humanControlPauseInFlight = false
                    self?.recordControlPlaneActionFailure("Control unavailable", error: reportedFailure)
                }
            }
        }
    }

    /// The person's own release. Agents this Viewer paused are not resumed yet: the hand-back
    /// sheet asks for a one-line note first (SPAO-219), and `completeHandoff` sends the resume
    /// with or without it. Every forced-off path still resumes immediately via
    /// `releaseHumanControl`, since nobody is there to write a note.
    ///
    /// This includes an agent that had paused itself to ask for help: Take Control placed an
    /// operator pause over its own, so the hand-back (with the note saying what the person did)
    /// is what lets it continue.
    func endHumanControl() {
        let paused = sessionsPausedForHumanControl
        let duration = controlStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        releaseHumanControl(resumeAgents: false)
        guard !paused.isEmpty else { return }
        pendingHandoff = PendingHandoff(sessionIDs: paused.sorted(), controlDuration: duration)
    }

    /// The surface's window stopped being key. Normally that ends Control; a Viewer-owned
    /// prompt that is waiting on the person's next chord does not count as leaving.
    func surfaceResignedKey() {
        guard interactionEnabled || humanControlPauseInFlight else { return }
        guard ViewerControlPolicy.releasesOnResignKey(pendingPrompt: pendingViewerPrompt) else {
            return
        }
        endHumanControl()
    }

    /// Resume the sessions held by the hand-back sheet. A blank note is a skip.
    func completeHandoff(note handoffNote: String?) {
        guard let pending = pendingHandoff else { return }
        pendingHandoff = nil
        let trimmed = handoffNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        resumeAgentInput(
            for: Set(pending.sessionIDs),
            handoffNote: trimmed.isEmpty ? nil : String(trimmed.prefix(AgentSession.maximumHandoffNoteCharacters)))
    }

    /// Take Control of a particular session, from anywhere: its tile, its pause banner, the menu
    /// bar, a notification. This is the ordinary Control path; nothing here bypasses its checks
    /// or announcements.
    ///
    /// A session that is not on the canvas yet cannot be controlled yet — Control needs its
    /// live stream. It is selected, and Control begins when the stream for that selection comes
    /// up, provided the person has not selected something else meanwhile and it happens within
    /// `pendingControlLifetime` (a stream that takes longer is not what they clicked on).
    func takeControl(for sessionID: String, now: Date = Date()) {
        guard sessions.contains(where: { $0.id == sessionID && $0.runtimeAttached != false }) else {
            return
        }
        guard !interactionEnabled else { return }
        let onCanvas = selectedSessionID == sessionID && canvasMode == .session
        if onCanvas, streamState.isLive {
            pendingControl = nil
            beginHumanControl()
            return
        }
        if !onCanvas { selectSession(sessionID) }
        pendingControl = (sessionID, streamGeneration,
                          now.addingTimeInterval(Self.pendingControlLifetime))
    }

    /// Called when a stream generation goes live. Begins a Control that `takeControl(for:)`
    /// deferred, if it still applies.
    private func beginPendingControlIfReady(generation: UInt64, now: Date = Date()) {
        guard let pending = pendingControl else { return }
        pendingControl = nil
        guard pending.generation == generation, now <= pending.expires,
              selectedSessionID == pending.sessionID, canvasMode == .session else { return }
        beginHumanControl()
    }

    /// Every transition that takes Control away must also hand the agents back their input.
    /// The forced-off paths — selection change, stream loss, permission loss, the selected
    /// session ending, disconnect — used to clear `interactionEnabled` alone, leaving the
    /// daemon-side pauses in place with no Viewer state left that could ever release them.
    ///
    /// The exception is an agent that had paused itself to ask for a person. A forced release
    /// means the person was interrupted, not that they finished helping; resuming it would clear
    /// its reason and send it on past the step it is waiting for. It stays paused, still shown
    /// as waiting, and the person can take Control again or resume it by hand.
    private func releaseHumanControl(resumeAgents: Bool) {
        humanControlRequestToken &+= 1
        interactionEnabled = false
        let ids = sessionsPausedForHumanControl
        let awaiting = sessionsAwaitingHuman
        sessionsPausedForHumanControl = []
        sessionsAwaitingHuman = []
        guard resumeAgents, !ids.isEmpty else { return }
        handBack(ids, awaitingHuman: awaiting)
    }

    /// Resume what this Viewer paused, except agents still waiting for a person.
    private func handBack(_ ids: Set<String>, awaitingHuman: Set<String>) {
        let waiting = ids.intersection(awaitingHuman)
        resumeAgentInput(for: ids.subtracting(waiting))
        for id in waiting.sorted() {
            let title = sessions.first { $0.id == id }.map(ViewerSessionGrouping.displayTitle) ?? id
            appendEvent(
                severity: .warning,
                title: "Still waiting for you",
                detail: "\(title) asked for help and stays paused. Take Control again, or use "
                    + "Resume Agent to let it continue without you.",
                sessionID: id)
        }
    }

    private func resumeAgentInput(for ids: Set<String>, handoffNote: String? = nil) {
        guard !ids.isEmpty else { return }
        humanControlResumesInFlight += 1
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            var failures: [String] = []
            for id in ids.sorted() {
                do {
                    try Self.sendSessionControl(
                        id: id, paused: false, transport: transport, handoffNote: handoffNote)
                } catch {
                    failures.append("\(id): \(error.localizedDescription)")
                }
            }
            let resumeFailures = failures
            await MainActor.run { [weak self] in
                self?.humanControlResumesInFlight -= 1
                if resumeFailures.isEmpty {
                    self?.appendEvent(
                        severity: .info,
                        title: "Human control released",
                        detail: "Agent input resumed.")
                    self?.refreshControlPlane(afterMutation: true)
                } else {
                    self?.recordControlPlaneActionFailure(
                        "Agent resume failed",
                        error: SpaceOError.badRequest(
                            "Agent input may still be paused: " +
                            resumeFailures.joined(separator: "; ") +
                            ". Use Resume Agent for these sessions when the daemon is reachable."))
                }
            }
        }
    }

    private nonisolated static func sendSessionControl(
        id: String,
        paused: Bool,
        transport: DaemonTransport,
        handoffNote: String? = nil
    ) throws {
        var request = Request(cmd: "session.control")
        request.session = id
        request.paused = paused
        request.operatorScope = true
        request.handoffNote = handoffNote
        let response = try transport(request)
        guard response.ok else {
            throw SpaceOError.badRequest(response.error ?? "session.control failed")
        }
    }

    func recordControlPlaneActionFailure(
        _ title: String,
        error: Error,
        sessionID: String? = nil
    ) {
        daemonError = error.localizedDescription
        note = InputNote(text: error.localizedDescription, isWarning: true)
        appendEvent(
            severity: .warning,
            title: title,
            detail: error.localizedDescription,
            sessionID: sessionID)
    }

    /// Each class keeps its own newest `eventLimitPerClass` entries. One shared cap let a burst
    /// of agent clicks push the pause, breach, or "session ended" the person needed to see out
    /// of the feed within seconds.
    static let eventLimitPerClass = 100

    func appendEvent(
        severity: ViewerEventSeverity,
        title: String,
        detail: String,
        sessionID: String? = nil,
        isAgentAction: Bool = false
    ) {
        events.insert(
            ViewerEvent(
                timestamp: Date(),
                severity: severity,
                title: title,
                detail: detail,
                sessionID: sessionID,
                isAgentAction: isAgentAction
            ),
            at: 0
        )
        let sameClass = events.lazy.filter { $0.isAgentAction == isAgentAction }.count
        guard sameClass > Self.eventLimitPerClass,
              let oldest = events.lastIndex(where: { $0.isAgentAction == isAgentAction }) else {
            return
        }
        events.remove(at: oldest)
    }

    // MARK: - Streaming

    func retryStream() {
        restartStreamForCurrentSelection()
    }

    private func restartStreamForCurrentSelection() {
        streamGeneration &+= 1
        let generation = streamGeneration
        let target = currentStreamTarget
        let previousStream = activeStream?.session
        activeStream = nil
        startTask?.cancel()
        startTask = nil
        let precedingTeardown = teardownTask
        let teardown = Task {
            if let precedingTeardown {
                await precedingTeardown.value
            }
            if let previousStream {
                await previousStream.stop()
            }
        }
        teardownTask = teardown

        // One MainActor transition owns both the visible state and the input mapping. Setting
        // Control off releases held keys; assigning display then clears stale drag/key targets
        // and installs the new geometry before any new stream can become live.
        releaseHumanControl(resumeAgents: true)
        input.display = target?.interactionDisplay
        note = nil
        streamError = nil
        lastSampleAt = nil
        liveSince = nil
        recentFrameTimes = []

        // No console or Mini Monitor needs pixels. Retire the capture and its surfaces while
        // retaining selection; the first returning consumer restarts through the same barrier.
        guard let target, !frameSinks.isEmpty else {
            streamState = .idle
            return
        }

        guard permissions.screenRecording else {
            let message = "Screen Recording permission is required to stream this display."
            streamState = .failed(message)
            streamError = message
            note = InputNote(text: message, isWarning: true)
            accessibilityAnnouncement(message)
            return
        }

        streamState = .starting
        let engine = streamEngine
        let pendingFrame = ViewerLatestValue<FrameDelivery>()
        let pendingHeartbeat = ViewerLatestValue<Bool>()
        startTask = Task { [weak self] in
            await teardown.value
            guard !Task.isCancelled else { return }
            do {
                let session = try await engine.start(
                    displayID: target.display.id,
                    pointSize: target.display.bounds.size,
                    sourceRect: target.sourceRect,
                    onFrame: { [weak self] sample in
                        guard pendingFrame.offer(FrameDelivery(sample: sample)) else {
                            PerformanceTrace.signposter.emitEvent("Viewer.FrameCoalesced")
                            return
                        }
                        Task { @MainActor [weak self] in
                            guard let delivery = pendingFrame.take() else { return }
                            self?.receiveFrame(delivery.sample, generation: generation)
                        }
                    },
                    onIdle: { [weak self] in
                        // Coalesced like frames: one main-actor hop however fast they come.
                        guard pendingHeartbeat.offer(true) else { return }
                        Task { @MainActor [weak self] in
                            guard pendingHeartbeat.take() != nil else { return }
                            self?.receiveHeartbeat(generation: generation)
                        }
                    },
                    onStopped: { [weak self] error in
                        Task { @MainActor [weak self] in
                            self?.handleStreamStopped(error, generation: generation)
                        }
                    }
                )
                guard let self else {
                    // A native start may complete after its owner was released/cancelled.
                    await session.stop()
                    return
                }
                await self.completeStart(
                    session,
                    generation: generation,
                    target: target
                )
            } catch is CancellationError {
                // A newer generation owns state now.
            } catch {
                await self?.failStart(error, generation: generation)
            }
        }
    }

    private func completeStart(
        _ session: any ViewerDisplayStreamSession,
        generation: UInt64,
        target: StreamTarget
    ) async {
        guard isCurrent(generation: generation) else {
            await session.stop()
            return
        }
        activeStream = (generation, target, session)
        streamState = .live
        streamError = nil
        startTask = nil
        liveSince = Date()
        // The tile may have moved while ScreenCaptureKit was starting. The generation is still
        // ours, so take the newer crop in place rather than restarting a capture that just came up.
        if let current = currentStreamTarget, target.sameIdentity(as: current),
           !target.sameCrop(as: current) {
            updateStreamCrop(to: current)
        }
        beginPendingControlIfReady(generation: generation)
    }

    /// SPAO-162. Re-crop the live capture to a moved or resized tile without a restart, and
    /// move the input geometry with it so clicks keep landing on the pixels the person sees.
    /// Anything short of a live stream falls back to a restart: there is no picture to protect.
    private func updateStreamCrop(to target: StreamTarget) {
        guard streamState.isLive, let active = activeStream else {
            restartStreamForCurrentSelection()
            return
        }
        activeStream = (active.generation, target, active.session)
        // Assigning the display drops held keys and buttons and closes the input gate, which is
        // right for geometry that moved under the person's pointer; Control itself stays on, so
        // re-arm the gate for the new geometry.
        input.display = target.interactionDisplay
        input.interactionEnabled = interactionEnabled
        tileMovedAt = Date()
        let generation = active.generation
        let session = active.session
        Task { [weak self] in
            do {
                try await session.updateCrop(target.sourceRect)
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation: generation) else { return }
                    self.restartStreamForCurrentSelection()
                }
            }
        }
    }

    private func failStart(_ error: Error, generation: UInt64) async {
        guard isCurrent(generation: generation) else { return }
        startTask = nil
        handleStreamStartFailure(error)
    }

    private func receiveFrame(_ sample: CMSampleBuffer, generation: UInt64) {
        guard streamState.isLive,
              activeStream?.generation == generation,
              isCurrent(generation: generation) else { return }
        let now = Date()
        lastSampleAt = now
        recentFrameTimes.append(now)
        if recentFrameTimes.count > Self.recentFrameLimit {
            recentFrameTimes.removeFirst(recentFrameTimes.count - Self.recentFrameLimit)
        }
        for sink in frameSinks.values { sink(sample) }
    }

    /// An idle sample: the capture is alive and the screen simply has not changed. It proves
    /// the picture is current without being a new picture.
    private func receiveHeartbeat(generation: UInt64) {
        guard streamState.isLive,
              activeStream?.generation == generation,
              isCurrent(generation: generation) else { return }
        lastSampleAt = Date()
    }

    func streamHealth(now: Date = Date()) -> ViewerStreamHealth {
        ViewerStreamHealth.evaluate(
            state: streamState,
            lastSampleAt: lastSampleAt,
            liveSince: liveSince,
            recentFrames: recentFrameTimes,
            now: now)
    }

    private func handleStreamStopped(_ error: Error?, generation: UInt64) {
        guard isCurrent(generation: generation) else { return }
        let stoppedActiveStream = activeStream?.generation == generation
        guard stoppedActiveStream || streamState == .starting else { return }
        activeStream = nil
        startTask?.cancel()
        startTask = nil
        // If the delegate reports a stop between startCapture returning and model installation,
        // invalidate that completion so it cannot turn this failed generation live again.
        streamGeneration &+= 1
        handleUnexpectedStreamStop(error)
    }

    /// The generation is the only authority over which capture attempt owns viewer state.
    /// `restartStreamForCurrentSelection` is the sole producer of generations and it snapshots
    /// the target at the same instant, so a matching generation already means "this callback
    /// belongs to the stream we most recently asked for".
    ///
    /// Re-deriving the target here and demanding equality would be strictly worse: the target
    /// is computed from the live `DisplayEntry`, which `applyDiscovery` replaces wholesale every
    /// poll. Cosmetic fields — `name` (AppKit refreshes `NSScreen.screens` behind
    /// `CGGetOnlineDisplayList`, so a stage is routinely renamed a poll or two after it appears)
    /// and `isActive` — change without a restart, which would permanently wedge the comparison
    /// and silently drop every frame while `streamState` still claimed `.live`.
    private func isCurrent(generation: UInt64) -> Bool {
        generation == streamGeneration
    }

    func handleUnexpectedStreamStop(_ error: Error?) {
        let detail = error?.localizedDescription ?? "the capture ended unexpectedly"
        transitionToUnavailableStream(
            errorText: "stream stopped: \(detail)",
            warningReason: "the live stream stopped: \(detail)"
        )
    }

    func handleStreamStartFailure(_ error: Error) {
        transitionToUnavailableStream(
            errorText: error.localizedDescription,
            warningReason: "the live stream failed to start: \(error.localizedDescription)"
        )
    }

    private func transitionToUnavailableStream(errorText: String, warningReason: String) {
        let hadControl = interactionEnabled
        releaseHumanControl(resumeAgents: true)
        streamState = .failed(errorText)
        streamError = errorText
        let prefix = hadControl ? "Control disabled because " : "Control unavailable because "
        let warning = prefix + warningReason + "."
        note = InputNote(text: warning, isWarning: true)
        accessibilityAnnouncement(warning)
    }

    // MARK: - Screenshot

    func saveScreenshot() {
        guard let target = currentStreamTarget else { return }
        let entry = target.display
        Task {
            do {
                let image = try await Self.snapshot(
                    of: entry,
                    sourceRect: target.sourceRect
                )
                let panel = NSSavePanel()
                panel.nameFieldStringValue = Self.screenshotFileName(
                    canvasMode: canvasMode,
                    sessionID: selectedSessionID,
                    displayID: entry.id)
                panel.allowedContentTypes = [.png]
                guard panel.runModal() == .OK, let url = panel.url else { return }
                try Capture.pngData(image).write(to: url)
                report(.saved(url))
            } catch {
                report(.failed(error.localizedDescription))
            }
        }
    }

    /// What a saved capture is called, from the same predicate the toolbar label and
    /// `currentStreamTarget` use.
    ///
    /// Switching to the Display canvas leaves `selectedSessionID` set — the sidebar still knows
    /// which session you came from, and the inspector still describes it. Naming the file from
    /// that alone meant a whole-display capture was written as `spaceo-session-<id>.png`: a file
    /// containing every tile on the display, labelled as one session's tile. The image is
    /// evidence, and the only scope it carries once saved is its name.
    nonisolated static func screenshotFileName(
        canvasMode: ViewerCanvasMode,
        sessionID: String?,
        displayID: CGDirectDisplayID
    ) -> String {
        guard canvasMode == .session, let sessionID else {
            return "spaceo-display-\(displayID).png"
        }
        return "spaceo-session-\(sessionID).png"
    }

    /// Surface the outcome where the user is looking.
    ///
    /// A screenshot that reported failure only through `streamError` — which no view reads —
    /// meant pressing the toolbar button produced no file, no error, and no clue why.
    private func report(_ result: ViewerScreenshotResult) {
        screenshotResult = result
        note = InputNote(text: result.message, isWarning: result.isFailure)
        accessibilityAnnouncement(result.message)
        appendEvent(
            severity: result.isFailure ? .warning : .info,
            title: result.isFailure ? "Screenshot failed" : "Screenshot saved",
            detail: result.message)
    }

    func revealScreenshot() {
        guard case let .saved(url) = screenshotResult else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func clearScreenshotResult() {
        screenshotResult = nil
    }

    private static func snapshot(
        of entry: DisplayEntry,
        sourceRect: CGRect?
    ) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == entry.id }) else {
            throw SpaceOError.captureFailed("display \(entry.id) is not shareable")
        }
        let config = SCStreamConfiguration()
        let dimensions = DisplayStream.frameDimensions(
            pixelWidth: display.width,
            pixelHeight: display.height,
            fallbackPointSize: entry.bounds.size,
            sourceRect: sourceRect
        )
        config.width = dimensions.width
        config.height = dimensions.height
        if let sourceRect {
            config.sourceRect = sourceRect
        }
        config.showsCursor = false
        config.captureResolution = .best
        let filter = SCContentFilter(display: display, excludingWindows: [])
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: config
        )
    }

    // MARK: - Permissions and Control

    func setInteractionEnabled(_ enabled: Bool) {
        switch ViewerControlPolicy.controlRequest(
            enabling: enabled,
            hasSelectedDisplay: selected != nil,
            selectedDisplayIsSpaceO: selected?.isSpaceO == true,
            hasActiveSession: !sessionsOnSelectedDisplay.isEmpty,
            streamRunning: streamState.isLive,
            screenRecordingGranted: permissions.screenRecording,
            accessibilityGranted: permissions.accessibility
        ) {
        case .enable:
            interactionEnabled = true
        case .disable:
            releaseHumanControl(resumeAgents: true)
        case let .blocked(message):
            releaseHumanControl(resumeAgents: true)
            note = InputNote(text: message, isWarning: true)
            accessibilityAnnouncement(message)
        }
    }

    /// Raise the system permission prompts for whatever is still missing.
    ///
    /// macOS only ever shows these once per app identity, and it will not show them at all unless
    /// something asks. Because `restartStreamForCurrentSelection` refuses to touch
    /// ScreenCaptureKit without a pre-flight grant, nothing else in the Viewer can trigger the
    /// capture prompt implicitly either — so with no caller here a first-run user was left to
    /// find System Settings and add the app by hand.
    nonisolated(unsafe) static let productionPermissionPrompt: PermissionPrompt = { permissions in
        if !permissions.screenRecording {
            CGRequestScreenCaptureAccess()
        }
        if !permissions.accessibility {
            // Use the documented option value without referencing the SDK's imported mutable
            // global, which is not concurrency-safe under Swift 6 strict checking.
            let options = ["AXTrustedCheckOptionPrompt": true]
            AXIsProcessTrustedWithOptions(options as CFDictionary)
        }
    }

    func requestPermissions() {
        permissionPrompt(permissions)
        // The prompt is answered out of process, so re-poll rather than assuming the grant
        // landed, and restart the selection so a newly granted capture permission produces a
        // live stream without the user relaunching the app.
        pollDiscovery(restartSelected: true)
    }

    func openPrivacySettings(pane: String) {
        let base = "x-apple.systempreferences:com.apple.preference.security?"
        if let url = URL(string: base + pane) {
            NSWorkspace.shared.open(url)
        }
    }
}
