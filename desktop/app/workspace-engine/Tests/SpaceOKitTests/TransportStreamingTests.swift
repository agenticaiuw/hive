import Darwin
import Foundation
import XCTest
@testable import SpaceOKit

/// A flag several tasks can poll without sharing a thread. Tests use it to hold stream
/// handlers open until they have observed the state under test.
private final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var arrivals = 0

    var isOpen: Bool { lock.withLock { open } }
    var arrived: Int { lock.withLock { arrivals } }

    func arrive() { lock.withLock { arrivals += 1 } }
    func release() { lock.withLock { open = true } }

    /// Yield until the gate opens; bounded so a broken test cannot hang the handler forever.
    func waitUntilOpen(maximumSeconds: Double = 10) async {
        let deadline = Date().addingTimeInterval(maximumSeconds)
        while !isOpen, Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }
}

private final class Collector<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Value] = []
    var all: [Value] { lock.withLock { values } }
    var count: Int { lock.withLock { values.count } }
    func append(_ value: Value) { lock.withLock { values.append(value) } }
}

/// SPAO-152 (concurrent accept loop) and SPAO-214 (event subscription streaming).
final class TransportStreamingTests: XCTestCase {
    private static var socketCounter = 0
    private static let counterLock = NSLock()

    /// Short literal path: `sun_path` is 104 bytes and never the user's real daemon socket.
    private func freshSocketPath() -> String {
        let n = Self.counterLock.withLock {
            Self.socketCounter += 1
            return Self.socketCounter
        }
        let path = "/tmp/spaceo-tx-\(getpid())-\(n).sock"
        unlink(path)
        return path
    }

