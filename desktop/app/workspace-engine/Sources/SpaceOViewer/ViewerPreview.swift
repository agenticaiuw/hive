import AppKit
import CoreMedia
import CoreVideo
import Foundation
import SpaceOKit

/// Deterministic screens for looking at the Viewer: `SpaceO Viewer --background --preview <name>`.
///
/// A preview talks to no daemon and captures no display. Sessions, displays and permissions come
/// from fixtures; the canvas shows a drawn stand-in for an agent's screen; Control is never
/// taken (the `control` scenario draws its chrome only). `scripts/viewer-snapshots.sh` launches
/// every scenario inside a SpaceO session and saves a screenshot of each, so a change to the
/// Viewer can be checked screen by screen without touching the real desktop or real sessions.
enum ViewerPreviewScenario: String, CaseIterable, Sendable {
    case welcome
    case onboardingAccess = "onboarding-access"
    case onboardingAgents = "onboarding-agents"
    case onboardingDone = "onboarding-done"
    case session
    case needsYou = "needs-you"
    case control
    case wholeDisplay = "whole-display"
    case activity
    case noPermission = "no-permission"
    case permissionGuide = "permission-guide"
    case offline
    case removeDisplay = "remove-display"
    case miniMonitor = "mini-monitor"
    case settingsGeneral = "settings-general"
    case settingsAgents = "settings-agents"
    case settingsPermissions = "settings-permissions"
    case settingsService = "settings-service"
    case settingsDisplays = "settings-displays"
    case settingsNotifications = "settings-notifications"

    static let current: ViewerPreviewScenario? = {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--preview"), index + 1 < arguments.count
        else { return nil }
        return ViewerPreviewScenario(rawValue: arguments[index + 1])
    }()

    var hasSessions: Bool {
        switch self {
        case .welcome, .onboardingAccess, .onboardingAgents, .onboardingDone, .offline: false
        default: true
        }
    }

    var permissions: PermissionState {
        switch self {
        case .noPermission, .permissionGuide: PermissionState(screenRecording: false, accessibility: false)
        case .onboardingAccess: PermissionState(screenRecording: true, accessibility: false)
        default: PermissionState(screenRecording: true, accessibility: true)
        }
    }

    var onboardingPage: FirstSessionWalkthrough.Page {
        switch self {
        case .onboardingAccess: .access
        case .onboardingAgents: .agents
        case .onboardingDone: .tryIt
        default: .welcome
        }
    }
}

@MainActor
enum ViewerPreview {
    nonisolated static let exclusiveDisplay: CGDirectDisplayID = 70_001
    nonisolated static let sharedDisplay: CGDirectDisplayID = 70_002

    static var displays: [DisplayEntry] {
        [DisplayEntry(id: exclusiveDisplay, bounds: CGRect(x: 4_000, y: 0, width: 1_920, height: 1_080),
                      isSpaceO: true, isActive: true, name: "Stage A"),
         DisplayEntry(id: sharedDisplay, bounds: CGRect(x: 6_000, y: 0, width: 1_920, height: 1_080),
                      isSpaceO: true, isActive: true, name: "Stage B")]
    }

    static func makeModel(_ scenario: ViewerPreviewScenario) -> ViewerModel {
        let offline = scenario == .offline
        let sessionsVisible = scenario.hasSessions
        let permissions = scenario.permissions
        let model = ViewerModel(
            streamEngine: PreviewStreamEngine(),
            discoveryProvider: { (offline ? [] : displays, permissions) },
            daemonTransport: { request in
                if offline { throw SpaceOError.badRequest("Couldn't connect to the SpaceO daemon") }
                return response(to: request, sessions: sessionsVisible ? sessions(now: Date()) : [])
            },
            permissionPrompt: { _ in },
            accessibilityAnnouncement: { _ in })
        let connections = model.agentConnections
        connections.pinnedStates = [
            .claudeCode: .connected(path: ViewerAgentConnections.spaceoPath, current: true),
            .codex: .notConnected,
            .cursor: .notConnected,
            .claudeDesktop: .notInstalled,
        ]
        return model
    }

