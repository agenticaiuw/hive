import XCTest
import CoreGraphics
@testable import SpaceOKit

final class RecordingFrameCaptureTests: XCTestCase {
    private final class Display: StageDisplayBacking {
        let displayID: CGDirectDisplayID = 97_101
        let bounds = CGRect(x: 100, y: 200, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
    }

    private func stage() -> Stage {
        let backing = Display()
        return Stage(testingBacking: backing, onlineDisplayIDs: { backing.valid ? [backing.displayID] : [] })
    }

    private static func image(width: Int = 16, height: Int = 16) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        return try XCTUnwrap(context.makeImage())
    }

    private final class SuspendedProvider: @unchecked Sendable {
        let started: XCTestExpectation
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?
        private var calls = 0
        init(started: XCTestExpectation) { self.started = started }
        var count: Int { lock.withLock { calls } }
        func image() async throws -> CGImage {
            let first = lock.withLock { calls += 1; return calls == 1 }
            if first {
                // Deliberately ignore task cancellation, like an uncooperative native callback.
                await withCheckedContinuation { continuation in
                    lock.withLock { self.continuation = continuation }
                    started.fulfill()
                }
            }
            return try RecordingFrameCaptureTests.image()
        }
        func release() {
            let pending = lock.withLock { defer { continuation = nil }; return continuation }
            pending?.resume()
        }
    }

    func testTimeoutCannotAccumulateCapturesAndLateResultIsDiscarded() async throws {
        let started = expectation(description: "native capture started")
        let provider = SuspendedProvider(started: started)
        // Warm the PNG encoder outside capture deadlines. The suspended provider forces
        // the timeout; a healthy recovery capture gets the normal production budget.
        _ = try Capture.pngData(Self.image(), maximumBytes: RecordingFrameCapture.maximumPNGBytes)
        let capture = RecordingFrameCapture { _, _, _, _ in try await provider.image() }
        let display = stage()
        let owner = SessionCaptureWork()
        let first = Task { try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin()) }
        await fulfillment(of: [started], timeout: 1)
        do { _ = try await first.value; XCTFail("expected timeout") }
        catch { XCTAssertEqual(error as? RecordingFrameCapture.Failure, .timeout) }
        XCTAssertFalse(owner.isQuiescent, "timed-out native work retains its capture ticket")
        for _ in 0..<25 {
            do { _ = try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin()); XCTFail("expected busy") }
            catch { XCTAssertEqual(error as? RecordingFrameCapture.Failure, .busy) }
        }
        XCTAssertEqual(provider.count, 1)
        provider.release()
        // Wait for the already-running worker to retire; do not restart a pending capture.
        var recovered = false
        let recoveryDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !recovered, ContinuousClock.now < recoveryDeadline {
            do {
                let data = try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin())
                XCTAssertFalse(data.isEmpty)
                recovered = true
                break
            } catch RecordingFrameCapture.Failure.busy {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        XCTAssertTrue(recovered)
        XCTAssertTrue(owner.isQuiescent)
        XCTAssertEqual(provider.count, 2)
    }

    func testCancellationReturnsBeforeNativeCallbackAndPreventsMoreWork() async throws {
        let started = expectation(description: "native capture started")
        let provider = SuspendedProvider(started: started)
        let capture = RecordingFrameCapture { _, _, _, _ in try await provider.image() }
        let display = stage()
        let owner = SessionCaptureWork()
        let first = Task { try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin()) }
        await fulfillment(of: [started], timeout: 1)
        first.cancel()
        do { _ = try await first.value; XCTFail("expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        do { _ = try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin()); XCTFail("expected busy") }
        catch { XCTAssertEqual(error as? RecordingFrameCapture.Failure, .busy) }
        XCTAssertEqual(provider.count, 1)
        XCTAssertFalse(owner.isQuiescent)
        provider.release()
    }

    func testCaptureRejectsBackendImageOutsideRequestedResolution() async throws {
        let display = stage()
        let owner = SessionCaptureWork()
        let capture = RecordingFrameCapture { _, _, _, _ in try Self.image(width: 481) }
        do { _ = try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin()); XCTFail("expected refusal") }
        catch { XCTAssertEqual(error as? RecordingFrameCapture.Failure, .invalidImage) }
        XCTAssertTrue(owner.isQuiescent)
    }

    func testLateProviderCannotBeatADelayedTimeoutCallback() async throws {
        final class Clock: @unchecked Sendable {
            let lock = NSLock()
            var value = ContinuousClock.now
            var now: ContinuousClock.Instant { lock.withLock { value } }
            func expire() { lock.withLock { value = value.advanced(by: .seconds(3)) } }
        }
        let clock = Clock()
        let capture = RecordingFrameCapture(now: { clock.now }) { _, _, _, _ in
            // Advance the observation clock without firing the real two-second timer.
            clock.expire()
            return try Self.image()
        }
        let display = stage()
        let owner = SessionCaptureWork()
        do {
            _ = try await capture.capture(stage: display, rect: display.bounds, foreign: .none, lease: owner.begin())
            XCTFail("late callback must not produce recorded evidence")
        } catch { XCTAssertEqual(error as? RecordingFrameCapture.Failure, .timeout) }
        XCTAssertTrue(owner.isQuiescent)
    }

    func testScaleBoundsFramebufferBeforeCaptureAndRejectsInvalidGeometry() throws {
        for size in [CGSize(width: 1, height: 1), CGSize(width: 16_000, height: 16_000), CGSize(width: 1, height: 16_000)] {
            let scale = try RecordingFrameCapture.scale(for: CGRect(origin: .zero, size: size))
            let pixels = try Capture.validatedDimensions(width: size.width, height: size.height, scale: scale)
            XCTAssertLessThanOrEqual(max(pixels.width, pixels.height), RecordingFrameCapture.maximumEdge)
            XCTAssertGreaterThan(scale, 0)
            XCTAssertLessThanOrEqual(scale, 1)
        }
        XCTAssertThrowsError(try RecordingFrameCapture.scale(for: .zero))
        XCTAssertThrowsError(try RecordingFrameCapture.scale(for: CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)))
    }
}
