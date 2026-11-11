import XCTest
@testable import SpaceOKit

/// Refusal uses the same production dispatch seams; diagnostics use a memory provider so the
/// safe suite never connects to the host pasteboard service.
final class PasteboardGuardProductionTests: XCTestCase {
    private let shortcuts = ["cmd+c", "cmd+x", "cmd+v", "cmd+shift+c", "cmd+option+x", "cmd+shift+v"]

    private func assertRefusal(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
        guard case .unsupportedTarget(let message) = error as? SpaceOError else {
            return XCTFail("expected clipboard refusal, got \(error)", file: file, line: line)
        }
        XCTAssertTrue(message.contains("isolated per-session clipboard"), file: file, line: line)
    }

    func testNativeCopyCutAndPasteFailClosedBeforePosting() throws {
        for shortcut in shortcuts {
            XCTAssertThrowsError(try InputRouter.deliverKey(KeyCombo.parse(shortcut)) {
                XCTFail("a refused key must never reach delivery")
            }) { assertRefusal($0) }
        }
    }

    func testPublicNativeKeysRefuseBeforeAnyHostInputOrPasteboardAccess() throws {
        for shortcut in shortcuts {
            XCTAssertThrowsError(try InputRouter.key(KeyCombo.parse(shortcut), to: getpid())) {
                assertRefusal($0)
            }
        }
    }

    func testDevToolsCopyCutAndPasteFailClosedBeforeAnyCDPDispatch() async throws {
        for shortcut in shortcuts {
            do {
                try await ChromiumBridge.deliverKey(KeyCombo.parse(shortcut)) { _ in
                    XCTFail("a refused key must never reach CDP")
                }
                XCTFail("expected refusal")
            } catch { assertRefusal(error) }
        }
    }

    func testOrdinaryNativeKeyStillReachesDelivery() throws {
        var deliveries = 0
        try InputRouter.deliverKey(KeyCombo.parse("shift+c")) { deliveries += 1 }
        XCTAssertEqual(deliveries, 1)
    }

    func testOrdinaryAndShiftedWebKeysStillDispatchWithCorrectDOMKey() async throws {
        var events: [[String: Any]] = []
        try await ChromiumBridge.deliverKey(KeyCombo.parse("shift+c")) { events.append($0) }
        XCTAssertEqual(events.compactMap { $0["type"] as? String }, ["rawKeyDown", "keyUp"])
        for event in events {
            XCTAssertEqual(event["key"] as? String, "C")
            XCTAssertEqual(event["code"] as? String, "KeyC")
            XCTAssertEqual(event["modifiers"] as? Int, 8)
            XCTAssertNil(event["commands"])
        }
    }

    func testDiagnosticSnapshotsBoundCountsAndBytes() {
        let pasteboard = MemoryDiagnosticPasteboard()
        _ = pasteboard.write([["first": Data(repeating: 1, count: 6)],
                              ["second": Data(repeating: 2, count: 6)]])
        let limits: [(PasteboardGuard.Limits, PasteboardGuard.SnapshotFailure)] = [
            (.init(maximumItems: 1), .tooManyItems(limit: 1)),
            (.init(maximumTypes: 1), .tooManyTypes(limit: 1)),
            (.init(maximumBytesPerValue: 5), .valueTooLarge(limit: 5)),
            (.init(maximumBytesPerValue: 10, maximumTotalBytes: 10), .aggregateTooLarge(limit: 10)),
        ]
        for (limit, expected) in limits {
            let snapshot = PasteboardGuard.snapshot(from: pasteboard, limits: limit)
            XCTAssertEqual(snapshot.failure, expected)
            XCTAssertTrue(snapshot.items.isEmpty)
        }
        let exact = PasteboardGuard.snapshot(from: pasteboard, limits: .init(
            maximumItems: 2, maximumTypes: 2, maximumBytesPerValue: 6, maximumTotalBytes: 12))
        XCTAssertTrue(exact.isComplete)
        XCTAssertEqual(exact.typeCount, 2)
    }

