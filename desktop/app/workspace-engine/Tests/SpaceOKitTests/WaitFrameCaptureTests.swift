import XCTest
import CoreGraphics
@testable import SpaceOKit

final class WaitFrameCaptureTests: XCTestCase {
    private final class Display: StageDisplayBacking {
        let displayID: CGDirectDisplayID = 97_201
        let bounds = CGRect(x: 0, y: 0, width: 640, height: 480)
        private let lock = NSLock()
        private var attached = true
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
    }
    private final class DiscoveryCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func increment() { lock.withLock { count += 1 } }
    }
    private let rect = CGRect(x: 0, y: 0, width: 16, height: 16)

    private func stage() -> Stage {
        let display = Display()
        return Stage(testingBacking: display, onlineDisplayIDs: { display.valid ? [display.displayID] : [] })
    }
    private static func image(width: Int = 16, height: Int = 16) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        return try XCTUnwrap(context.makeImage())
    }
    private final class Suspended: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?
        private var calls = 0
        let entered: XCTestExpectation
        init(_ entered: XCTestExpectation) { self.entered = entered }
        var count: Int { lock.withLock { calls } }
        func capture(_ rect: CGRect) async throws -> CGImage {
            let first = lock.withLock { calls += 1; return calls == 1 }
            if first {
                await withCheckedContinuation { continuation in
                    lock.withLock { self.continuation = continuation }
                    entered.fulfill()
                }
            }
            return try WaitFrameCaptureTests.image(width: Int(rect.width), height: Int(rect.height))
        }
        func release() {
            let value = lock.withLock { defer { continuation = nil }; return continuation }
            value?.resume()
        }
    }
    private func drain(_ capture: WaitFrameCapture) async throws {
        for _ in 0..<200 {
            if capture.isQuiescent { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("released worker did not retire")
    }

    func testTimeoutDiscardsLateFramesAndBoundsOutstandingWork() async throws {
        let entered = expectation(description: "capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = WaitFrameCapture { _, rect, _ in try await provider.capture(rect) }
        let owner = SessionCaptureWork()
        let display = stage()
        let rect = self.rect
        let first = Task { try await capture.hash(stage: display, rect: rect, foreign: .none,
                                                 timeout: 0.03, lease: owner.begin()) }
        await fulfillment(of: [entered], timeout: 1)
        do { _ = try await first.value; XCTFail("expected timeout") }
        catch { XCTAssertEqual(error as? WaitFrameCapture.Failure, .timeout) }
        XCTAssertFalse(owner.isQuiescent)
        for _ in 0..<25 {
            let rejectedOwner = SessionCaptureWork()
            do {
                _ = try await capture.hash(stage: display, rect: rect, foreign: .none,
                                           timeout: 1, lease: rejectedOwner.begin())
                XCTFail("expected busy")
            } catch { XCTAssertEqual(error as? WaitFrameCapture.Failure, .busy) }
            XCTAssertTrue(rejectedOwner.isQuiescent)
        }
        XCTAssertEqual(provider.count, 1)
        provider.release()
        try await drain(capture)
        XCTAssertTrue(owner.isQuiescent)
        let hash = try await capture.hash(stage: display, rect: rect, foreign: .none,
                                          timeout: 1, lease: owner.begin())
        XCTAssertEqual(hash, try Capture.validatedFrameHash(Self.image()))
        XCTAssertEqual(provider.count, 2, "a new probe must capture a new frame")
    }

    func testCancellationReturnsWhileCaptureTicketRemainsOwned() async throws {
        let entered = expectation(description: "capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = WaitFrameCapture { _, rect, _ in try await provider.capture(rect) }
        let owner = SessionCaptureWork()
        let display = stage()
        let rect = self.rect
        let request = Task { try await capture.hash(stage: display, rect: rect, foreign: .none,
                                                   timeout: 10, lease: owner.begin()) }
        await fulfillment(of: [entered], timeout: 1)
        request.cancel()
        do { _ = try await request.value; XCTFail("expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(owner.isQuiescent)
        XCTAssertFalse(capture.isQuiescent)
        provider.release()
        try await drain(capture)
        XCTAssertTrue(owner.isQuiescent)
    }

    func testRejectsIncompleteOrOversizedFramesAndReleasesTickets() async throws {
        let display = stage()
        for size in [15, 17] {
            let owner = SessionCaptureWork()
            let capture = WaitFrameCapture { _, _, _ in try Self.image(width: size) }
            do {
                _ = try await capture.hash(stage: display, rect: rect, foreign: .none,
                                           timeout: 1, lease: owner.begin())
                XCTFail("incorrect framebuffer extent")
            } catch { XCTAssertEqual(error as? WaitFrameCapture.Failure, .invalidImage) }
            XCTAssertTrue(owner.isQuiescent)
            XCTAssertTrue(capture.isQuiescent)
        }
    }

    func testRejectedAndCancelledAdmissionReleasesLeaseWithoutProviderWork() async throws {
        let display = stage()
        let owner = SessionCaptureWork()
        let capture = WaitFrameCapture { _, _, _ in XCTFail("provider must not start"); return try Self.image() }
        for timeout in [0, -1, .nan, .infinity, 61] {
            do { _ = try await capture.hash(stage: display, rect: rect, foreign: .none,
                                            timeout: timeout, lease: owner.begin()); XCTFail("invalid budget") }
            catch { }
            XCTAssertTrue(owner.isQuiescent)
            XCTAssertTrue(capture.isQuiescent)
        }
        let rect = self.rect
        let request = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await capture.hash(stage: display, rect: rect, foreign: .none,
                                           timeout: 1, lease: owner.begin())
        }
        do { _ = try await request.value; XCTFail("cancelled admission") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(owner.isQuiescent)
        XCTAssertTrue(capture.isQuiescent)
    }

    func testManagerWaitReturnsTimeoutAndBusyProbeHasNoStaleHash() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(pid: identity.pid, identity: identity,
            bundleIdentifier: "dev.spaceo.capture-test", name: "fixture",
            url: URL(fileURLWithPath: "/fixture"), startedByUs: true,
            devToolsPort: nil, temporaryProfile: nil)
        let discoveries = DiscoveryCounter()
        let display = stage()
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: display.bounds.size,
            stageFactory: { _, _, _, _ in display }, stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let entered = expectation(description: "manager capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = WaitFrameCapture { _, rect, _ in try await provider.capture(rect) }
        let manager = SessionManager(pool: pool, runJanitor: false, waitFrameCapture: capture,
            sessionFactory: { id, slot in
                try AgentSession(id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: SessionWindowDriver(windows: { _ in discoveries.increment(); return [] },
                        userDisplayBounds: { nil }, move: { _, _ in }, liveBounds: { _ in nil }),
                    initialApps: [app])
            })
        let session = try await manager.create(name: "capture-wait")
        let discoveryCount = discoveries.value
        var request = Request(cmd: "wait")
        request.session = session.id
        request.waitCondition = "stable_ms"
        request.waitValue = "100"
        request.timeout = 0.5
        let waiting = Task { await manager.handle(request) }
        await fulfillment(of: [entered], timeout: 1)
        let response = await waiting.value
        XCTAssertTrue(response.ok, response.message ?? "")
        XCTAssertEqual(response.wait?.outcome, "timeout")
        let busy = try await manager.probeNow(.stableMs(100), request: request)
        XCTAssertEqual(busy, .notYet(nil))
        XCTAssertEqual(provider.count, 1)
        XCTAssertEqual(discoveries.value, discoveryCount, "tile stability does not need an owned-window scan")
        let ping = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(ping.ok)
        let incomplete = try await manager.destroyAll(quitApps: false)
        XCTAssertFalse(incomplete.isComplete)
        XCTAssertEqual(incomplete.pendingSessionIDs, [session.id])
        provider.release()
        try await drain(capture)
        let complete = try await manager.destroyAll(quitApps: false)
        XCTAssertTrue(complete.isComplete)
    }

    func testManagerReportsIncompleteFramesAsCaptureFailures() async throws {
        let display = stage()
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: display.bounds.size,
            stageFactory: { _, _, _, _ in display }, stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let capture = WaitFrameCapture { _, _, _ in try Self.image() }
        let manager = SessionManager(pool: pool, runJanitor: false, waitFrameCapture: capture,
            sessionFactory: { id, slot in
                try AgentSession(id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: SessionWindowDriver(windows: { _ in [] }, userDisplayBounds: { nil },
                        move: { _, _ in }, liveBounds: { _ in nil }), initialApps: [])
            })
        let session = try await manager.create(name: "bad-frame")
        var request = Request(cmd: "wait")
        request.session = session.id
        request.waitCondition = "stable_ms"
        request.waitValue = "100"
        request.timeout = 0.5
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "capture_failed")
        XCTAssertTrue(response.error?.contains("complete requested tile") == true)
        let report = try await manager.destroyAll(quitApps: false)
        XCTAssertTrue(report.isComplete)
    }

    func testNativeCaptureFencesTeardownWithoutBlockingItsResponse() async throws {
        let display = stage()
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: display.bounds.size,
            stageFactory: { _, _, _, _ in display }, stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let slot = try pool.allocate()
        let session = try AgentSession(id: "capture", slot: slot,
            teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
            windowDriver: SessionWindowDriver(windows: { _ in [] }, userDisplayBounds: { nil },
                move: { _, _ in XCTFail("no movement") }, liveBounds: { _ in nil }), initialApps: [])
        let entered = expectation(description: "capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = WaitFrameCapture { _, rect, _ in try await provider.capture(rect) }
        let rect = self.rect
        let lease = try session.beginCaptureWork()
        let request = Task { try await capture.hash(stage: display, rect: rect, foreign: .none,
                                                   timeout: 0.03, lease: lease) }
        await fulfillment(of: [entered], timeout: 1)
        do { _ = try await request.value; XCTFail("expected timeout") }
        catch { XCTAssertEqual(error as? WaitFrameCapture.Failure, .timeout) }
        let started = ContinuousClock.now
        let report = session.destroy(quitApps: false, timeout: 0)
        XCTAssertLessThan(started.duration(to: .now), .seconds(1))
        XCTAssertFalse(report.isComplete)
        XCTAssertEqual(report.pendingSessionIDs, [session.id])
        XCTAssertEqual(report.stillAttachedDisplayIDs, [display.displayID])
        XCTAssertTrue(display.isValid)
        XCTAssertTrue(session.teardownPending, "empty sessions still retain pending capture resources")
        XCTAssertThrowsError(try session.beginCaptureWork())
        provider.release()
        try await drain(capture)
        XCTAssertTrue(session.teardownPending, "callback completion must not pretend teardown retried")
        XCTAssertTrue(session.destroy(quitApps: false, timeout: 0).isComplete)
        XCTAssertFalse(session.teardownPending)
        XCTAssertTrue(pool.release(slot, retainEmpty: false))
    }
}
