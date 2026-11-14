import CoreGraphics
import Foundation
import XCTest
@testable import WorkspaceCore
@testable import WorkspaceEngine

final class FakeDisplay: WorkspaceDisplayHandle {
    let displayID: UInt32
    let bounds: CGRect
    weak var owner: FakeDisplays?
    init(id: UInt32, width: Int, height: Int, owner: FakeDisplays) {
        displayID = id
        bounds = CGRect(x: 3000, y: 2000, width: width, height: height)
        self.owner = owner
    }
    func invalidate() { owner?.ids.remove(displayID) }
}

final class FakeDisplays: DisplayProvider {
    var ids: Set<UInt32> = []
    var failWith: String?
    var made = 0
    func make(width: Int, height: Int, name: String) throws -> WorkspaceDisplayHandle {
        if let failWith { throw WorkspaceError("display_creation_failed", failWith) }
        made += 1
        let display = FakeDisplay(id: UInt32(40 + made), width: width, height: height, owner: self)
        ids.insert(display.displayID)
        return display
    }
    func online() -> [UInt32] { Array(ids) }
}

final class RecordingHousekeeper: AppHousekeeper {
    var putAway: [[SessionApp]] = []
    func putAway(_ apps: [SessionApp]) { putAway.append(apps) }
}

final class SessionTests: XCTestCase {
    var state: URL!
    var displays: FakeDisplays!
    var housekeeper: RecordingHousekeeper!
    var time = 1000.0
    var problem: String?

    override func setUpWithError() throws {
        state = FileManager.default.temporaryDirectory.appendingPathComponent("hive-ws-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        displays = FakeDisplays()
        housekeeper = RecordingHousekeeper()
        time = 1000
        problem = nil
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: state)
    }

    func manager(instance: String = "run-1") -> SessionManager {
        SessionManager(state: state, displays: displays, housekeeper: housekeeper,
                       health: { [unowned self] in self.problem }, clock: { [unowned self] in self.time }, instanceID: instance)
    }

    let create: [String: Any] = ["name": "personal-agent-workspace", "title": "Agent workspace", "preset": "exclusive",
                                 "orphan_grace_seconds": 1800, "ttl_seconds": 3600]

    func code(_ body: () throws -> Any) -> String? {
        do {
            _ = try body()
            return nil
        } catch let error as WorkspaceError {
            return error.code
        } catch {
            return "other"
        }
    }

    func testClaimBeforeCreateIsUnknownSession() {
        let sessions = manager()
        XCTAssertThrowsError(try sessions.claim("personal-agent-workspace", by: 1)) { error in
            XCTAssertTrue("\(error)".hasPrefix("[unknown_session] "))
        }
    }

    func testCreateMakesTheHolderAndTheListingHiveReads() throws {
        let sessions = manager()
        let text = try sessions.create(create, by: 1)
        XCTAssertTrue(text.contains("on whole display 41, 1440x900"))
        let listing = sessions.listing(for: 1)
        let own = try NSRegularExpression(pattern: #"^\[yours\] session 'personal-agent-workspace' on whole display (\d+)[,\n]"#)
        XCTAssertEqual(own.numberOfMatches(in: listing, range: NSRange(listing.startIndex..., in: listing)), 1)
        XCTAssertTrue(listing.contains("\n  input: UNPAUSED\n"))
        XCTAssertFalse(sessions.listing(for: 2).contains("[yours]"))
        XCTAssertEqual(SessionStore(state: state).load()?.displayID, 41)
    }

    func testOnlyOneSession() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        XCTAssertEqual(code { try sessions.create(self.create, by: 2) }, "session_exists")
    }

