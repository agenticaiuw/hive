import Foundation
import AppKit
import CoreGraphics
import SpaceOPrivate

/// How directly SpaceO knows the value used by an isolation check.
public enum IsolationCoverage: String, Codable, Equatable, Sendable {
    /// Read from the subsystem that owns the state.
    case observed
    /// Derived from another observation rather than read from the owning subsystem.
    case inferred
    /// No safe observation is available.
    case unknown

    fileprivate func combined(with other: IsolationCoverage) -> IsolationCoverage {
        if self == .unknown || other == .unknown { return .unknown }
        if self == .inferred || other == .inferred { return .inferred }
        return .observed
    }
}

/// The dimensions that make up SpaceO's attention-isolation claim.
public enum IsolationDimension: String, Codable, CaseIterable, Equatable, Sendable {
    case menuBarOwner = "menu_bar_owner"
    case windowServerFrontProcess = "window_server_front_process"
    case keyInputRoute = "key_input_route"
    case textInputRoute = "text_input_route"
    case cursorLocation = "cursor_location"
    case activeSpace = "active_space"
}

/// Coverage attached to one snapshot. A concrete synthetic snapshot is fully observed by default;
/// live capture supplies the weaker truth for routes macOS does not safely expose.
public struct IsolationSnapshotCoverage: Equatable, Sendable {
    public let menuBarOwner: IsolationCoverage
    public let windowServerFrontProcess: IsolationCoverage
    public let keyInputRoute: IsolationCoverage
    public let textInputRoute: IsolationCoverage
    public let cursorLocation: IsolationCoverage
    public let activeSpace: IsolationCoverage

    public init(menuBarOwner: IsolationCoverage,
                windowServerFrontProcess: IsolationCoverage,
                keyInputRoute: IsolationCoverage,
                textInputRoute: IsolationCoverage,
                cursorLocation: IsolationCoverage,
                activeSpace: IsolationCoverage) {
        self.menuBarOwner = menuBarOwner
        self.windowServerFrontProcess = windowServerFrontProcess
        self.keyInputRoute = keyInputRoute
        self.textInputRoute = textInputRoute
        self.cursorLocation = cursorLocation
        self.activeSpace = activeSpace
    }

    public static let observed = IsolationSnapshotCoverage(
        menuBarOwner: .observed,
        windowServerFrontProcess: .observed,
        keyInputRoute: .observed,
        textInputRoute: .observed,
        cursorLocation: .observed,
        activeSpace: .observed
    )

    public static let live = IsolationSnapshotCoverage(
        menuBarOwner: .observed,
        // There is no safe public WindowServer front-process getter. This field mirrors AppKit.
        windowServerFrontProcess: .inferred,
        // Synthetic live-shaped snapshots default to unknown. Real capture promotes these to
        // inferred when the public Accessibility focused-application proxy is readable.
        keyInputRoute: .unknown,
        textInputRoute: .unknown,
        cursorLocation: .observed,
        activeSpace: .observed
    )

    fileprivate subscript(_ dimension: IsolationDimension) -> IsolationCoverage {
        switch dimension {
        case .menuBarOwner: return menuBarOwner
        case .windowServerFrontProcess: return windowServerFrontProcess
        case .keyInputRoute: return keyInputRoute
        case .textInputRoute: return textInputRoute
        case .cursorLocation: return cursorLocation
        case .activeSpace: return activeSpace
        }
    }
}

public enum IsolationCheckStatus: String, Codable, Equatable, Sendable {
    case passed
    case failed
    case unknown
}

/// One auditable row in an isolation verdict.
public struct IsolationCheckReport: Codable, Equatable, Sendable {
    public let dimension: IsolationDimension
    public let required: Bool
    public let coverage: IsolationCoverage
    public let status: IsolationCheckStatus
    public let evidence: String
    public let failures: [String]