    private static func connectRaw(to path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                   socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else { close(fd); return nil }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                _ = strcpy($0, path)
            }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { close(fd); return nil }
        return fd
    }

    /// Connect with a few retries: a momentarily full backlog is not a refusal.
    private static func connectRawPatiently(to path: String) -> Int32? {
        var attempt = connectRaw(to: path)
        for _ in 0..<50 where attempt == nil {
            usleep(20_000)
            attempt = connectRaw(to: path)
        }
        return attempt
    }

    private static func sendLine(_ request: Request, on fd: Int32) throws {
        let payload = try Wire.encoder.encode(request) + Data([0x0A])
        payload.withUnsafeBytes { buffer in
            _ = Foundation.write(fd, buffer.baseAddress!, buffer.count)
        }
    }

    private static func readResponse(on fd: Int32, seconds: UInt64 = 10) -> Response? {
        let deadline = DispatchTime.now().uptimeNanoseconds &+ seconds * 1_000_000_000
        guard let line = Transport.readLine(from: fd, deadlineUptimeNanoseconds: deadline) else {
            return nil
        }
        return try? Wire.decoder.decode(Response.self, from: Data(line.utf8))
    }

    func testAdmissionTimeoutDoesNotRetainARemovedWaiter() {
        for cancel in [false, true] {
            let queue = DispatchQueue(label: "spaceo.test.waiter-lifetime")
            queue.suspend()
            defer { queue.resume() }
            var request = Request(cmd: "clipboard.set")
            request.text = String(repeating: "x", count: 1_000_000)
            var waiter: Transport.Server.AdmissionWaiter? = .init(fd: -1, request: .success(request))
            weak var retained: Transport.Server.AdmissionWaiter?
            retained = waiter
            waiter?.scheduleExpiry(on: queue, deadline: .now()) { _ in
                XCTFail("removed waiters must not expire")
            }
            // Admission and stop cancel; also verify the queue cannot own a removed waiter
            // even if cancellation was missed. Keep the work item itself alive throughout.
            let work = waiter?.timer
            if cancel { work?.cancel(); waiter?.timer = nil }
            waiter = nil
            XCTAssertNil(retained, "scheduled timeout retained the decoded request owner")
            work?.cancel()
        }
    }

    func testAdmissionExpiryClearsItsTimerAndReleasesTheWaiter() {
        let queue = DispatchQueue(label: "spaceo.test.waiter-expiry")
        let expired = expectation(description: "waiter expired")
        var waiter: Transport.Server.AdmissionWaiter? = .init(fd: -1, request: .success(Request(cmd: "ping")))
        weak var retained: Transport.Server.AdmissionWaiter?
        retained = waiter
        waiter?.scheduleExpiry(on: queue, deadline: .now()) { value in
            XCTAssertNil(value.timer)
            expired.fulfill()
        }
        wait(for: [expired], timeout: 2)
        queue.sync {} // The callback must return before testing ownership.
        waiter = nil
        XCTAssertNil(retained, "expiry must not leave a waiter/work-item cycle")
    }

    func testReadFramePreservesBytesAndExistingFramingRefusals() throws {
        let valid = Data("{\"text\":\"é😀\"}".utf8)
        let cases: [(Data, Int, Data?)] = [
            (valid + Data("\nignored".utf8), valid.count, valid),
            (valid + Data([10]), valid.count - 1, nil),
            (valid, 100, nil),
            (Data([10]), 100, nil),
            (Data([0xFF, 10]), 100, nil),
            (Data([0xC3, 10]), 100, nil),
            (Data([0xFF, 0xFE, 0x7B, 0, 0x7D, 0, 10]), 100, nil)
        ]
        for (input, cap, expected) in cases {
            let pipe = Pipe()
            pipe.fileHandleForWriting.write(input)
            try pipe.fileHandleForWriting.close()
            defer { try? pipe.fileHandleForReading.close() }
            XCTAssertEqual(Transport.readFrame(from: pipe.fileHandleForReading.fileDescriptor,
                                               maximumBytes: cap), expected)
        }
    }

    func testServerAdmitsExactRequestLimitAndRefusesNextByte() throws {
        let path = freshSocketPath()
        let admitted = Collector<String>()
        let server = Transport.Server(path: path) { request in
            admitted.append(request.cmd)
            return .success("accepted")
        }
        try server.start()
        defer { server.stop() }
        let cap = 1_048_576
        var request = Request(cmd: "ping")
        request.text = ""
        let overhead = try Wire.encoder.encode(request).count
        request.text = String(repeating: "x", count: cap - overhead)
        let payload = try Wire.encoder.encode(request)
        XCTAssertEqual(payload.count, cap)
        let response = try Transport.sendLinePayload(payload, to: path, timeout: 3,
            maximumRequestBytes: cap + 1, maximumResponseBytes: 256)
        XCTAssertTrue(try Wire.decoder.decode(Response.self, from: response).ok)
        // Valid JSON plus a space exceeds the frame limit without changing request semantics.
        XCTAssertThrowsError(try Transport.sendLinePayload(payload + Data([32]), to: path, timeout: 3,
            maximumRequestBytes: cap + 1, maximumResponseBytes: 256))
        XCTAssertEqual(admitted.all, ["ping"])
    }

    func testLineBufferPreservesFragmentedAndCoalescedUnicodeLines() throws {
        let lines = ["first", "", "é😀", String(repeating: "x", count: 100), "last"]
        let bytes = Array((lines.joined(separator: "\n") + "\n").utf8)
        for chunkSize in [1, 2, 7, 64, bytes.count] {
            var buffer = Transport.LineBuffer(maximumBytes: 100)
            var received: [String] = []
            for start in stride(from: 0, to: bytes.count, by: chunkSize) {
                try buffer.append(bytes[start..<min(start + chunkSize, bytes.count)])
                while let line = buffer.nextLine() {
                    received.append(try XCTUnwrap(String(data: line, encoding: .utf8)))
                }
                XCTAssertNil(buffer.nextLine(), "repeated empty polls must preserve the search cursor")
            }
            XCTAssertEqual(received, lines)
            XCTAssertFalse(buffer.hasPartialLine)
        }
    }

    func testLineBufferEnforcesEveryTerminatedLineAndIncompleteTail() throws {
        for input in ["12345", "12345\n", "ok\n12345", "ok\n12345\n", "12345\nok\n"] {
            var buffer = Transport.LineBuffer(maximumBytes: 4)
            XCTAssertThrowsError(try buffer.append(input.utf8), input)
            XCTAssertNil(buffer.nextLine(), "invalid chunks must not be retained")
            XCTAssertFalse(buffer.hasPartialLine)
        }
        var buffer = Transport.LineBuffer(maximumBytes: 4)
        try buffer.append("1234".utf8)
        XCTAssertTrue(buffer.hasPartialLine)
        XCTAssertNil(buffer.nextLine())
        XCTAssertThrowsError(try buffer.append("5\n".utf8))
        try buffer.append("\n1234\n".utf8)
        XCTAssertEqual(buffer.nextLine(), Data("1234".utf8))
        XCTAssertEqual(buffer.nextLine(), Data("1234".utf8))
        XCTAssertNil(buffer.nextLine())
        XCTAssertFalse(buffer.hasPartialLine)
    }

    func testLineBufferCompactsAfterDrainingWithoutDroppingItsTail() throws {
        var buffer = Transport.LineBuffer(maximumBytes: 20_000)
        let prefix = String(repeating: "line\n", count: 5_000)
        try buffer.append((prefix + "tail").utf8)
        for _ in 0..<5_000 { XCTAssertEqual(buffer.nextLine(), Data("line".utf8)) }
        XCTAssertNil(buffer.nextLine())
        XCTAssertTrue(buffer.hasPartialLine)
        try buffer.append(" continued\nnext\n".utf8)
        XCTAssertEqual(buffer.nextLine(), Data("tail continued".utf8))
        // Appending before draining all complete lines must also retain the right offsets.
        try buffer.append("final\n".utf8)
        XCTAssertEqual(buffer.nextLine(), Data("next".utf8))
        XCTAssertEqual(buffer.nextLine(), Data("final".utf8))
        XCTAssertNil(buffer.nextLine())
    }

    func testTransferredFrameOwnsItsBytesAcrossFurtherReadsAndRefusals() throws {
        let original = Data(String(repeating: "é😀", count: 20_000).utf8)
        var buffer = Transport.LineBuffer(maximumBytes: original.count)
        try buffer.append(original.prefix(37))
        XCTAssertNil(buffer.nextLine())
        try buffer.append(original.dropFirst(37))
        XCTAssertNil(buffer.nextLine())
        try buffer.append([10])
        let held = try XCTUnwrap(buffer.nextLine())
        XCTAssertEqual(held, original)
        XCTAssertFalse(buffer.hasPartialLine)
        XCTAssertNil(buffer.nextLine())
        XCTAssertThrowsError(try buffer.append(Data(repeating: 120, count: original.count + 1)))
        XCTAssertNil(buffer.nextLine())
        try buffer.append("next\n\ntail".utf8)
        XCTAssertEqual(buffer.nextLine(), Data("next".utf8))
        XCTAssertEqual(buffer.nextLine(), Data())
        XCTAssertNil(buffer.nextLine())
        try buffer.append([10])
        XCTAssertEqual(buffer.nextLine(), Data("tail".utf8))
        XCTAssertEqual(held, original, "transferred bytes must survive reuse, compaction, and rejected appends")
        XCTAssertFalse(buffer.hasPartialLine)
    }

    func testSingleEmptyAndInlineFramesResetAllSearchState() throws {
        var buffer = Transport.LineBuffer(maximumBytes: 16)
        for count in [0, 1, 14, 15, 16, 0, 16, 1] {
            let value = Data(repeating: 120, count: count)
            try buffer.append(value)
            XCTAssertNil(buffer.nextLine())
            try buffer.append([10])
            XCTAssertEqual(buffer.nextLine(), value)
            XCTAssertNil(buffer.nextLine())
            XCTAssertFalse(buffer.hasPartialLine)
        }
    }

    func testSubscriberReportsPartialEOFInsteadOfACleanClose() throws {
        for partial in [false, true] {
            let path = freshSocketPath()
            let listener = socket(AF_UNIX, SOCK_STREAM, 0)
            XCTAssertGreaterThanOrEqual(listener, 0)
            defer { close(listener); unlink(path) }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let capacity = MemoryLayout.size(ofValue: address.sun_path)
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { _ = strcpy($0, path) }
            }
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            XCTAssertEqual(bound, 0)
            XCTAssertEqual(listen(listener, 1), 0)
            let finished = expectation(description: "raw peer finished")
            DispatchQueue.global().async {
                defer { finished.fulfill() }
                var ready = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
                guard poll(&ready, 1, 5_000) > 0 else { return }
                let peer = accept(listener, nil, nil)
                guard peer >= 0 else { return }
                defer { close(peer) }
                guard Transport.readLine(from: peer,
                    deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds + 5_000_000_000) != nil else { return }
                let payload = Data(("{\"ok\":true}\n" + (partial ? "{\"ok\":" : "")).utf8)
                payload.withUnsafeBytes { bytes in
                    XCTAssertEqual(Foundation.write(peer, bytes.baseAddress!, bytes.count), bytes.count)
                }
            }
            let closed = expectation(description: "subscription closed")
            let errors = Collector<String>()
            let responses = Collector<Response>()
            let subscription = Transport.subscribe(to: path, sinceSeq: 0,
                onResponse: { responses.append($0) }, onClose: { error in
                    if let error { errors.append(String(describing: error)) }
                    closed.fulfill()
                })
            wait(for: [finished, closed], timeout: 7)
            XCTAssertFalse(subscription.isRunning)
            XCTAssertEqual(responses.count, 1)
            XCTAssertEqual(errors.count, partial ? 1 : 0)
            if partial { XCTAssertTrue(errors.all.first?.contains("incomplete line") == true) }
        }
    }

    // MARK: - SPAO-152

    func testIdleConnectionsDoNotDelayAnOrdinaryRequest() throws {
        let path = freshSocketPath()
        let server = Transport.Server(path: path) { .success($0.cmd) }
        try server.start()
        defer { server.stop() }

        // Each connects and sends nothing. Before SPAO-152 every one of these held the accept
        // thread for its 3 s read deadline, in series.
        var idle: [Int32] = []
        defer { for fd in idle { close(fd) } }
        for _ in 0..<100 {
            guard let fd = Self.connectRawPatiently(to: path) else { continue }
            idle.append(fd)
        }
        XCTAssertEqual(idle.count, 100, "the test must actually park 100 idle connections")

        let started = Date()
        let response = try Transport.send(Request(cmd: "ping"), to: path, timeout: 5)
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertTrue(response.ok, "unexpected error: \(response.error ?? "none")")
        XCTAssertEqual(response.message, "ping")
        XCTAssertLessThan(elapsed, 1.0,
                          "idle peers must not queue a real request behind their read deadline")
    }

    func testInFlightCeilingStillShedsTheSurplusWithBusyAfterABoundedWait() throws {
        let path = freshSocketPath()
        let cap = Transport.Server.maximumInFlightConnections
        let server = Transport.Server(path: path) { _ in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            return .success()
        }
        try server.start()
        defer { server.stop() }

        var clients: [Int32] = []
        defer { for fd in clients { close(fd) } }
        for _ in 0..<(cap + 8) {
            guard let fd = Self.connectRawPatiently(to: path) else { continue }
            try Self.sendLine(Request(cmd: "ping"), on: fd)
            clients.append(fd)
        }
        XCTAssertEqual(clients.count, cap + 8, "the test must push past the ceiling")

        let started = Date()
        var accepted = 0
        var shed = 0
        var firstBusyAt: Date?
        // The surplus is at the tail; read it first so the busy timing is not hidden behind
        // the 3 s handlers ahead of it.
        for fd in clients.reversed() {
            guard let reply = Self.readResponse(on: fd) else { continue }
            if reply.ok {
                accepted += 1
            } else if reply.error?.contains("busy") == true {
                shed += 1
                if firstBusyAt == nil { firstBusyAt = Date() }
                XCTAssertEqual(reply.errorCode, "daemon_busy")
            }
        }
        XCTAssertEqual(accepted, cap, "every slot must have produced a real response")
        XCTAssertEqual(shed, 8, "every surplus connection must get a busy reply, not silence")
        let busyDelay = try XCTUnwrap(firstBusyAt).timeIntervalSince(started)
        XCTAssertLessThan(busyDelay, 2.5,
                          "busy must come after the ~1 s admission wait, not after the handlers")
    }

    // MARK: - SPAO-214

    private static func event(_ seq: UInt64) -> Response {
        var response = Response(ok: true)
        response.events = [DaemonEvent(seq: seq, at: Date(timeIntervalSince1970: 0),
                                       kind: "test", session: nil, detail: [:])]
        response.nextSeq = seq + 1
        return response
    }

    func testSubscriberReceivesEveryStreamedLineThenACleanClose() throws {
        let path = freshSocketPath()
        let server = Transport.Server(path: path) { _ in .success("ordinary") }
        let seenRequest = Collector<Request>()
        server.streamHandler = { request, write in
            seenRequest.append(request)
            for seq: UInt64 in 1...3 {
                guard write(Self.event(seq)) else { return }
            }
        }
        try server.start()
        defer { server.stop() }

        let received = Collector<Response>()
        let closed = expectation(description: "onClose")
        let closeError = Collector<String>()
        let subscription = Transport.subscribe(
            to: path,
            sinceSeq: 7,
            onResponse: { received.append($0) },
            onClose: { error in
                if let error { closeError.append("\(error)") }
                closed.fulfill()
            })
        wait(for: [closed], timeout: 5)

        XCTAssertEqual(closeError.all, [], "the daemon ended the stream; that is not an error")
        XCTAssertEqual(received.all.map(\.nextSeq), [2, 3, 4])
        XCTAssertEqual(received.all.compactMap { $0.events?.first?.seq }, [1, 2, 3])
        XCTAssertEqual(seenRequest.all.map(\.cmd), ["events.subscribe"])
        XCTAssertEqual(seenRequest.all.first?.sinceSeq, 7)
        XCTAssertFalse(subscription.isRunning)

        // Ordinary requests still take the one-shot path on the same server.
        XCTAssertEqual(try Transport.send(Request(cmd: "ping"), to: path, timeout: 5).message,
                       "ordinary")
    }

    func testEventDeliveryReplaysThroughTheRealStreamingTransport() throws {
        let path = freshSocketPath()
        let bus = EventBus(capacity: 8)
        bus.publish(kind: "first", session: "other", detail: ["content": "private"])
        bus.publish(kind: "second", session: "mine", detail: ["content": "visible"])
        let server = Transport.Server(path: path) { _ in .success() }
        server.streamHandler = { request, write in
            let delivery = EventStreamDelivery(bus: bus, since: request.sinceSeq ?? 0,
                redactor: { EventBus.redacting($0, coveredSessions: ["mine"], operatorScope: false) }) { response in
                    let delivered = write(response)
                    return delivered && response.events?.last?.seq != 2
                }
            await delivery.waitUntilClosed()
        }
        try server.start()
        defer { server.stop() }
        let received = Collector<Response>()
        let closed = expectation(description: "stream finished")
        let subscription = Transport.subscribe(to: path, sinceSeq: 0, onResponse: { received.append($0) },
            onClose: { error in XCTAssertNil(error); closed.fulfill() })
        wait(for: [closed], timeout: 3)
        XCTAssertFalse(subscription.isRunning)
        XCTAssertEqual(received.all.compactMap(\.nextSeq), [0, 1, 2])
        let events = received.all.flatMap { $0.events ?? [] }
        XCTAssertEqual(events.map(\.seq), [1, 2])
        XCTAssertEqual(events.first?.detail, [:])
        XCTAssertEqual(events.last?.detail, ["content": "visible"])
        XCTAssertEqual(bus.subscriberCount, 0)
    }

    func testCancelClosesTheConnectionAndTheServerWriterReportsIt() throws {
        let path = freshSocketPath()
        let server = Transport.Server(path: path) { _ in .success() }
        let writerSawPeerGone = expectation(description: "writer returned false")
        let writesAfterFirst = Collector<Bool>()
        server.streamHandler = { _, write in
            guard write(Self.event(1)) else { return }
            // Keep emitting until the peer is gone; bounded so a failure cannot spin forever.
            for _ in 0..<200 {
                try? await Task.sleep(nanoseconds: 25_000_000)
                let delivered = write(Self.event(2))
                writesAfterFirst.append(delivered)
                if !delivered {
                    writerSawPeerGone.fulfill()
                    return
                }
            }
        }
        try server.start()
        defer { server.stop() }

        let firstLine = expectation(description: "first line")
        firstLine.assertForOverFulfill = false
        let closed = expectation(description: "onClose")
        let closeError = Collector<String>()
        let subscription = Transport.subscribe(
            to: path,
            sinceSeq: 0,
            onResponse: { _ in firstLine.fulfill() },
            onClose: { error in
                if let error { closeError.append("\(error)") }
                closed.fulfill()
            })
        XCTAssertTrue(subscription.isRunning)
        wait(for: [firstLine], timeout: 5)

        subscription.cancel()
        wait(for: [closed, writerSawPeerGone], timeout: 5)
        XCTAssertFalse(subscription.isRunning)
        XCTAssertEqual(closeError.all, [], "cancel is not an error")
        XCTAssertEqual(writesAfterFirst.all.last, false)
        // Cancelling twice is harmless.
        subscription.cancel()
    }

    func testIdleSubscriberWaitsForItsFirstEventAndCancelsCleanly() throws {
        let path = freshSocketPath()
        let release = Gate()
        let server = Transport.Server(path: path) { _ in .success() }
        server.streamHandler = { _, write in
            // Ensure the new nonblocking reader encounters EAGAIN before the first event.
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard write(Self.event(1)) else { return }
            await release.waitUntilOpen()
        }
        try server.start()
        defer { release.release(); server.stop() }
        let delivered = expectation(description: "event after idle")
        let closed = expectation(description: "idle subscription cancelled")
        let subscription = Transport.subscribe(to: path, sinceSeq: 0, onResponse: { response in
            XCTAssertEqual(response.events?.first?.seq, 1)
            delivered.fulfill()
        }, onClose: { error in
            XCTAssertNil(error)
            closed.fulfill()
        })
        wait(for: [delivered], timeout: 3)
        XCTAssertTrue(subscription.isRunning)
        subscription.cancel()
        wait(for: [closed], timeout: 3)
        XCTAssertFalse(subscription.isRunning)
    }

    func testStreamingCeilingRejectsTheSurplusSubscriberWithoutStarvingRequests() throws {
        let path = freshSocketPath()
        let cap = Transport.Server.maximumStreamingConnections
        let gate = Gate()
        let server = Transport.Server(path: path) { .success($0.cmd) }
        server.streamHandler = { _, write in
            gate.arrive()
            await gate.waitUntilOpen()
            _ = write(Self.event(1))
        }
        try server.start()
        defer { server.stop() }

        var subscriptions: [Transport.EventSubscription] = []
        defer { for subscription in subscriptions { subscription.cancel() } }
        let allClosed = expectation(description: "all subscribers closed")
        allClosed.expectedFulfillmentCount = cap
        for _ in 0..<cap {
            subscriptions.append(Transport.subscribe(
                to: path, sinceSeq: 0,
                onResponse: { _ in },
                onClose: { _ in allClosed.fulfill() }))
        }
        let admitted = Date().addingTimeInterval(10)
        while gate.arrived < cap, Date() < admitted { usleep(10_000) }
        XCTAssertEqual(gate.arrived, cap, "every slot up to the ceiling must be usable")

        // The surplus subscriber is answered, not parked.
        let extra = try XCTUnwrap(Self.connectRawPatiently(to: path))
        defer { close(extra) }
        try Self.sendLine(Request(cmd: "events.subscribe"), on: extra)
        let refusal = try XCTUnwrap(Self.readResponse(on: extra, seconds: 5))
        XCTAssertFalse(refusal.ok)
        XCTAssertTrue(refusal.error?.contains("too many event subscribers") == true,
                      "unexpected reply: \(refusal.error ?? "ok")")

        // Subscribers hold their own ceiling: ordinary requests are unaffected.
        let started = Date()
        let ping = try Transport.send(Request(cmd: "ping"), to: path, timeout: 5)
        XCTAssertEqual(ping.message, "ping")
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)

        gate.release()
        wait(for: [allClosed], timeout: 10)
    }

    func testSubscribeAgainstNoDaemonReportsTheErrorThroughOnClose() {
        let path = freshSocketPath()
        let closed = expectation(description: "onClose")
        let closeError = Collector<String>()
        let subscription = Transport.subscribe(
            to: path, sinceSeq: 0,
            onResponse: { _ in XCTFail("nothing can arrive without a daemon") },
            onClose: { error in
                closeError.append(error.map { "\($0)" } ?? "nil")
                closed.fulfill()
            })
        wait(for: [closed], timeout: 5)
        XCTAssertFalse(subscription.isRunning)
        XCTAssertTrue(closeError.all.first?.contains("no SpaceO daemon") == true,
                      "got: \(closeError.all)")
    }
}
