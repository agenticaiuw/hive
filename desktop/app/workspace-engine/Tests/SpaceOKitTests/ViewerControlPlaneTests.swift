import CoreGraphics
import CoreMedia
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// The Viewer's own controls: the ones that used to lead somewhere the user could not come back
/// from, and the one that reported nothing at all.
@MainActor
final class ViewerControlPlaneTests: XCTestCase {

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Request] = []

        func append(_ request: Request) { lock.withLock { storage.append(request) } }
        var requests: [Request] { lock.withLock { storage } }
    }

    func testEmptyEventGapRefreshesTheControlPlane() async throws {
        let recorder = RequestRecorder()
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        var gap = Response(ok: true)
        gap.events = []
        gap.resyncRequired = true
        model.ingest(gap)
        try await waitUntil { recorder.requests.contains { $0.cmd == "pool" } }
        XCTAssertTrue(recorder.requests.contains { $0.cmd == "session.list" })
    }

    func testRetiredEventGenerationCannotIngestOrReconnect() {
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { _ in .success() }, accessibilityAnnouncement: { _ in })
        let old = model.prepareEventStream()
        var response = Response(ok: true)
        response.events = [DaemonEvent(seq: 1, at: Date(), kind: "old.event", session: nil, detail: [:])]
        old.mailbox.offer(response, schedule: {})
        old.mailbox.finish(schedule: {})
        let current = model.prepareEventStream()
        model.eventStreamReconnectAttempts = 3
        model.consumeEventStream(old.mailbox, generation: old.generation)
        model.scheduleEventStreamReconnect(generation: old.generation)
        XCTAssertTrue(model.eventStreamMailbox === current.mailbox)
        XCTAssertEqual(model.eventStreamGeneration, current.generation)
        XCTAssertEqual(model.eventStreamReconnectAttempts, 3)
        XCTAssertNil(model.eventStreamReconnectTask)
        XCTAssertFalse(model.events.contains { $0.title == "Old Event" })
        XCTAssertEqual(old.mailbox.pendingCount, 0)
        model.scheduleEventStreamReconnect(generation: current.generation)
        let reconnect = model.eventStreamReconnectTask
        XCTAssertNotNil(reconnect)
        _ = model.prepareEventStream()
        XCTAssertEqual(reconnect?.isCancelled, true)
        XCTAssertNil(model.eventStreamReconnectTask)
    }

    func testEventBatchRequestsOneRefreshAndKeepsItsGapWarningVisible() async throws {
        let recorder = RequestRecorder()
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        let stream = model.prepareEventStream()
        var response = Response(ok: true)
        response.events = (1...128).map { DaemonEvent(seq: UInt64($0), at: Date(), kind: "agent.action",
                                                    session: nil, detail: [:]) }
        response.resyncRequired = true
        stream.mailbox.offer(response, schedule: {})
        model.consumeEventStream(stream.mailbox, generation: stream.generation)
        XCTAssertEqual(model.events.first?.title, "Event history incomplete")
        try await waitUntil { recorder.requests.contains { $0.cmd == "pool" } }
        XCTAssertEqual(recorder.requests.filter { $0.cmd == "session.list" }.count, 1)
        XCTAssertEqual(model.events.filter(\.isAgentAction).count, ViewerModel.eventLimitPerClass)
        XCTAssertTrue(model.events.contains { $0.title == "Event history incomplete" })
    }

    func testAgentActionSpamCannotEvictPausesOrSessionChanges() {
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { _ in .success() }, accessibilityAnnouncement: { _ in })
        model.ingest(DaemonEvent(seq: 1, at: Date(), kind: "input.paused", session: "a",
                                 detail: ["byOperator": "true"]))
        model.ingest(DaemonEvent(seq: 2, at: Date(), kind: "session.destroyed", session: "b",
                                 detail: ["complete": "true"]))
        for index in 0..<500 {
            model.ingest(DaemonEvent(seq: UInt64(index + 3), at: Date(), kind: "agent.action",
                                     session: "a", detail: ["cmd": "click", "outcome": "confirmed"]))
        }
        XCTAssertEqual(model.events.filter(\.isAgentAction).count, ViewerModel.eventLimitPerClass)
        XCTAssertTrue(model.events.contains { $0.title == "Agent paused by you" })
        XCTAssertTrue(model.events.contains { $0.title == "Session ended" })
    }

    func testPollDeltaActionIsSkippedWhileTheEventStreamIsConnected() throws {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        var session = try Self.sessionInfo(id: "agent", displayID: 7,
                                           frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))
        session.lastAgentAction = "click"
        session.lastAgentActionAt = Date(timeIntervalSinceReferenceDate: 1_000)
        model.eventStreamConnected = true
        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))
        XCTAssertFalse(model.events.contains { $0.title == "Agent action" },
                       "the stream already listed it")
        XCTAssertEqual(model.agentActivity["agent"]?.count, 1, "the sparkline still counts it")

        session.lastAgentActionAt = Date(timeIntervalSinceReferenceDate: 2_000)
        model.eventStreamConnected = false
        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))
        XCTAssertTrue(model.events.contains { $0.title == "Agent action" && $0.isAgentAction },
                      "with the stream down the poll delta is the only source")
    }

    func testUnconfirmedOrRedactedVerdictCannotClearAnObservedBreach() {
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { _ in .success() }, accessibilityAnnouncement: { _ in })
        model.recordIsolationVerdict(sessionID: "test", breached: true)
        for verdict in [nil, "unknown", "partial", "unexpected"] as [String?] {
            let detail = verdict.map { ["verdict": $0] } ?? [:]
            model.ingest(DaemonEvent(seq: 1, at: Date(), kind: "isolation.verdict", session: "test", detail: detail))
            XCTAssertTrue(model.isolationBreaches.contains("test"))
        }
        model.ingest(DaemonEvent(seq: 2, at: Date(), kind: "isolation.verdict", session: "test",
                                detail: ["verdict": "intact"], redacted: true))
        XCTAssertTrue(model.isolationBreaches.contains("test"))
        model.ingest(DaemonEvent(seq: 3, at: Date(), kind: "isolation.verdict", session: "test",
                                detail: ["verdict": "intact"]))
        XCTAssertFalse(model.isolationBreaches.contains("test"))
    }

    func testBlockedHumanControlNeverEnablesInputOrPausesSessions() {
        let recorder = RequestRecorder()
        let model = ViewerModel(
            automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: false, accessibility: false),
            daemonTransport: { request in
                recorder.append(request)
                return .success()
            },
            accessibilityAnnouncement: { _ in })
        model.beginHumanControl()
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertFalse(model.input.interactionEnabled)
        XCTAssertTrue(model.note?.isWarning == true)
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    func testManualAgentResumeIsRefusedWhileHumanControlIsEnabled() throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        model.setInteractionEnabled(true)
        XCTAssertTrue(model.interactionEnabled)
        XCTAssertFalse(model.canChangeAgentPause)
        model.setSessionPaused("agent", paused: false)
        XCTAssertTrue(recorder.requests.isEmpty)
        XCTAssertTrue(model.note?.text.contains("Release Input") == true)
    }

    func testHumanControlWaitsForAnEarlierManualResume() async throws {
        let recorder = RequestRecorder()
        let releaseResume = DispatchSemaphore(value: 0)
        defer { releaseResume.signal() }
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in
                recorder.append(request)
                if request.cmd == "session.control", request.paused == false {
                    _ = releaseResume.wait(timeout: .now() + 3)
                }
                return .success()
            }, accessibilityAnnouncement: { _ in })
        model.setSessionPaused("agent", paused: false)
        try await waitUntil { recorder.requests.contains { $0.cmd == "session.control" } }
        XCTAssertFalse(model.canChangeAgentPause)
        model.beginHumanControl()
        model.setSessionPaused("agent", paused: true)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertEqual(recorder.requests.filter { $0.cmd == "session.control" }.count, 1)
        releaseResume.signal()
        try await waitUntil { model.canChangeAgentPause }
    }

    private final class DelayedPoll: @unchecked Sendable {
        private let lock = NSLock()
        let releaseFirstList = DispatchSemaphore(value: 0)
        private var listCalls = 0
        private var created = false
        private var storage: [Request] = []
        let session: SessionInfo

        init(session: SessionInfo) { self.session = session }
        var listCount: Int { lock.withLock { listCalls } }
        var requests: [Request] { lock.withLock { storage } }

        func send(_ request: Request) -> Response {
            let state = lock.withLock { () -> (firstList: Bool, created: Bool) in
                storage.append(request)
                if request.cmd == "session.create" { created = true }
                if request.cmd == "session.list" { listCalls += 1 }
                return (request.cmd == "session.list" && listCalls == 1, created)
            }
            // Snapshot first, then delay delivery to model a stale response already in transit.
            if state.firstList { _ = releaseFirstList.wait(timeout: .now() + 3) }
            var response = Response(ok: true)
            if request.cmd == "session.list" { response.sessions = state.created ? [session] : [] }
            if request.cmd == "session.create" {
                response.session = session
                response.controllerLeaseID = request.controllerLeaseID
            }
            return response
        }
    }

    func testSlowPollsCoalesceIntoOneFollowupInsteadOfAccumulating() async throws {
        let transport = DelayedPoll(session: try Self.sessionInfo(
            id: "viewer-session", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        defer { transport.releaseFirstList.signal() }
        let model = ViewerModel(automaticRefresh: false,
            daemonTransport: { transport.send($0) }, accessibilityAnnouncement: { _ in })
        model.refreshControlPlane()
        try await waitUntil { transport.listCount == 1 }
        for _ in 0..<100 { model.refreshControlPlane() }
        XCTAssertEqual(transport.listCount, 1)
        transport.releaseFirstList.signal()
        try await waitUntil { transport.requests.filter { $0.cmd == "pool" }.count == 2 }
        XCTAssertEqual(transport.listCount, 2)
        XCTAssertEqual(model.connectivity, .connected)
    }

    func testOldEmptyPollCannotDiscardNewlyCreatedSessionLease() async throws {
        let transport = DelayedPoll(session: try Self.sessionInfo(
            id: "viewer-session", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        defer { transport.releaseFirstList.signal() }
        let model = ViewerModel(automaticRefresh: false,
            daemonTransport: { transport.send($0) }, accessibilityAnnouncement: { _ in })
        model.refreshControlPlane()
        try await waitUntil { transport.listCount == 1 }
        model.createSession()
        try await waitUntil { model.events.contains { $0.title == "Session created" } }
        transport.releaseFirstList.signal()
        try await waitUntil { transport.requests.contains { $0.cmd == "session.heartbeat" } }
        try await waitUntil { model.sessions.map(\.id) == ["viewer-session"] }
        let create = try XCTUnwrap(transport.requests.first { $0.cmd == "session.create" })
        let heartbeat = try XCTUnwrap(transport.requests.first { $0.cmd == "session.heartbeat" })
        XCTAssertEqual(heartbeat.controllerLeaseID, create.controllerLeaseID)
        XCTAssertEqual(model.connectivity, .connected)
    }

    private final class DelayedPause: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Request] = []
        let releasePause = DispatchSemaphore(value: 0)
        var requests: [Request] { lock.withLock { storage } }
        func send(_ request: Request) -> Response {
            lock.withLock { storage.append(request) }
            if request.cmd == "session.control", request.paused == true {
                _ = releasePause.wait(timeout: .now() + 3)
            }
            return .success()
        }
    }

    func testReleaseAndRetakeCannotRaceAnEarlierPauseResponse() async throws {
        let transport = DelayedPause()
        defer { transport.releasePause.signal() }
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        var announcements: [String] = []
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { transport.send($0) }, accessibilityAnnouncement: { announcements.append($0) })
        model.beginHumanControl()
        try await waitUntil { transport.requests.contains { $0.paused == true } }
        model.endHumanControl()
        model.beginHumanControl()
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.text.contains("Finishing") == true)
        transport.releasePause.signal()
        try await waitUntil { transport.requests.contains { $0.paused == false } }
        XCTAssertEqual(transport.requests.filter { $0.paused == true }.count, 1)
        XCTAssertFalse(announcements.contains { $0.hasPrefix("Control enabled") })
    }

    func testPermissionLossWhilePauseIsInFlightCannotEnableControlLater() async throws {
        let transport = DelayedPause()
        defer { transport.releasePause.signal() }
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        var announcements: [String] = []
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { transport.send($0) }, accessibilityAnnouncement: { announcements.append($0) })
        model.beginHumanControl()
        try await waitUntil { transport.requests.contains { $0.paused == true } }
        model.applyDiscovery(displays: [display],
            permissions: PermissionState(screenRecording: true, accessibility: false))
        transport.releasePause.signal()
        try await waitUntil { transport.requests.contains { $0.paused == false } }
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertFalse(announcements.contains { $0.hasPrefix("Control enabled") })
    }

    func testDisconnectAttemptsOwnedPausesAndReportsUnconfirmedResume() async throws {
        let recorder = RequestRecorder()
        let releasePoll = DispatchSemaphore(value: 0)
        defer { releasePoll.signal() }
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in
                recorder.append(request)
                if request.cmd == "session.control", request.paused == false {
                    return .failure(SpaceOError.badRequest("daemon temporarily unavailable"))
                }
                var response = Response(ok: true)
                if request.cmd == "session.list" {
                    _ = releasePoll.wait(timeout: .now() + 4)
                    response.sessions = [session]
                }
                return response
            }, accessibilityAnnouncement: { _ in })
        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        // Hold the background refresh so it cannot change the takeover state during the outage.
        try await waitUntil { recorder.requests.contains { $0.cmd == "session.list" } }
        let start = Date(timeIntervalSinceReferenceDate: 100)
        let failure = SpaceOError.badRequest("transport timed out")
        model.applyControlPlaneFailure(failure, now: start)
        model.applyControlPlaneFailure(failure, now: start.addingTimeInterval(6))
        XCTAssertFalse(model.interactionEnabled)
        try await waitUntil { model.events.contains { $0.title == "Agent resume failed" } }
        XCTAssertEqual(recorder.requests.filter { $0.cmd == "session.control" && $0.paused == false }.map(\.session), ["agent"])
        XCTAssertTrue(model.note?.text.contains("agent") == true)
        XCTAssertFalse(model.events.contains { $0.title == "Human control released" })
    }

    func testFailedTakeoverReportsRollbackFailureAndAffectedSession() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 200, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let first = try Self.sessionInfo(id: "agent-a", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let second = try Self.sessionInfo(id: "agent-b", displayID: 7,
            frame: CGRect(x: 100, y: 0, width: 100, height: 100))
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [first, second], initialStreamRunning: true,
            daemonTransport: { request in
                recorder.append(request)
                if request.session == "agent-b" {
                    return .failure(SpaceOError.badRequest("takeover refused"))
                }
                if request.paused == false {
                    return .failure(SpaceOError.badRequest("resume refused"))
                }
                return .success()
            }, accessibilityAnnouncement: { _ in })
        model.beginHumanControl()
        try await waitUntil { model.events.contains { $0.title == "Control unavailable" } }
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.text.contains("takeover refused") == true)
        XCTAssertTrue(model.note?.text.contains("agent-a") == true)
        XCTAssertTrue(model.note?.text.contains("resume refused") == true)
        XCTAssertTrue(model.note?.text.contains("Resume") == true)
        XCTAssertEqual(recorder.requests.filter { $0.cmd == "session.control" }.count, 3)
    }

    // MARK: - Hand back with a note (SPAO-219)

    func testReleasingControlHoldsTheResumeUntilTheNoteIsSentAndCarriesIt() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        model.endHumanControl()

        XCTAssertFalse(model.interactionEnabled)
        XCTAssertEqual(model.pendingHandoff?.sessionIDs, ["agent"])
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(recorder.requests.filter { $0.paused == false }.count, 0,
                       "the resume waits for the sheet")

        model.beginHumanControl()
        XCTAssertFalse(model.interactionEnabled, "retaking Control waits for the hand-back")
        XCTAssertTrue(model.note?.text.contains("hand-back") == true)

        model.completeHandoff(note: "  Dismissed the login dialog and signed in.  ")
        XCTAssertNil(model.pendingHandoff)
        try await waitUntil { recorder.requests.contains { $0.paused == false } }
        let resume = try XCTUnwrap(recorder.requests.first { $0.paused == false })
        XCTAssertEqual(resume.cmd, "session.control")
        XCTAssertEqual(resume.session, "agent")
        XCTAssertEqual(resume.operatorScope, true)
        XCTAssertEqual(resume.handoffNote, "Dismissed the login dialog and signed in.")

        let pause = try XCTUnwrap(recorder.requests.first { $0.paused == true })
        XCTAssertNil(pause.handoffNote, "only the release carries a note")
    }

    func testSkippingTheNoteResumesWithoutOne() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        model.endHumanControl()
        model.completeHandoff(note: "   ")
        try await waitUntil { recorder.requests.contains { $0.paused == false } }
        let resume = try XCTUnwrap(recorder.requests.first { $0.paused == false })
        XCTAssertNil(resume.handoffNote)
        XCTAssertEqual(resume.operatorScope, true)
        try await waitUntil { model.events.contains { $0.title == "Human control released" } }
    }

    func testForcedReleaseResumesImmediatelyWithoutASheet() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        // Accessibility revoked under Control: nobody is there to write a note.
        model.applyDiscovery(displays: [display],
            permissions: PermissionState(screenRecording: true, accessibility: false))
        XCTAssertNil(model.pendingHandoff)
        try await waitUntil { recorder.requests.contains { $0.paused == false } }
    }

    // MARK: - Scope switching

    func testScopeSwitchingSurvivesSelectingADisplay() async throws {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900),
            isSpaceO: true,
            isActive: true,
            name: "SpaceO Display")
        let session = try Self.sessionInfo(
            id: "agent-1",
            displayID: display.id,
            frame: CGRect(x: 0, y: 0, width: 1_440, height: 900))

        let response: Response = {
            var value = Response(ok: true)
            value.sessions = [session]
            return value
        }()
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            daemonTransport: { _ in response },
            accessibilityAnnouncement: { _ in })

        model.refreshControlPlane()
        try await waitUntil { !model.sessions.isEmpty }

        model.selectSession(session.id)
        XCTAssertTrue(model.canSwitchCanvasMode)

        // Selecting a display clears the session selection. Gating the scope control on a
        // *selected* session therefore disabled the only control that could switch back, and
        // the "pick the first session on this display" fallback became unreachable.
        model.selectDisplay(display.id)
        XCTAssertNil(model.selectedSession)
        XCTAssertTrue(model.canSwitchCanvasMode,
                      "the display hosts a session, so Session scope is still reachable")

        model.setCanvasMode(.session)
        XCTAssertEqual(model.selectedSession?.id, session.id)
    }

    func testScopeSwitchingIsUnavailableWithoutASessionToSwitchTo() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        XCTAssertFalse(model.canSwitchCanvasMode,
                       "with nothing selected there is no scope to switch between")
    }

    func testSessionModeSelectsASessionThatAppearsAfterAnEmptyPoll() throws {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900),
            isSpaceO: true,
            isActive: true,
            name: "SpaceO Display")
        let session = try Self.sessionInfo(
            id: "agent-1",
            displayID: display.id,
            frame: display.bounds)
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            accessibilityAnnouncement: { _ in })

        model.applyControlPlane(sessions: [], poolResponse: Response(ok: true))
        XCTAssertNil(model.selectedSession)

        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))

        XCTAssertEqual(model.selectedSession?.id, session.id)
        XCTAssertEqual(model.canvasMode, .session)
    }

    func testSessionModeFallsForwardWhenTheSelectedSessionEnds() throws {
        let firstDisplay = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900),
            isSpaceO: true,
            isActive: true,
            name: "SpaceO Display 1")
        let secondDisplay = DisplayEntry(
            id: 8,
            bounds: CGRect(x: 1_440, y: 0, width: 1_440, height: 900),
            isSpaceO: true,
            isActive: true,
            name: "SpaceO Display 2")
        let first = try Self.sessionInfo(
            id: "agent-1", displayID: firstDisplay.id, frame: firstDisplay.bounds)
        let second = try Self.sessionInfo(
            id: "agent-2", displayID: secondDisplay.id, frame: secondDisplay.bounds)
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [firstDisplay, secondDisplay],
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            accessibilityAnnouncement: { _ in })

        model.applyControlPlane(sessions: [first, second], poolResponse: Response(ok: true))
        model.selectSession(first.id)
        model.applyControlPlane(sessions: [second], poolResponse: Response(ok: true))

        XCTAssertEqual(model.selectedSession?.id, second.id)
        XCTAssertEqual(model.selectedID, secondDisplay.id)
        XCTAssertEqual(model.canvasMode, .session)
    }

    func testDisplayModeDoesNotAutoSelectANewSession() throws {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900),
            isSpaceO: true,
            isActive: true,
            name: "SpaceO Display")
        let session = try Self.sessionInfo(
            id: "agent-1", displayID: display.id, frame: display.bounds)
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            accessibilityAnnouncement: { _ in })
        model.selectDisplay(display.id)

        model.applyControlPlane(sessions: [session], poolResponse: Response(ok: true))

        XCTAssertNil(model.selectedSession)
        XCTAssertEqual(model.canvasMode, .display)
    }

    // MARK: - Screenshot feedback

    func testScreenshotOutcomesCarryAUserVisibleMessage() {
        let url = URL(fileURLWithPath: "/tmp/spaceo-test.png")
        let saved = ViewerScreenshotResult.saved(url)
        XCTAssertFalse(saved.isFailure)
        XCTAssertTrue(saved.message.contains(url.path),
                      "a saved screenshot has to name the file the user is looking for")

        let failed = ViewerScreenshotResult.failed("display is not shareable")
        XCTAssertTrue(failed.isFailure)
        XCTAssertTrue(failed.message.contains("display is not shareable"))
    }

    func testScreenshotResultIsDismissible() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        XCTAssertNil(model.screenshotResult,
                     "nothing to report before a screenshot is taken")
        model.clearScreenshotResult()
        XCTAssertNil(model.screenshotResult)
    }

    func testDaemonPermissionFailuresAppearInViewerHealth() {
        let model = ViewerModel(
            automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            accessibilityAnnouncement: { _ in })
        var response = Response(ok: true)
        response.daemon = DaemonRuntimeInfo(
            version: "1.0.0",
            executableSHA256: nil,
            executableBuildUUID: nil,
            pid: 42,
            instanceID: UUID(),
            startedAt: Date(),
            accessibilityGranted: false,
            screenRecordingGranted: false,
            canDrive: false,
            canCapture: false)

        model.applyControlPlane(sessions: [], poolResponse: response)

        XCTAssertTrue(model.healthAlerts.contains { $0.id == "daemon-accessibility" })
        XCTAssertTrue(model.healthAlerts.contains { $0.id == "daemon-screen-recording" })
    }

    func testConfiguredDensityDoesNotComeFromAnExistingDisplaysFrozenCapacity() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        var response = Response(ok: true)
        response.displays = [DisplayPool.DisplayReport(
            displayID: 7,
            x: 0,
            y: 0,
            width: 1_920,
            height: 1_080,
            capacity: 1,
            used: 1,
            spaces: []
        )]
        response.sessionsPerDisplay = 4

        model.applyControlPlane(sessions: [], poolResponse: response)

        XCTAssertEqual(model.infrastructure.displays.first?.capacity, 1,
                       "existing displays must keep their original layout")
        XCTAssertEqual(model.infrastructure.configuredDensity, 4,
                       "the control must show what a newly created display will use")
    }

    func testOlderDaemonDensityFallsBackToExistingDisplayCapacity() {
        let snapshot = ViewerInfrastructureSnapshot(displays: [DisplayPool.DisplayReport(
            displayID: 7,
            x: 0,
            y: 0,
            width: 1_920,
            height: 1_080,
            capacity: 3,
            used: 1,
            spaces: []
        )])

        XCTAssertEqual(snapshot.configuredDensity, 3)
    }

    func testViewerPauseAndResumeUseOperatorScopedSessionControl() async throws {
        let recorder = RequestRecorder()
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                recorder.append(request)
                return .success()
            },
            accessibilityAnnouncement: { _ in })

        model.setSessionPaused("agent-7", paused: true)
        try await waitUntil { model.canChangeAgentPause }
        model.setSessionPaused("agent-7", paused: false)
        try await waitUntil {
            recorder.requests.filter { $0.cmd == "session.control" }.count >= 2
        }

        let requests = recorder.requests.filter { $0.cmd == "session.control" }
        XCTAssertTrue(requests.allSatisfy { $0.session == "agent-7" })
        XCTAssertTrue(requests.allSatisfy { $0.operatorScope == true })
        XCTAssertEqual(Set(requests.compactMap(\.paused)), [true, false])
    }

    func testViewerDestroyTargetsOneSessionWithoutStoppingDaemon() async throws {
        let recorder = RequestRecorder()
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                recorder.append(request)
                return .success("destroyed")
            },
            accessibilityAnnouncement: { _ in })

        model.destroySession("runaway")
        try await waitUntil { recorder.requests.contains { $0.cmd == "session.destroy" } }
        let request = try XCTUnwrap(recorder.requests.first { $0.cmd == "session.destroy" })
        XCTAssertEqual(request.session, "runaway")
        XCTAssertEqual(request.operatorScope, true)
        XCTAssertNotEqual(request.cmd, "daemon.stop")
    }

    func testViewerHeartbeatsSessionsItCreates() async throws {
        let recorder = RequestRecorder()
        let session = try Self.sessionInfo(
            id: "viewer-session",
            displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 1_440, height: 900))
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                recorder.append(request)
                switch request.cmd {
                case "session.create":
                    var response = Response(ok: true)
                    response.session = session
                    response.controllerLeaseID = request.controllerLeaseID
                    return response
                case "session.list":
                    var response = Response(ok: true)
                    response.sessions = [session]
                    return response
                default:
                    return .success()
                }
            },
            accessibilityAnnouncement: { _ in })

        model.createSession()
        try await waitUntil {
            recorder.requests.contains { $0.cmd == "session.heartbeat" }
        }

        let create = try XCTUnwrap(recorder.requests.first { $0.cmd == "session.create" })
        let heartbeat = try XCTUnwrap(
            recorder.requests.first { $0.cmd == "session.heartbeat" })
        XCTAssertEqual(heartbeat.session, session.id)
        XCTAssertEqual(heartbeat.controllerLeaseID, create.controllerLeaseID)
    }

    /// A heartbeat the daemon refuses is that session's lease problem, not a daemon outage:
    /// the same poll just received a healthy `session.list`. The Viewer must drop the lease
    /// and stay connected instead of reporting the daemon disconnected and emptying the
    /// navigator on every poll.
    func testRefusedHeartbeatDropsTheLeaseWithoutDisconnecting() async throws {
        let recorder = RequestRecorder()
        let session = try Self.sessionInfo(
            id: "viewer-session",
            displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 1_440, height: 900))
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                recorder.append(request)
                switch request.cmd {
                case "session.create":
                    var response = Response(ok: true)
                    response.session = session
                    response.controllerLeaseID = request.controllerLeaseID
                    return response
                case "session.list":
                    var response = Response(ok: true)
                    response.sessions = [session]
                    return response
                case "session.heartbeat":
                    return .failure(SpaceOError.badRequest(
                        "controller lease does not match session 'viewer-session'"))
                default:
                    return .success()
                }
            },
            accessibilityAnnouncement: { _ in })

        model.createSession()
        try await waitUntil {
            recorder.requests.contains { $0.cmd == "session.heartbeat" }
        }
        try await waitUntil { model.connectivity == .connected }
        XCTAssertEqual(model.sessions.map(\.id), ["viewer-session"])
        XCTAssertTrue(
            model.events.contains { $0.title.contains("lease") },
            "the refused lease must be reported once")

        // The next poll no longer carries the refused lease. `pool` is the last request of a
        // poll, so a second one proves the second poll is past its heartbeat stage.
        model.refreshControlPlane()
        try await waitUntil {
            recorder.requests.filter { $0.cmd == "pool" }.count >= 2
        }
        XCTAssertEqual(
            recorder.requests.filter { $0.cmd == "session.heartbeat" }.count, 1)
        XCTAssertEqual(model.connectivity, .connected)
        XCTAssertEqual(model.sessions.map(\.id), ["viewer-session"])
    }

    // MARK: - Take Control of an agent that paused itself

    /// "needs 2FA code": the agent paused itself. Take Control has to place an operator pause
    /// over it (or the agent could lift its own pause mid-typing), and releasing has to go
    /// through the hand-back sheet and resume it with the note.
    func testTakingControlOfASelfPausedAgentHoldsItAndHandsBackWithTheNote() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        var session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        session.inputPaused = true
        session.agentPauseReason = "needs 2FA"
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        let pause = try XCTUnwrap(recorder.requests.first { $0.paused == true })
        XCTAssertEqual(pause.session, "agent")
        XCTAssertEqual(pause.operatorScope, true,
                       "an operator pause, which the agent cannot lift while the person types")

        model.endHumanControl()
        XCTAssertEqual(model.pendingHandoff?.sessionIDs, ["agent"], "the hand-back sheet appears")
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(recorder.requests.contains { $0.paused == false },
                       "nothing resumes before the note")

        model.completeHandoff(note: "Entered the 2FA code.")
        try await waitUntil { recorder.requests.contains { $0.paused == false } }
        let resume = try XCTUnwrap(recorder.requests.first { $0.paused == false })
        XCTAssertEqual(resume.session, "agent")
        XCTAssertEqual(resume.handoffNote, "Entered the 2FA code.")
        XCTAssertEqual(resume.operatorScope, true)
    }

    func testControlLeavesAHandPlacedOperatorPauseAlone() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        var session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        session.inputPaused = true   // paused by the operator: no reason
        XCTAssertFalse(ViewerControlPolicy.pausesForControl(session))
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        model.beginHumanControl()
        XCTAssertTrue(model.interactionEnabled)
        model.endHumanControl()
        XCTAssertNil(model.pendingHandoff)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertFalse(recorder.requests.contains { $0.cmd == "session.control" },
                       "Control did not place that pause and must not lift it")
    }

    func testForcedReleaseKeepsASelfPausedAgentWaitingButResumesTheOthers() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 200, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        var asking = try Self.sessionInfo(id: "asking", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        asking.inputPaused = true
        asking.agentPauseReason = "needs 2FA"
        let running = try Self.sessionInfo(id: "running", displayID: 7,
            frame: CGRect(x: 100, y: 0, width: 100, height: 100))
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [asking, running], initialStreamRunning: true,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
        XCTAssertEqual(Set(recorder.requests.filter { $0.paused == true }.compactMap(\.session)),
                       ["asking", "running"])

        // Accessibility revoked: a forced release, nobody there to write a note.
        model.applyDiscovery(displays: [display],
            permissions: PermissionState(screenRecording: true, accessibility: false))
        try await waitUntil { recorder.requests.contains { $0.paused == false } }
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(recorder.requests.filter { $0.paused == false }.compactMap(\.session),
                       ["running"])
        XCTAssertTrue(model.events.contains {
            $0.title == "Still waiting for you" && $0.sessionID == "asking"
        })
    }

    // MARK: - Help requests

    func testResumeAllSkipsAgentsWaitingForAPersonAndSaysSo() async throws {
        let recorder = RequestRecorder()
        var handPaused = try Self.sessionInfo(id: "a", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        handPaused.inputPaused = true
        var asking = try Self.sessionInfo(id: "b", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        asking.inputPaused = true
        asking.agentPauseReason = "needs a CAPTCHA solved"
        let running = try Self.sessionInfo(id: "c", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let model = ViewerModel(automaticRefresh: false,
            initialSessions: [handPaused, asking, running],
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        let plan = model.resumeAllPlan
        XCTAssertEqual(plan.resumable, ["a"])
        XCTAssertEqual(plan.waiting, 1)
        XCTAssertEqual(plan.title, "Resume 1 Agent · 1 waiting for you")

        model.setAllSessionsPaused(false)
        try await waitUntil { model.events.contains { $0.title == "All agents resumed" } }
        XCTAssertEqual(recorder.requests.filter { $0.cmd == "session.control" }.compactMap(\.session),
                       ["a"])

        XCTAssertEqual(ViewerAttention.resumeAllPlan([asking]).title,
                       "Resume All Agents · 1 waiting for you")
        XCTAssertTrue(ViewerAttention.resumeAllPlan([asking]).isEmpty)
    }

    func testHelpRequestsSetTheDockBadgeAndAreAnnouncedOnce() throws {
        var badges: [String?] = []
        var announcements: [String] = []
        let model = ViewerModel(automaticRefresh: false,
            accessibilityAnnouncement: { announcements.append($0) },
            dockBadge: { badges.append($0) })
        var asking = try Self.sessionInfo(id: "b", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        asking.title = "Checkout"
        asking.inputPaused = true
        asking.agentPauseReason = "needs 2FA code"
        let running = try Self.sessionInfo(id: "c", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))

        model.applyControlPlane(sessions: [running], poolResponse: Response(ok: true))
        model.applyControlPlane(sessions: [running, asking], poolResponse: Response(ok: true))
        model.applyControlPlane(sessions: [running, asking], poolResponse: Response(ok: true))
        XCTAssertEqual(badges, ["1"], "set once, not on every poll")
        XCTAssertEqual(announcements.filter { $0 == "Checkout needs you: needs 2FA code" }.count, 1)
        XCTAssertEqual(model.events.filter { $0.title == "Agent needs you" }.count, 1)
        XCTAssertEqual(model.statusAggregate.needsHuman, 1)

        asking.inputPaused = false
        asking.agentPauseReason = nil
        model.applyControlPlane(sessions: [running, asking], poolResponse: Response(ok: true))
        XCTAssertEqual(badges, ["1", nil])
    }

    // MARK: - Destructive actions ask first

    func testCleanUpAndDestroyGoThroughTheSameConfirmation() async throws {
        XCTAssertTrue(ViewerHealthAction.reclaimSession("x").requiresConfirmation)
        XCTAssertTrue(ViewerHealthAction.destroySession("x").requiresConfirmation)
        XCTAssertFalse(ViewerHealthAction.retryStream.requiresConfirmation)
        XCTAssertFalse(ViewerHealthAction.resumeSession("x").requiresConfirmation)
        XCTAssertTrue(ViewerHealthAction.reclaimSession("x").confirmationMessage.contains("quit"))

        let recorder = RequestRecorder()
        var detached = try Self.sessionInfo(id: "old", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        detached.runtimeAttached = false
        detached.reclaimable = true
        let model = ViewerModel(automaticRefresh: false,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [detached],
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })
        let alert = try XCTUnwrap(model.healthAlerts.first { $0.id == "recovery-old" })
        XCTAssertEqual(alert.actionTitle, "Clean Up…")

        model.request(try XCTUnwrap(alert.action))
        XCTAssertEqual(model.pendingConfirmation, .reclaimSession("old"))
        XCTAssertEqual(model.confirmationTitle(for: .reclaimSession("old")), "Clean up old?")
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(recorder.requests.isEmpty, "one click no longer quits anything")

        model.cancelPendingAction()
        XCTAssertNil(model.pendingConfirmation)
        model.request(.reclaimSession("old"))
        model.confirmPendingAction()
        try await waitUntil { recorder.requests.contains { $0.cmd == "session.destroy" } }
        XCTAssertEqual(recorder.requests.first { $0.cmd == "session.destroy" }?.session, "old")
    }

    // MARK: - Where keys go

    func testKeyDestinationNamesTheFrontWindowAndWarnsForAForeignApp() async throws {
        let recorder = RequestRecorder()
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        var session = try Self.sessionInfo(id: "agent", displayID: 7, frame: display.bounds)
        session.apps = [try Wire.decoder.decode(AppInfo.self, from: Data(
            #"{"pid":100,"name":"Safari","startedByUs":true}"#.utf8))]
        var requestedBounds: [CGRect] = []
        var announcements: [String] = []
        let engine = GatedStreamEngine()
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session],
            streamEngine: engine,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { announcements.append($0) },
            frontWindowProvider: { bounds in
                requestedBounds.append(bounds)
                return WindowRef(windowID: 41, pid: 100, title: "Sign in",
                                 frame: CGRect(x: 0, y: 0, width: 80, height: 80))
            },
            appNameProvider: { $0 == 555 ? "SecurityAgent" : nil })
        model.addFrameSink("fixture") { _ in }
        model.selectSession("agent")
        try await waitUntil { engine.pendingCount >= 1 }
        engine.completeAll()
        try await waitUntil { model.streamRunning }
        XCTAssertNil(model.keyDestination, "no destination without Control")

        model.setInteractionEnabled(true)
        XCTAssertEqual(requestedBounds.last, display.bounds)
        let destination = try XCTUnwrap(model.keyDestination)
        XCTAssertEqual(destination.title, "Safari — Sign in")
        XCTAssertEqual(destination.bannerText, "Keys → Safari — Sign in")
        XCTAssertTrue(destination.isSessionApp)

        model.keyTargetChanged(WindowRef(windowID: 9, pid: 555, title: "Unlock",
                                         frame: CGRect(x: 0, y: 0, width: 10, height: 10)))
        XCTAssertEqual(model.keyDestination?.title, "SecurityAgent — Unlock")
        XCTAssertEqual(model.keyDestination?.isSessionApp, false)
        XCTAssertTrue(model.keyDestination?.bannerText.contains("not this session's app") == true)
        XCTAssertTrue(model.note?.isWarning == true)
        XCTAssertTrue(announcements.contains { $0.contains("not one of this session's apps") })

        model.setInteractionEnabled(false)
        XCTAssertNil(model.keyDestination)
    }

    // MARK: - Take Control from anywhere

    func testTakeControlOfAnotherSessionSelectsItAndBeginsOnceItsStreamIsLive() async throws {
        let engine = GatedStreamEngine()
        let recorder = RequestRecorder()
        let (display, first, second) = try twoSessionsOnOneDisplay()
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [first, second],
            streamEngine: engine,
            daemonTransport: { request in
                recorder.append(request)
                // The refresh after the pause must keep both sessions listed.
                var response = Response(ok: true)
                if request.cmd == "session.list" { response.sessions = [first, second] }
                return response
            },
            accessibilityAnnouncement: { _ in })
        model.addFrameSink("fixture") { _ in }
        model.selectSession("a")
        try await waitUntil { engine.pendingCount >= 1 }
        engine.completeAll()
        try await waitUntil { model.streamRunning }

        model.takeControl(for: "b")
        XCTAssertEqual(model.selectedSessionID, "b")
        XCTAssertEqual(model.pendingControlSessionID, "b")
        XCTAssertFalse(model.interactionEnabled, "no Control before b's stream is up")
        XCTAssertFalse(recorder.requests.contains { $0.cmd == "session.control" })

        try await waitUntil { engine.pendingCount >= 1 }
        engine.completeAll()
        try await waitUntil { model.interactionEnabled }
        XCTAssertNil(model.pendingControlSessionID)
        XCTAssertEqual(model.selectedSessionID, "b")
        // The ordinary Control path: every session reachable on the display is paused.
        XCTAssertTrue(recorder.requests.contains { $0.paused == true && $0.session == "b" })
    }

    func testPendingTakeControlIsCancelledBySelectingSomethingElseAndExpires() async throws {
        let engine = GatedStreamEngine()
        let recorder = RequestRecorder()
        let (display, first, second) = try twoSessionsOnOneDisplay()
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [first, second],
            streamEngine: engine,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.addFrameSink("fixture") { _ in }
        model.takeControl(for: "b")
        XCTAssertEqual(model.pendingControlSessionID, "b")
        model.selectSession("a")
        XCTAssertNil(model.pendingControlSessionID, "a selection change cancels it")
        try await waitUntil { engine.pendingCount >= 1 }
        engine.completeAll()
        try await waitUntil { model.streamRunning }
        XCTAssertFalse(model.interactionEnabled)

        // Requested long ago: by the time the stream is up it no longer applies.
        model.takeControl(for: "b", now: Date().addingTimeInterval(-60))
        try await waitUntil { engine.pendingCount >= 1 }
        engine.completeAll()
        try await waitUntil { model.streamRunning }
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertNil(model.pendingControlSessionID)
        XCTAssertFalse(recorder.requests.contains { $0.cmd == "session.control" })
    }

    // MARK: - Notification clicks

    func testNotificationActionSelectsTheSessionAndRequestsAWindow() throws {
        let (display, first, second) = try twoSessionsOnOneDisplay()
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [first, second],
            streamEngine: GatedStreamEngine(),
            daemonTransport: { _ in .success() },
            accessibilityAnnouncement: { _ in })
        XCTAssertFalse(model.windowRequested)

        model.handleNotificationAction(session: "b", section: .health)
        XCTAssertEqual(model.selectedSessionID, "b")
        XCTAssertEqual(model.canvasMode, .session)
        XCTAssertEqual(model.inspectorSection, .health)
        XCTAssertTrue(model.inspectorVisible)
        XCTAssertTrue(model.windowRequested)
        XCTAssertNil(model.pendingControlSessionID, "a plain click does not take Control")

        model.acknowledgeWindowRequest()
        XCTAssertFalse(model.windowRequested)

        model.handleNotificationAction(ViewerNotificationAction(
            sessionID: "a", section: .overview, notificationClass: .agentNeedsHuman,
            takeControl: true))
        XCTAssertEqual(model.selectedSessionID, "a")
        XCTAssertEqual(model.pendingControlSessionID, "a",
                       "the notification's Take Control button deep-links into Control")
        XCTAssertTrue(model.windowRequested)
    }

    // MARK: - Reconnects and the daemon banner

    func testSelectionSurvivesADaemonOutage() throws {
        let (display, first, second) = try twoSessionsOnOneDisplay()
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            streamEngine: GatedStreamEngine(),
            accessibilityAnnouncement: { _ in })
        model.applyControlPlane(sessions: [first, second], poolResponse: Response(ok: true))
        model.selectSession("b")

        let start = Date(timeIntervalSinceReferenceDate: 100)
        let failure = SpaceOError.badRequest("transport timed out")
        model.applyControlPlaneFailure(failure, now: start)
        model.applyControlPlaneFailure(failure, now: start.addingTimeInterval(6))
        XCTAssertEqual(model.connectivity, .disconnected)
        XCTAssertNil(model.selectedSessionID)
        XCTAssertEqual(model.workspaceBanners.map(\.kind), [.offline])

        model.applyControlPlane(sessions: [first, second], poolResponse: Response(ok: true))
        XCTAssertEqual(model.selectedSessionID, "b",
                       "the person's choice comes back, not the first session on the display")
    }

    func testADifferentDaemonInstanceRaisesTheRestartBanner() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        func pool(_ instance: UUID) -> Response {
            var response = Response(ok: true)
            response.daemon = DaemonRuntimeInfo(
                version: SpaceOVersion.current, executableSHA256: nil, pid: 1,
                instanceID: instance, startedAt: Date())
            return response
        }
        let first = UUID()
        model.applyControlPlane(sessions: [], poolResponse: pool(first))
        model.applyControlPlane(sessions: [], poolResponse: pool(first))
        XCTAssertTrue(model.workspaceBanners.isEmpty)
        model.applyControlPlane(sessions: [], poolResponse: pool(UUID()))
        XCTAssertEqual(model.workspaceBanners.map(\.text),
                       ["The daemon restarted; earlier sessions ended."])
        model.dismissDaemonRestartBanner()
        XCTAssertTrue(model.workspaceBanners.isEmpty)
    }

    func testSelectedSessionEndingIsAnnounced() throws {
        var announcements: [String] = []
        let (display, first, second) = try twoSessionsOnOneDisplay()
        var titled = second
        titled.title = "Checkout"
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            streamEngine: GatedStreamEngine(),
            accessibilityAnnouncement: { announcements.append($0) })
        model.applyControlPlane(sessions: [first, titled], poolResponse: Response(ok: true))
        model.selectSession("b")
        model.applyControlPlane(sessions: [first], poolResponse: Response(ok: true))
        XCTAssertEqual(model.selectedSessionID, "a")
        XCTAssertTrue(announcements.contains("Checkout ended. Now showing a."))
    }

    // MARK: - Keyboard navigation

    func testSessionMenuNavigationFollowsTheNavigator() throws {
        let (display, first, second) = try twoSessionsOnOneDisplay()
        var asking = try Self.sessionInfo(id: "c", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        asking.inputPaused = true
        asking.agentPauseReason = "needs approval"
        let model = ViewerModel(automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            streamEngine: GatedStreamEngine(),
            accessibilityAnnouncement: { _ in })
        model.applyControlPlane(sessions: [first, second, asking], poolResponse: Response(ok: true))
        XCTAssertEqual(model.navigationOrder, ["c", "a", "b"], "the waiting agent sorts first")

        model.selectSession("a")
        model.selectAdjacentSession(1)
        XCTAssertEqual(model.selectedSessionID, "b")
        model.selectAdjacentSession(1)
        XCTAssertEqual(model.selectedSessionID, "c", "wraps")
        model.selectAdjacentSession(-1)
        XCTAssertEqual(model.selectedSessionID, "b")
        model.selectSession(atShortcut: 2)
        XCTAssertEqual(model.selectedSessionID, "a")
        model.selectSession(atShortcut: 9)
        XCTAssertEqual(model.selectedSessionID, "a", "past the end does nothing")
        model.goToSessionNeedingAttention()
        XCTAssertEqual(model.selectedSessionID, "c")
    }

    // MARK: - Helpers

    private func twoSessionsOnOneDisplay() throws -> (DisplayEntry, SessionInfo, SessionInfo) {
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 200, height: 100),
            isSpaceO: true, isActive: true, name: "Test display")
        let first = try Self.sessionInfo(id: "a", displayID: 7,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let second = try Self.sessionInfo(id: "b", displayID: 7,
            frame: CGRect(x: 100, y: 0, width: 100, height: 100))
        return (display, first, second)
    }

    /// Starts wait until the test releases them, so "before the stream is live" is a state the
    /// test can observe. Superseded starts are still released; the model drops stale ones.
    private final class GatedStreamEngine: ViewerDisplayStreaming, @unchecked Sendable {
        private final class Session: ViewerDisplayStreamSession, @unchecked Sendable {
            func stop() async {}
            func updateCrop(_ sourceRect: CGRect?) async throws {}
        }

        private let lock = NSLock()
        private var waiting: [CheckedContinuation<any ViewerDisplayStreamSession, Error>] = []

        var pendingCount: Int { lock.withLock { waiting.count } }

        func start(
            displayID: CGDirectDisplayID, pointSize: CGSize, sourceRect: CGRect?,
            onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
            onStopped: @escaping @Sendable (Error?) -> Void
        ) async throws -> any ViewerDisplayStreamSession {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock { waiting.append(continuation) }
            }
        }

        func completeAll() {
            let released = lock.withLock { () -> [CheckedContinuation<any ViewerDisplayStreamSession, Error>] in
                defer { waiting.removeAll() }
                return waiting
            }
            released.forEach { $0.resume(returning: Session()) }
        }
    }

    /// `SessionInfo` only has initialisers from live runtime objects, so build one through the
    /// wire format the Viewer actually receives.
    private static func sessionInfo(
        id: String,
        displayID: CGDirectDisplayID,
        frame: CGRect
    ) throws -> SessionInfo {
        let json = """
        {
          "id": "\(id)",
          "displayID": \(displayID),
          "x": \(frame.minX), "y": \(frame.minY),
          "width": \(frame.width), "height": \(frame.height),
          "tileIndex": 0, "tileCapacity": 1,
          "exclusiveDisplay": true,
          "spaces": [], "hasOwnSpace": true,
          "apps": [], "windows": [],
          "createdAt": "2026-07-30T00:00:00Z",
          "teardownPending": false,
          "runtimeAttached": true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    private func waitUntil(
        timeout: TimeInterval = 2,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("condition was not met within \(timeout)s")
    }
}

/// The Events inspector reads daemon events as sentences, with a severity that follows what
/// happened, instead of raw `key=value` pairs that all looked like warnings.
final class ViewerEventFormatterTests: XCTestCase {

    private func event(_ kind: String, _ detail: [String: String], redacted: Bool? = nil) -> DaemonEvent {
        DaemonEvent(seq: 1, at: Date(), kind: kind, session: "s", detail: detail, redacted: redacted)
    }

    func testVerdictSeverityFollowsTheVerdict() {
        let intact = ViewerEventFormatter.format(event("isolation.verdict", ["verdict": "intact"]))
        XCTAssertEqual(intact.severity, .info)
        XCTAssertEqual(intact.title, "Isolation intact")
        let breached = ViewerEventFormatter.format(event("isolation.verdict",
            ["verdict": "breached", "action": "click", "failures": "frontmost app changed"]))
        XCTAssertEqual(breached.severity, .critical)
        XCTAssertEqual(breached.detail, "After the agent's click. frontmost app changed")
        let partial = ViewerEventFormatter.format(event("isolation.verdict", ["verdict": "partial"]))
        XCTAssertEqual(partial.severity, .warning)
        XCTAssertTrue(partial.detail.contains("not a pass"))
    }

    func testAgentActionsReadAsSentencesAndAreMarkedAsActions() {
        let click = ViewerEventFormatter.format(event("agent.action",
            ["cmd": "click", "outcome": "confirmed", "target": "Sign in", "x": "10", "y": "20"]))
        XCTAssertEqual(click.title, "Agent click")
        XCTAssertEqual(click.detail, "Click “Sign in” · confirmed")
        XCTAssertTrue(click.isAgentAction)
        XCTAssertEqual(click.severity, .info)
        let typed = ViewerEventFormatter.format(event("agent.action",
            ["cmd": "type", "outcome": "refused", "characters": "12"]))
        XCTAssertEqual(typed.detail, "Typed 12 characters · refused")
        XCTAssertEqual(typed.severity, .warning)
        let key = ViewerEventFormatter.format(event("agent.action",
            ["cmd": "key", "outcome": "unconfirmed", "action": "cmd+l"]))
        XCTAssertEqual(key.detail, "Pressed cmd+l · unconfirmed")
        let scroll = ViewerEventFormatter.format(event("agent.action",
            ["cmd": "scroll", "outcome": "confirmed", "x": "5", "y": "6"]))
        XCTAssertEqual(scroll.detail, "Scroll at 5, 6 · confirmed")
    }

    func testPausesSessionsAppsAndUnknownKinds() {
        XCTAssertEqual(ViewerEventFormatter.format(event("input.paused", ["byOperator": "true"])).title,
                       "Agent paused by you")
        let asking = ViewerEventFormatter.format(event("input.paused",
            ["byOperator": "false", "reason": "needs 2FA"]))
        XCTAssertEqual(asking.title, "Agent needs you")
        XCTAssertEqual(asking.detail, "needs 2FA")
        XCTAssertTrue(ViewerEventFormatter.format(event("input.resumed", ["handoffNote": "present"]))
            .detail.contains("hand-back note"))
        XCTAssertEqual(ViewerEventFormatter.format(event("app.launched",
            ["app": "Safari", "pid": "42", "ok": "true"])).detail, "Safari (pid 42)")
        XCTAssertEqual(ViewerEventFormatter.format(event("app.launched",
            ["app": "Safari", "ok": "false"])).severity, .warning)
        XCTAssertEqual(ViewerEventFormatter.format(event("app.exited", ["names": "Preview,Safari"])).detail,
                       "Preview, Safari is no longer running.")
        let unknown = ViewerEventFormatter.format(event("window.reparked", ["windowID": "9", "reason": "drift"]))
        XCTAssertEqual(unknown.title, "Window Reparked")
        XCTAssertEqual(unknown.detail, "reason: drift · window ID: 9")
        let hidden = ViewerEventFormatter.format(event("agent.action", ["cmd": "click"], redacted: true))
        XCTAssertTrue(hidden.detail.contains("hidden"))
        XCTAssertTrue(hidden.isAgentAction)
    }

    func testThisSessionFilterKeepsDaemonWideEvents() {
        let events = [
            ViewerEvent(timestamp: Date(), severity: .info, title: "mine", detail: "", sessionID: "a"),
            ViewerEvent(timestamp: Date(), severity: .info, title: "other", detail: "", sessionID: "b"),
            ViewerEvent(timestamp: Date(), severity: .info, title: "daemon", detail: "", sessionID: nil),
        ]
        XCTAssertEqual(ViewerEventFilter.apply(.selectedSession, to: events, selectedSessionID: "a")
            .map(\.title), ["mine", "daemon"])
        XCTAssertEqual(ViewerEventFilter.apply(.all, to: events, selectedSessionID: "a").count, 3)
        XCTAssertEqual(ViewerEventFilter.apply(.selectedSession, to: events, selectedSessionID: nil).count, 3)
    }
}