    public init(dimension: IsolationDimension,
                required: Bool = true,
                coverage: IsolationCoverage,
                status: IsolationCheckStatus,
                evidence: String,
                failures: [String] = []) {
        self.dimension = dimension
        self.required = required
        self.coverage = coverage
        self.status = status
        self.evidence = evidence
        self.failures = failures
    }
}

public enum IsolationVerdict: String, Codable, Equatable, Sendable {
    /// Every required check had usable coverage and none failed.
    case intact
    /// At least one check detected an attributable isolation failure.
    case breached
    /// No covered check failed, but at least one required check was unknown.
    case partial
}

/// The machine-readable isolation result shared by the daemon protocol, CLI, and MCP.
public struct IsolationReport: Codable, Equatable, Sendable {
    public let verdict: IsolationVerdict
    public let checks: [IsolationCheckReport]
    public let failures: [String]
    /// Whether the process that took these observations held the Accessibility grant, when it
    /// knew. The summary names a missing grant as the cause of a partial verdict only when this
    /// says so; evidence text alone cannot tell "not granted" from "granted, but the focused app
    /// exposed nothing". Optional on the wire for older daemons.
    public var accessibilityGranted: Bool? = nil

    /// Adoption can acquire a process that already owned global focus before the operation.
    /// An unchanged PID is not a clean current state: preserve those current failures too.
    public func includingCurrentFailures(_ current: IsolationReport) -> IsolationReport {
        var merged = IsolationReport(checks: checks.map { check in
            guard let now = current.checks.first(where: { $0.dimension == check.dimension }),
                  now.status == .failed else { return check }
            return IsolationCheckReport(dimension: check.dimension, required: check.required,
                coverage: now.coverage, status: .failed,
                evidence: check.evidence + "; current state: " + now.evidence,
                failures: Array(Set(check.failures + now.failures)).sorted())
        })
        merged.accessibilityGranted = accessibilityGranted ?? current.accessibilityGranted
        return merged
    }

    public init(checks: [IsolationCheckReport], accessibilityGranted: Bool? = nil) {
        self.accessibilityGranted = accessibilityGranted
        self.checks = checks
        self.failures = checks.flatMap(\.failures)
        if !failures.isEmpty {
            verdict = .breached
        } else if checks.contains(where: {
            $0.required && ($0.coverage == .unknown || $0.status == .unknown)
        }) {
            verdict = .partial
        } else {
            verdict = .intact
        }
    }

    public var isFullyIntact: Bool { verdict == .intact }

    /// Compatibility payload for old clients. Omit it for partial reports so an empty legacy
    /// array cannot be mistaken for a fully covered clean verdict.
    public var legacyDrift: [String]? {
        verdict == .partial ? nil : failures
    }
}

/// The project's correctness claim and the limits of its evidence, made into a value.
///
/// SpaceO's promise is "this does not change while an agent works". Making it a first-class
/// type means tests assert on it directly, while coverage prevents an unavailable observation
/// from becoming a clean production verdict.
public struct IsolationSnapshot: Equatable, Sendable, CustomStringConvertible {

    /// The app owning the menu bar, per AppKit.
    public let frontmostPID: pid_t
    /// Storage for the WindowServer front process. Live capture mirrors AppKit into this field
    /// and marks it inferred because no safe WindowServer getter is called.
    public let windowServerFrontPID: pid_t
    /// Storage for physical-key and text-input routes. Values are meaningful only when the
    /// corresponding coverage is not unknown; live capture currently stores zero for both.
    public let keyFocusPID: pid_t
    public let typingFocusPID: pid_t
    public let cursor: CGPoint
    public let activeSpace: UInt64
    /// Agent screen rects at capture time, so we can detect a pointer routed onto one.
    public let stageRects: [CGRect]
    /// Processes belonging to agents, so we can tell whose fault a focus change was.
    public let agentPIDs: Set<pid_t>
    public let agentSpaces: Set<UInt64>
    public let coverage: IsolationSnapshotCoverage
    /// Whether this process held the Accessibility grant at capture time; nil when unknown
    /// (synthetic snapshots). Carried into reports so their summary can name the real cause.
    public var accessibilityGranted: Bool? = nil
    /// The exact process that owned the menu bar, when it could be identified, so a later
    /// decision cannot mistake a process that reused its PID for the person's application.
    public var frontmostIdentity: ProcessIdentity? = nil

