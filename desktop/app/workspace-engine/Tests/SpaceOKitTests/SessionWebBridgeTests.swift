import CoreGraphics
import XCTest
@testable import SpaceOKit

final class SessionWebBridgeTests: XCTestCase {
    private final class DisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 91_501
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        private let lock = NSLock()
        private var attached = true
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
    }

    /// Bridge availability is ledger state. Prove it without launching Chrome or creating
    /// another virtual display just to query a fabricated process identifier.
    func testAdoptedBrowserHasNoManagedBridge() throws {
        let backing = DisplayBacking()
        let stage = Stage(testingBacking: backing,
            onlineDisplayIDs: { backing.valid ? [backing.displayID] : [] })
        defer { XCTAssertTrue(stage.invalidate(waitingForRemoval: 0)) }
        let identity = ProcessIdentity(pid: 99_999, startedAtMicroseconds: 1)
        let app = LaunchedApp(pid: identity.pid, identity: identity,
            bundleIdentifier: "com.google.Chrome", name: "Browser",
            url: URL(fileURLWithPath: "/Applications/Browser.app"), startedByUs: false,
            devToolsPort: nil, temporaryProfile: nil)
        let session = try AgentSession(id: "test-adopt-browser",
            slot: DisplayPool.Slot(stage: stage, index: 0, capacity: 1),
            teardownDriver: SessionAppTeardownDriver(
                isAlive: { _ in false },
                quit: { _, _ in XCTFail("adopted browser must never be quit") },
                waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
            windowDriver: SessionWindowDriver(windows: { _ in [] },
                userDisplayBounds: { nil },
                move: { _, _ in XCTFail("bridge lookup must never move a window") },
                liveBounds: { _ in nil }),
            watcherFactory: { _, _ in
                XCTFail("bridge lookup must never install a native watcher")
                throw SpaceOError.unsupportedTarget("test fixture has no native watcher")
            }, initialApps: [app])
        defer { XCTAssertTrue(session.destroy(quitApps: false).isComplete) }

        XCTAssertNil(session.webBridge(for: identity.pid))
        XCTAssertNil(session.webBridge(for: 99_998))
        XCTAssertNil(session.webBridge())
        XCTAssertFalse(session.hasWebBridge)
    }
}
