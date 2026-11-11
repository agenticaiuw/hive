import Darwin
import Foundation
import XCTest
@testable import SpaceOKit

final class TransportDeadlineTests: XCTestCase {
    func testCancellablePollChecksStopWithoutSocketReadiness() {
        let pipe = Pipe()
        defer { try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close() }
        var checks = 0
        XCTAssertFalse(Transport.wait(fd: pipe.fileHandleForReading.fileDescriptor, for: Int16(POLLIN),
            deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds + 2_000_000_000,
            isCancelled: { checks += 1; return checks >= 3 }))
        XCTAssertEqual(checks, 3)
        XCTAssertFalse(Transport.wait(fd: pipe.fileHandleForReading.fileDescriptor, for: Int16(POLLIN),
            deadlineUptimeNanoseconds: 0, isCancelled: { false }))
    }

    func testCancellationInterruptsSubscriptionUploadBeforeSetupDeadline() throws {
        let uploadStarted = DispatchSemaphore(value: 0)
        let releasePeer = DispatchSemaphore(value: 0)
        try withPeer({ fd in
            var capacity: Int32 = 1_024
            setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &capacity, socklen_t(MemoryLayout<Int32>.size))
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, 2_000) > 0 else { XCTFail("upload never arrived"); return }
            var byte: UInt8 = 0
            guard read(fd, &byte, 1) == 1 else { XCTFail("upload was empty"); return }
            uploadStarted.signal()
            // Hold the peer open without draining it, keeping the client's write backpressured.
            _ = releasePeer.wait(timeout: .now() + 4)
        }, client: { path in
            var request = Request(cmd: "events.subscribe")
            request.text = String(repeating: "x", count: 900_000)
            let closed = expectation(description: "cancelled subscription closed once")
            let subscription = Transport.EventSubscription(path: path, sinceSeq: 0, request: request,
                onResponse: { _ in XCTFail("cancelled setup must not deliver responses") },
                onClose: { error in XCTAssertNil(error); closed.fulfill() })
            let setup = DispatchGroup()
            setup.enter()
            DispatchQueue.global().async { subscription.start(); setup.leave() }
            defer {
                releasePeer.signal()
                XCTAssertEqual(setup.wait(timeout: .now() + 3), .success)
            }
            XCTAssertEqual(uploadStarted.wait(timeout: .now() + 2), .success)
            XCTAssertEqual(setup.wait(timeout: .now()), .timedOut, "fixture must stall setup")
            XCTAssertFalse(subscription.isRunning, "a registered setup socket is not an active reader")
            subscription.cancel()
            XCTAssertEqual(setup.wait(timeout: .now() + 1), .success,
                           "cancel must wake the write instead of waiting for its five-second deadline")
            wait(for: [closed], timeout: 1)
            subscription.cancel()
            subscription.start()
            XCTAssertFalse(subscription.isRunning)
        })
    }

    /// A synthetic peer with bounded acceptance and nonblocking I/O; never the user's daemon.
    private func withPeer(
        _ serve: @escaping @Sendable (Int32) -> Void,
        client: (String) throws -> Void
    ) throws {
        let path = "/tmp/spaceo-deadline-\(getpid())-\(UUID().uuidString.prefix(8)).sock"
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        guard listener >= 0 else { return }
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
        guard bound == 0 else { return }
        XCTAssertEqual(listen(listener, 4), 0)
        let finished = expectation(description: "synthetic peer finished")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, 3_000) > 0 else {
                XCTFail("the synthetic peer never received a connection")
                return
            }
            let fd = accept(listener, nil, nil)
            guard fd >= 0 else { XCTFail("synthetic peer accept failed"); return }
            defer { close(fd) }
            var noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
                XCTFail("synthetic peer could not use nonblocking I/O")
                return
            }
            serve(fd)
        }
        defer { wait(for: [finished], timeout: 5) }
        try client(path)
    }

    func testExpiredWriterCannotEmitEvenWhenDescriptorIsWritable() throws {
        let pipe = Pipe()
        defer { try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close() }
        XCTAssertFalse(Transport.writeAll(Data("late\n".utf8),
            to: pipe.fileHandleForWriting.fileDescriptor, deadlineUptimeNanoseconds: 0))
        try pipe.fileHandleForWriting.close()
        XCTAssertTrue(pipe.fileHandleForReading.readDataToEndOfFile().isEmpty)
    }

    func testFragmentedResponseCannotExtendReadBudget() throws {
        try withPeer({ fd in
            let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
            guard Transport.readFrame(from: fd, deadlineUptimeNanoseconds: deadline) != nil else { return }
            guard Transport.writeAll(Data("{\"ok\":".utf8), to: fd,
                                     deadlineUptimeNanoseconds: deadline) else { return }
            usleep(220_000)
            guard Transport.writeAll(Data("true".utf8), to: fd,
                                     deadlineUptimeNanoseconds: deadline) else { return }
            usleep(220_000)
            _ = Transport.writeAll(Data("}\n".utf8), to: fd, deadlineUptimeNanoseconds: deadline)
        }, client: { path in
            XCTAssertThrowsError(try Transport.send(Request(cmd: "ping"), to: path, timeout: 0.3))
        })
    }

    func testUploadAndResponseShareOneBudget() throws {
        // Exceeds the Unix socket buffer so upload cannot complete before the peer drains it.
        let payload = Data(repeating: 120, count: 2 * 1_048_576)
        try withPeer({ fd in
            usleep(1_200_000)
            let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
            guard Transport.readFrame(from: fd, maximumBytes: 9 * 1_048_576,
                                      deadlineUptimeNanoseconds: deadline) != nil else {
                XCTFail("the complete upload must arrive before testing response-budget sharing")
                return
            }
            usleep(1_200_000)
            _ = Transport.writeAll(Data("ok\n".utf8), to: fd, deadlineUptimeNanoseconds: deadline)
        }, client: { path in
            // Each 1.2 s phase fits a 2 s budget; their sum does not. Leave enough upload
            // headroom that this tests budget sharing instead of hosted-runner throughput.
            XCTAssertThrowsError(try Transport.sendLinePayload(payload, to: path, timeout: 2,
                maximumRequestBytes: 9 * 1_048_576, maximumResponseBytes: 100))
        })
    }

    func testTimelyFragmentedResponseStillSucceeds() throws {
        try withPeer({ fd in
            let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
            guard Transport.readFrame(from: fd, deadlineUptimeNanoseconds: deadline) != nil else { return }
            for fragment in ["{\"ok\":", "true", "}\n"] {
                guard Transport.writeAll(Data(fragment.utf8), to: fd,
                                         deadlineUptimeNanoseconds: deadline) else { return }
            }
        }, client: { path in
            XCTAssertTrue(try Transport.send(Request(cmd: "ping"), to: path, timeout: 2).ok)
        })
    }
}
