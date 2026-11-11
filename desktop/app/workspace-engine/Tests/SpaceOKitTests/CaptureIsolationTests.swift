import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Regression coverage for the shared-display capture privacy boundary.
///
/// These tests exercise the exact exclusion planner used to build `SCContentFilter`, with a
/// synthetic ScreenCaptureKit snapshot. That makes the observable effect — the foreign window id
/// passed to the filter, or a fail-closed error — deterministic without attaching a real display.
final class CaptureIsolationTests: XCTestCase {
    func testWindowCaptureRefusesChangedSnapshotGeometry() throws {
        let window = WindowRef(windowID: 1, pid: 101, title: "fixture",
            frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        try Capture.validateWindowCaptureFrame(window, frame: window.frame)
        XCTAssertThrowsError(try Capture.validateWindowCaptureFrame(window,
            frame: window.frame.offsetBy(dx: 1, dy: 0)))
    }

    func testWindowCaptureAcceptsMatchingSnapshotOwner() throws {
        let window = WindowRef(windowID: 42, pid: 101, title: "", frame: .zero)
        try Capture.validateWindowCaptureOwner(window, ownerPID: 101)
    }

    func testWindowCaptureRefusesRecycledIDAndUnknownOwner() {
        let window = WindowRef(windowID: 42, pid: 101, title: "", frame: .zero)
        for owner: pid_t? in [202, nil, 0, -1] {
            XCTAssertThrowsError(try Capture.validateWindowCaptureOwner(window, ownerPID: owner)) { error in
                guard case SpaceOError.captureFailed = error else {
                    return XCTFail("expected a structured capture failure")
                }
            }
        }
    }

    func testWindowCaptureRefusesPlaceholderAndInvalidRequestedProcess() {
        for (id, pid): (CGWindowID, pid_t) in [(0, 101), (42, 0), (42, -1)] {
            let window = WindowRef(windowID: id, pid: pid, title: "", frame: .zero)
            XCTAssertThrowsError(try Capture.validateWindowCaptureOwner(window, ownerPID: pid))
        }
    }

    private final class FakeDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 2560, height: 1600)
        private let lock = NSLock()
        private var attached = true