    /// Scenario state that needs a first poll to have landed.
    static func stage(_ scenario: ViewerPreviewScenario, on model: ViewerModel) {
        switch scenario {
        case .session:
            model.selectSession("lisbon")
            model.inspectorVisible = true
        case .needsYou:
            model.selectSession("invoice")
            model.inspectorVisible = true
        case .control:
            model.selectSession("lisbon")
            model.previewControlChrome = true
            model.keyDestination = ViewerKeyDestination(
                pid: 4_242, windowID: 9, appName: "Safari", windowTitle: "Flights to Lisbon",
                isSessionApp: true)
        case .wholeDisplay:
            model.selectDisplay(sharedDisplay)
        case .activity:
            model.selectSession("notes")
            model.inspectorVisible = true
            model.inspectorSection = .events
            for (title, detail) in [("Agent action", "click · confirmed · Button — Save"),
                                    ("Agent action", "type · confirmed · Text — Release notes"),
                                    ("Session appeared", "The daemon attached a new session.")] {
                model.appendEvent(severity: .info, title: title, detail: detail,
                                  sessionID: "notes", isAgentAction: title == "Agent action")
            }
        case .noPermission:
            model.selectSession("lisbon")
        case .permissionGuide:
            model.selectSession("lisbon")
            model.permissionGuide = .screenRecording
        case .offline:
            let start = Date().addingTimeInterval(-10)
            model.applyControlPlaneFailure(
                SpaceOError.badRequest("Couldn't connect to the SpaceO daemon"), now: start)
            model.applyControlPlaneFailure(
                SpaceOError.badRequest("Couldn't connect to the SpaceO daemon"), now: Date())
        case .removeDisplay:
            model.selectDisplay(sharedDisplay)
            model.request(.removeDisplay(sharedDisplay))
        case .miniMonitor:
            model.selectSession("lisbon")
            MiniMonitorController.shared.setVisible(true, model: model)
        case .settingsGeneral: model.showSettings(.general)
        case .settingsAgents: model.showSettings(.agents)
        case .settingsPermissions: model.showSettings(.permissions)
        case .settingsService: model.showSettings(.spaceo)
        case .settingsDisplays: model.showSettings(.displays)
        case .settingsNotifications: model.showSettings(.notifications)
        case .welcome, .onboardingAccess, .onboardingAgents, .onboardingDone:
            break
        }
    }

    // MARK: - Fixture daemon

    private nonisolated static func response(to request: Request, sessions: [SessionInfo]) -> Response {
        var response = Response(ok: true)
        switch request.cmd {
        case "session.list":
            response.sessions = sessions
        case "pool":
            response.displays = [report(exclusiveDisplay, x: 4_000, capacity: 1, used: 1),
                                 report(sharedDisplay, x: 6_000, capacity: 2, used: 2)]
            response.sessionsPerDisplay = 2
            response.daemon = DaemonRuntimeInfo(
                version: SpaceOVersion.current, executableSHA256: nil, pid: 4_000,
                instanceID: daemonInstance, startedAt: Date().addingTimeInterval(-5_400),
                accessibilityGranted: true, screenRecordingGranted: true,
                canDrive: true, canCapture: true, responsibleProcess: "Terminal")
        default:
            break
        }
        return response
    }

    private nonisolated static let daemonInstance = UUID()

    private nonisolated static func report(_ id: CGDirectDisplayID, x: Double, capacity: Int,
                               used: Int) -> DisplayPool.DisplayReport {
        let json = """
        {"displayID":\(id),"x":\(x),"y":0,"width":1920,"height":1080,
         "capacity":\(capacity),"used":\(used),"spaces":[]}
        """
        // Fixture literals: a decode failure is a programming error in this file.
        return try! Wire.decoder.decode(DisplayPool.DisplayReport.self, from: Data(json.utf8))
    }

