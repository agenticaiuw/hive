import XCTest
@testable import SpaceOKit

/// `daemon restart` against current daemons (drain) and against daemons that predate drain,
/// driven through a fake socket, clock, and process so no daemon is ever touched.
final class DaemonRestartTests: XCTestCase {

    /// Scripted daemon: answers each command from `handler`, records what it was sent, and
    /// "exits" once a stop is acknowledged or the scripted drain completes.
    private final class FakeDaemon {
        var sent: [Request] = []
        var timeouts: [TimeInterval] = []
        var sleeps: [TimeInterval] = []
        var alive = true
        var clock = Date(timeIntervalSince1970: 0)
        var progress: [String] = []
        var handler: (Request, FakeDaemon) -> Response = { _, _ in .success() }

        func restart() -> DaemonRestart {
            var restart = DaemonRestart(
                send: { [unowned self] request, timeout in
                    self.sent.append(request)
                    self.timeouts.append(timeout)
                    return self.handler(request, self)
                },
                isAlive: { [unowned self] in self.alive },
                now: { [unowned self] in self.clock },
                sleep: { [unowned self] seconds in
                    self.sleeps.append(seconds)
                    self.clock.addTimeInterval(seconds)
                },
                progress: { [unowned self] in self.progress.append($0) })
            restart.pollInterval = 1
            return restart
        }

        var commands: [String] { sent.map(\.cmd) }
    }

    private static func legacyRefusal(_ command: String) -> Response {
        var response = Response(ok: false)
        response.error = "unknown command '\(command)'"
        response.errorCode = "bad_request"
        response.daemon = DaemonRuntimeInfo(version: "1.0.0", executableSHA256: nil, pid: 7,
                                            instanceID: UUID(), startedAt: Date())
        return response
    }

    private static func sessions(_ count: Int, detached: Int = 0) -> Response {
        func info(_ id: String, attached: Bool) -> SessionInfo {
            let json = """
            {"id":"\(id)","displayID":1,"x":0,"y":0,"width":10,"height":10,"tileIndex":0,
             "tileCapacity":1,"exclusiveDisplay":false,"spaces":[],"hasOwnSpace":false,"apps":[],
             "windows":[],"createdAt":"2026-01-01T00:00:00Z","teardownPending":false,
             "runtimeAttached":\(attached)}
            """
            return try! Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        }
        var response = Response.success()
        response.sessions = (0..<count).map { info("s\($0)", attached: true) }
            + (0..<detached).map { info("d\($0)", attached: false) }
        return response
    }

    func testCurrentDaemonDrainsAndExits() {
        let daemon = FakeDaemon()
        var polls = 0
        daemon.handler = { request, fake in
            switch request.cmd {
            case "daemon.drain": return .success("draining 1 session")
            case "session.list":
                polls += 1
                if polls >= 3 { fake.alive = false }
                return Self.sessions(polls >= 3 ? 0 : 1)
            default: return .success()
            }
        }
        let outcome = daemon.restart().run(mode: .whenIdle, timeout: 60)
        XCTAssertEqual(outcome, .stopped("the old daemon drained and exited"))
        XCTAssertEqual(daemon.sent.first?.cmd, "daemon.drain")
        XCTAssertEqual(daemon.sent.first?.operatorScope, true)
        XCTAssertFalse(daemon.commands.contains("daemon.stop"), "a draining daemon exits by itself")
        XCTAssertTrue(daemon.progress.contains("draining 1 session"))
        XCTAssertTrue(daemon.progress.contains("1 live session(s) remaining…"))
    }

    /// The reported bug: 1.0.0 answers `unknown command 'daemon.drain'` and the documented
    /// upgrade used to stop there.
    func testLegacyDaemonIsWaitedOnUntilIdleThenStopped() throws {
        let daemon = FakeDaemon()
        var polls = 0
        daemon.handler = { request, fake in
            switch request.cmd {
            case "daemon.drain": return Self.legacyRefusal("daemon.drain")
            case "session.list":
                polls += 1
                return Self.sessions(polls < 3 ? 2 : 0, detached: 1)
            case "daemon.stop":
                fake.alive = false
                return .success("SpaceO daemon shutdown completed")
            default: return .success()
            }
        }
        let outcome = daemon.restart().run(mode: .whenIdle, timeout: 600)
        XCTAssertEqual(outcome, .stopped("SpaceO daemon shutdown completed"))
        XCTAssertEqual(daemon.commands, ["daemon.drain", "session.list", "session.list", "session.list", "daemon.stop"])
        let stop = try XCTUnwrap(daemon.sent.last)
        XCTAssertEqual(stop.operatorScope, true)
        XCTAssertEqual(stop.leaveDetachedRecords, true)
        XCTAssertTrue(daemon.progress.first?.contains("the running daemon (1.0.0) predates `daemon.drain`") == true,
                      "the fallback explains itself: \(daemon.progress)")
        XCTAssertTrue(daemon.progress.contains("2 live session(s) remaining; waiting for them to be destroyed…"),
                      "detached records are not live sessions")
        XCTAssertEqual(daemon.progress.filter { $0.contains("live session(s) remaining") }.count, 1,
                       "progress is printed on change, not on every poll")
    }

