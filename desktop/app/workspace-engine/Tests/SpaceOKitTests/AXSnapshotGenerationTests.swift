import XCTest
import ApplicationServices
@testable import SpaceOKit

final class AXSnapshotGenerationTests: XCTestCase {
    func testIndexFromFirstWindowIsRefusedForSecondWindow() throws {
        var cache = AXSnapshotCache()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let first = window(id: 101, pid: identity.pid)
        let second = window(id: 202, pid: identity.pid)
        let element = AXUIElementCreateApplication(identity.pid)
        let snapshot = AXSnapshot(
            pid: identity.pid,
            windowID: first.windowID,
            processIdentity: identity,
            generation: cache.generation,
            nodes: [],
            elements: [0: element])
        try cache.store(snapshot)

        XCTAssertNotNil(
            try cache.element(at: 0, for: first, processIdentity: identity))
        XCTAssertThrowsError(
            try cache.element(at: 0, for: second, processIdentity: identity)
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("belongs to window 101"))
            XCTAssertTrue(error.localizedDescription.contains("requested window 202"))
            XCTAssertTrue(error.localizedDescription.contains("refusing the stale index"))
        }
    }

    /// Found by the agent journal: an index past the end was a terminal `bad_request` with no
    /// recovery. It is a recoverable misread; the error names the valid range and the snapshot
    /// stays usable for the corrected index.
    func testOutOfRangeIndexIsRecoverableAndLeavesTheSnapshotUsable() throws {
        var cache = AXSnapshotCache()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let target = window(id: 101, pid: identity.pid)
        let element = AXUIElementCreateApplication(identity.pid)
        try cache.store(AXSnapshot(pid: identity.pid, windowID: target.windowID, processIdentity: identity,
                                   generation: cache.generation, nodes: [],
                                   elements: [0: element, 1: element, 2: element]))
        XCTAssertThrowsError(try cache.element(at: 99, for: target, processIdentity: identity)) { error in
            XCTAssertEqual((error as? SpaceOError)?.code, "stale_snapshot")
            XCTAssertTrue(error.localizedDescription.contains("valid indices: 0–2"), error.localizedDescription)
            XCTAssertEqual((error as? SpaceOError)?.recovery?.tool, "spaceo_read_screen")
        }
        XCTAssertNotNil(try cache.element(at: 2, for: target, processIdentity: identity))
    }

    func testInvalidationExpiresEveryStoredIndex() throws {
        var cache = AXSnapshotCache()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let target = window(id: 101, pid: identity.pid)
        let oldGeneration = cache.generation
        let snapshot = AXSnapshot(
            pid: identity.pid,
            windowID: target.windowID,
            processIdentity: identity,
            generation: oldGeneration,
            nodes: [],
            elements: [0: AXUIElementCreateApplication(identity.pid)])
        try cache.store(snapshot)

        cache.invalidate()

        XCTAssertNotEqual(cache.generation, oldGeneration)
        XCTAssertThrowsError(
            try cache.element(at: 0, for: target, processIdentity: identity)
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("no current"))
            XCTAssertTrue(error.localizedDescription.contains("read the screen again"))
        }
    }

    func testStoreRejectsTraversalFromSupersededGeneration() throws {
        var cache = AXSnapshotCache()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let target = window(id: 101, pid: identity.pid)
        let staleGeneration = cache.generation
        cache.invalidate()
        let snapshot = AXSnapshot(
            pid: identity.pid,
            windowID: target.windowID,
            processIdentity: identity,
            generation: staleGeneration,
            nodes: [],
            elements: [:])

        XCTAssertThrowsError(try cache.store(snapshot)) { error in
            XCTAssertTrue(error.localizedDescription.contains("stale window generation"))
        }
    }

    private func window(id: CGWindowID, pid: pid_t) -> SpaceOKit.WindowRef {
        SpaceOKit.WindowRef(
            windowID: id,
            pid: pid,
            title: "window \(id)",
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    }
}