    private nonisolated static func sessions(now: Date) -> [SessionInfo] {
        let stamp = ISO8601DateFormatter().string(from: now)
        let recent = ISO8601DateFormatter().string(from: now.addingTimeInterval(-2))
        return [
            session(id: "lisbon", title: "Book a flight to Lisbon", display: exclusiveDisplay,
                    frame: CGRect(x: 4_000, y: 0, width: 1_920, height: 1_080), tile: 0, capacity: 1,
                    owner: "Claude Code", apps: [("Safari", "com.apple.Safari", 501)],
                    window: "Flights to Lisbon",
                    extra: ",\"lastAgentAction\":\"click\",\"lastAgentActionAt\":\"\(recent)\","
                        + "\"lastAgentActionTarget\":\"Button — Search flights\","
                        + "\"lastAgentActionOutcome\":\"confirmed\","
                        + "\"lastAgentActionX\":4700,\"lastAgentActionY\":420",
                    created: now.addingTimeInterval(-1_900), stamp: stamp),
            session(id: "notes", title: "Draft release notes", display: sharedDisplay,
                    frame: CGRect(x: 6_000, y: 0, width: 960, height: 1_080), tile: 0, capacity: 2,
                    owner: "Codex",
                    apps: [("TextEdit", "com.apple.TextEdit", 502), ("Notes", "com.apple.Notes", 503)],
                    window: "Release notes.rtf", extra: ",\"colorTag\":\"blue\"",
                    created: now.addingTimeInterval(-3_600), stamp: stamp),
            session(id: "invoice", title: "Pay the March invoice", display: sharedDisplay,
                    frame: CGRect(x: 6_960, y: 0, width: 960, height: 1_080), tile: 1, capacity: 2,
                    owner: "Claude Code", apps: [("Safari", "com.apple.Safari", 504)],
                    window: "Acme Billing — Pay",
                    extra: ",\"inputPaused\":true,"
                        + "\"agentPauseReason\":\"Enter the 2FA code sent to your phone\"",
                    created: now.addingTimeInterval(-600), stamp: stamp),
        ]
    }

    private nonisolated static func session(
        id: String, title: String, display: CGDirectDisplayID, frame: CGRect, tile: Int,
        capacity: Int, owner: String, apps: [(String, String, Int32)], window: String,
        extra: String, created: Date, stamp: String
    ) -> SessionInfo {
        let appsJSON = apps.map {
            "{\"pid\":\($0.2),\"name\":\"\($0.0)\",\"bundleID\":\"\($0.1)\",\"startedByUs\":true}"
        }.joined(separator: ",")
        let windowJSON = """
        {"windowID":\(apps[0].2 + 9_000),"pid":\(apps[0].2),"title":"\(window)",
         "x":\(frame.minX + 40),"y":\(frame.minY + 60),"width":\(frame.width - 80),
         "height":\(frame.height - 120),"onStage":true,"spaces":[]}
        """
        let json = """
        {"id":"\(id)","title":"\(title)","displayID":\(display),
         "x":\(frame.minX),"y":\(frame.minY),"width":\(frame.width),"height":\(frame.height),
         "tileIndex":\(tile),"tileCapacity":\(capacity),"exclusiveDisplay":\(capacity == 1),
         "spaces":[],"hasOwnSpace":true,"apps":[\(appsJSON)],"windows":[\(windowJSON)],
         "createdAt":"\(ISO8601DateFormatter().string(from: created))",
         "teardownPending":false,"runtimeAttached":true,"lastActivityAt":"\(stamp)",
         "controllerOwner":{"id":"\(owner.lowercased())","kind":"mcp","label":"\(owner)"}\(extra)}
        """
        return try! Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }
}

// MARK: - Drawn stand-in for a live stream

/// Delivers a drawn picture of a desktop twice a second, so the canvas, its overlays and the
/// stream-health footer behave as they do live.
final class PreviewStreamEngine: ViewerDisplayStreaming, @unchecked Sendable {
    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession {
        let size = sourceRect?.size ?? pointSize
        let session = PreviewStreamSession(size: size, tiles: sourceRect == nil ? 2 : 1,
                                           onFrame: onFrame)
        session.begin()
        return session
    }
}

final class PreviewStreamSession: ViewerDisplayStreamSession, @unchecked Sendable {
    private let size: CGSize
    private let tiles: Int
    private let onFrame: @Sendable (CMSampleBuffer) -> Void
    private let timer: DispatchSourceTimer
    private var sample: CMSampleBuffer?

    init(size: CGSize, tiles: Int, onFrame: @escaping @Sendable (CMSampleBuffer) -> Void) {
        self.size = size
        self.tiles = tiles
        self.onFrame = onFrame
        timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    }

