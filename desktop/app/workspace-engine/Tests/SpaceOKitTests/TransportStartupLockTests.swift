import Darwin
import XCTest
@testable import SpaceOKit

final class TransportStartupLockTests: XCTestCase {
    private func withLockDescriptors(_ body: (Int32, Int32) throws -> Void) throws {
        let path = "/tmp/spaceo-start-\(UUID().uuidString).lock"
        let owner = open(path, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0o600)
        XCTAssertGreaterThanOrEqual(owner, 0)
        guard owner >= 0 else { return }
        defer { close(owner); unlink(path) }
        let contender = open(path, O_RDWR | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(contender, 0)
        guard contender >= 0 else { return }
        defer { close(contender) }
        try body(owner, contender)
    }

    func testContendedStartupLockTimesOutWithoutStealingIt() throws {
        try withLockDescriptors { owner, contender in
            XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), 0)
            var clock: UInt64 = 0
            var waits: [useconds_t] = []
            XCTAssertThrowsError(try Transport.Server.acquireStartupLock(contender,
                timeoutNanoseconds: 25_000_000, now: { clock }, pause: { duration in
                    waits.append(duration)
                    clock += UInt64(duration) * 1_000
                })) {
                guard case Transport.TransportError.busy = $0 else {
                    return XCTFail("expected a retryable busy error")
                }
            }
            XCTAssertEqual(waits, [10_000, 10_000, 5_000])
            XCTAssertEqual(flock(contender, LOCK_EX | LOCK_NB), -1,
                           "timing out must leave the owner's lock intact")
        }
    }

    func testCompetingStarterCanFinishInsideTheSharedWait() throws {
        try withLockDescriptors { owner, contender in
            XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), 0)
            var clock: UInt64 = 0
            try Transport.Server.acquireStartupLock(contender, timeoutNanoseconds: 30_000_000,
                now: { clock }, pause: { duration in
                    clock += UInt64(duration) * 1_000
                    XCTAssertEqual(flock(owner, LOCK_UN), 0)
                })
            XCTAssertEqual(clock, 10_000_000)
            XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), -1,
                           "the successor must own the lock until its startup completes")
        }
    }

    func testLockReleasedAtDeadlineDoesNotStartLate() throws {
        try withLockDescriptors { owner, contender in
            XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), 0)
            var clock: UInt64 = 0
            XCTAssertThrowsError(try Transport.Server.acquireStartupLock(contender,
                timeoutNanoseconds: 10_000_000, now: { clock }, pause: { duration in
                    clock += UInt64(duration) * 1_000
                    XCTAssertEqual(flock(owner, LOCK_UN), 0)
                }))
            XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), 0,
                           "the expired contender must not acquire the newly available lock")
        }
    }

    func testInvalidDescriptorDoesNotRetry() {
        XCTAssertThrowsError(try Transport.Server.acquireStartupLock(-1,
            pause: { _ in XCTFail("invalid descriptors are permanent failures") })) {
            guard case Transport.TransportError.socketFailed = $0 else {
                return XCTFail("expected a structured socket error")
            }
        }
    }

    func testStopCancelsPendingStartupAndLeavesNoStrandedSocket() async throws {
        let path = "/tmp/spaceo-start-\(UUID().uuidString).sock"
        let lockPath = path + ".lock"
        let owner = open(lockPath, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0o600)
        XCTAssertGreaterThanOrEqual(owner, 0)
        guard owner >= 0 else { return }
        defer { close(owner); unlink(lockPath); unlink(path) }
        XCTAssertEqual(flock(owner, LOCK_EX | LOCK_NB), 0)
        let server = Transport.Server(path: path) { _ in .success() }
        defer { server.stop() }
        let stopped = expectation(description: "pending start returns after stop")
        DispatchQueue.global().async {
            do {
                try server.start()
                XCTFail("startup should be cancelled")
            } catch {
                XCTAssertTrue(String(describing: error).contains("cancelled by stop"))
            }
            stopped.fulfill()
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while !server.startupInProgressForTesting, ContinuousClock.now < deadline {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(server.startupInProgressForTesting)
        XCTAssertThrowsError(try server.start(), "the same server cannot have concurrent starters")
        server.stop()
        await fulfillment(of: [stopped], timeout: 1)
        XCTAssertEqual(server.listeningDescriptorForTesting, -1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(flock(owner, LOCK_UN), 0)
        try server.start()
        XCTAssertGreaterThanOrEqual(server.listeningDescriptorForTesting, 0,
                                   "a cancelled start must not poison the next start")
    }

    func testServerRefusesPipeLockWithoutReplacingItOrCreatingASocket() throws {
        let path = "/tmp/spaceo-start-\(UUID().uuidString).sock"
        let lockPath = path + ".lock"
        XCTAssertEqual(mkfifo(lockPath, 0o600), 0)
        defer { unlink(lockPath); unlink(path) }
        let server = Transport.Server(path: path) { _ in .success() }
        XCTAssertThrowsError(try server.start())
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        var info = stat()
        XCTAssertEqual(lstat(lockPath, &info), 0)
        XCTAssertEqual(info.st_mode & S_IFMT, S_IFIFO)
    }
}