    func testABusySessionSaysOnlyAnAbandonedOneCanBeClaimed() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        XCTAssertThrowsError(try sessions.claim("personal-agent-workspace", by: 2)) { error in
            XCTAssertTrue("\(error)".contains("only an abandoned session"))
        }
        XCTAssertNoThrow(try sessions.claim("personal-agent-workspace", by: 1))
    }

    func testWhenTheHolderLeavesAnotherClientClaimsIt() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        sessions.clientGone(1)
        XCTAssertNotNil(SessionStore(state: state).load()?.orphanedAt)
        XCTAssertNoThrow(try sessions.claim("personal-agent-workspace", by: 2))
        XCTAssertNil(sessions.live?.record.orphanedAt)
        XCTAssertEqual(code { try sessions.session("personal-agent-workspace", for: 1, acting: false) }, "not_yours")
    }

    func testAnUnclaimedSessionEndsAfterItsGraceAndPutsItsAppsAway() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        sessions.addApp(SessionApp(name: "TextEdit", bundleID: "com.apple.TextEdit", pid: 4242))
        sessions.clientGone(1)
        time += 1800
        sessions.tick()
        XCTAssertNotNil(sessions.live)
        time += 1
        sessions.tick()
        XCTAssertNil(sessions.live)
        XCTAssertEqual(housekeeper.putAway.first?.map(\.pid), [4242])
        XCTAssertTrue(displays.ids.isEmpty)
        XCTAssertNil(SessionStore(state: state).load())
    }

    func testALeaseThatIsNotRenewedReleasesTheHolder() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        time += 3000
        sessions.renew(1)
        time += 3000
        sessions.tick()
        XCTAssertEqual(sessions.live?.holder, 1)
        time += 601
        sessions.tick()
        XCTAssertNil(sessions.live?.holder)
        XCTAssertNoThrow(try sessions.claim("personal-agent-workspace", by: 2))
    }

    func testTheSessionEndsWhenItsDisplayGoesOffline() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        displays.ids.removeAll()
        sessions.tick()
        XCTAssertNil(sessions.live)
    }

    func testAnUnhealthyMacRefusesWithoutLatching() {
        problem = "memory_pressure"
        let sessions = manager()
        XCTAssertThrowsError(try sessions.create(create, by: 1)) { error in
            XCTAssertTrue("\(error)".hasPrefix("[display_creation_failed] could not create the agent display: host health refused: memory_pressure; "))
        }
        XCTAssertNil(sessions.latch.reason)
        XCTAssertEqual(displays.made, 0)
    }

    func testADisplayThatFailsLatchesUntilCleared() throws {
        displays.failWith = "the display never came online"
        let sessions = manager()
        XCTAssertEqual(code { try sessions.create(self.create, by: 1) }, "display_creation_failed")
        XCTAssertEqual(sessions.latch.reason, "display: the display never came online")
        displays.failWith = nil
        XCTAssertThrowsError(try sessions.create(create, by: 1)) { error in
            XCTAssertTrue("\(error)".contains("display safety is blocked"))
        }
        sessions.latch.clear()
        XCTAssertNoThrow(try sessions.create(create, by: 1))
    }

    func testAFailureUnderMemoryPressureIsAHostHealthLatch() {
        displays.failWith = "the display never came online"
        var calls = 0
        let sessions = SessionManager(state: state, displays: displays, housekeeper: housekeeper,
                                      health: { calls += 1; return calls > 1 ? "swap_activity" : nil },
                                      clock: { [unowned self] in self.time })
        _ = code { try sessions.create(self.create, by: 1) }
        XCTAssertTrue(sessions.latch.reason?.hasPrefix("host health: swap_activity") == true)
    }

    func testPausedInputRefusesActionsButNotReading() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        try sessions.setPaused(true, reason: "operator")
        XCTAssertEqual(code { try sessions.session("personal-agent-workspace", for: 1, acting: true) }, "input_paused")
        XCTAssertNoThrow(try sessions.session("personal-agent-workspace", for: 1, acting: false))
        XCTAssertTrue(sessions.listing(for: 1).contains("  input: PAUSED (operator has Control)"))
        try sessions.setPaused(true, reason: "waiting for the user")
        XCTAssertTrue(sessions.listing(for: 1).contains("  input: PAUSED (agent: waiting for the user)"))
        try sessions.setPaused(false, reason: nil)
        XCTAssertNoThrow(try sessions.session("personal-agent-workspace", for: 1, acting: true))
    }

    func testTheJanitorPutsAwayWhatADeadRunLeft() throws {
        let first = manager(instance: "run-1")
        _ = try first.create(create, by: 1)
        first.addApp(SessionApp(name: "Notes", bundleID: "com.apple.Notes", pid: 777))
        let second = manager(instance: "run-2")
        second.janitor()
        XCTAssertEqual(housekeeper.putAway.first?.map(\.pid), [777])
        XCTAssertNil(SessionStore(state: state).load())
        XCTAssertEqual(code { try second.claim("personal-agent-workspace", by: 1) }, "unknown_session")
    }

    func testDestroyByAnotherClientIsRefused() throws {
        let sessions = manager()
        _ = try sessions.create(create, by: 1)
        XCTAssertEqual(code { try sessions.destroy("personal-agent-workspace", by: 2) }, "session_busy")
        XCTAssertNoThrow(try sessions.destroy("personal-agent-workspace", by: 1))
        XCTAssertNil(sessions.live)
    }

    func testCreateChecksItsArguments() {
        let sessions = manager()
        XCTAssertEqual(code { try sessions.create(["name": "bad name!"], by: 1) }, "bad_request")
        XCTAssertEqual(code { try sessions.create(["name": "ok", "preset": "shared"], by: 1) }, "bad_request")
        XCTAssertEqual(code { try sessions.create([:], by: 1) }, "bad_request")
    }
}
