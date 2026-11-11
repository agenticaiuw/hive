import Foundation
import CoreGraphics

/// Task readiness is separate from command success and from evidence of presentation.
public struct ReadinessReport: Codable, Sendable, Equatable {
    public var state: String
    public var blockers: [String]
    public var applicationCount: Int
    public var windowCount: Int
    public var visibility: String = "unknown"
    public var presentationVerification: String = "unverified"
    public var nextAction: String?

    public init(applicationCount: Int, windowCount: Int, attached: Bool,
                paused: Bool, canDrive: Bool?, requireWindow: Bool = true) {
        self.applicationCount = applicationCount
        self.windowCount = windowCount
        blockers = []
        if !attached { blockers.append("session_not_attached") }
        if paused { blockers.append("input_paused") }
        if canDrive != true { blockers.append("driving_unavailable_or_unknown") }
        if requireWindow && applicationCount == 0 { blockers.append("application_not_attached") }
        if requireWindow && windowCount == 0 { blockers.append("application_window_not_ready") }
        state = blockers.isEmpty ? "ready" : "blocked"
        if paused { nextAction = "resume_after_resolving_blocker" }
        else if windowCount == 0 { nextAction = "wait_for_matching_window" }
        else if canDrive != true { nextAction = "spaceo doctor --json" }
    }
}

/// Opaque receipt invalidated by daemon/session replacement, process reuse or changed geometry.
public struct GeometryReceipt: Codable, Sendable, Equatable {
    public var token: String
    public var backingScale: Double?
    public var sessionGeneration: UUID
    public var displayID: UInt32
    public var windowID: UInt32
    public var coordinateSpace: String = "window-local-points"
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(sessionGeneration: UUID, displayID: UInt32, displayBounds: CGRect,
                window: WindowRef, process: ProcessIdentity?, backingScale: Double? = nil) {
        self.sessionGeneration = sessionGeneration
        self.backingScale = backingScale
        self.displayID = displayID
        windowID = window.windowID
        x = window.frame.minX; y = window.frame.minY
        width = window.frame.width; height = window.frame.height
        let source = "\(sessionGeneration)|\(displayID)|\(displayBounds)|\(window.windowID)|\(window.pid)|\(String(describing: process))|\(window.frame)|\(String(describing: backingScale))"
        token = sha256Hex(Data(source.utf8))
    }
}

public struct PlacementReceipt: Codable, Sendable {
    public var policy: String
    public var requested: CGRect
    public var observed: CGRect
    public var overflowEdges: [String]
    public var exactFrameMatched: Bool
}

public struct CaptureReceipt: Codable, Sendable {
    /// Backend image-return time, before processing or file publication. This wall-clock
    /// observation does not prove pixel freshness, visibility, or compositor presentation.
    public var capturedAt: Date
    /// Display capture source for tile captures; nil for independent window captures.
    public var displayID: UInt32?
    public var destinationDisplayID: UInt32
    public var windowID: UInt32?
    public var sourceKind: String
    public var persistence: String
    public var freshness: String = "unknown"
    public var visibility: String = "unknown"
    public var presentationVerification: String = "unverified"
}

public struct ActionReceipt: Codable, Sendable {
    public var command: String
    public var windowID: UInt32?
    public var route: String
    public var completion: String
    public var requestedDuration: Double?
    public var elapsedSeconds: Double
    /// `confirmed`, `unconfirmed`, or `refused` — the same vocabulary as the event stream.
    public var outcome: String? = nil
}

public enum LaunchOptions {
    public static func validate(arguments: [String], timeout: Double) throws {
        guard timeout.isFinite, (0.5...120).contains(timeout) else {
            throw SpaceOError.badRequest("timeout must be finite and from 0.5 through 120 seconds")
        }
        guard arguments.count <= 128, arguments.allSatisfy({ !$0.contains("\0") && $0.utf8.count <= 4096 }),
              arguments.reduce(0, { $0 + $1.utf8.count }) <= 32768 else {
            throw SpaceOError.badRequest("launch arguments exceed the 128 argument / 32768 byte limit")
        }
    }
}

public struct PermissionReadinessReport: Codable, Sendable, Equatable {
    public var state: String
    public var blockers: [String]
    public var nextAction: String?

    public init(clientAX: Bool, clientCapture: Bool, daemon: DaemonRuntimeInfo?) {
        blockers = []
        if let daemon {
            let differences = [daemon.accessibilityGranted.map { $0 != clientAX },
                               daemon.screenRecordingGranted.map { $0 != clientCapture }]
            if differences.contains(true) {
                blockers.append("permission_state_mismatch")
                nextAction = "inspect all sessions before coordinated daemon restart; do not repeat an already granted permission prompt"
            }
            if differences.contains(nil) {
                blockers.append("permission_state_unknown")
                nextAction = nextAction ?? "inspect all sessions and update/restart the daemon to obtain permission health"
            }
            if daemon.canDrive != true { blockers.append("daemon_driving_unavailable") }
            if daemon.canCapture != true { blockers.append("daemon_capture_unavailable") }
        } else {
            blockers.append("daemon_not_running")
            nextAction = "spaceo daemon"
        }
        state = blockers.isEmpty ? "ready" : "blocked"
    }
}

public struct DisplayTargetReceipt: Codable, Sendable {
    public var identity: UUID
    public var displayID: UInt32
    public var logicalBounds: CGRect
    public var backingScale: Double?
    public var topologyGeneration: String

    public init(identity: UUID, displayID: UInt32, logicalBounds: CGRect, backingScale: Double?) {
        self.identity = identity
        self.displayID = displayID
        self.logicalBounds = logicalBounds
        self.backingScale = backingScale
        let value = "\(identity)|\(displayID)|\(logicalBounds)|\(String(describing: backingScale))"
        self.topologyGeneration = sha256Hex(Data(value.utf8))
    }
}

public struct VerificationAssertion: Codable, Sendable, Equatable {
    public var requiredDimensions: [IsolationDimension]
    public var unmetDimensions: [IsolationDimension]
    public var satisfied: Bool

    public init(required: [IsolationDimension], report: IsolationReport?) {
        requiredDimensions = required
        unmetDimensions = required.filter { dimension in
            !((report?.checks ?? []).contains {
                $0.dimension == dimension && $0.coverage == .observed && $0.status == .passed
            })
        }
        satisfied = unmetDimensions.isEmpty
    }
}