    func begin() {
        sample = Self.makeSample(size: size, tiles: tiles)
        timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(500))
        timer.setEventHandler { [weak self] in
            guard let self, let sample = self.sample else { return }
            self.onFrame(sample)
        }
        timer.resume()
    }

    func stop() async { timer.cancel() }
    func updateCrop(_ sourceRect: CGRect?) async throws {}

    /// A wallpaper and one mock app window per tile, drawn into an IOSurface-backed buffer the
    /// console can present the same way it presents a captured frame.
    static func makeSample(size: CGSize, tiles: Int) -> CMSampleBuffer? {
        let width = max(64, Int(size.width)), height = max(64, Int(size.height))
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                  attributes as CFDictionary, &buffer) == kCVReturnSuccess,
              let buffer else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        // Flip to top-left origin so the drawing reads like screen coordinates.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        drawDesktop(in: CGRect(x: 0, y: 0, width: width, height: height), tiles: tiles)
        NSGraphicsContext.restoreGraphicsState()

        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format)
        guard let format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero,
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format,
            sampleTiming: &timing, sampleBufferOut: &sample)
        return sample
    }

    private static func drawDesktop(in bounds: CGRect, tiles: Int) {
        let wallpaper = NSGradient(colors: [
            NSColor(calibratedRed: 0.10, green: 0.16, blue: 0.36, alpha: 1),
            NSColor(calibratedRed: 0.36, green: 0.22, blue: 0.48, alpha: 1),
            NSColor(calibratedRed: 0.86, green: 0.47, blue: 0.36, alpha: 1),
        ])
        wallpaper?.draw(in: bounds, angle: -35)
        NSColor.black.withAlphaComponent(0.35).setFill()
        NSBezierPath(rect: CGRect(x: 0, y: 0, width: bounds.width, height: 24)).fill()
        let tileWidth = bounds.width / CGFloat(tiles)
        for index in 0..<tiles {
            let tile = CGRect(x: CGFloat(index) * tileWidth, y: 24, width: tileWidth,
                              height: bounds.height - 24)
            drawWindow(in: tile.insetBy(dx: tile.width * 0.08, dy: tile.height * 0.08),
                       title: index == 0 ? "Flights to Lisbon" : "Acme Billing — Pay")
        }
    }

    private static func drawWindow(in frame: CGRect, title: String) {
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 30
        shadow.shadowOffset = NSSize(width: 0, height: -8)
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 12, yRadius: 12).fill()
        NSGraphicsContext.restoreGraphicsState()

        let bar = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 52)
        NSColor(calibratedWhite: 0.93, alpha: 1).setFill()
        NSBezierPath(roundedRect: bar, xRadius: 12, yRadius: 12).fill()
        for (offset, color) in [(20.0, NSColor.systemRed), (40, .systemYellow), (60, .systemGreen)] {
            color.setFill()
            NSBezierPath(ovalIn: CGRect(x: frame.minX + offset, y: frame.minY + 20,
                                        width: 12, height: 12)).fill()
        }
        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 0.25, alpha: 1)]
        (title as NSString).draw(at: CGPoint(x: frame.minX + 90, y: frame.minY + 16),
                                 withAttributes: titleAttributes)

        let heading: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 30, weight: .bold),
            .foregroundColor: NSColor(calibratedWhite: 0.12, alpha: 1)]
        (title as NSString).draw(at: CGPoint(x: frame.minX + 40, y: frame.minY + 90),
                                 withAttributes: heading)
        NSColor(calibratedWhite: 0.86, alpha: 1).setFill()
        var y = frame.minY + 150
        for fraction in [0.82, 0.66, 0.74, 0.5, 0.7] where y < frame.maxY - 80 {
            NSBezierPath(roundedRect: CGRect(x: frame.minX + 40, y: y,
                                             width: (frame.width - 80) * fraction, height: 14),
                         xRadius: 7, yRadius: 7).fill()
            y += 34
        }
        let button = CGRect(x: frame.minX + 40, y: min(y + 20, frame.maxY - 70),
                            width: 180, height: 44)
        NSColor.systemBlue.setFill()
        NSBezierPath(roundedRect: button, xRadius: 10, yRadius: 10).fill()
        let label: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: NSColor.white]
        ("Continue" as NSString).draw(at: CGPoint(x: button.minX + 56, y: button.minY + 12),
                                      withAttributes: label)
    }
}