        init(displayID: CGDirectDisplayID) { self.displayID = displayID }

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
    }

    private struct WatcherUnavailable: Error {}

    private final class DiscoveryState: @unchecked Sendable {
        private let lock = NSLock()
        private var failed = false
        private var legacyCalls = 0
        private var titleCalls = 0
        var legacyCount: Int { lock.withLock { legacyCalls } }
        var titleCount: Int { lock.withLock { titleCalls } }
        func recordLegacy() { lock.withLock { legacyCalls += 1 } }
        func setFailure(_ value: Bool) { lock.withLock { failed = value } }
        func check(includeTitles: Bool) throws {
            if includeTitles { lock.withLock { titleCalls += 1 } }
            if lock.withLock({ failed }) { throw AXWindowDiscovery.incomplete("fixture discovery failure") }
        }
    }

    override func setUp() {
        super.setUp()
        ProcessOwnership.reset()
        AgentActivity.reset()
    }

    override func tearDown() {
        ProcessOwnership.reset()
        AgentActivity.reset()
        super.tearDown()
    }

    func testSessionManagerFeedsTheOtherLiveSessionsWindowIntoCaptureExclusions() async throws {
        let displayID: CGDirectDisplayID = 91_041
        let backing = FakeDisplayBacking(displayID: displayID)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.valid ? [displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 2,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })

        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let foreignApp = LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.capture-isolation-test",
            name: "Foreign Editor",
            url: URL(fileURLWithPath: "/Applications/ForeignEditor.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let foreignDialog = WindowRef(
            windowID: 47,
            pid: identity.pid,
            title: "Session A dialog",
            frame: CGRect(x: -360, y: 350, width: 2000, height: 900))
        let discovery = DiscoveryState()
        let windowDriver = SessionWindowDriver(
            windows: { pid in
                discovery.recordLegacy()
                return pid == identity.pid ? [foreignDialog] : []
            },
            userDisplayBounds: { nil },
            move: { _, _ in },
            liveBounds: { id in id == foreignDialog.windowID ? foreignDialog.frame : nil },
            checkedWindows: { pid, budget, includeTitles in
                try discovery.check(includeTitles: includeTitles)
                guard pid == identity.pid else { return [] }
                try budget.consumeNode()
                return [foreignDialog]
            })
        let teardownDriver = SessionAppTeardownDriver(
            isAlive: { _ in false },
            quit: { _, _ in },
            waitForExit: { _, _ in [] },
            cleanupTemporaryProfile: { _ in })
        let captured = expectation(description: "before and after recording exclusions")
        captured.expectedFulfillmentCount = 2
        let frameCapture = RecordingFrameCapture { _, rect, foreign, scale in
            XCTAssertEqual(foreign.processIDs, [identity.pid])
            XCTAssertEqual(foreign.windows.map(\.windowID), [foreignDialog.windowID])
            XCTAssertEqual(try Capture.exclusionWindowIDs(capturedRect: rect,
                foreignContent: foreign, shareableWindows: [Capture.ShareableWindow(
                    windowID: foreignDialog.windowID, pid: foreignDialog.pid, frame: foreignDialog.frame)]),
                [foreignDialog.windowID])
            XCTAssertLessThan(scale, 1)
            captured.fulfill()
            let context = try XCTUnwrap(CGContext(data: nil, width: 16, height: 16,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            return try XCTUnwrap(context.makeImage())
        }
        let waitCaptured = expectation(description: "stability exclusions")
        let waitCapture = WaitFrameCapture { _, rect, foreign in
            XCTAssertEqual(foreign.processIDs, [identity.pid])
            XCTAssertEqual(foreign.windows.map(\.windowID), [foreignDialog.windowID])
            waitCaptured.fulfill()
            let context = try XCTUnwrap(CGContext(data: nil, width: Int(rect.width), height: Int(rect.height),
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            return try XCTUnwrap(context.makeImage())
        }
        let screenshotCaptured = expectation(description: "screenshot exclusions")
        let screenshotCapture = ScreenshotCapture(provider: { source in
            guard case .region(_, let rect, _, let scale, let foreign) = source else {
                throw SpaceOError.captureFailed("expected tile capture")
            }
            XCTAssertEqual(foreign.processIDs, [identity.pid])
            XCTAssertEqual(foreign.windows.map(\.windowID), [foreignDialog.windowID])
            screenshotCaptured.fulfill()
            let size = try Capture.validatedDimensions(width: rect.width, height: rect.height, scale: scale)
            let context = try XCTUnwrap(CGContext(data: nil, width: size.width, height: size.height,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            return ScreenshotCapture.Frame(image: try XCTUnwrap(context.makeImage()), geometry: ImageGeometry(
                origin: "tile", scale: scale, pixelWidth: size.width, pixelHeight: size.height,
                pointWidth: rect.width, pointHeight: rect.height, originX: rect.minX, originY: rect.minY))
        })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            recordingFrameCapture: frameCapture,
            waitFrameCapture: waitCapture,
            screenshotCapture: screenshotCapture,
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: teardownDriver,
                    windowDriver: windowDriver,
                    watcherFactory: { _, _ in throw WatcherUnavailable() },
                    initialApps: id == "session-a" ? [foreignApp] : [])
            })

        _ = try await manager.create(name: "session-a")
        let target = try await manager.create(name: "session-b")
        let legacyBeforeCapture = discovery.legacyCount
        let titlesBeforeCapture = discovery.titleCount
        let foreignContent = try await manager.foreignCaptureContent(for: target)
        XCTAssertEqual(discovery.legacyCount, legacyBeforeCapture)
        XCTAssertEqual(discovery.titleCount, titlesBeforeCapture, "capture discovery must not request titles")
        let targetTile = target.frame

        XCTAssertEqual(foreignContent.processIDs, [identity.pid])
        XCTAssertEqual(foreignContent.windows, [Capture.ForeignWindow(
            sessionID: "session-a",
            windowID: foreignDialog.windowID,
            pid: foreignDialog.pid,
            frame: foreignDialog.frame)])
        XCTAssertEqual(try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: [Capture.ShareableWindow(
                windowID: foreignDialog.windowID,
                pid: foreignDialog.pid,
                frame: foreignDialog.frame)]), [foreignDialog.windowID])

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: target.id, mode: .actionsAndFrames, rootDirectory: root)
        await manager.installIsolationRecording(recorder, session: target)
        var request = Request(cmd: "run")
        request.session = target.id
        request.app = "" // No app resolution or launch.
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "bad_request")
        await fulfillment(of: [captured], timeout: 1)
        XCTAssertEqual(recorder.actionCount, 1)

        var waitRequest = Request(cmd: "wait")
        waitRequest.session = target.id
        let stability = try await manager.probeNow(.stableMs(100), request: waitRequest)
        guard case .notYet(let probe) = stability else { return XCTFail("one frame cannot prove stability") }
        XCTAssertNotNil(probe?.frameHash)
        await fulfillment(of: [waitCaptured], timeout: 1)
        XCTAssertEqual(discovery.titleCount, titlesBeforeCapture)

        var screenshotRequest = Request(cmd: "screenshot")
        screenshotRequest.session = target.id
        screenshotRequest.full = true
        screenshotRequest.memory = true
        let screenshot = await manager.handle(screenshotRequest)
        XCTAssertTrue(screenshot.ok, screenshot.error ?? "")
        XCTAssertNotNil(screenshot.imageBase64)
        await fulfillment(of: [screenshotCaptured], timeout: 1)

        discovery.setFailure(true)
        do {
            _ = try await manager.foreignCaptureContent(for: target)
            XCTFail("incomplete foreign discovery must not return partial exclusions")
        } catch {
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .provider)
        }
        do {
            _ = try await manager.probeNow(.stableMs(100), request: waitRequest)
            XCTFail("stability must refuse incomplete foreign exclusions")
        } catch {
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .provider)
        }
        let failedScreenshot = await manager.handle(screenshotRequest)
        XCTAssertFalse(failedScreenshot.ok, "screenshot must refuse incomplete foreign exclusions")
        XCTAssertNil(failedScreenshot.imageBase64)
        let failedEvidence = await manager.handle(request)
        XCTAssertFalse(failedEvidence.ok)
        XCTAssertEqual(failedEvidence.errorCode, "bad_request", "optional evidence cannot replace the command outcome")
        XCTAssertTrue(failedEvidence.warnings?.contains { $0.contains("capture_unavailable") } == true)
        XCTAssertEqual(recorder.actionCount, 2)
        XCTAssertEqual(discovery.titleCount, titlesBeforeCapture, "recording exclusions must not request titles")
        discovery.setFailure(false)

        // This also drains the neighbours' lifecycle leases after failed exclusion discovery.
        _ = try? await manager.destroyAll(quitApps: true)
    }

    func testOverlappingWindowFromAnotherSessionIsPassedToTheCaptureFilter() throws {
        let targetTile = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let foreignDialog = CGRect(x: -360, y: 350, width: 2000, height: 900)
        let foreignPID: pid_t = 501
        let targetPID: pid_t = 502

        let foreignContent = Capture.ForeignContent(
            windows: [Capture.ForeignWindow(
                sessionID: "session-a",
                windowID: 41,
                pid: foreignPID,
                frame: foreignDialog)],
            processIDs: [foreignPID])
        let shareableWindows = [
            Capture.ShareableWindow(
                windowID: 41, pid: foreignPID, frame: foreignDialog),
            Capture.ShareableWindow(
                windowID: 42,
                pid: targetPID,
                frame: CGRect(x: 1320, y: 40, width: 900, height: 1200)),
        ]

        let exclusions = try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: shareableWindows)

        XCTAssertEqual(exclusions, [41],
                       "session B's tile filter must exclude session A's overlapping dialog")
        XCTAssertFalse(exclusions.contains(42),
                       "the target session's own window must remain in its capture")
    }

    func testNewForeignWindowBetweenRefreshAndCaptureIsAlsoExcluded() throws {
        let targetTile = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let foreignPID: pid_t = 501
        let foreignContent = Capture.ForeignContent(
            windows: [],
            processIDs: [foreignPID])

        let exclusions = try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: [Capture.ShareableWindow(
                windowID: 43,
                pid: foreignPID,
                frame: CGRect(x: 1200, y: 200, width: 500, height: 400))])

        XCTAssertEqual(exclusions, [43],
                       "the live foreign pid closes the AX-to-ScreenCaptureKit creation race")
    }

    func testKnownOverlappingWindowThatIsNotShareableFailsClosed() {
        let targetTile = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let foreignContent = Capture.ForeignContent(
            windows: [Capture.ForeignWindow(
                sessionID: "session-a",
                windowID: 44,
                pid: 501,
                frame: CGRect(x: 1200, y: 200, width: 500, height: 400))],
            processIDs: [501])

        XCTAssertThrowsError(try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: [])) { error in
            XCTAssertTrue(error.localizedDescription.contains("44"),
                          "the refusal should identify the unresolved foreign window: \(error)")
        }
    }

    func testRecycledWindowIDCannotSatisfyTheForeignIdentityCheck() {
        let targetTile = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let frame = CGRect(x: 1200, y: 200, width: 500, height: 400)
        let foreignContent = Capture.ForeignContent(
            windows: [Capture.ForeignWindow(
                sessionID: "session-a", windowID: 45, pid: 501, frame: frame)],
            processIDs: [501])

        XCTAssertThrowsError(try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: [Capture.ShareableWindow(
                windowID: 45, pid: 999, frame: frame)]))
    }

    func testMissingForeignWindowOutsideTheCaptureDoesNotBlockAnUnrelatedTile() throws {
        let targetTile = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let foreignContent = Capture.ForeignContent(
            windows: [Capture.ForeignWindow(
                sessionID: "session-a",
                windowID: 46,
                pid: 501,
                frame: CGRect(x: 100, y: 200, width: 500, height: 400))],
            processIDs: [501])

        XCTAssertEqual(try Capture.exclusionWindowIDs(
            capturedRect: targetTile,
            foreignContent: foreignContent,
            shareableWindows: []), [])
    }
}

private extension SessionManager {
    func installIsolationRecording(_ recorder: SessionRecorder, session: AgentSession) {
        recorders[session.id] = recorder
        session.setRecordingMode(recorder.mode.rawValue)
    }
}