    func testLegacyDaemonThatNeverIdlesIsLeftRunning() {
        let daemon = FakeDaemon()
        daemon.handler = { request, _ in
            switch request.cmd {
            case "daemon.drain": return Self.legacyRefusal("daemon.drain")
            case "session.list": return Self.sessions(1)
            default: return .success()
            }
        }
        guard case .stillBusy(let message) = daemon.restart().run(mode: .whenIdle, timeout: 30) else {
            return XCTFail("expected stillBusy")
        }
        XCTAssertFalse(daemon.commands.contains("daemon.stop"), "a wait that times out stops nothing")
        XCTAssertTrue(message.contains("nothing was stopped"))
        XCTAssertTrue(message.contains("--now"))
        XCTAssertLessThanOrEqual(daemon.clock.timeIntervalSince1970, 32, "the wait is bounded by --timeout")
    }

    func testNowStopsImmediatelyWithoutDraining() throws {
        let daemon = FakeDaemon()
        daemon.handler = { request, fake in
            if request.cmd == "daemon.stop" { fake.alive = false }
            return .success("stopping")
        }
        XCTAssertEqual(daemon.restart().run(mode: .now, timeout: 900), .stopped("stopping"))
        XCTAssertEqual(daemon.commands, ["daemon.stop"])
        XCTAssertEqual(daemon.sent.first?.leaveDetachedRecords, true)
    }

    func testDrainRefusedForAnotherReasonIsSurfaced() {
        let daemon = FakeDaemon()
        daemon.handler = { _, _ in
            var refused = Response(ok: false)
            refused.error = "daemon restart requires operator scope"
            refused.errorCode = "bad_request"
            return refused
        }
        guard case .refused(let response) = daemon.restart().run(mode: .whenIdle, timeout: 60) else {
            return XCTFail("expected refused")
        }
        XCTAssertEqual(response.error, "daemon restart requires operator scope")
        XCTAssertEqual(daemon.commands, ["daemon.drain"], "only an unknown-command refusal triggers the fallback")
    }

    func testStopAcknowledgedButProcessLingers() {
        let daemon = FakeDaemon()
        daemon.handler = { _, _ in .success("stopping") }
        guard case .stillBusy(let message) = daemon.restart().run(mode: .now, timeout: 10) else {
            return XCTFail("expected stillBusy")
        }
        XCTAssertTrue(message.contains("has not exited yet"))
    }

    func testRestartRefusesInvalidLimitsBeforeSendingAnything() {
        for value in [Double.nan, .infinity, -.infinity, 0, -1, 3_601] {
            let daemon = FakeDaemon()
            guard case .refused = daemon.restart().run(mode: .whenIdle, timeout: value) else {
                return XCTFail("invalid timeout accepted")
            }
            XCTAssertTrue(daemon.sent.isEmpty)
        }
        for value in [Double.nan, .infinity, 0, -1, 61] {
            let daemon = FakeDaemon()
            var restart = daemon.restart()
            restart.pollInterval = value
            guard case .refused = restart.run(mode: .now, timeout: 10) else {
                return XCTFail("invalid polling interval accepted")
            }
            XCTAssertTrue(daemon.sent.isEmpty)
        }
    }

    func testDrainPollingAndSleepUseOnlyRemainingDeadline() {
        let daemon = FakeDaemon()
        daemon.handler = { request, fake in
            if request.cmd == "daemon.drain" {
                fake.clock.addTimeInterval(0.25)
                return .success("draining")
            }
            fake.clock.addTimeInterval(0.5)
            return Self.sessions(1)
        }
        guard case .stillBusy = daemon.restart().run(mode: .whenIdle, timeout: 1) else {
            return XCTFail("expected a bounded wait")
        }
        XCTAssertEqual(daemon.timeouts, [1, 0.75])
        XCTAssertEqual(daemon.sleeps, [0.25])
        XCTAssertEqual(daemon.clock.timeIntervalSince1970, 1)
    }

    func testLateLegacyIdleResponseCannotTriggerStop() {
        let daemon = FakeDaemon()
        daemon.handler = { request, fake in
            if request.cmd == "daemon.drain" { return Self.legacyRefusal("daemon.drain") }
            fake.clock.addTimeInterval(2)
            return Self.sessions(0)
        }
        guard case .stillBusy(let message) = daemon.restart().run(mode: .whenIdle, timeout: 1) else {
            return XCTFail("late idle result cannot renew the shutdown budget")
        }
        XCTAssertTrue(message.contains("no stop was sent"))
        XCTAssertEqual(daemon.commands, ["daemon.drain", "session.list"])
        XCTAssertEqual(daemon.timeouts, [1, 1])
    }

    func testLegacyStopSharesOriginalDeadline() {
        let daemon = FakeDaemon()
        daemon.handler = { request, fake in
            switch request.cmd {
            case "daemon.drain": return Self.legacyRefusal("daemon.drain")
            case "session.list":
                fake.clock.addTimeInterval(0.75)
                return Self.sessions(0)
            default: return .success("stopping")
            }
        }
        guard case .stillBusy = daemon.restart().run(mode: .whenIdle, timeout: 1) else {
            return XCTFail("acknowledged shutdown still has to exit before the deadline")
        }
        XCTAssertEqual(daemon.commands, ["daemon.drain", "session.list", "daemon.stop"])
        XCTAssertEqual(daemon.timeouts, [1, 1, 0.25])
        XCTAssertEqual(daemon.sleeps, [0.25])
        XCTAssertEqual(daemon.clock.timeIntervalSince1970, 1)
    }

    func testTransportFailureIsUnreachable() {
        let daemon = FakeDaemon()
        let restart = DaemonRestart(
            send: { _, _ in throw Transport.TransportError.socketFailed("reset") },
            isAlive: { true }, sleep: { _ in }, progress: { _ in })
        XCTAssertEqual(restart.run(mode: .whenIdle, timeout: 5), .unreachable("socket error: reset"))
        _ = daemon
    }
}