    func testUnavailableOrChangedValuesCannotBeRestored() {
        let pasteboard = MemoryDiagnosticPasteboard()
        pasteboard.replace([.init(types: { ["missing"] }, data: { _ in nil })])
        let unavailable = PasteboardGuard.snapshot(from: pasteboard)
        XCTAssertEqual(unavailable.failure, .valueUnavailable)
        pasteboard.setString("newer user value")
        XCTAssertFalse(PasteboardGuard.restore(unavailable, to: pasteboard))
        XCTAssertEqual(pasteboard.string, "newer user value")

        pasteboard.replace([.init(types: { ["changing"] }, data: { _ in
            pasteboard.setString("concurrent copy")
            return Data([1])
        })])
        let changed = PasteboardGuard.snapshot(from: pasteboard)
        XCTAssertEqual(changed.failure, .changedDuringCapture)
        XCTAssertFalse(PasteboardGuard.restore(changed, to: pasteboard))
        XCTAssertEqual(pasteboard.string, "concurrent copy")
    }

    func testDiagnosticTimeoutCoversMetadataAndValuesWithOneWorkerMaximum() {
        for stage in ["open", "changeCount", "items", "types", "value"] {
            let pasteboard = MemoryDiagnosticPasteboard()
            let started = DispatchSemaphore(value: 0)
            let release = DispatchSemaphore(value: 0)
            let finished = DispatchSemaphore(value: 0)
            let stall = {
                started.signal()
                _ = release.wait(timeout: .now() + 2)
                finished.signal()
            }
            switch stage {
            case "open": break
            case "changeCount": pasteboard.beforeChangeCount = stall
            case "items": pasteboard.beforeItems = stall
            case "types": pasteboard.replace([.init(types: { stall(); return ["x"] }, data: { _ in Data([1]) })])
            default: pasteboard.replace([.init(types: { ["x"] }, data: { _ in stall(); return Data([1]) })])
            }
            let limits = PasteboardGuard.Limits(snapshotTimeout: 0.03)
            let start = DispatchTime.now().uptimeNanoseconds
            let snapshot = PasteboardGuard.boundedSnapshot(limits: limits) {
                if stage == "open" { stall() }
                return pasteboard
            }
            XCTAssertEqual(snapshot.failure, .timedOut, stage)
            XCTAssertEqual(started.wait(timeout: .now() + 1), .success, stage)
            // Another provider cannot start while the timed-out worker remains inside IPC.
            let untouched = MemoryDiagnosticPasteboard()
            untouched.beforeItems = { XCTFail("a second provider worker was started") }
            for _ in 0..<8 {
                XCTAssertEqual(PasteboardGuard.snapshot(from: untouched, limits: limits).failure, .timedOut)
            }
            XCTAssertLessThan(DispatchTime.now().uptimeNanoseconds - start, 1_000_000_000)
            release.signal()
            XCTAssertEqual(finished.wait(timeout: .now() + 1), .success)
            // Wait for the single worker to leave and release its gate before the next fixture.
            let recovery = MemoryDiagnosticPasteboard()
            let deadline = Date().addingTimeInterval(1)
            var recovered = false
            repeat {
                recovered = PasteboardGuard.snapshot(from: recovery).isComplete
                if !recovered { Thread.sleep(forTimeInterval: 0.001) }
            } while !recovered && Date() < deadline
            XCTAssertTrue(recovered, stage)
        }
    }

    func testZeroTimeoutDoesNotStartProviderWork() {
        let pasteboard = MemoryDiagnosticPasteboard()
        pasteboard.beforeChangeCount = { XCTFail("zero-budget request touched provider") }
        XCTAssertEqual(PasteboardGuard.snapshot(from: pasteboard, limits: .init(snapshotTimeout: 0)).failure, .timedOut)
    }

    func testIncompleteSnapshotRestoreDoesNotOpenTheSystemPasteboard() {
        let incomplete = PasteboardGuard.Snapshot(items: [], changeCount: 0, failure: .timedOut)
        XCTAssertFalse(PasteboardGuard.restore(incomplete))
    }
}
