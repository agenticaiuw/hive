import AppKit
import CoreMedia
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

@MainActor
final class ViewerStreamLifecycleTests: XCTestCase {

    func testModelDeallocationStopsItsActiveCapture() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        var model: ViewerModel? = makeModel(engine: engine, displays: [display])
        weak var releasedModel: ViewerModel?
        releasedModel = model
        model?.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model!, .live)

        model = nil
        XCTAssertNil(releasedModel)
        try await waitUntil { session.stopCount == 1 }
    }

    func testCaptureCompletingAfterModelDeallocationIsStopped() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        var model: ViewerModel? = makeModel(engine: engine, displays: [display])
        weak var releasedModel: ViewerModel?
        releasedModel = model
        model?.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)

        model = nil
        XCTAssertNil(releasedModel, "startup must not keep its owner alive")
        // This provider deliberately completes despite cancellation, like a native callback.
        let session = try await engine.completeFirstStart()
        try await waitUntil { session.stopCount == 1 }
    }

    func testCaptureFollowsFirstAndLastFrameConsumer() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(engine: engine, displays: [display], hasSurface: false)
        model.selectedID = display.id
        XCTAssertEqual(model.streamState, .idle)
        let initialStarts = await engine.pendingCount
        XCTAssertEqual(initialStarts, 0)

        model.addFrameSink("console") { _ in }
        try await waitForPendingStarts(engine, count: 1)
        let first = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        let generation = model.streamGeneration
        model.addFrameSink("console") { _ in }
        model.addFrameSink("mini") { _ in }
        model.removeFrameSink("console")
        XCTAssertEqual(model.streamGeneration, generation)
        XCTAssertEqual(first.stopCount, 0, "Mini Monitor still needs the capture")

        model.removeFrameSink("mini")
        model.addFrameSink("replacement") { _ in }
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(first.stopCount, 0, "a same-update surface replacement keeps its stream")
        XCTAssertEqual(model.streamGeneration, generation)
        model.removeFrameSink("replacement")
        try await waitUntil { first.stopCount == 1 }
        XCTAssertEqual(model.streamState, .idle)
        XCTAssertEqual(model.selectedID, display.id)
        model.addFrameSink("reopened") { _ in }
        try await waitForPendingStarts(engine, count: 1)
        _ = try await engine.completeFirstStart()
        try await waitForState(model, .live)
    }

    func testConsumerRemovalDuringStartRetiresLateStream() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(engine: engine, displays: [display], hasSurface: false)
        model.selectedID = display.id
        model.addFrameSink("console") { _ in }
        try await waitForPendingStarts(engine, count: 1)
        model.removeFrameSink("console")
        let late = try await engine.completeFirstStart()
        try await waitUntil { late.stopCount == 1 }
        XCTAssertEqual(model.streamState, .idle)
        XCTAssertNil(model.lastSampleAt)
        model.onFrame = { _ in }
        try await waitForPendingStarts(engine, count: 1)
        let current = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.onFrame = nil
        try await waitUntil { current.stopCount == 1 }
        XCTAssertEqual(model.streamState, .idle)
    }

    func testPermissionDenialThenGrantAutomaticallyRetriesSelectedDisplay() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(
            engine: engine,
            displays: [display],
            permissions: PermissionState(screenRecording: false, accessibility: true)
        )

        XCTAssertEqual(model.streamState, .idle)
        model.selectedID = display.id

        guard case let .failed(message) = model.streamState else {
            return XCTFail("permission denial must be an explicit failed state")
        }
        XCTAssertTrue(message.contains("Screen Recording"))
        let deniedPendingCount = await engine.pendingCount
        XCTAssertEqual(deniedPendingCount, 0)

        model.applyDiscovery(
            displays: [display],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        XCTAssertEqual(model.streamState, .starting)
        try await waitForPendingStarts(engine, count: 1)
        _ = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        XCTAssertTrue(model.streamRunning)
    }

    func testTransientStopDisablesControlAndRetryReturnsToLive() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let firstSession = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)

        firstSession.fail(TestViewerStreamError("transient capture stop"))
        try await waitUntil { !model.streamState.isLive }

        guard case let .failed(message) = model.streamState else {
            return XCTFail("unexpected stop must move live to failed")
        }
        XCTAssertTrue(message.contains("transient capture stop"))
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.isWarning == true)

        model.retryStream()
        XCTAssertEqual(model.streamState, .starting)
        try await waitForPendingStarts(engine, count: 1)
        _ = try await engine.completeFirstStart()
        try await waitForState(model, .live)
    }

    func testStopReportedWhileStartingInvalidatesLaterSuccessfulCompletion() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        await engine.stopFirstPending(TestViewerStreamError("stopped during startup"))
        try await waitUntil {
            if case .failed = model.streamState { return true }
            return false
        }

        let staleSession = try await engine.completeFirstStart()
        try await waitUntil { staleSession.stopCount == 1 }
        guard case let .failed(message) = model.streamState else {
            return XCTFail("the stopped generation must remain failed")
        }
        XCTAssertTrue(message.contains("stopped during startup"))
    }

    func testFailedStartCanBeRetriedAndRefreshRestartsLiveStream() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        var snapshot = (
            displays: [display],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: snapshot.displays,
            initialPermissions: snapshot.permissions,
            streamEngine: engine,
            discoveryProvider: { snapshot },
            accessibilityAnnouncement: { _ in }
        )

        model.addFrameSink("fixture") { _ in }

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        await engine.failFirstStart(TestViewerStreamError("temporary start failure"))
        try await waitUntil {
            if case .failed = model.streamState { return true }
            return false
        }

        model.retryStream()
        try await waitForPendingStarts(engine, count: 1)
        let retrySession = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        let retryGeneration = model.streamGeneration

        // Refresh is a user command, not the periodic no-op poll: it always restarts.
        snapshot = (snapshot.displays, snapshot.permissions)
        model.refresh()
        XCTAssertEqual(model.streamState, .starting)
        XCTAssertGreaterThan(model.streamGeneration, retryGeneration)
        try await waitUntil { retrySession.stopCount == 1 }
        try await waitForPendingStarts(engine, count: 1)
        _ = try await engine.completeFirstStart()
        try await waitForState(model, .live)
    }

    func testReverseCompletionCannotReplaceNewerSelectionAndStaleFramesAreIgnored()
        async throws {
        let engine = FakeViewerStreamEngine()
        let first = makeDisplay(id: 7)
        let second = makeDisplay(id: 8, originX: 1_920)
        let model = makeModel(engine: engine, displays: [first, second])
        var acceptedFrames = 0
        model.onFrame = { _ in acceptedFrames += 1 }

        model.selectedID = first.id
        try await waitForPendingStarts(engine, count: 1)
        model.selectedID = second.id
        try await waitForPendingStarts(engine, count: 2)

        let secondSession = try await engine.completeStart(displayID: second.id)
        try await waitForState(model, .live)
        XCTAssertEqual(model.selectedID, second.id)
        XCTAssertEqual(model.input.display?.id, second.id)

        // The canceled first start ignores cancellation and completes after the second.
        let staleFirstSession = try await engine.completeStart(displayID: first.id)
        try await waitUntil { staleFirstSession.stopCount == 1 }
        XCTAssertEqual(model.streamState, .live)
        XCTAssertEqual(model.selectedID, second.id)

        staleFirstSession.emitFrame(makeSampleBuffer())
        secondSession.emitFrame(makeSampleBuffer())
        try await waitUntil { acceptedFrames == 1 }
        XCTAssertEqual(acceptedFrames, 1,
                       "only the current display generation may present frames")
    }

    /// AppKit refreshes `NSScreen.screens` behind `CGGetOnlineDisplayList`, so a freshly created
    /// stage is routinely renamed one poll after the Viewer already started streaming it. That
    /// rename must stay cosmetic: it changes no capture geometry, so it must neither restart the
    /// stream nor invalidate the frames the running capture is still producing.
    func testCosmeticRenameKeepsDeliveringFramesWithoutRestart() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7, name: "SpaceO stage 7")
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])
        var acceptedFrames = 0
        model.onFrame = { _ in acceptedFrames += 1 }

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        let liveGeneration = model.streamGeneration

        session.emitFrame(makeSampleBuffer())
        try await waitUntil { acceptedFrames == 1 }

        // Same id, same bounds — only the AppKit-derived label and the active flag move.
        model.applyDiscovery(
            displays: [makeDisplay(id: 7,
                                   isActive: false,
                                   name: "Stage — SpaceO Display")],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        XCTAssertEqual(model.streamGeneration, liveGeneration,
                       "a cosmetic rename must not restart the capture")
        XCTAssertEqual(model.streamState, .live)
        XCTAssertEqual(session.stopCount, 0)
        XCTAssertTrue(model.interactionEnabled)

        session.emitFrame(makeSampleBuffer())
        try await waitUntil { acceptedFrames == 2 }
        XCTAssertEqual(acceptedFrames, 2,
                       "frames from the still-current capture must survive a rename")
    }

    /// The mirror hazard: a renamed display must not swallow a genuine ScreenCaptureKit stop.
    /// Silently staying `.live` on a dead capture is what makes a frozen picture look current.
    func testCosmeticRenameStillSurfacesGenuineStreamStop() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7, name: "SpaceO stage 7")
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)

        model.applyDiscovery(
            displays: [makeDisplay(id: 7, name: "Stage — SpaceO Display")],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        session.fail(TestViewerStreamError("capture died after rename"))
        try await waitUntil { !model.streamState.isLive }

        guard case let .failed(message) = model.streamState else {
            return XCTFail("a stop after a rename must still reach the failed state")
        }
        XCTAssertTrue(message.contains("capture died after rename"))
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.isWarning == true)
    }

    /// If the rename lands inside the ScreenCaptureKit start window, the completion must still
    /// install the session. Dropping it stopped the brand-new stream and stranded the Viewer in
    /// "Starting secure display stream…" with no failure banner and no retry path.
    func testCosmeticRenameDuringStartStillCompletesToLive() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7, name: "SpaceO stage 7")
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        XCTAssertEqual(model.streamState, .starting)

        model.applyDiscovery(
            displays: [makeDisplay(id: 7, name: "Stage — SpaceO Display")],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        XCTAssertEqual(session.stopCount, 0,
                       "the completing start owns the current generation")
        XCTAssertTrue(model.streamRunning)
    }

    func testSelectedDisplayRemovalStopsStreamAndReturnsToIdle() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(
            engine: engine,
            displays: [display],
            sessions: [try makeSession(display: display)])
        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)

        model.applyDiscovery(
            displays: [],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        XCTAssertNil(model.selectedID)
        XCTAssertEqual(model.streamState, .idle)
        XCTAssertNil(model.input.display)
        XCTAssertFalse(model.interactionEnabled)
        try await waitUntil { session.stopCount == 1 }
    }

    func testSameIDGeometryChangeAtomicallyResetsInputAndRestartsStream() async throws {
        let engine = FakeViewerStreamEngine()
        let original = makeDisplay(id: 7, width: 1_920)
        let resized = makeDisplay(id: 7, width: 2_560)
        let model = makeModel(
            engine: engine,
            displays: [original],
            sessions: [try makeSession(display: original)])
        model.selectedID = original.id
        try await waitForPendingStarts(engine, count: 1)
        let firstSession = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)
        let originalGeneration = model.streamGeneration

        model.applyDiscovery(
            displays: [resized],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )

        XCTAssertEqual(model.streamState, .starting)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertFalse(model.input.interactionEnabled)
        XCTAssertEqual(model.input.display, resized)
        XCTAssertGreaterThan(model.streamGeneration, originalGeneration)
        try await waitUntil { firstSession.stopCount == 1 }
        try await waitForPendingStarts(engine, count: 1)
        _ = try await engine.completeFirstStart()
        try await waitForState(model, .live)

        let stableGeneration = model.streamGeneration
        let subpixelJitter = makeDisplay(id: 7, originX: 0.25, width: 2_560.25)
        model.applyDiscovery(
            displays: [subpixelJitter],
            permissions: PermissionState(screenRecording: true, accessibility: true)
        )
        XCTAssertEqual(model.streamGeneration, stableGeneration,
                       "sub-point discovery jitter is not a material geometry change")
        XCTAssertEqual(model.streamState, .live)
    }

    func testInputRecoveryWarningBecomesVisibleAndAnnounced() async throws {
        let engine = FakeViewerStreamEngine()
        var announcements: [String] = []
        let model = ViewerModel(
            automaticRefresh: false,
            streamEngine: engine,
            accessibilityAnnouncement: { announcements.append($0) }
        )
        let warning = InputNote(
            text: "the local input route could not be verified as restored",
            isWarning: true
        )

        model.input.onNote?(warning)
        try await waitUntil { model.note == warning }

        XCTAssertEqual(model.note, warning)
        XCTAssertTrue(announcements.last?.contains("Viewer input blocked") == true)
        XCTAssertTrue(announcements.last?.contains("could not be verified") == true)
    }

    func testSelectingSessionStartsTileScopedStreamAndInputGeometry() async throws {
        let engine = FakeViewerStreamEngine()
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 100, y: 50, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage 7"
        )
        let model = makeModel(engine: engine, displays: [display])
        let json = """
        {
          "id":"focused","displayID":7,"x":1060,"y":50,"width":960,"height":540,
          "tileIndex":1,"tileCapacity":4,"exclusiveDisplay":false,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          "createdAt":"2026-07-28T00:00:00Z","teardownPending":false,
          "runtimeAttached":true
        }
        """
        let session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))

        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))
        try await waitForPendingStarts(engine, count: 1)

        XCTAssertEqual(model.selectedSessionID, "focused")
        XCTAssertEqual(model.canvasMode, .session)
        let sourceRect = await engine.firstSourceRect()
        XCTAssertEqual(
            sourceRect,
            CGRect(x: 960, y: 0, width: 960, height: 540)
        )
        XCTAssertEqual(
            model.interactionDisplay?.bounds,
            CGRect(x: 1060, y: 50, width: 960, height: 540)
        )
    }

    /// SPAO-162. A tile that moves is the same display at the same size with a different crop.
    /// The running capture takes the new region in place; nothing stops, nothing restarts, and
    /// the input geometry follows so clicks keep landing on the pixels shown.
    func testTileMoveReCropsTheLiveStreamInsteadOfRestartingIt() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let before = try makeSession(
            id: "moving", display: display,
            frame: CGRect(x: 0, y: 0, width: 960, height: 540))
        let after = try makeSession(
            id: "moving", display: display,
            frame: CGRect(x: 960, y: 540, width: 960, height: 540))
        let model = makeModel(engine: engine, displays: [display])
        var acceptedFrames = 0
        model.onFrame = { _ in acceptedFrames += 1 }

        model.applyControlPlane(sessions: [before], poolResponse: Response(ok: true))
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)
        let liveGeneration = model.streamGeneration
        XCTAssertNil(model.tileMovedAt)

        model.applyControlPlane(sessions: [after], poolResponse: Response(ok: true))

        XCTAssertEqual(model.streamGeneration, liveGeneration,
                       "a crop-only change must not restart the capture")
        XCTAssertEqual(model.streamState, .live)
        XCTAssertEqual(session.stopCount, 0)
        let pendingStarts = await engine.pendingCount
        XCTAssertEqual(pendingStarts, 0, "no new start may be issued for a moved tile")
        try await waitUntil { session.cropUpdates.count == 1 }
        XCTAssertEqual(session.cropUpdates.first,
                       CGRect(x: 960, y: 540, width: 960, height: 540))
        XCTAssertEqual(model.interactionDisplay?.bounds,
                       CGRect(x: 960, y: 540, width: 960, height: 540))
        XCTAssertEqual(model.input.display?.bounds,
                       CGRect(x: 960, y: 540, width: 960, height: 540))
        XCTAssertTrue(model.interactionEnabled, "Control survives a tile move")
        XCTAssertTrue(model.input.interactionEnabled)
        XCTAssertNotNil(model.tileMovedAt)

        session.emitFrame(makeSampleBuffer())
        try await waitUntil { acceptedFrames == 1 }
    }

    /// A session that leaves the selected display is still the same capture of that display:
    /// the crop widens to the whole display in place. Only the display itself changing — see
    /// `testSameIDGeometryChangeAtomicallyResetsInputAndRestartsStream` — is an identity change.
    func testSessionLeavingTheSelectedDisplayWidensTheCropWithoutRestart() async throws {
        let engine = FakeViewerStreamEngine()
        let first = makeDisplay(id: 7)
        let second = makeDisplay(id: 8, originX: 1_920)
        let before = try makeSession(id: "hopping", display: first, frame: first.bounds)
        let after = try makeSession(id: "hopping", display: second, frame: second.bounds)
        let model = makeModel(engine: engine, displays: [first, second])

        model.applyControlPlane(sessions: [before], poolResponse: Response(ok: true))
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        let liveGeneration = model.streamGeneration

        model.applyControlPlane(sessions: [after], poolResponse: Response(ok: true))

        XCTAssertEqual(model.streamGeneration, liveGeneration)
        XCTAssertEqual(model.selectedID, first.id, "the display selection is the human's")
        try await waitUntil { session.cropUpdates.count == 1 }
        XCTAssertEqual(session.cropUpdates.first, CGRect?.none,
                       "nil means the whole selected display")
        XCTAssertEqual(session.stopCount, 0)
    }

    /// SPAO-161. Two console windows are two sinks on one stream. Registering the second must
    /// not unhook the first, and removing one leaves the other receiving.
    func testEverySurfaceSinkReceivesFramesAndRemovalIsIndependent() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(engine: engine, displays: [display])
        var first = 0
        var second = 0
        model.addFrameSink("window-1") { _ in first += 1 }
        model.addFrameSink("window-2") { _ in second += 1 }

        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)

        session.emitFrame(makeSampleBuffer())
        try await waitUntil { first == 1 && second == 1 }

        model.removeFrameSink("window-1")
        session.emitFrame(makeSampleBuffer())
        try await waitUntil { second == 2 }
        XCTAssertEqual(first, 1, "a closed window's sink is gone; the other keeps streaming")
    }

    func testRepeatedDaemonFailureDoesNotFloodEventHistory() {
        let model = ViewerModel(automaticRefresh: false)
        let error = TestViewerStreamError("daemon unavailable")

        model.applyControlPlaneFailure(error)
        model.applyControlPlaneFailure(error)
        model.applyControlPlaneFailure(error)

        XCTAssertEqual(model.connectivity, .degraded)
        XCTAssertEqual(model.events.count, 1)
        XCTAssertEqual(model.events.first?.title, "Connection interrupted")
    }

    func testTerminalDaemonDisconnectClearsLiveAuthority() throws {
        let model = ViewerModel(automaticRefresh: false)
        let json = """
        {
          "id":"stale","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          "createdAt":"2026-07-28T00:00:00Z","teardownPending":false,
          "runtimeAttached":true
        }
        """
        let session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        var pool = Response(ok: true)
        pool.displays = [DisplayPool.DisplayReport(
            displayID: 7,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            capacity: 1,
            used: 1,
            spaces: []
        )]
        model.applyControlPlane(sessions: [session], poolResponse: pool)
        XCTAssertEqual(model.sessions.count, 1)
        XCTAssertEqual(model.infrastructure.displays.count, 1)

        let start = Date(timeIntervalSinceReferenceDate: 100)
        model.applyControlPlaneFailure(
            TestViewerStreamError("daemon unavailable"),
            now: start
        )
        model.applyControlPlaneFailure(
            TestViewerStreamError("daemon unavailable"),
            now: start.addingTimeInterval(6)
        )

        XCTAssertEqual(model.connectivity, .disconnected)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertTrue(model.infrastructure.displays.isEmpty)
        XCTAssertNil(model.selectedSessionID)
    }

    // MARK: - Stream health

    /// A capture that stays "live" but delivers nothing must stop saying Live: the fake engine
    /// sends one frame and then goes silent.
    func testASilentLiveStreamIsReportedStalledWithItsAge() async throws {
        let engine = FakeViewerStreamEngine()
        let display = makeDisplay(id: 7)
        let model = makeModel(engine: engine, displays: [display],
                              sessions: [try makeSession(display: display)])
        var accepted = 0
        model.onFrame = { _ in accepted += 1 }
        model.selectedID = display.id
        try await waitForPendingStarts(engine, count: 1)
        let session = try await engine.completeFirstStart()
        try await waitForState(model, .live)
        let liveSince = try XCTUnwrap(model.liveSince)
        XCTAssertNil(model.lastSampleAt)
        XCTAssertEqual(model.streamHealth(now: liveSince.addingTimeInterval(1)).status, .live)
        XCTAssertEqual(model.streamHealth(now: liveSince.addingTimeInterval(3.5)).status,
                       .stalled(secondsSinceUpdate: 3),
                       "no sample at all since going live is a stall too")

        session.emitFrame(makeSampleBuffer())
        try await waitUntil { accepted == 1 }
        let sampled = try XCTUnwrap(model.lastSampleAt)
        let fresh = model.streamHealth(now: sampled.addingTimeInterval(0.5))
        XCTAssertEqual(fresh.status, .live)
        XCTAssertEqual(fresh.statusText, "Live")
        XCTAssertEqual(fresh.framesPerSecond, 0.5)

        // Silence.
        let stalled = model.streamHealth(now: sampled.addingTimeInterval(7.2))
        XCTAssertEqual(stalled.status, .stalled(secondsSinceUpdate: 7))
        XCTAssertEqual(stalled.statusText, "Stalled · last update 7s ago")
        XCTAssertTrue(stalled.isStalled)

        // A restart clears the bookkeeping for the new generation.
        model.retryStream()
        XCTAssertNil(model.lastSampleAt)
        XCTAssertNil(model.liveSince)
        XCTAssertEqual(model.streamHealth().status, .starting)
    }

    func testStreamHealthIsPureOverStateSamplesAndClock() {
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        XCTAssertEqual(ViewerStreamHealth.evaluate(
            state: .idle, lastSampleAt: nil, liveSince: nil, recentFrames: [], now: now).status, .idle)
        XCTAssertEqual(ViewerStreamHealth.evaluate(
            state: .failed("x"), lastSampleAt: now, liveSince: now, recentFrames: [], now: now).status,
            .failed)
        // A heartbeat (idle sample) counts as evidence even without new frames.
        let heartbeatOnly = ViewerStreamHealth.evaluate(
            state: .live, lastSampleAt: now.addingTimeInterval(-1),
            liveSince: now.addingTimeInterval(-60), recentFrames: [], now: now)
        XCTAssertEqual(heartbeatOnly.status, .live)
        XCTAssertEqual(heartbeatOnly.framesPerSecond, 0)
        XCTAssertTrue(heartbeatOnly.tooltip.contains("not changed"))
        let frames = (0..<60).map { now.addingTimeInterval(-Double($0) / 30) }
        let busy = ViewerStreamHealth.evaluate(
            state: .live, lastSampleAt: now, liveSince: now.addingTimeInterval(-60),
            recentFrames: frames, now: now)
        XCTAssertEqual(busy.tooltip, "Live · 30 fps")
        XCTAssertEqual(ViewerStreamHealth.evaluate(
            state: .live, lastSampleAt: now.addingTimeInterval(-2.9),
            liveSince: now.addingTimeInterval(-60), recentFrames: [], now: now).status, .live,
            "under the threshold is still live")
    }

    private func makeModel(
        engine: FakeViewerStreamEngine,
        displays: [DisplayEntry],
        sessions: [SessionInfo] = [],
        hasSurface: Bool = true,
        permissions: PermissionState = PermissionState(
            screenRecording: true,
            accessibility: true
        )
    ) -> ViewerModel {
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: displays,
            initialPermissions: permissions,
            initialSessions: sessions,
            streamEngine: engine,
            accessibilityAnnouncement: { _ in }
        )
        if hasSurface { model.addFrameSink("fixture") { _ in } }
        return model
    }

    private func makeDisplay(id: CGDirectDisplayID,
                             originX: CGFloat = 0,
                             width: CGFloat = 1_920,
                             isActive: Bool = true,
                             name: String? = nil) -> DisplayEntry {
        DisplayEntry(
            id: id,
            bounds: CGRect(x: originX, y: 0, width: width, height: 1_080),
            isSpaceO: true,
            isActive: isActive,
            name: name ?? "Stage \(id)"
        )
    }

    private func makeSession(id: String? = nil,
                             display: DisplayEntry,
                             frame: CGRect? = nil) throws -> SessionInfo {
        let frame = frame ?? display.bounds
        let json = """
        {
          "id": "\(id ?? "session-\(display.id)")", "displayID": \(display.id),
          "x": \(frame.minX), "y": \(frame.minY),
          "width": \(frame.width), "height": \(frame.height),
          "tileIndex": 0, "tileCapacity": 1,
          "exclusiveDisplay": true,
          "spaces": [], "hasOwnSpace": true,
          "apps": [], "windows": [],
          "createdAt": "2026-07-30T00:00:00Z",
          "teardownPending": false, "runtimeAttached": true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    private func waitForPendingStarts(_ engine: FakeViewerStreamEngine,
                                      count: Int,
                                      file: StaticString = #filePath,
                                      line: UInt = #line) async throws {
        try await waitUntil(file: file, line: line) {
            await engine.pendingCount == count
        }
    }

    private func waitForState(_ model: ViewerModel,
                              _ state: ViewerStreamState,
                              file: StaticString = #filePath,
                              line: UInt = #line) async throws {
        try await waitUntil(file: file, line: line) {
            model.streamState == state
        }
    }

    private func waitUntil(file: StaticString = #filePath,
                           line: UInt = #line,
                           _ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<1_000 {
            if await condition() { return }
            await Task.yield()
        }
        XCTFail("condition did not become true", file: file, line: line)
        throw TestViewerStreamError("timed out")
    }

    private func makeSampleBuffer() -> CMSampleBuffer {
        var sample: CMSampleBuffer?
        let status = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: nil,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: nil,
            sampleCount: 0,
            sampleTimingEntryCount: 0,
            sampleTimingArray: nil,
            sampleSizeEntryCount: 0,
            sampleSizeArray: nil,
            sampleBufferOut: &sample
        )
        XCTAssertEqual(status, noErr)
        return sample!
    }
}

private struct TestViewerStreamError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private final class FakeViewerStreamSession: ViewerDisplayStreamSession, @unchecked Sendable {
    private let lock = NSLock()
    private let onFrame: @Sendable (CMSampleBuffer) -> Void
    private let onStopped: @Sendable (Error?) -> Void
    private var storedStopCount = 0
    private var storedCropUpdates: [CGRect?] = []

    init(onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
         onStopped: @escaping @Sendable (Error?) -> Void) {
        self.onFrame = onFrame
        self.onStopped = onStopped
    }

    var stopCount: Int { lock.withLock { storedStopCount } }
    var cropUpdates: [CGRect?] { lock.withLock { storedCropUpdates } }

    func stop() async {
        lock.withLock { storedStopCount += 1 }
    }

    func updateCrop(_ sourceRect: CGRect?) async throws {
        lock.withLock { storedCropUpdates.append(sourceRect) }
    }

    func emitFrame(_ sample: CMSampleBuffer) {
        onFrame(sample)
    }

    func fail(_ error: Error?) {
        onStopped(error)
    }
}

private actor FakeViewerStreamEngine: ViewerDisplayStreaming {
    private struct PendingStart {
        let displayID: CGDirectDisplayID
        let sourceRect: CGRect?
        let onFrame: @Sendable (CMSampleBuffer) -> Void
        let onStopped: @Sendable (Error?) -> Void
        let continuation: CheckedContinuation<any ViewerDisplayStreamSession, Error>
    }

    private var pending: [PendingStart] = []

    var pendingCount: Int { pending.count }

    func firstSourceRect() -> CGRect? {
        pending.first?.sourceRect
    }

    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<any ViewerDisplayStreamSession, Error>) in
            pending.append(PendingStart(
                displayID: displayID,
                sourceRect: sourceRect,
                onFrame: onFrame,
                onStopped: onStopped,
                continuation: continuation
            ))
        }
    }

    func completeFirstStart() throws -> FakeViewerStreamSession {
        guard !pending.isEmpty else {
            throw TestViewerStreamError("no pending start")
        }
        return complete(at: 0)
    }

    func completeStart(displayID: CGDirectDisplayID) throws -> FakeViewerStreamSession {
        guard let index = pending.firstIndex(where: { $0.displayID == displayID }) else {
            throw TestViewerStreamError("no pending start for display \(displayID)")
        }
        return complete(at: index)
    }

    func failFirstStart(_ error: Error) {
        guard !pending.isEmpty else { return }
        let request = pending.removeFirst()
        request.continuation.resume(throwing: error)
    }

    func stopFirstPending(_ error: Error?) {
        pending.first?.onStopped(error)
    }

    private func complete(at index: Int) -> FakeViewerStreamSession {
        let request = pending.remove(at: index)
        let session = FakeViewerStreamSession(
            onFrame: request.onFrame,
            onStopped: request.onStopped
        )
        request.continuation.resume(returning: session)
        return session
    }
}
