import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

final class ScreenshotCaptureTests: XCTestCase {
    private final class Display: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 97_301
        private let lock = NSLock()
        private var attached = true
        private var frame = CGRect(x: 0, y: 0, width: 640, height: 480)
        var bounds: CGRect { lock.withLock { frame } }
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        func move() { lock.withLock { frame.origin.x += 100 } }
    }
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ContinuousClock.now
        var now: ContinuousClock.Instant { lock.withLock { value } }
        func advance(_ seconds: Double) { lock.withLock { value = value.advanced(by: .seconds(seconds)) } }
    }
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [Int] = []
        var values: [Int] { lock.withLock { stored } }
        func record(_ value: Int) { lock.withLock { stored.append(value) } }
    }
    private final class Suspended: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?
        private var calls = 0
        let entered: XCTestExpectation
        init(_ entered: XCTestExpectation) { self.entered = entered }
        var count: Int { lock.withLock { calls } }
        func frame(_ source: ScreenshotCapture.Source) async throws -> ScreenshotCapture.Frame {
            lock.withLock { calls += 1 }
            await withCheckedContinuation { continuation in
                lock.withLock { self.continuation = continuation }
                entered.fulfill()
            }
            return try ScreenshotCaptureTests.frame(source)
        }
        func release() {
            let value = lock.withLock { defer { continuation = nil }; return continuation }
            value?.resume()
        }
    }

    private static func frame(_ source: ScreenshotCapture.Source) throws -> ScreenshotCapture.Frame {
        let rect: CGRect
        let scale: Double
        let windowID: UInt32?
        switch source {
        case .window(let window, let requested): rect = window.frame; scale = requested; windowID = window.windowID
        case .region(_, let tile, let subRect, let requested, _):
            rect = subRect.map { CGRect(x: tile.minX + $0.minX, y: tile.minY + $0.minY,
                                       width: $0.width, height: $0.height).intersection(tile) } ?? tile
            scale = requested
            windowID = nil
        }
        let dimensions = try Capture.validatedDimensions(width: rect.width, height: rect.height, scale: scale)
        let context = try XCTUnwrap(CGContext(data: nil, width: dimensions.width, height: dimensions.height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: dimensions.width, height: dimensions.height))
        return ScreenshotCapture.Frame(image: try XCTUnwrap(context.makeImage()), geometry: ImageGeometry(
            origin: windowID == nil ? "tile" : "window", scale: scale,
            pixelWidth: dimensions.width, pixelHeight: dimensions.height,
            pointWidth: rect.width, pointHeight: rect.height, originX: rect.minX, originY: rect.minY, windowID: windowID))
    }

    private func manager(_ capture: ScreenshotCapture, display: Display = Display(),
                         apps: [LaunchedApp] = [], windowDriver: SessionWindowDriver? = nil) async throws -> (SessionManager, AgentSession) {
        let stage = Stage(testingBacking: display, onlineDisplayIDs: { display.valid ? [display.displayID] : [] })
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: display.bounds.size,
            stageFactory: { _, _, _, _ in stage }, stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let manager = SessionManager(pool: pool, runJanitor: false, screenshotCapture: capture,
            sessionFactory: { id, slot in
                try AgentSession(id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: windowDriver ?? SessionWindowDriver(windows: { _ in [] }, userDisplayBounds: { nil },
                        move: { _, _ in }, liveBounds: { _ in nil }), initialApps: apps)
            })
        return (manager, try await manager.create(name: "screenshot"))
    }
    private func drain(_ capture: ScreenshotCapture) async throws {
        for _ in 0..<200 {
            if capture.isQuiescent { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("released worker did not retire")
    }
    private func request(_ session: AgentSession, output: URL? = nil) -> Request {
        var request = Request(cmd: "screenshot")
        request.session = session.id
        request.full = true
        request.memory = output == nil
        request.output = output?.path
        return request
    }

    func testTimedOutCaptureCannotPublishOrAccumulateWorkAndTeardownRetries() async throws {
        let entered = expectation(description: "capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = ScreenshotCapture(timeout: 0.03, provider: { try await provider.frame($0) })
        let (manager, session) = try await manager(capture)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        try Data("preserve".utf8).write(to: path)
        let request = request(session, output: path)
        let pending = Task { await manager.handle(request) }
        await fulfillment(of: [entered], timeout: 1)
        let response = await pending.value
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "capture_failed")
        XCTAssertTrue(response.error?.contains("timed out") == true)
        for _ in 0..<10 {
            let busy = await manager.handle(request)
            XCTAssertEqual(busy.errorCode, "capture_failed")
            XCTAssertTrue(busy.error?.contains("still running") == true)
        }
        XCTAssertEqual(provider.count, 1)
        let ping = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(ping.ok)
        let incomplete = try await manager.destroyAll(quitApps: false)
        XCTAssertFalse(incomplete.isComplete)
        XCTAssertTrue(session.teardownPending)
        provider.release()
        try await drain(capture)
        XCTAssertEqual(try Data(contentsOf: path), Data("preserve".utf8))
        let complete = try await manager.destroyAll(quitApps: false)
        XCTAssertTrue(complete.isComplete)
    }

    func testEncodingTimeoutRetainsTicketAndNeverPublishesLateBytes() async throws {
        let entered = expectation(description: "encoding entered")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let capture = ScreenshotCapture(timeout: 0.05, provider: { try Self.frame($0) }, encoder: { _, _ in
            entered.fulfill()
            _ = release.wait(timeout: .now() + 2)
            return Data("late PNG".utf8)
        })
        let (manager, session) = try await manager(capture)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let request = request(session, output: path)
        let pending = Task { await manager.handle(request) }
        await fulfillment(of: [entered], timeout: 1)
        let response = await pending.value
        XCTAssertEqual(response.errorCode, "capture_failed")
        XCTAssertFalse(capture.isQuiescent)
        let report = session.destroy(quitApps: false, timeout: 0)
        XCTAssertFalse(report.isComplete)
        release.signal()
        try await drain(capture)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
        let cleanup = try await manager.destroyAll(quitApps: false)
        XCTAssertTrue(cleanup.isComplete)
    }

    func testCaptureAndEncodingSpendOneBudgetEvenIfTimerHasNotFired() async throws {
        let clock = Clock()
        let owner = SessionCaptureWork()
        let limits = Counter()
        let capture = ScreenshotCapture(now: { clock.now }, provider: { source in
            clock.advance(8)
            return try Self.frame(source)
        }, encoder: { _, maximumBytes in
            limits.record(maximumBytes)
            clock.advance(8)
            return Data([1])
        })
        let budget = capture.makeBudget()
        let window = WindowRef(windowID: 1, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 16, height: 16))
        let image = try await capture.capture(.window(window, scale: 1), budget: budget, lease: owner.begin())
        XCTAssertEqual(try budget.remaining(), 7, accuracy: 0.001)
        do {
            _ = try await capture.prepare(image.image, tags: nil, memory: false, budget: budget, lease: owner.begin())
            XCTFail("encoding must not renew the capture budget")
        } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
        XCTAssertEqual(limits.values, [64 * 1_048_576])
        XCTAssertTrue(owner.isQuiescent)
        XCTAssertTrue(capture.isQuiescent)
    }

    func testMemoryAndFilePNGResultsRespectTheirLimits() async throws {
        let limits = Counter()
        let capture = ScreenshotCapture(provider: { try Self.frame($0) }, encoder: { image, maximumBytes in
            limits.record(maximumBytes)
            return try Capture.pngData(image, maximumBytes: maximumBytes)
        })
        let (manager, session) = try await manager(capture)
        let memory = await manager.handle(request(session))
        XCTAssertTrue(memory.ok, memory.error ?? "")
        let bytes = try XCTUnwrap(memory.imageBase64.flatMap { Data(base64Encoded: $0) })
        XCTAssertEqual(Array(bytes.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        XCTAssertEqual(memory.capture?.persistence, "memory")
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let file = await manager.handle(request(session, output: path))
        XCTAssertTrue(file.ok, file.error ?? "")
        XCTAssertEqual(file.path, path.path)
        XCTAssertEqual(try Data(contentsOf: path), bytes)
        XCTAssertEqual(limits.values, [5 * 1_048_576, 64 * 1_048_576])
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testCaptureTimestampSurvivesProcessingFileSaveWireAndMCP() async throws {
        let observed = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = Clock()
        let capture = ScreenshotCapture(now: { clock.now }, provider: { source in
            let frame = try Self.frame(source)
            return ScreenshotCapture.Frame(image: frame.image, geometry: frame.geometry, capturedAt: observed)
        }, encoder: { image, limit in
            // Model seconds of processing without sleeping or changing the machine's clock.
            clock.advance(4)
            return try Capture.pngData(image, maximumBytes: limit)
        })
        let (manager, session) = try await manager(capture)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        for destination in [nil, path] as [URL?] {
            let response = await manager.handle(request(session, output: destination))
            XCTAssertTrue(response.ok, response.error ?? "")
            let wire = try Wire.decoder.decode(Response.self, from: Wire.encoder.encode(response))
            let receipt = try XCTUnwrap(wire.capture)
            XCTAssertEqual(receipt.capturedAt, observed)
            XCTAssertEqual(receipt.freshness, "unknown")
            XCTAssertEqual(receipt.visibility, "unknown")
            XCTAssertEqual(receipt.presentationVerification, "unverified")
            XCTAssertEqual(receipt.persistence, destination == nil ? "memory" : "file")
            let rendered = MCPServer.render(wire)
            let line = try XCTUnwrap(rendered.split(separator: "\n").first { $0.hasPrefix("capture: ") })
            let json = Data(line.dropFirst("capture: ".count).utf8)
            let exposed = try Wire.decoder.decode(CaptureReceipt.self, from: json)
            XCTAssertEqual(exposed.capturedAt, observed, "agent-visible metadata must retain the image's observation time")
            XCTAssertEqual(exposed.presentationVerification, "unverified")
        }
        _ = try await manager.destroyAll(quitApps: false)
    }


    func testScreenshotCreatesMissingParentChainAndNamesBlockedDirectory() async throws {
        let capture = ScreenshotCapture(provider: { try Self.frame($0) })
        let (manager, session) = try await manager(capture)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let output = root.appendingPathComponent("missing/deep/diag.png")
        let response = await manager.handle(request(session, output: output))
        XCTAssertTrue(response.ok, response.error ?? "")
        let bytes = try Data(contentsOf: output)
        XCTAssertEqual(Array(bytes.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        let blocker = root.appendingPathComponent("file")
        try Data("preserve".utf8).write(to: blocker)
        let blocked = blocker.appendingPathComponent("missing/diag.png")
        let failure = await manager.handle(request(session, output: blocked))
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.errorCode, "capture_failed")
        XCTAssertTrue(failure.error?.contains(blocked.deletingLastPathComponent().path) == true)
        XCTAssertEqual(try Data(contentsOf: blocker), Data("preserve".utf8))
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testGeometryChangedDuringEncodingRefusesPublication() async throws {
        let display = Display()
        let capture = ScreenshotCapture(provider: { try Self.frame($0) }, encoder: { image, limit in
            display.move()
            return try Capture.pngData(image, maximumBytes: limit)
        })
        let (manager, session) = try await manager(capture, display: display)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let response = await manager.handle(request(session, output: path))
        XCTAssertEqual(response.errorCode, "stale_geometry")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testCancellationKeepsNativeTicketUntilCallbackReturns() async throws {
        let entered = expectation(description: "capture entered")
        let provider = Suspended(entered)
        defer { provider.release() }
        let capture = ScreenshotCapture(provider: { try await provider.frame($0) })
        let owner = SessionCaptureWork()
        let window = WindowRef(windowID: 1, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 16, height: 16))
        let request = Task { try await capture.capture(.window(window, scale: 1), budget: capture.makeBudget(), lease: owner.begin()) }
        await fulfillment(of: [entered], timeout: 1)
        request.cancel()
        do { _ = try await request.value; XCTFail("cancelled capture") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(owner.isQuiescent)
        XCTAssertFalse(capture.isQuiescent)
        provider.release()
        try await drain(capture)
        XCTAssertTrue(owner.isQuiescent)
    }

    func testExpiredBudgetReleasesAdmissionWithoutStartingProvider() async throws {
        let clock = Clock()
        let capture = ScreenshotCapture(now: { clock.now }, provider: { _ in
            XCTFail("expired capture must not start"); throw CancellationError()
        })
        let budget = capture.makeBudget()
        clock.advance(15)
        let owner = SessionCaptureWork()
        let window = WindowRef(windowID: 1, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 16, height: 16))
        do {
            _ = try await capture.capture(.window(window, scale: 1), budget: budget, lease: owner.begin())
            XCTFail("expired capture")
        } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
        XCTAssertTrue(owner.isQuiescent)
        XCTAssertTrue(capture.isQuiescent)
    }

    func testOversizedEncodingIsRejectedBeforeBase64Publication() async throws {
        let capture = ScreenshotCapture(provider: { try Self.frame($0) }, encoder: { _, maximumBytes in
            Data(count: maximumBytes + 1)
        })
        let (manager, session) = try await manager(capture)
        let response = await manager.handle(request(session))
        XCTAssertEqual(response.errorCode, "capture_failed")
        XCTAssertTrue(response.error?.contains("PNG exceeds") == true)
        XCTAssertNil(response.imageBase64)
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testExplicitNewWindowIsComparedToItsResolvedGeometry() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        final class Windows: @unchecked Sendable {
            let lock = NSLock()
            var second = false
            func addSecond() { lock.withLock { second = true } }
            var hasSecond: Bool { lock.withLock { second } }
        }
        let state = Windows()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let first = WindowRef(windowID: 10, pid: identity.pid, title: "first", frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        let second = WindowRef(windowID: 11, pid: identity.pid, title: "second", frame: CGRect(x: 200, y: 100, width: 160, height: 120))
        let app = LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.capture-fixture",
            name: "fixture", url: URL(fileURLWithPath: "/fixture"), startedByUs: true,
            devToolsPort: nil, temporaryProfile: nil)
        let windows = SessionWindowDriver(windows: { _ in state.hasSecond ? [first, second] : [first] },
            userDisplayBounds: { nil }, move: { _, _ in }, liveBounds: { $0 == first.windowID ? first.frame : second.frame },
            liveOwnerPID: { _ in identity.pid })
        let capture = ScreenshotCapture(provider: { try Self.frame($0) })
        let (manager, session) = try await manager(capture, apps: [app], windowDriver: windows)
        _ = try session.refreshWindowsChecked()
        XCTAssertEqual(session.primaryWindow?.windowID, first.windowID)
        state.addSecond()
        var request = request(session)
        request.full = false
        request.window = second.windowID
        let response = await manager.handle(request)
        XCTAssertTrue(response.ok, response.error ?? "")
        XCTAssertEqual(response.image?.windowID, second.windowID)
        XCTAssertEqual(response.image?.originX, second.frame.minX)
        _ = try await manager.destroyAll(quitApps: false)
    }

    private final class TargetState: @unchecked Sendable {
        let lock = NSLock()
        let target: SpaceOKit.WindowRef
        private var owner: pid_t?
        private var bounds: CGRect?
        private var discoveries = 0
        init(_ target: SpaceOKit.WindowRef) { self.target = target; owner = target.pid; bounds = target.frame }
        var count: Int { lock.withLock { discoveries } }
        var liveOwner: pid_t? { lock.withLock { owner } }
        var liveBounds: CGRect? { lock.withLock { bounds } }
        func changeOwner(_ value: pid_t?) { lock.withLock { owner = value } }
        func move() { lock.withLock { bounds?.origin.x += 1 } }
        func disappear() { lock.withLock { bounds = nil } }
        func discover() throws -> [SpaceOKit.WindowRef] {
            try lock.withLock {
                discoveries += 1
                guard discoveries == 1 else {
                    throw AXWindowDiscovery.incomplete("window page is unavailable (AXError -25204)")
                }
                return [target]
            }
        }
    }

    private func targetFixture(_ capture: ScreenshotCapture, state: TargetState) async throws -> (SessionManager, AgentSession) {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.capture-fixture",
            name: "fixture", url: URL(fileURLWithPath: "/fixture"), startedByUs: true,
            devToolsPort: nil, temporaryProfile: nil)
        let driver = SessionWindowDriver(windows: { _ in [] }, userDisplayBounds: { nil }, move: { _, _ in },
            liveBounds: { _ in state.liveBounds }, liveOwnerPID: { _ in state.liveOwner },
            checkedWindows: { _, budget, _ in try budget.check(); return try state.discover() })
        let result = try await manager(capture, apps: [app], windowDriver: driver)
        _ = try result.1.refreshWindowsChecked()
        return result
    }

    func testKnownWindowCaptureDoesNotDependOnGlobalAXDiscovery() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let target = WindowRef(windowID: 10, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        let state = TargetState(target)
        let capture = ScreenshotCapture(provider: { try Self.frame($0) })
        let (manager, session) = try await targetFixture(capture, state: state)
        for explicit in [false, true] {
            var request = request(session)
            request.full = false
            if explicit { request.window = target.windowID }
            let response = await manager.handle(request)
            XCTAssertTrue(response.ok, response.error ?? "")
            XCTAssertEqual(response.image?.windowID, target.windowID)
        }
        XCTAssertEqual(state.count, 1, "a healthy target must not depend on another AX window-list read")
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testWindowCaptureRefusesImpreciseProcessIdentityBeforeNativeWork() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let identity = ProcessIdentity(pid: getpid(), startedAtMicroseconds: 0)
        let window = WindowRef(windowID: 10, pid: identity.pid, title: "fixture",
            frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        let app = LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.capture-fixture",
            name: "fixture", url: URL(fileURLWithPath: "/fixture"), startedByUs: true,
            devToolsPort: nil, temporaryProfile: nil)
        let windows = SessionWindowDriver(windows: { _ in [window] }, userDisplayBounds: { nil },
            move: { _, _ in }, liveBounds: { _ in window.frame }, liveOwnerPID: { _ in identity.pid })
        let capture = ScreenshotCapture(provider: { _ in
            XCTFail("a PID without its start time must not establish capture ownership")
            throw CancellationError()
        })
        let (manager, session) = try await manager(capture, apps: [app], windowDriver: windows)
        _ = try session.refreshWindowsChecked()
        var request = request(session)
        request.full = false
        let response = await manager.handle(request)
        XCTAssertEqual(response.errorCode, "window_not_ready")
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testWindowCaptureRefusesChangedOrUnknownOwnershipBeforeAndAfterWork() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let target = WindowRef(windowID: 10, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        for phase in ["before", "capture", "encoding"] {
            for owner in [nil, target.pid + 1] as [pid_t?] {
                let state = TargetState(target)
                let calls = Counter()
                let capture = ScreenshotCapture(provider: {
                    calls.record(1)
                    if phase == "capture" { state.changeOwner(owner) }
                    return try Self.frame($0)
                }, encoder: { image, limit in
                    if phase == "encoding" { state.changeOwner(owner) }
                    return try Capture.pngData(image, maximumBytes: limit)
                })
                let (manager, session) = try await targetFixture(capture, state: state)
                if phase == "before" { state.changeOwner(owner) }
                let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: path) }
                try Data("preserve".utf8).write(to: path)
                var request = request(session, output: path)
                request.full = false
                let response = await manager.handle(request)
                XCTAssertEqual(response.errorCode, "window_not_ready", phase)
                XCTAssertNil(response.imageBase64)
                XCTAssertEqual(try Data(contentsOf: path), Data("preserve".utf8))
                XCTAssertEqual(calls.values.count, phase == "before" ? 0 : 1)
                _ = try await manager.destroyAll(quitApps: false)
            }
        }
    }

    func testWindowCaptureRefusesMovementOrDisappearanceDuringEncoding() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let target = WindowRef(windowID: 10, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        for disappears in [false, true] {
            let state = TargetState(target)
            let capture = ScreenshotCapture(provider: { try Self.frame($0) }, encoder: { image, limit in
                if disappears { state.disappear() } else { state.move() }
                return try Capture.pngData(image, maximumBytes: limit)
            })
            let (manager, session) = try await targetFixture(capture, state: state)
            var request = request(session)
            request.full = false
            let response = await manager.handle(request)
            XCTAssertEqual(response.errorCode, disappears ? "window_not_ready" : "stale_geometry")
            XCTAssertNil(response.imageBase64)
            _ = try await manager.destroyAll(quitApps: false)
        }
    }

    func testUnknownCaptureWindowStillRequiresSuccessfulDiscovery() async throws {
        ProcessOwnership.reset()
        defer { ProcessOwnership.reset() }
        let target = WindowRef(windowID: 10, pid: getpid(), title: "fixture", frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        let state = TargetState(target)
        let capture = ScreenshotCapture(provider: { _ in XCTFail("unknown target must not capture"); throw CancellationError() })
        let (manager, session) = try await targetFixture(capture, state: state)
        var request = request(session)
        request.full = false
        request.window = 11
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(state.count, 2)
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testScaledFramebufferLimitRefusesBeforeNativeCapture() async throws {
        let maximum = try Capture.boundedDimensions(width: 8_192, height: 8_192)
        XCTAssertEqual(maximum.width * maximum.height, Capture.maximumPixelCount)
        XCTAssertThrowsError(try Capture.boundedDimensions(width: 8_192, height: 8_192, scale: 2))
        let capture = ScreenshotCapture(provider: { _ in XCTFail("oversized allocation must not start"); throw CancellationError() })
        let owner = SessionCaptureWork()
        let window = WindowRef(windowID: 1, pid: getpid(), title: "huge", frame: CGRect(x: 0, y: 0, width: 8_192, height: 8_192))
        do {
            _ = try await capture.capture(.window(window, scale: 4), budget: capture.makeBudget(), lease: owner.begin())
            XCTFail("oversized native framebuffer")
        } catch { XCTAssertTrue(error.localizedDescription.contains("pixels")) }
        XCTAssertTrue(owner.isQuiescent)
    }

    func testNegativeRegionSizeDoesNotBecomeAStandardizedRectangle() async throws {
        let capture = ScreenshotCapture(provider: { _ in XCTFail("invalid region must not capture"); throw CancellationError() })
        let (manager, session) = try await manager(capture)
        var request = request(session)
        request.x = 20; request.y = 20; request.width = -10; request.height = 10
        let response = await manager.handle(request)
        XCTAssertEqual(response.errorCode, "bad_request")
        _ = try await manager.destroyAll(quitApps: false)
    }

    func testTileAnnotationRefusesBeforeCapture() async throws {
        let capture = ScreenshotCapture(provider: { _ in XCTFail("unsupported request must not capture"); throw CancellationError() })
        let (manager, session) = try await manager(capture)
        var request = request(session)
        request.annotate = true
        let response = await manager.handle(request)
        XCTAssertEqual(response.errorCode, "bad_request")
        XCTAssertTrue(capture.isQuiescent)
        _ = try await manager.destroyAll(quitApps: false)
    }
}
