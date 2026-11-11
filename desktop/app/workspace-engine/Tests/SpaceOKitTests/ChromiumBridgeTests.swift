import XCTest
import Foundation
import Darwin
@testable import SpaceOKit

/// Regressions for SPAO-132: bounded DevTools responses and deliberate target binding.
///
/// Driven against a real loopback HTTP server rather than a mocked `URLSession`, because both
/// halves of the ticket are about what happens on the wire — a body that keeps coming, and a
/// target list whose order means nothing.
final class ChromiumBridgeTests: XCTestCase {

    final class LockedCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var stored = 0

        var value: Int { lock.withLock { stored } }
        func increment() { lock.withLock { stored += 1 } }
    }

    // MARK: - A DevTools endpoint that answers however the test needs

    /// Minimal single-shot HTTP server on 127.0.0.1. Serves one canned body per connection.
    final class FakeDevTools {

        enum Behavior {
            /// A normal JSON reply. The closure receives the port the server ended up on, so a
            /// target list can carry websocket urls that actually match it.
            case body((Int) -> String)
            /// Claim a huge Content-Length, then stream `chunkCount` chunks of `chunk`.
            case oversized(chunk: String, chunkCount: Int, declaredLength: Int?)
            case streaming(chunk: String, chunkCount: Int)
            case stalled(sendHeaders: Bool)
        }

        let port: Int
        private let listener: Int32
        private var thread: Thread?
        private let behavior: Behavior
        private let requestObserver: ((String) -> Void)?
        private let stopped = NSLock()
        private var isStopped = false
        private var storedRequest = ""
        var lastRequest: String { stopped.withLock { storedRequest } }

        init?(behavior: Behavior, requestObserver: ((String) -> Void)? = nil) {
            // Everything runs against locals until the last line: a closure that touched a
            // stored property here would capture a half-initialised `self`.
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { return nil }
            var yes: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = 0                        // let the kernel choose
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0, listen(fd, 8) == 0 else {
                close(fd)
                return nil
            }
            var actual = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let named = withUnsafeMutablePointer(to: &actual) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    getsockname(fd, $0, &length)
                }
            }
            guard named == 0 else {
                close(fd)
                return nil
            }
            self.behavior = behavior
            self.requestObserver = requestObserver
            self.listener = fd
            self.port = Int(UInt16(bigEndian: actual.sin_port))
            start()
        }

        private func start() {
            let thread = Thread { [weak self] in self?.serve() }
            thread.name = "fake-devtools"
            self.thread = thread
            thread.start()
        }

        private func serve() {
            while !stopped.withLock({ isStopped }) {
                let client = accept(listener, nil, nil)
                guard client >= 0 else { return }
                defer { close(client) }
                var noSignal: Int32 = 1
                setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                           socklen_t(MemoryLayout<Int32>.size))

                // Retain the request for method assertions; every path gets the same reply.
                var scratch = [UInt8](repeating: 0, count: 4096)
                let received = recv(client, &scratch, scratch.count, 0)
                if received > 0 {
                    let request = String(decoding: scratch.prefix(received), as: UTF8.self)
                    stopped.withLock { storedRequest = request }
                    requestObserver?(request)
                }

                switch behavior {
                case .stalled(let sendHeaders):
                    // Bound the fake even if a regression fails to cancel the client.
                    var timeout = timeval(tv_sec: 2, tv_usec: 0)
                    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                    if sendHeaders {
                        let header = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx"
                        _ = send(client, header, header.utf8.count, 0)
                    }
                    _ = recv(client, &scratch, scratch.count, 0)
                case .body(let make):
                    let json = make(port)
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                        + "Content-Length: \(json.utf8.count)\r\nConnection: close\r\n\r\n" + json
                    _ = send(client, response, response.utf8.count, 0)

                case .oversized(let chunk, let chunkCount, _), .streaming(let chunk, let chunkCount):
                    let lengthHeader: String
                    if case .oversized(_, _, let declaredLength) = behavior {
                        let declared = declaredLength ?? (chunk.utf8.count * chunkCount)
                        lengthHeader = "Content-Length: \(declared)\r\n"
                    } else {
                        lengthHeader = ""
                    }
                    let header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                        + lengthHeader + "Connection: close\r\n\r\n"
                    _ = send(client, header, header.utf8.count, 0)
                    for _ in 0..<chunkCount {
                        if stopped.withLock({ isStopped }) { break }
                        let written = send(client, chunk, chunk.utf8.count, 0)
                        // The client cancelling mid-stream is the success case for the oversized
                        // tests; stop writing rather than spinning on a broken pipe.
                        if written <= 0 { break }
                    }
                }
            }
        }

        func stop() {
            stopped.withLock { isStopped = true }
            close(listener)
        }
    }

    // MARK: - Bounded responses

    func testANormalTargetListIsParsed() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        let targets = try await bridge.targets()
        XCTAssertEqual(targets.count, 1)
        XCTAssertEqual(targets.first?.id, "A")
        XCTAssertEqual(targets.first?.title, "one")
    }

    /// A page whose debugger url points somewhere other than the browser's own loopback port is
    /// dropped, not attached to — the endpoint does not get to redirect automation.
    func testAnEntryPointingOffTheLoopbackPortIsNotATarget() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one")], port: port + 1)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        let targets = try await bridge.targets()
        XCTAssertTrue(targets.isEmpty)
    }

    /// The core fix: the body is abandoned *while* it is arriving, not measured after it lands.
    func testAnOversizedTargetListIsRefusedWithoutBufferingItAll() async throws {
        // 64 KiB per chunk, far more chunks than the limit allows: a bridge that buffered first
        // would hold tens of megabytes before it ever checked.
        let chunk = String(repeating: "x", count: 64 * 1024)
        let chunkCount = 64
        let server = try XCTUnwrap(FakeDevTools(behavior: .oversized(
            chunk: chunk, chunkCount: chunkCount, declaredLength: nil)))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.targets()
            XCTFail("an oversized target list must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("limit"),
                          "the refusal must name the limit: \(error.localizedDescription)")
        }
    }

    /// A declared length over the limit is refused before a byte of body is read at all.
    func testADeclaredLengthOverTheLimitIsRefusedUpFront() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .oversized(
            chunk: "x", chunkCount: 1,
            declaredLength: ChromiumBridge.maximumTargetListBytes + 1)))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.targets()
            XCTFail("a body declaring more than the limit must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("declares"),
                          error.localizedDescription)
        }
    }

    func testNewTabRejectsDeclaredOversizeBeforeParsing() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .oversized(
            chunk: "x", chunkCount: 1, declaredLength: 65_537)))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.openInNewTab(URL(string: "https://example.com/")!)
            XCTFail("oversized new-tab response must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("declares 65537"), "\(error)")
        }
        XCTAssertTrue(server.lastRequest.hasPrefix("PUT /json/new?"))
    }

    func testNewTabRejectsStreamingOversizeWithoutContentLength() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .streaming(
            chunk: String(repeating: "x", count: 4096), chunkCount: 32)))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.openInNewTab(URL(string: "https://example.com/")!)
            XCTFail("oversized new-tab stream must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("exceeded the 65536-byte limit"), "\(error)")
        }
    }

    func testBoundedBodyPreservesExactLimitAndPartialChunk() async throws {
        // Cross the 16 KiB accumulation boundary, then finish with a partial chunk.
        let payload = String(repeating: "a", count: 16 * 1024 + 7)
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { _ in payload }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        let request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/test")!)
        let data = try await bridge.boundedBody(for: request, maximumBytes: payload.utf8.count,
                                                description: "test")
        XCTAssertEqual(data, Data(payload.utf8))
    }

    func testTargetListRejectsStreamingOversizeWithoutContentLength() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .streaming(
            chunk: String(repeating: "x", count: 64 * 1024), chunkCount: 20)))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.targets()
            XCTFail("oversized target stream must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("exceeded the 1048576-byte limit"), "\(error)")
        }
    }

    func testPersistentWebSocketDoesNotInheritDiscoveryLifetime() {
        let discovery = ChromiumBridge.discoveryConfiguration()
        let webSocket = ChromiumBridge.webSocketConfiguration()

        XCTAssertEqual(discovery.timeoutIntervalForRequest, 5)
        XCTAssertEqual(discovery.timeoutIntervalForResource, 15)
        XCTAssertGreaterThanOrEqual(webSocket.timeoutIntervalForRequest, 24 * 60 * 60)
        XCTAssertGreaterThanOrEqual(webSocket.timeoutIntervalForResource, 24 * 60 * 60)
    }

    func testPointerModifiersUseTheDevToolsBitmask() throws {
        XCTAssertEqual(try ChromiumBridge.devToolsModifiers([]), 0)
        XCTAssertEqual(try ChromiumBridge.devToolsModifiers(.maskAlternate), 1)
        XCTAssertEqual(try ChromiumBridge.devToolsModifiers(.maskControl), 2)
        XCTAssertEqual(try ChromiumBridge.devToolsModifiers(.maskCommand), 4)
        XCTAssertEqual(try ChromiumBridge.devToolsModifiers(.maskShift), 8)
        XCTAssertEqual(
            try ChromiumBridge.devToolsModifiers([.maskCommand, .maskShift]),
            12)
        XCTAssertThrowsError(
            try ChromiumBridge.devToolsModifiers(.maskSecondaryFn))
    }

    /// A late Foundation callback must not turn a bounded DevTools command into a daemon-wide
    /// stall. The simulated operation deliberately ignores the deadline and completes later.
    func testReplyTimeoutDoesNotWaitForALateCompletion() async throws {
        let returned = expectation(description: "deadline returns before callback")
        let callback = CallbackBox()
        let waiter = Task {
            do {
                let _: String = try await ChromiumBridge.firstCompletion(
                    within: 0.02, start: { callback.install($0) })
                XCTFail("the late completion must lose to the deadline")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("timed out"),
                              error.localizedDescription)
            }
            returned.fulfill()
        }
        // Prove ordering directly, without requiring a loaded hosted runner to schedule the
        // continuation within 150 ms. A callback-waiting regression still fails this assertion.
        await fulfillment(of: [returned], timeout: 2)
        callback.complete()
        callback.complete()
        await waiter.value
    }

    func testReplyTimeoutRunsCleanupOnce() async throws {
        let cleanupCount = LockedCounter()
        do {
            let _: String = try await ChromiumBridge.firstCompletion(
                within: 0.01,
                start: { _ in },
                onTimeout: { cleanupCount.increment() })
            XCTFail("a callback that never arrives must time out")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("timed out"),
                          error.localizedDescription)
        }
        XCTAssertEqual(cleanupCount.value, 1)
    }

    private final class CallbackBox: @unchecked Sendable {
        private let lock = NSLock()
        private var callback: (@Sendable (Result<String, Error>) -> Void)?
        func install(_ callback: @escaping @Sendable (Result<String, Error>) -> Void) {
            lock.withLock { self.callback = callback }
        }
        func complete() { lock.withLock { callback }?(.success("late")) }
    }

    func testCancellingReplyReturnsBeforeCallbackAndCleansUpExactlyOnce() async throws {
        let started = expectation(description: "callback operation started")
        let finished = expectation(description: "cancelled caller returned")
        let callback = CallbackBox()
        let cleanup = LockedCounter()
        let waiter = Task {
            do {
                let _: String = try await ChromiumBridge.firstCompletion(within: 120, start: {
                    callback.install($0)
                    started.fulfill()
                }, onTimeout: { cleanup.increment() })
                XCTFail("cancelled receive must not succeed")
            } catch is CancellationError {
                XCTAssertEqual(cleanup.value, 1, "cleanup must precede continuation resumption")
            } catch { XCTFail("unexpected error: \(error)") }
            finished.fulfill()
        }
        await fulfillment(of: [started], timeout: 1)
        waiter.cancel()
        await fulfillment(of: [finished], timeout: 1)
        callback.complete()
        callback.complete()
        XCTAssertEqual(cleanup.value, 1)
        await waiter.value
    }

    func testAlreadyCancelledReplyDoesNotStartOperation() async {
        let starts = LockedCounter()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                let _: String = try await ChromiumBridge.firstCompletion(within: 120, start: { _ in
                    starts.increment()
                })
                XCTFail("already cancelled receive must fail")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await task.value
        XCTAssertEqual(starts.value, 0)
    }

    private final class CleanupToken: @unchecked Sendable {
        let released: XCTestExpectation
        init(_ released: XCTestExpectation) { self.released = released }
        func use() {}
        deinit { released.fulfill() }
    }

    func testCompletedReplyReleasesTimeoutCapturesBeforeDeadline() async throws {
        let released = expectation(description: "timeout captures released")
        func complete() async throws {
            let token = CleanupToken(released)
            let result: String = try await ChromiumBridge.firstCompletion(
                within: 120, start: { $0(.success("done")) }, onTimeout: { token.use() })
            XCTAssertEqual(result, "done")
        }
        try await complete()
        await fulfillment(of: [released], timeout: 1)
    }

    func testCancelledQueuedCommandLeavesWhileHolderRemainsBusy() async throws {
        let bridge = ChromiumBridge(port: 1)
        let gate = await bridge.commandGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        let finished = expectation(description: "queued command cancelled")
        let waiter = Task {
            do {
                _ = try await bridge.evaluate("1")
                XCTFail("cancelled queued command must not execute")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
            finished.fulfill()
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while gate.pendingCount == 0 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(gate.pendingCount, 1)
        waiter.cancel()
        await fulfillment(of: [finished], timeout: 1)
        XCTAssertEqual(gate.pendingCount, 0)
        await waiter.value
    }

    func testQueuedCommandCannotFollowARebindToAnotherPage() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one"), (id: "B", title: "two")], port: port)
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        try await bridge.attach(toTargetID: "A")
        let gate = await bridge.commandGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        let waiter = Task {
            do {
                _ = try await bridge.evaluate("1")
                XCTFail("queued command must not follow a rebind")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("target changed while the command was queued"),
                              "\(error)")
            }
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while gate.pendingCount == 0 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(gate.pendingCount, 1)
        try await bridge.attach(toTargetID: "B")
        holder.finish()
        await waiter.value
        await bridge.detach()
    }

    func testCancelledReadinessReturnsWithoutPolling() async {
        let bridge = ChromiumBridge(port: 1)
        let finished = expectation(description: "readiness cancelled")
        let waiter = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            let ready = await bridge.waitUntilReady(timeout: 120)
            XCTAssertFalse(ready)
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 1)
        await waiter.value
    }

    func testCancelledNavigationDoesNotBeginACommand() async {
        let bridge = ChromiumBridge(port: 1)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try await bridge.navigate(to: URL(string: "https://example.com")!)
                XCTFail("cancelled navigation must fail before sending")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await task.value
    }

    private final class CommandLog: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [String] = []
        var events: [String] { lock.withLock { stored } }
        func append(_ event: String) { lock.withLock { stored.append(event) } }
    }

    func testStartupCreatesBackgroundPagesAndReleasesBrowserBinding() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:\(port)/devtools/browser/test\"}"
        }))
        defer { server.stop() }
        let log = CommandLog()
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { method, params in
            XCTAssertEqual(method, "Target.createTarget")
            XCTAssertEqual(params["background"] as? Bool, true)
            if params["newWindow"] as? Bool == true {
                XCTAssertEqual(params["left"] as? Int, 2032)
                XCTAssertEqual(params["top"] as? Int, 32)
                XCTAssertEqual(params["width"] as? Int, 1216)
                XCTAssertEqual(params["height"] as? Int, 736)
            } else {
                XCTAssertNil(params["left"], "tab creation must omit window-only bounds")
            }
            log.append(params["url"] as? String ?? "")
            return ["targetId": "created"]
        })
        let files = [URL(fileURLWithPath: "/tmp/first.html"), URL(fileURLWithPath: "/tmp/second.html")]
        try await bridge.createBackgroundPages(files: files,
            region: CGRect(x: 2000, y: 0, width: 1280, height: 800))
        XCTAssertEqual(log.events, files.map(\.absoluteString))
        let bound = await bridge.boundTargetID
        XCTAssertNil(bound)
    }

    func testStartupRejectsTooSmallInsetBeforeConnecting() async throws {
        let bridge = ChromiumBridge(port: 1, commandExecutor: { _, _ in
            XCTFail("invalid geometry must not create a target")
            return [:]
        })
        do {
            try await bridge.createBackgroundPages(files: [],
                region: CGRect(x: 0, y: 0, width: 1, height: 1))
            XCTFail("sub-point inset dimensions must not be truncated to zero")
        } catch SpaceOError.badRequest {} catch { XCTFail("unexpected error: \(error)") }
    }

    func testStartupRejectsAnUnconfirmedCreatedPage() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:\(port)/devtools/browser/test\"}"
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in [:] })
        do {
            try await bridge.createBackgroundPages(files: [],
                region: CGRect(x: 2000, y: 0, width: 1280, height: 800))
            XCTFail("an empty reply cannot confirm page creation")
        } catch {
            XCTAssertTrue(String(describing: error).contains("did not confirm"))
        }
        let bound = await bridge.boundTargetID
        XCTAssertNil(bound)
    }

    func testReusedFileOpenReportsConfirmedUnknownAndUnexecutedPages() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:\(port)/devtools/browser/test\"}"
        }))
        defer { server.stop() }
        let sent = CommandLog()
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, params in
            sent.append(params["url"] as? String ?? "")
            if sent.events.count == 1 { return ["targetId": "first-page"] }
            throw SpaceOError.launchFailed("connection closed before reply")
        })
        do {
            try await bridge.createBackgroundPages(
                files: (0..<3).map { URL(fileURLWithPath: "/tmp/\($0).html") },
                region: CGRect(x: 2000, y: 0, width: 1280, height: 800),
                reportPartialCompletion: true)
            XCTFail("the second open must fail")
        } catch {
            let wire = try JSONEncoder().encode(Response.failure(
                AppLauncher.launchFailure(error, application: "Test Browser")))
            let response = try JSONDecoder().decode(Response.self, from: wire)
            XCTAssertFalse(response.ok)
            XCTAssertEqual(response.errorCode, "file_open_incomplete")
            XCTAssertEqual(response.firstFailureIndex, 1)
            XCTAssertEqual(response.steps?.map(\.ok), [true, false, false])
            XCTAssertEqual(response.steps?.map(\.executed), [true, true, false])
            XCTAssertEqual(response.steps?.map(\.completion), ["confirmed", "unknown", "not_executed"])
            XCTAssertTrue(response.steps?.first?.message?.contains("first-page") == true)
        }
        XCTAssertEqual(sent.events.count, 2, "do not open later files after unknown delivery")
        let bound = await bridge.boundTargetID
        XCTAssertNil(bound)
    }

    func testReusedFileOpenDistinguishesValidationFailureBeforeAndAfterDelivery() async throws {
        for stopAfter in [1, 3] {
            let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
                "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:\(port)/devtools/browser/test\"}"
            }))
            defer { server.stop() }
            let sent = CommandLog()
            let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in
                sent.append("sent")
                return ["targetId": "page-\(sent.events.count)"]
            })
            do {
                try await bridge.createBackgroundPages(
                    files: (0..<3).map { URL(fileURLWithPath: "/tmp/\($0).html") },
                    region: CGRect(x: 2000, y: 0, width: 1280, height: 800),
                    reportPartialCompletion: true, validate: {
                        if sent.events.count == stopAfter {
                            throw SpaceOError.applicationExited("test process exited")
                        }
                    })
                XCTFail("process validation must fail")
            } catch {
                let response = Response.failure(error)
                XCTAssertEqual(response.errorCode, "file_open_incomplete")
                XCTAssertEqual(response.firstFailureIndex, stopAfter == 3 ? nil : 1)
                XCTAssertEqual(response.steps?.map(\.executed), (0..<3).map { $0 < stopAfter })
                XCTAssertEqual(response.steps?.map(\.completion),
                    (0..<3).map { $0 < stopAfter ? "confirmed" : "not_executed" })
            }
            XCTAssertEqual(sent.events.count, stopAfter)
        }
    }

    func testReusedFileOpenCancellationBeforeSendReportsNotExecuted() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1:\(port)/devtools/browser/test\"}"
        }))
        defer { server.stop() }
        let sent = CommandLog()
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in
            sent.append("sent")
            return ["targetId": "first-page"]
        })
        let task = Task {
            try await bridge.createBackgroundPages(
                files: (0..<3).map { URL(fileURLWithPath: "/tmp/\($0).html") },
                region: CGRect(x: 2000, y: 0, width: 1280, height: 800),
                reportPartialCompletion: true, validate: {
                    if sent.events.count == 1 { withUnsafeCurrentTask { $0?.cancel() } }
                })
        }
        do { try await task.value; XCTFail("pre-send cancellation must fail") }
        catch {
            let response = Response.failure(error)
            XCTAssertEqual(response.errorCode, "file_open_incomplete")
            XCTAssertEqual(response.firstFailureIndex, 1)
            XCTAssertEqual(response.steps?.map(\.executed), [true, false, false])
            XCTAssertEqual(response.steps?.map(\.completion), ["confirmed", "not_executed", "not_executed"])
        }
        XCTAssertEqual(sent.events.count, 1)
    }

    func testStartupRejectsRemoteBrowserEndpointBeforeSendingCommands() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            "{\"webSocketDebuggerUrl\":\"ws://example.com:\(port)/devtools/browser/test\"}"
        }))
        defer { server.stop() }
        let log = CommandLog()
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { method, _ in
            log.append(method)
            return ["targetId": "unexpected"]
        })
        do {
            try await bridge.createBackgroundPages(files: [],
                region: CGRect(x: 0, y: 0, width: 1280, height: 800))
            XCTFail("remote endpoints must be rejected")
        } catch {}
        XCTAssertEqual(log.events, [])
    }

    func testStartupRejectsBoundsThatCannotFitProtocolIntegers() async throws {
        let bridge = ChromiumBridge(port: 1)
        do {
            try await bridge.createBackgroundPages(files: [],
                region: CGRect(x: CGFloat.greatestFiniteMagnitude, y: 0, width: 1280, height: 800))
            XCTFail("bounds must be checked before integer conversion or networking")
        } catch {
            XCTAssertTrue(String(describing: error).contains("integer range"))
        }
    }

    private func checkCancelledGesture(_ action: @escaping (ChromiumBridge) async throws -> Void,
                                       expected: [String]) async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one")], port: port)
        }))
        defer { server.stop() }
        let log = CommandLog()
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, params in
            let type = params["type"] as? String ?? ""
            log.append(type)
            if type == "mousePressed" || type == "rawKeyDown" {
                withUnsafeCurrentTask { $0?.cancel() }
            }
            return [:]
        })
        try await bridge.attach(toTargetID: "A")
        let gesture = Task {
            do {
                try await action(bridge)
                XCTFail("gesture must preserve cancellation after cleanup")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await gesture.value
        XCTAssertEqual(log.events, expected)
        await bridge.detach()
    }

    func testCancelledClickStillReleasesItsButton() async throws {
        try await checkCancelledGesture({ try await $0.click(x: 4, y: 5) },
                                        expected: ["mouseMoved", "mousePressed", "mouseReleased"])
    }

    func testCancelledDragStillReleasesItsButtonWithoutFurtherMoves() async throws {
        try await checkCancelledGesture({ try await $0.drag(fromX: 4, fromY: 5, toX: 10, toY: 12) },
                                        expected: ["mouseMoved", "mousePressed", "mouseReleased"])
    }

    func testCancelledKeyStillReleasesItsKey() async throws {
        try await checkCancelledGesture({ try await $0.key("enter") },
                                        expected: ["rawKeyDown", "keyUp"])
    }

    func testPublicKeyRejectsClipboardShortcutsBeforeTransport() async throws {
        let log = CommandLog()
        let bridge = ChromiumBridge(port: 1, commandExecutor: { method, _ in
            log.append(method)
            return [:]
        })
        for shortcut in ["cmd+c", "cmd+x", "cmd+v", "cmd+shift+c"] {
            do {
                try await bridge.key(shortcut)
                XCTFail("shared clipboard shortcuts must be rejected")
            } catch SpaceOError.unsupportedTarget(let reason) {
                XCTAssertTrue(reason.contains("isolated per-session clipboard"))
            } catch {
                XCTFail("clipboard refusal must precede binding/transport checks: \(error)")
            }
        }
        XCTAssertTrue(log.events.isEmpty)
    }

    func testGestureCleanupNeverReleasesOnAReboundPage() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one"), (id: "B", title: "two")], port: port)
        }))
        defer { server.stop() }
        let log = CommandLog()
        let pressed = expectation(description: "press started")
        let pause = SessionOperationGate()
        let holder = try await pause.enter()
        defer { holder.finish() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, params in
            let type = params["type"] as? String ?? ""
            log.append(type)
            if type == "mousePressed" {
                pressed.fulfill()
                let lease = try await pause.enter()
                lease.finish()
            }
            return [:]
        })
        try await bridge.attach(toTargetID: "A")
        let gesture = Task {
            do {
                try await bridge.click(x: 4, y: 5)
                XCTFail("interrupted gesture must fail")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [pressed], timeout: 1)
        try await bridge.attach(toTargetID: "B")
        gesture.cancel()
        await gesture.value
        XCTAssertEqual(log.events, ["mouseMoved", "mousePressed"])
        let target = await bridge.boundTargetID
        XCTAssertEqual(target, "B", "cleanup must not retire the replacement socket")
        await bridge.detach()
    }

    func testGestureCannotContinueAfterRebindingBetweenEvents() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one"), (id: "B", title: "two")], port: port)
        }))
        defer { server.stop() }
        let log = CommandLog()
        let moved = expectation(description: "first move started")
        let pause = SessionOperationGate()
        let holder = try await pause.enter()
        defer { holder.finish() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, params in
            log.append(params["type"] as? String ?? "")
            moved.fulfill()
            let lease = try await pause.enter()
            lease.finish()
            return [:]
        })
        try await bridge.attach(toTargetID: "A")
        let gesture = Task {
            do {
                try await bridge.click(x: 4, y: 5)
                XCTFail("gesture must not continue against a new binding")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("target changed"), "\(error)")
            }
        }
        await fulfillment(of: [moved], timeout: 1)
        try await bridge.attach(toTargetID: "B")
        holder.finish()
        await gesture.value
        XCTAssertEqual(log.events, ["mouseMoved"])
        await bridge.detach()
    }

    private func checkReboundAction(_ action: @escaping (ChromiumBridge) async throws -> Void,
                                    firstMethod: String, reply: [String: Any]) async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "one"), (id: "B", title: "two")], port: port)
        }))
        defer { server.stop() }
        let log = CommandLog()
        let started = expectation(description: "first command started")
        let pause = SessionOperationGate()
        let holder = try await pause.enter()
        defer { holder.finish() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { method, _ in
            log.append(method)
            started.fulfill()
            let lease = try await pause.enter()
            lease.finish()
            return reply
        })
        try await bridge.attach(toTargetID: "A")
        let operation = Task {
            do {
                try await action(bridge)
                XCTFail("operation must not follow a rebind")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("target changed"), "\(error)")
            }
        }
        await fulfillment(of: [started], timeout: 1)
        try await bridge.attach(toTargetID: "B")
        holder.finish()
        await operation.value
        XCTAssertEqual(log.events, [firstMethod])
        await bridge.detach()
    }

    func testElementLookupCannotClickOnAReboundPage() async throws {
        try await checkReboundAction({ try await $0.clickElement(index: 0) },
                                     firstMethod: "Runtime.evaluate",
                                     reply: ["result": ["value": #"{"x":4,"y":5}"#]])
    }

    func testNavigationDoesNotPollAReboundPage() async throws {
        try await checkReboundAction({ _ = try await $0.navigate(to: URL(string: "https://example.com")!) },
                                     firstMethod: "Page.navigate", reply: [:])
    }

    func testAnInvalidPortIsRefusedBeforeAnyConnection() async {
        for port in [0, -1, 70_000] {
            let bridge = ChromiumBridge(port: port)
            do {
                _ = try await bridge.targets()
                XCTFail("port \(port) must be refused")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("port"),
                              error.localizedDescription)
            }
        }
    }

    // MARK: - Target binding

    static func listing(_ entries: [(id: String, title: String)], port: Int) -> String {
        let body = entries.map { entry in
            """
            {"type":"page","id":"\(entry.id)","title":"\(entry.title)",
             "url":"https://example.test/\(entry.id)",
             "webSocketDebuggerUrl":"ws://127.0.0.1:\(port)/devtools/page/\(entry.id)"}
            """
        }.joined(separator: ",")
        return "[\(body)]"
    }

    func testAnEmptyTargetListFailsClosed() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { _ in "[]" }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.attachToLaunchedTarget()
            XCTFail("no pages means nothing to attach to")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("no page targets"),
                          error.localizedDescription)
        }
        let bound = await bridge.boundTargetID
        XCTAssertNil(bound)
    }

    /// The behaviour the ticket is about: list order is not authority. With more than one page,
    /// the bridge must refuse rather than silently drive whichever came back first.
    func testMultipleTargetsFailClosedInsteadOfTrustingListOrder() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "first"), (id: "B", title: "second")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.attachToLaunchedTarget()
            XCTFail("two pages is ambiguous and must not be resolved by list order")
        } catch {
            let message = error.localizedDescription
            XCTAssertTrue(message.contains("2 page targets"), message)
            XCTAssertTrue(message.contains("A") && message.contains("B"),
                          "the refusal must name the candidates so a caller can choose: \(message)")
        }
        let bound = await bridge.boundTargetID
        XCTAssertNil(bound, "a refused attach must leave the bridge unbound")
    }

    func testAttachingToAnUnknownTargetIDFailsClosed() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "first")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        do {
            _ = try await bridge.attach(toTargetID: "does-not-exist")
            XCTFail("an unknown target must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("does-not-exist"),
                          error.localizedDescription)
        }
    }

    /// PAR-22: a second `attach` has to move the bridge. `connect(to:)` used to return early on
    /// "a socket exists", so re-attaching handed back the requested target while every command
    /// kept going to the previously bound page.
    func testReattachingToADifferentTargetMovesTheBridge() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "first"), (id: "B", title: "second")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        let first = try await bridge.attach(toTargetID: "A")
        XCTAssertEqual(first.id, "A")
        var bound = await bridge.boundTargetID
        XCTAssertEqual(bound, "A")

        let second = try await bridge.attach(toTargetID: "B")
        XCTAssertEqual(second.id, "B")
        bound = await bridge.boundTargetID
        XCTAssertEqual(bound, "B",
                       "the returned target is only honest if the bridge actually re-pointed")
        let opened = await bridge.socketsOpened
        XCTAssertEqual(opened, 2, "re-pointing at another page must open that page's socket")
    }

    /// The other half: attaching to the page the bridge is already on stays a no-op, so a
    /// re-attach does not churn a working session's socket.
    func testReattachingToTheSameTargetKeepsTheExistingSocket() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "first"), (id: "B", title: "second")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        _ = try await bridge.attach(toTargetID: "A")
        _ = try await bridge.attach(toTargetID: "A")

        let bound = await bridge.boundTargetID
        XCTAssertEqual(bound, "A")
        let opened = await bridge.socketsOpened
        XCTAssertEqual(opened, 1)
    }

    /// A refused re-attach must not unbind the page the bridge is driving — failing closed means
    /// the caller keeps a known-good binding, not an unusable bridge.
    func testARefusedReattachLeavesTheOriginalBindingIntact() async throws {
        let server = try XCTUnwrap(FakeDevTools(behavior: .body { port in
            Self.listing([(id: "A", title: "first")], port: port)
        }))
        defer { server.stop() }

        let bridge = ChromiumBridge(port: server.port)
        _ = try await bridge.attach(toTargetID: "A")
        do {
            _ = try await bridge.attach(toTargetID: "B")
            XCTFail("a target that is not in the list must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("no page target 'B'"),
                          error.localizedDescription)
        }
        let bound = await bridge.boundTargetID
        XCTAssertEqual(bound, "A")
        let opened = await bridge.socketsOpened
        XCTAssertEqual(opened, 1)
    }

    func testAnEmptyOrOverlongTargetIDIsRefusedBeforeAnyRequest() async {
        let bridge = ChromiumBridge(port: 9_222)
        for id in ["", String(repeating: "x", count: 257)] {
            do {
                _ = try await bridge.attach(toTargetID: id)
                XCTFail("target id '\(id.prefix(8))…' must be refused")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("target id"),
                              error.localizedDescription)
            }
        }
    }

    /// Commands must never run against a bridge that is not deliberately bound to a page.
    func testCommandsOnAnUnboundBridgeFailClosed() async {
        let bridge = ChromiumBridge(port: 9_222)
        do {
            _ = try await bridge.evaluate("1 + 1")
            XCTFail("an unbound bridge must not execute anything")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("not attached"),
                          error.localizedDescription)
        }
        do {
            try await bridge.verifyBoundTarget()
            XCTFail("verification of an unbound bridge must fail")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("not attached"),
                          error.localizedDescription)
        }
    }

    // MARK: - Endpoint validation

    func testWebSocketURLsMustStayOnTheirPrivateLoopbackPort() {
        XCTAssertNotNil(ChromiumBridge.validatedWebSocketURL(
            "ws://127.0.0.1:9222/devtools/page/A", port: 9_222))
        XCTAssertNotNil(ChromiumBridge.validatedWebSocketURL(
            "ws://localhost:9222/devtools/page/A", port: 9_222))

        for hostile in ["ws://evil.test:9222/devtools/page/A",
                        "ws://127.0.0.1:9223/devtools/page/A",
                        "wss://127.0.0.1:9222/devtools/page/A",
                        "ws://user:pass@127.0.0.1:9222/devtools/page/A",
                        "http://127.0.0.1:9222/devtools/page/A"] {
            XCTAssertNil(ChromiumBridge.validatedWebSocketURL(hostile, port: 9_222),
                         "\(hostile) must not be accepted")
        }
    }
}