    public init(frontmostPID: pid_t,
                windowServerFrontPID: pid_t,
                keyFocusPID: pid_t = 0,
                typingFocusPID: pid_t = 0,
                cursor: CGPoint,
                activeSpace: UInt64,
                stageRects: [CGRect] = [],
                agentPIDs: Set<pid_t> = [],
                agentSpaces: Set<UInt64> = [],
                coverage: IsolationSnapshotCoverage = .observed) {
        self.frontmostPID = frontmostPID
        self.windowServerFrontPID = windowServerFrontPID
        self.keyFocusPID = keyFocusPID
        self.typingFocusPID = typingFocusPID
        self.cursor = cursor
        self.activeSpace = activeSpace
        self.stageRects = stageRects
        self.agentPIDs = agentPIDs
        self.agentSpaces = agentSpaces
        self.coverage = coverage
    }

    /// Stage rectangles are usable cursor evidence only when global coordinates identify one
    /// display unambiguously. macOS can temporarily publish a newly attached virtual display at
    /// the physical display's exact `(0,0)` bounds. In that state a cursor point is inside both
    /// screens, so calling it an agent-screen breach would be a false accusation.
    static func cursorStageRects(
        agentDisplayIDs: [CGDirectDisplayID],
        onlineDisplayIDs: [CGDirectDisplayID],
        bounds: (CGDirectDisplayID) -> CGRect
    ) -> [CGRect]? {
        let agentIDs = Set(agentDisplayIDs)
        let agentRects = agentDisplayIDs.map(bounds)
        let userRects = onlineDisplayIDs
            .filter { !agentIDs.contains($0) }
            .map(bounds)

        guard (agentRects + userRects).allSatisfy({ rect in
            !rect.isNull && !rect.isInfinite && !rect.isEmpty
        }) else { return nil }
        let overlapsUserDisplay = agentRects.contains { agent in
            userRects.contains { user in
                let intersection = agent.intersection(user)
                return !intersection.isNull && !intersection.isEmpty
            }
        }
        return overlapsUserDisplay ? nil : agentRects
    }

