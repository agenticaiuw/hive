import AppKit
import CoreGraphics
import CoreMedia
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-160. Copy out of, drop into, and paste into an agent's session — each an explicit user
/// action, each brokered by the daemon. The general pasteboard is never touched here: the model's
/// pasteboard seams are recorders.
@MainActor
final class ViewerClipboardTests: XCTestCase {

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Request] = []
        func append(_ request: Request) { lock.withLock { storage.append(request) } }
        var requests: [Request] { lock.withLock { storage } }
    }

    private final class PasteboardRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var writtenValues: [String] = []
        var readValue: String?
        func write(_ value: String) { lock.withLock { writtenValues.append(value) } }
        var written: [String] { lock.withLock { writtenValues } }
    }

    private func session(id: String = "agent", apps: [String] = []) throws -> SessionInfo {
        let appsJSON = apps.enumerated().map {
            "{\"pid\":\($0.offset + 100),\"name\":\"\($0.element)\",\"startedByUs\":true}"
        }.joined(separator: ",")
        let json = """
        {
          "id":"\(id)","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":true,"apps":[\(appsJSON)],"windows":[],
          "createdAt":"2026-07-30T00:00:00Z","teardownPending":false,"runtimeAttached":true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    /// Selecting a session restarts the stream, so these tests use an engine that comes up at
    /// once; Control needs a live stream and nothing here touches ScreenCaptureKit.
    private final class ImmediateStreamSession: ViewerDisplayStreamSession, @unchecked Sendable {
        func stop() async {}
        func updateCrop(_ sourceRect: CGRect?) async throws {}
    }

    private final class ImmediateStreamEngine: ViewerDisplayStreaming, @unchecked Sendable {
        func start(
            displayID: CGDirectDisplayID, pointSize: CGSize, sourceRect: CGRect?,
            onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
            onStopped: @escaping @Sendable (Error?) -> Void
        ) async throws -> any ViewerDisplayStreamSession {
            ImmediateStreamSession()
        }
    }

    private func makeModel(
        session: SessionInfo,
        recorder: RequestRecorder,
        pasteboard: PasteboardRecorder,
        respond: @escaping @Sendable (Request) -> Response = { _ in .success() }
    ) -> ViewerModel {
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
                                   isSpaceO: true, isActive: true, name: "Stage")
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialSessions: [session],
            streamEngine: ImmediateStreamEngine(),
            daemonTransport: { request in
                recorder.append(request)
                // The poll that follows a mutation must keep the session in the inventory;
                // an empty list would deselect it and release Control.
                if request.cmd == "session.list" {
                    var response = Response(ok: true)
                    response.sessions = [session]
                    return response
                }
                return respond(request)
            },
            accessibilityAnnouncement: { _ in },
            pasteboardWriter: { pasteboard.write($0) },
            pasteboardReader: { pasteboard.readValue })
        model.addFrameSink("fixture") { _ in }
        model.selectSession(session.id)
        return model
    }

    private func takeControl(_ model: ViewerModel) async throws {
        try await waitUntil { model.streamRunning }
        model.beginHumanControl()
        try await waitUntil { model.interactionEnabled }
    }

    // MARK: - Copy from Session

    func testCopyFromSessionReadsTheBrokerAndWritesThePasteboardOnce() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard) {
            var response = Response(ok: true)
            if $0.cmd == "clipboard.get" { response.value = "error: ECONNREFUSED" }
            return response
        }

        model.copyFromSession()
        try await waitUntil { pasteboard.written == ["error: ECONNREFUSED"] }

        let get = try XCTUnwrap(recorder.requests.first { $0.cmd == "clipboard.get" })
        XCTAssertEqual(get.session, "agent")
        XCTAssertEqual(get.operatorScope, true)
        XCTAssertTrue(model.events.contains { $0.title == "Copied from session" })
    }

    func testCopyWithoutASelectionSendsNothingAndWritesNothing() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in },
            pasteboardWriter: { pasteboard.write($0) },
            pasteboardReader: { pasteboard.readValue })
        model.copyFromSession()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(recorder.requests.isEmpty)
        XCTAssertTrue(pasteboard.written.isEmpty)
        XCTAssertTrue(model.note?.isWarning == true)
    }

    func testEmptySessionClipboardNeverWritesThePasteboard() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        model.copyFromSession()
        try await waitUntil { model.note?.text.contains("empty") == true }
        XCTAssertTrue(pasteboard.written.isEmpty)
    }

    // MARK: - Drop to open

    func testDroppedFilesAskFirstThenRunTheChosenAppWithThePaths() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(apps: ["Preview", "Safari"]),
                              recorder: recorder, pasteboard: pasteboard)
        let files = [URL(fileURLWithPath: "/tmp/notes.txt"), URL(fileURLWithPath: "/tmp/spec.pdf")]

        model.requestOpenFiles(files + [URL(string: "https://example.com")!])
        let drop = try XCTUnwrap(model.pendingFileDrop)
        XCTAssertEqual(drop.defaultApp, "Preview", "defaults to the session's first app")
        XCTAssertEqual(drop.files, files, "only file URLs are offered")
        XCTAssertTrue(recorder.requests.isEmpty, "nothing is sent before the person confirms")

        model.confirmOpenFiles(drop, app: "TextEdit")
        XCTAssertNil(model.pendingFileDrop)
        try await waitUntil { recorder.requests.contains { $0.cmd == "run" } }
        let run = try XCTUnwrap(recorder.requests.first { $0.cmd == "run" })
        XCTAssertEqual(run.session, "agent")
        XCTAssertEqual(run.app, "TextEdit")
        XCTAssertEqual(run.files, ["/tmp/notes.txt", "/tmp/spec.pdf"])
        XCTAssertEqual(run.operatorScope, true)
    }

    func testDropWithNoAppsDefaultsToTextEditAndCancelSendsNothing() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        model.requestOpenFiles([URL(fileURLWithPath: "/tmp/a.txt")])
        XCTAssertEqual(model.pendingFileDrop?.defaultApp, "TextEdit")
        model.cancelOpenFiles()
        XCTAssertNil(model.pendingFileDrop)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    // MARK: - ⌘V while Control is active

    func testBrokeredPasteAsksInlineOnceThenRestoresTheBrokerAfterPressingCommandV() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        pasteboard.readValue = "hunter2-one-time-code"
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard) {
            var response = Response(ok: true)
            if $0.cmd == "clipboard.get" { response.value = "agent's own copy" }
            return response
        }
        try await takeControl(model)
        let before = recorder.requests.count

        // First ⌘V: an inline prompt on the canvas, no sheet, nothing sent.
        XCTAssertTrue(model.requestBrokeredPaste())
        let pending = try XCTUnwrap(model.pendingPasteConfirmation)
        XCTAssertEqual(pending.sessionID, "agent")
        XCTAssertTrue(pending.prompt.contains("Press ⌘V again to paste into agent"))
        XCTAssertTrue(pending.prompt.contains("not kept"))
        XCTAssertNil(model.activeSheet, "the confirmation is not a sheet")
        XCTAssertTrue(model.interactionEnabled)
        XCTAssertEqual(recorder.requests.count, before, "nothing is sent before the confirmation")

        // Second ⌘V is the answer.
        XCTAssertTrue(model.requestBrokeredPaste())
        XCTAssertNil(model.pendingPasteConfirmation)
        let brokeredCommands = ["clipboard.get", "clipboard.set", "key"]
        try await waitUntil {
            recorder.requests.filter { brokeredCommands.contains($0.cmd) }.count == 4
        }
        let brokered = recorder.requests.filter { brokeredCommands.contains($0.cmd) }
        XCTAssertEqual(brokered.map(\.cmd), ["clipboard.get", "clipboard.set", "key", "clipboard.set"])
        XCTAssertTrue(brokered.allSatisfy { $0.session == "agent" && $0.operatorScope == true })
        XCTAssertEqual(brokered[1].text, "hunter2-one-time-code")
        XCTAssertEqual(brokered[2].key, "cmd+v")
        XCTAssertEqual(brokered[3].text, "agent's own copy",
                       "the broker gets back what it held; the pasted secret is not left behind")
        try await waitUntil { model.note?.text.contains("not kept") == true }

        // Later pastes into the same session: no prompt, straight through, still restored.
        pasteboard.readValue = "second"
        XCTAssertTrue(model.requestBrokeredPaste())
        XCTAssertNil(model.pendingPasteConfirmation)
        try await waitUntil {
            recorder.requests.filter { $0.cmd == "clipboard.set" }.map(\.text) == [
                "hunter2-one-time-code", "agent's own copy", "second", "agent's own copy",
            ]
        }
    }

    func testAnEmptyBrokerIsRestoredToEmptyAndAFailedKeyStillRestores() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        pasteboard.readValue = "secret"
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard) {
            // clipboard.get on an empty broker: ok, no value.
            if $0.cmd == "key" { return .failure(SpaceOError.badRequest("no focused element")) }
            return Response(ok: true)
        }
        try await takeControl(model)
        model.pasteConfirmedSessions.insert("agent")
        XCTAssertTrue(model.requestBrokeredPaste())
        try await waitUntil { model.events.contains { $0.title == "Paste failed" } }
        let sets = recorder.requests.filter { $0.cmd == "clipboard.set" }.map(\.text)
        XCTAssertEqual(sets, ["secret", ""], "restored to empty even though the key press failed")
        XCTAssertTrue(model.note?.text.contains("no focused element") == true)
    }

    func testAPasteIsNotStagedWhenTheBrokerCannotBeReadFirst() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        pasteboard.readValue = "secret"
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard) {
            if $0.cmd == "clipboard.get" { return .failure(SpaceOError.badRequest("unreadable")) }
            return Response(ok: true)
        }
        try await takeControl(model)
        model.pasteConfirmedSessions.insert("agent")
        XCTAssertTrue(model.requestBrokeredPaste())
        try await waitUntil { model.events.contains { $0.title == "Paste failed" } }
        XCTAssertFalse(recorder.requests.contains { $0.cmd == "clipboard.set" || $0.cmd == "key" })
    }

    func testAFailedRestoreIsReportedAsTextLeftInTheBroker() {
        let calls = RequestRecorder()
        let outcome = ViewerModel.brokeredPaste(text: "secret", sessionID: "agent") { request in
            calls.append(request)
            if request.cmd == "clipboard.set", request.text == "" {
                return .failure(SpaceOError.badRequest("daemon went away"))
            }
            return Response(ok: true)
        }
        guard case let .pastedButNotRestored(error) = outcome else {
            return XCTFail("expected pastedButNotRestored, got \(outcome)")
        }
        XCTAssertTrue(error.localizedDescription.contains("daemon went away"))
        XCTAssertEqual(calls.requests.map(\.cmd), ["clipboard.get", "clipboard.set", "key", "clipboard.set"])
    }

    func testInlinePasteConfirmationExpiresAndIsClearedWhenControlEnds() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        pasteboard.readValue = "text"
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        try await takeControl(model)
        let start = Date()
        XCTAssertTrue(model.requestBrokeredPaste(now: start))
        let first = try XCTUnwrap(model.pendingPasteConfirmation)
        // A second ⌘V after the prompt lapsed is a new request, not a confirmation.
        XCTAssertTrue(model.requestBrokeredPaste(
            now: start.addingTimeInterval(ViewerModel.pasteConfirmationLifetime + 1)))
        XCTAssertNotEqual(model.pendingPasteConfirmation?.id, first.id)
        XCTAssertFalse(recorder.requests.contains { $0.cmd == "clipboard.set" })

        model.endHumanControl()
        XCTAssertNil(model.pendingPasteConfirmation)
    }

    func testTheWindowLosingKeyDoesNotEndControlWhileThePastePromptIsUp() async throws {
        XCTAssertTrue(ViewerControlPolicy.releasesOnResignKey(pendingPrompt: false))
        XCTAssertFalse(ViewerControlPolicy.releasesOnResignKey(pendingPrompt: true))

        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        pasteboard.readValue = "text"
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        try await takeControl(model)
        XCTAssertTrue(model.requestBrokeredPaste())
        model.surfaceResignedKey()
        XCTAssertTrue(model.interactionEnabled, "the Viewer's own prompt is not leaving")

        model.cancelBrokeredPaste()
        model.surfaceResignedKey()
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertNotNil(model.pendingHandoff, "an ordinary resign-key release still hands back")
    }

    func testBrokeredPasteIsRefusedWithoutControl() throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        XCTAssertFalse(model.requestBrokeredPaste())
        XCTAssertNil(model.pendingPasteConfirmation)
    }

    func testTheModelInstallsTheInterceptForExactlyCommandV() async throws {
        let recorder = RequestRecorder()
        let pasteboard = PasteboardRecorder()
        let model = makeModel(session: try session(), recorder: recorder, pasteboard: pasteboard)
        try await takeControl(model)
        let interceptor = try XCTUnwrap(model.input.keyInterceptor)

        XCTAssertTrue(interceptor(true, ViewerPastePolicy.pasteKeyCode, [.command]))
        XCTAssertNotNil(model.pendingPasteConfirmation)
        XCTAssertTrue(interceptor(false, ViewerPastePolicy.pasteKeyCode, [.command]),
                      "the up is swallowed too, so no stray V reaches the remote app")
        XCTAssertFalse(interceptor(true, ViewerPastePolicy.pasteKeyCode, [.command, .shift]))
        XCTAssertFalse(interceptor(true, 0, [.command]))
        XCTAssertFalse(interceptor(true, ViewerPastePolicy.pasteKeyCode, []),
                       "a plain V is a keystroke for the remote app")
    }

    func testInputControllerHonoursTheInterceptBeforeDelivery() {
        let target = SpaceOKit.WindowRef(
            windowID: 41, pid: getpid() + 1, title: "Target",
            frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 800, height: 600),
                                   isSpaceO: true, isActive: true, name: "Stage")
        let posted = expectation(description: "the plain key is delivered")
        let lock = NSLock()
        var postedCodes: [CGKeyCode] = []
        let controller = ViewerInputController(
            keyPoster: { code, _, down, _, _ in
                lock.withLock { postedCodes.append(code) }
                if down { posted.fulfill() }
            },
            frontWindowProvider: { _ in target })
        var intercepted: [(Bool, UInt16)] = []
        controller.keyInterceptor = { down, keyCode, modifiers in
            intercepted.append((down, keyCode))
            return ViewerPastePolicy.isBrokeredPaste(keyCode: keyCode, modifiers: modifiers)
        }
        controller.display = display
        controller.interactionEnabled = true

        controller.key(down: true, keyCode: 9, modifiers: [.command], characters: "v")
        controller.key(down: false, keyCode: 9, modifiers: [.command], characters: "v")
        controller.key(down: true, keyCode: 0, modifiers: [], characters: "a")
        wait(for: [posted], timeout: 1)

        XCTAssertEqual(lock.withLock { postedCodes }, [0], "⌘V never reached the poster")
        XCTAssertEqual(intercepted.map(\.1), [9, 9, 0])
        controller.interactionEnabled = false
    }

    // MARK: - Helpers

    private func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("condition was not met within \(timeout)s")
    }
}