    private static func onlineDisplayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success else { return [] }
        return Array(displays.prefix(Int(count)))
    }

    /// Public, bounded proxy for the application currently receiving Accessibility focus.
    ///
    /// This does not claim to expose the WindowServer's physical keyboard/text route, nor the
    /// focused window or field. It is nevertheless usable inferred evidence: when Accessibility
    /// says an agent-owned application became focused, SpaceO can attribute and fail that change
    /// without touching the removed private ProcessSerialNumber getters.
    private static func accessibilityFocusedApplicationPID() -> pid_t? {
        let systemWide = AXUIElementCreateSystemWide()
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide,
            kAXFocusedApplicationAttribute as CFString,
            &raw) == .success,
              let raw,
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let application = unsafeBitCast(raw, to: AXUIElement.self)
        var pid: pid_t = 0
        guard AXUIElementGetPid(application, &pid) == .success, pid > 0 else { return nil }
        return pid
    }

    public static func capture() -> IsolationSnapshot {
        let frontmostApplication = NSWorkspace.shared.frontmostApplication
        let frontmostPID = frontmostApplication?.processIdentifier ?? 0
        let accessibilityFocusPID = accessibilityFocusedApplicationPID()
        // CoreGraphics uses the same global coordinates as display and window bounds.
        let cursorEvent = CGEvent(source: nil)
        let activeSpace = SPOActiveSpace()
        let agentDisplayIDs = Stage.spaceODisplayIDs()
        let cursorRects = cursorStageRects(
            agentDisplayIDs: agentDisplayIDs,
            onlineDisplayIDs: onlineDisplayIDs(),
            bounds: CGDisplayBounds)
        let captureCoverage = IsolationSnapshotCoverage(
            menuBarOwner: frontmostApplication == nil ? .unknown : .observed,
            windowServerFrontProcess: frontmostApplication == nil ? .unknown : .inferred,
            keyInputRoute: accessibilityFocusPID == nil ? .unknown : .inferred,
            textInputRoute: accessibilityFocusPID == nil ? .unknown : .inferred,
            cursorLocation: cursorEvent == nil || cursorRects == nil ? .unknown : .observed,
            activeSpace: activeSpace == 0 ? .unknown : .observed
        )
        var snapshot = IsolationSnapshot(
            frontmostPID: frontmostPID,
            // The private focus/front-process getters use undocumented ProcessSerialNumber ABIs.
            // Keep the comparison fields for synthetic tests, but use the public AppKit view for
            // live containment instead of calling any of those getters.
            windowServerFrontPID: frontmostPID,
            keyFocusPID: accessibilityFocusPID ?? 0,
            typingFocusPID: accessibilityFocusPID ?? 0,
            cursor: cursorEvent?.location ?? .zero,
            activeSpace: activeSpace,
            stageRects: cursorRects ?? [],
            agentPIDs: AgentActivity.ownedPIDs,
            agentSpaces: AgentActivity.ownedSpaces,
            coverage: captureCoverage
        )
        snapshot.accessibilityGranted = AXIsProcessTrusted()
        snapshot.frontmostIdentity = frontmostPID > 0 ? ProcessIdentity.current(of: frontmostPID) : nil
        return snapshot
    }

    /// A baseline you can actually assert against.
    ///
    /// `capture()` is a single instant, and an instant can land mid-transition — an app that is
    /// quitting is still frontmost for a moment, and a baseline taken then reports a "breach"
    /// when the system settles onto the next app. This waits for two consecutive identical
    /// readings before returning, so the baseline describes a state the machine is actually in.
    public static func captureStable(settleFor interval: TimeInterval = 0.25,
                                     timeout: TimeInterval = 3) -> IsolationSnapshot {
        let safeInterval = interval.isFinite ? min(max(interval, 0.01), 1.0) : 0.25
        let safeTimeout = timeout.isFinite ? min(max(timeout, safeInterval), 30) : 3
        var previous = capture()
        let deadline = Date().addingTimeInterval(safeTimeout)
        while Date() < deadline {
            usleep(UInt32(safeInterval * 1_000_000))
            let current = capture()
            if current.frontmostPID == previous.frontmostPID,
               current.windowServerFrontPID == previous.windowServerFrontPID,
               current.activeSpace == previous.activeSpace,
               NSRunningApplication(processIdentifier: current.frontmostPID) != nil {
                return current
            }
            previous = current
        }
        return previous
    }

    private func cursorMoved(from other: IsolationSnapshot) -> Bool {
        abs(cursor.x - other.cursor.x) > 1 || abs(cursor.y - other.cursor.y) > 1
    }

    private func coverage(of dimension: IsolationDimension,
                          comparedTo other: IsolationSnapshot) -> IsolationCoverage {
        coverage[dimension].combined(with: other.coverage[dimension])
    }

    private func failures(for dimension: IsolationDimension,
                          from other: IsolationSnapshot) -> [String] {
        guard coverage(of: dimension, comparedTo: other) != .unknown else { return [] }

        switch dimension {
        case .menuBarOwner:
            if frontmostPID != other.frontmostPID, agentPIDs.contains(frontmostPID) {
                return [
                    "an agent app took the menu bar: pid "
                    + "\(other.frontmostPID) -> \(frontmostPID)"
                ]
            }
        case .windowServerFrontProcess:
            if windowServerFrontPID != other.windowServerFrontPID,
               agentPIDs.contains(windowServerFrontPID) {
                return [
                    "an agent app became the WindowServer front process: pid "
                    + "\(other.windowServerFrontPID) -> \(windowServerFrontPID)"
                ]
            }
        case .keyInputRoute:
            if keyFocusPID != other.keyFocusPID, agentPIDs.contains(keyFocusPID) {
                return [
                    "an agent app took the key-input route: pid "
                    + "\(other.keyFocusPID) -> \(keyFocusPID)"
                ]
            }
        case .textInputRoute:
            if typingFocusPID != other.typingFocusPID, agentPIDs.contains(typingFocusPID) {
                return [
                    "an agent app took the text-input route: pid "
                    + "\(other.typingFocusPID) -> \(typingFocusPID)"
                ]
            }
        case .activeSpace:
            if activeSpace != other.activeSpace, agentSpaces.contains(activeSpace) {
                return [
                    "the user was pulled onto an agent display's Space: "
                    + "\(other.activeSpace) -> \(activeSpace)"
                ]
            }
        case .cursorLocation:
            if cursorMoved(from: other), stageRects.contains(where: { $0.contains(cursor) }) {
                return [
                    String(
                        format: "cursor is sitting on an agent screen at (%.0f,%.0f)",
                        cursor.x,
                        cursor.y
                    )
                ]
            }
        }
        return []
    }

    private func currentFailures(for dimension: IsolationDimension) -> [String] {
        guard coverage[dimension] != .unknown else { return [] }

        switch dimension {
        case .menuBarOwner where agentPIDs.contains(frontmostPID):
            return ["an agent app currently owns the menu bar: pid \(frontmostPID)"]
        case .windowServerFrontProcess where agentPIDs.contains(windowServerFrontPID):
            return [
                "an agent app is currently inferred to be the WindowServer front process: "
                + "pid \(windowServerFrontPID)"
            ]
        case .keyInputRoute where agentPIDs.contains(keyFocusPID):
            return ["an agent app currently owns the key-input route: pid \(keyFocusPID)"]
        case .textInputRoute where agentPIDs.contains(typingFocusPID):
            return ["an agent app currently owns the text-input route: pid \(typingFocusPID)"]
        case .activeSpace where agentSpaces.contains(activeSpace):
            return ["the active Space currently belongs to an agent display: \(activeSpace)"]
        case .cursorLocation where stageRects.contains(where: { $0.contains(cursor) }):
            return [
                String(
                    format: "cursor is currently on an agent screen at (%.0f,%.0f)",
                    cursor.x,
                    cursor.y
                )
            ]
        default:
            return []
        }
    }

    private func evidence(for dimension: IsolationDimension,
                          coverage: IsolationCoverage) -> String {
        switch (dimension, coverage) {
        case (.menuBarOwner, .observed):
            return "NSWorkspace frontmost application"
        case (.windowServerFrontProcess, .inferred):
            return "inferred from AppKit; no safe WindowServer front-process getter is available"
        case (.keyInputRoute, .unknown), (.textInputRoute, .unknown):
            return "Accessibility focused-application proxy was unavailable; the keyboard/text route was not ruled out"
        case (.keyInputRoute, .inferred), (.textInputRoute, .inferred):
            return "inferred from the public Accessibility focused application; this does not identify a specific key window or text field"
        case (.cursorLocation, .observed):
            return "CoreGraphics event location"
        case (.activeSpace, .observed):
            return "WindowServer active Space"
        case (_, .unknown):
            return "no usable observation was available"
        default:
            return coverage == .observed ? "supplied observation" : "derived observation"
        }
    }

    public func report(comparedTo other: IsolationSnapshot) -> IsolationReport {
        let checks = IsolationDimension.allCases.map { dimension -> IsolationCheckReport in
            let checkCoverage = coverage(of: dimension, comparedTo: other)
            let checkFailures = failures(for: dimension, from: other)
            let status: IsolationCheckStatus
            if checkCoverage == .unknown {
                status = .unknown
            } else {
                status = checkFailures.isEmpty ? .passed : .failed
            }
            return IsolationCheckReport(
                dimension: dimension,
                coverage: checkCoverage,
                status: status,
                evidence: evidence(for: dimension, coverage: checkCoverage),
                failures: checkFailures
            )
        }
        // Missing at either end means part of the comparison ran without the grant.
        let grants = [other.accessibilityGranted, accessibilityGranted].compactMap { $0 }
        return IsolationReport(checks: checks,
                               accessibilityGranted: grants.isEmpty ? nil : !grants.contains(false))
    }

    /// Per-dimension coverage and failures visible at this instant. This cannot reconstruct a
    /// past transient breach, but it lets `spaceo verify` reject agent-owned user state now.
    public func currentReport() -> IsolationReport {
        let checks = IsolationDimension.allCases.map { dimension -> IsolationCheckReport in
            let checkCoverage = coverage[dimension]
            let checkFailures = currentFailures(for: dimension)
            let status: IsolationCheckStatus
            if checkCoverage == .unknown {
                status = .unknown
            } else {
                status = checkFailures.isEmpty ? .passed : .failed
            }
            return IsolationCheckReport(
                dimension: dimension,
                coverage: checkCoverage,
                status: status,
                evidence: evidence(for: dimension, coverage: checkCoverage),
                failures: checkFailures
            )
        }
        return IsolationReport(checks: checks, accessibilityGranted: accessibilityGranted)
    }

    /// Changes SpaceO is responsible for, limited to dimensions with usable coverage.
    ///
    /// Cursor movement counts as a breach when the pointer ended up on an agent screen (the
    /// actual failure mode — an agent dragging the user's pointer to its own window). A user
    /// idly moving their mouse across their own display is not a breach.
    public func breaches(from other: IsolationSnapshot) -> [String] {
        report(comparedTo: other).failures
    }

    /// Changes we observed but do not attribute to SpaceO — almost always the user working.
    public func ambientChanges(from other: IsolationSnapshot) -> [String] {
        var out: [String] = []
        let blamed = breaches(from: other)
        if coverage(of: .cursorLocation, comparedTo: other) != .unknown,
           cursorMoved(from: other),
           blamed.allSatisfy({ !$0.contains("cursor") }) {
            out.append(String(format: "cursor moved (%.0f,%.0f) -> (%.0f,%.0f) — not caused by SpaceO",
                              other.cursor.x, other.cursor.y, cursor.x, cursor.y))
        }
        if coverage(of: .menuBarOwner, comparedTo: other) != .unknown,
           frontmostPID != other.frontmostPID,
           !agentPIDs.contains(frontmostPID) {
            out.append("frontmost app changed between the user's own apps: "
                     + "pid \(other.frontmostPID) -> \(frontmostPID) — not caused by SpaceO")
        }
        return out
    }

    public func drift(from other: IsolationSnapshot) -> [String] {
        breaches(from: other) + ambientChanges(from: other)
    }

    public func isUndisturbed(comparedTo other: IsolationSnapshot) -> Bool {
        report(comparedTo: other).isFullyIntact
    }

    public var description: String {
        let key = coverage.keyInputRoute == .unknown ? "unknown" : "\(keyFocusPID)"
        let typing = coverage.textInputRoute == .unknown ? "unknown" : "\(typingFocusPID)"
        return String(
            format: "front=%d wsFront=%d(%@) key=%@ typing=%@ cursor=(%.0f,%.0f) space=%llu",
            frontmostPID,
            windowServerFrontPID,
            coverage.windowServerFrontProcess.rawValue,
            key,
            typing,
            cursor.x,
            cursor.y,
            activeSpace
        )
    }
}
