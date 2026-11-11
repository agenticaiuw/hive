import XCTest
@testable import SpaceOKit

final class DisplaySafetyRecoveryTests: XCTestCase {
    private typealias Step = DisplayLifecycleLease.HostHealthRecoveryStep

    /// Holds a recovery inside chosen filesystem steps, as a stalled pwrite/fsync/rename would,
    /// then lets the real call run late without any further deadline check.
    private final class Stall: @unchecked Sendable {
        let reached = DispatchSemaphore(value: 0)
        private let gates: [Step: (release: DispatchSemaphore, done: DispatchSemaphore)]
        init(_ steps: [Step]) {
            gates = Dictionary(uniqueKeysWithValues: steps.map { ($0, (release: DispatchSemaphore(value: 0), done: DispatchSemaphore(value: 0))) })
        }
        var interpose: DisplayLifecycleLease.HostHealthRecoveryInterposer {
            { [self] step, perform in
                guard let gate = gates[step] else { return try perform() }
                reached.signal()
                gate.release.wait()
                defer { gate.done.signal() }
                try perform()
            }
        }
        func complete(_ step: Step) -> DispatchTimeoutResult {
            gates[step]!.release.signal()
            return gates[step]!.done.wait(timeout: .now() + 5)
        }
    }

    private func fixture(_ journal: [String: Any], body: (String) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("display-safety.json")
        try JSONSerialization.data(withJSONObject: journal).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try body(file.path)
    }
    private var unknown: [String: Any] {
        ["attempts": [100.0], "dayAttempts": [50.0, 100.0], "pending": false,
         "failure": "host health: host_health_unknown"]
    }

    private func journal(_ path: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
    }

    /// Decision and staged records beside the journal, by name suffix.
    private func records(_ path: String) throws -> [String: Data] {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        let prefix = URL(fileURLWithPath: path).lastPathComponent + ".recovery-"
        var found: [String: Data] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) where name.hasPrefix(prefix) {
            found[String(name.dropFirst(prefix.count))] = try Data(contentsOf: directory.appendingPathComponent(name))
        }
        return found
    }

    private func assertBudgetsRetained(_ path: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let saved = try journal(path)
        XCTAssertEqual(saved["attempts"] as? [Double], [100], file: file, line: line)
        XCTAssertEqual(saved["dayAttempts"] as? [Double], [50, 100], file: file, line: line)
    }

    /// A late recovery step still holds the journal lock; wait for it before probing admission.
    private func waitForOwnerRelease(_ path: String, file: StaticString = #filePath, line: UInt = #line) {
        let fd = open(path, O_RDONLY | O_CLOEXEC)
        defer { close(fd) }
        let deadline = Date().addingTimeInterval(5)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            guard Date() < deadline else { return XCTFail("recovery kept the journal lock", file: file, line: line) }
            usleep(10_000)
        }
        flock(fd, LOCK_UN)
    }

    /// A persisted, unresolved recovery marker for `token`, as a worker writes before committing.
    private func marked(_ token: String) -> [String: Any] {
        var journal = unknown
        journal["failure"] = "host health: recovery \(token) has not committed"
        journal["recovery"] = token
        return journal
    }

    private func writePrivate(_ file: String, _ text: String) throws {
        let fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        let bytes = Array(text.utf8)
        guard write(fd, bytes, bytes.count) == bytes.count else { throw POSIXError(.EIO) }
    }

    private func assertRetained(_ path: String, _ label: String = "", file: StaticString = #filePath, line: UInt = #line) {
        let status = DisplayLifecycleLease.status(path: path)
        XCTAssertEqual(status.state, .blocked, label, file: file, line: line)
        XCTAssertTrue(status.reason?.hasPrefix("host health: host_health_unknown (") == true, "\(label): \(status)", file: file, line: line)
        XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire(), label, file: file, line: line)
    }

    /// Both the commit and its deadline abort are stalled: the outcome is genuinely undecided,
    /// readers must not guess, and the stalled worker still excludes every new owner.
    private func assertUndecidedWhileWorkerHoldsLock(_ path: String, _ stall: Stall, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(stall.reached.wait(timeout: .now() + 5), .success, file: file, line: line)
        XCTAssertEqual(stall.reached.wait(timeout: .now() + 5), .success, file: file, line: line)
        let status = DisplayLifecycleLease.status(path: path)
        XCTAssertEqual(status.state, .unknown, file: file, line: line)
        XCTAssertTrue(status.reason?.contains("is undecided; a stalled recovery may still commit") == true, "\(status)", file: file, line: line)
        XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire(), file: file, line: line) { error in
            XCTAssertTrue(String(describing: error).contains("another SpaceO process owns the display lifecycle"), "\(error)", file: file, line: line)
        }
    }

    private func assertBlockedAndRecoverable(_ path: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let status = DisplayLifecycleLease.status(path: path)
        XCTAssertEqual(status.state, .blocked, file: file, line: line)
        XCTAssertTrue(status.reason?.hasPrefix("host health: host_health_unknown (") == true, "\(status)", file: file, line: line)
        XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire(), file: file, line: line)
        try assertBudgetsRetained(path, file: file, line: line)
        // Only another explicit operator run clears it; budgets still survive.
        _ = try DisplayLifecycleLease.clearHostHealthLatch(path: path) {}
        XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready, file: file, line: line)
        try assertBudgetsRetained(path, file: file, line: line)
    }

    func testRecoveryArchivesLatchInPlaceAndPreservesCreationBudgets() throws {
        try fixture(unknown) { path in
            let inode = try FileManager.default.attributesOfItem(atPath: path)[.systemFileNumber] as? NSNumber
            var validated = false
            let token = UUID().uuidString
            let archive = try DisplayLifecycleLease.clearHostHealthLatch(path: path, token: token) { validated = true }
            XCTAssertTrue(validated)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
            XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: path)[.systemFileNumber] as? NSNumber, inode)
            // The journal itself still blocks; only the exclusive commit record makes it ready.
            XCTAssertEqual(try journal(path)["recovery"] as? String, token)
            XCTAssertNotNil(try journal(path)["failure"])
            XCTAssertEqual(try records(path), [token: Data("commit \(token)\n".utf8)])
            try assertBudgetsRetained(path)
            // The next owner admits and normalizes the journal when it persists.
            let owner = DisplayLifecycleLease(path: path)
            try owner.acquire()
            try owner.begin(creation: false)
            try owner.finish()
            XCTAssertNil(try journal(path)["failure"])
            XCTAssertNil(try journal(path)["recovery"])
            try assertBudgetsRetained(path)
            let archived = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: archive))) as? [String: Any])
            XCTAssertEqual(archived["failure"] as? String, "host health: host_health_unknown")
            XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: archive)[.posixPermissions] as? NSNumber, 0o600)
        }
    }

    func testPendingMutationLiveCaseAndOtherFailureReasonsCannotBeCleared() throws {
        for (key, value) in [("pending", true as Any), ("liveTestPending", true as Any),
                             ("failure", "host health: colorsync_busy" as Any),
                             ("failure", "removal was not confirmed" as Any)] {
            var journal = unknown; journal[key] = value
            try fixture(journal) { path in
                let before = try Data(contentsOf: URL(fileURLWithPath: path))
                XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) { XCTFail("ineligible journal must not reach host validation") })
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
            }
        }
    }



    func testHealthChangingDuringJournalWriteCannotCommitRecovery() throws {
        final class State: @unchecked Sendable {
            let lock = NSLock()
            var healthy = true
            func setUnhealthy() { lock.withLock { healthy = false } }
            func check() throws {
                try lock.withLock { if !healthy { throw SpaceOError.badRequest("host no longer settled") } }
            }
        }
        var resource = unknown; resource["failure"] = "host health: swap_activity"
        try fixture(resource) { path in
            let state = State()
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 5,
                interpose: { step, perform in
                    try perform()
                    if step == .journal { state.setUnhealthy() }
                }, validateStillHealthy: { try state.check() }, validateHost: { _ in }))
            let status = DisplayLifecycleLease.status(path: path)
            XCTAssertEqual(status.state, .blocked)
            try assertBudgetsRetained(path)
            XCTAssertFalse(try records(path).values.contains { String(decoding: $0, as: UTF8.self).hasPrefix("commit ") })
        }
    }

    func testHealthChangingBeforeCommitCallCannotClearRecovery() throws {
        final class State: @unchecked Sendable {
            let lock = NSLock()
            var healthy = true
            func setUnhealthy() { lock.withLock { healthy = false } }
            func check() throws {
                try lock.withLock { if !healthy { throw SpaceOError.badRequest("host no longer settled") } }
            }
        }
        var resource = unknown; resource["failure"] = "host health: swap_activity"
        try fixture(resource) { path in
            let state = State()
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 5,
                interpose: { step, perform in
                    if step == .commit { state.setUnhealthy() }
                    try perform()
                }, validateStillHealthy: { try state.check() }, validateHost: { _ in }))
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked)
            try assertBudgetsRetained(path)
            XCTAssertFalse(try records(path).values.contains { String(decoding: $0, as: UTF8.self).hasPrefix("commit ") })
        }
    }

    func testRecoveredResourceLatchesPreserveBudgetsAndRequireHostValidation() throws {
        for reason in ["swap_activity", "memory_pressure", "memory_pressure,swap_activity",
                       "recent_windowserver_diagnostic", "swap_activity,recent_windowserver_diagnostic"] {
            var resource = unknown
            resource["failure"] = "host health: " + reason
            try fixture(resource) { path in
                let before = try Data(contentsOf: URL(fileURLWithPath: path))
                XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {
                    throw SpaceOError.badRequest("host still unhealthy")
                })
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
                var validated = false
                let archive = try DisplayLifecycleLease.clearHostHealthLatch(path: path) { validated = true }
                XCTAssertTrue(validated)
                XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
                try assertBudgetsRetained(path)
                XCTAssertEqual(try journal(archive)["failure"] as? String, "host health: " + reason)
            }
        }
    }

    func testResourceRecoveryRefusesPendingWorkOwnersAndMixedIncidentReasons() throws {
        for reason in ["recent_windowserver_diagnostic,colorsync_busy", "memory_pressure,colorsync_busy",
                       "host_health_timeout", "host_health_stale", "swap_activity,", "swap_activity,unknown"] {
            var resource = unknown; resource["failure"] = "host health: " + reason
            try fixture(resource) { path in
                let before = try Data(contentsOf: URL(fileURLWithPath: path))
                XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {
                    XCTFail("incident reason must not reach validation")
                }) { error in
                    XCTAssertTrue(String(describing: error).contains("not an eligible idle health latch"))
                }
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
            }
        }
        for key in ["pending", "liveTestPending"] {
            var resource = unknown; resource["failure"] = "host health: swap_activity"; resource[key] = true
            try fixture(resource) { path in
                XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {
                    XCTFail("pending work must not reach validation")
                }) { error in
                    XCTAssertTrue(String(describing: error).contains("a display mutation or live case is pending"))
                }
            }
        }
        var resource = unknown; resource["failure"] = "host health: swap_activity"
        try fixture(resource) { path in
            let owner = DisplayLifecycleLease(path: path)
            XCTAssertThrowsError(try owner.acquire())
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {
                XCTFail("active owner must exclude recovery")
            })
            withExtendedLifetime(owner) {}
        }
    }

    func testHostRefusalAndActiveOwnerCannotClearLatch() throws {
        try fixture(unknown) { path in
            let before = try Data(contentsOf: URL(fileURLWithPath: path))
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) { throw SpaceOError.badRequest("host is not recovered") })
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
            let owner = DisplayLifecycleLease(path: path)
            XCTAssertThrowsError(try owner.acquire()) // Acquired owner lock remains held despite the latch.
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) { XCTFail("owner exclusion precedes recovery") })
            withExtendedLifetime(owner) {}
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
        }
    }

    func testExpiredRecoveryCannotClearAfterArchiving() throws {
        try fixture(unknown) { path in
            let before = try Data(contentsOf: URL(fileURLWithPath: path))
            var checks = 0
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path, checkDeadline: {
                checks += 1
                if checks == 3 { throw SpaceOError.badRequest("deadline expired") }
            }) {})
            XCTAssertEqual(checks, 3)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
            XCTAssertEqual(try records(path), [:])
        }
    }

    func testExpiryAfterPersistedMarkerKeepsLatchUntilOperatorReruns() throws {
        try fixture(unknown) { path in
            var checks = 0
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path, checkDeadline: {
                checks += 1
                if checks == 4 { throw SpaceOError.badRequest("deadline expired") }
            }) {})
            XCTAssertEqual(checks, 4)
            XCTAssertNotNil(try journal(path)["recovery"])
            XCTAssertEqual(try records(path), [:]) // Staged commit removed; nothing committed.
            try assertBlockedAndRecoverable(path)
        }
    }

    /// Regression for a final persistence call that stalls past the caller deadline and then
    /// lands: the deadline failure is claimed first, so the late write cannot clear the latch.
    func testStalledFinalPersistenceCannotClearLatchAfterDeadlineFailure() throws {
        for step in [Step.journal, .commit] {
            try fixture(unknown) { path in
                let stall = Stall([step])
                XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                    path: path, worker: DisplayLifecycleCoordinator(), timeout: 1, interpose: stall.interpose) { _ in }
                ) { error in
                    XCTAssertTrue(String(describing: error).contains("was aborted; the latch is retained"), "\(step): \(error)")
                }
                XCTAssertEqual(stall.reached.wait(timeout: .now()), .success, "\(step)")
                // .journal: the marker is not yet written. .commit: the abort claim is final even
                // though the staged record remains. Neither may read as undecided or ready.
                XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked, "\(step)")
                XCTAssertEqual(stall.complete(step), .success, "\(step)") // The stalled call now lands.
                waitForOwnerRelease(path)
                XCTAssertNotNil(try journal(path)["recovery"], "\(step)")
                XCTAssertEqual(try records(path).values.map(\.isEmpty), [true], "\(step): only the abort claim remains")
                try assertBlockedAndRecoverable(path)
            }
        }
    }

    func testCommitThatLandsBeforeDeadlineAbortIsReportedAsCleared() throws {
        try fixture(unknown) { path in
            let stall = Stall([.sync])
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 1, interpose: stall.interpose) { _ in }
            ) { error in
                XCTAssertTrue(String(describing: error).contains("committed before its deadline abort; the latch is cleared"), "\(error)")
            }
            XCTAssertEqual(stall.complete(.sync), .success)
            waitForOwnerRelease(path)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
            try assertBudgetsRetained(path)
        }
    }

    func testUnconfirmedDeadlineAbortReportsUnknownOutcome() throws {
        try fixture(unknown) { path in
            let stall = Stall([.commit, .abort])
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 1, abortTimeout: 0.3,
                interpose: stall.interpose) { _ in }
            ) { error in
                let text = String(describing: error)
                XCTAssertTrue(text.contains("abort was not confirmed"), text)
                XCTAssertFalse(text.contains("retained"), text)
                XCTAssertTrue(text.contains("after this safety process has fully exited"), text)
            }
            assertUndecidedWhileWorkerHoldsLock(path, stall)
            // Outcome remains unknown to the timed-out caller. Once the pre-call stall ends,
            // the commit-boundary deadline check rejects the write before its syscall.
            XCTAssertEqual(stall.complete(.commit), .success)
            XCTAssertEqual(stall.complete(.abort), .success)
            waitForOwnerRelease(path)
            try assertBlockedAndRecoverable(path)
        }
    }

    func testUnconfirmedAbortThatLandsFirstRetainsRecoverableLatch() throws {
        try fixture(unknown) { path in
            let stall = Stall([.commit, .abort])
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 1, abortTimeout: 0.3,
                interpose: stall.interpose) { _ in }
            ) { error in XCTAssertTrue(String(describing: error).contains("abort was not confirmed"), "\(error)") }
            assertUndecidedWhileWorkerHoldsLock(path, stall)
            XCTAssertEqual(stall.complete(.abort), .success)
            // The abort claim decides the outcome while the worker still holds its staged record.
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked)
            XCTAssertEqual(stall.complete(.commit), .success) // The late commit loses.
            waitForOwnerRelease(path)
            XCTAssertEqual(try records(path).values.map(\.isEmpty), [true], "only the abort claim remains")
            try assertBlockedAndRecoverable(path)
        }
    }

    func testUnlockedReaderInspectsStagedRecordBeforeDecision() throws {
        let token = UUID().uuidString
        try fixture(marked(token)) { path in
            let staged = path + ".recovery-\(token).staged"
            try writePrivate(staged, "commit \(token)\n")
            // Marker, staged record, no decision: a live worker could still commit.
            let undecided = DisplayLifecycleLease.status(path: path)
            XCTAssertEqual(undecided.state, .unknown)
            XCTAssertTrue(undecided.reason?.contains("recovery \(token) is undecided") == true, "\(undecided)")
            // Under the journal lock no worker is live, so the owner refuses rather than waits.
            XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire())
            // An abort claim is final even beside a staged record: the commit rename is exclusive.
            try writePrivate(path + ".recovery-\(token)", "")
            assertRetained(path, "aborted with staged record")
            XCTAssertEqual(unlink(path + ".recovery-\(token)"), 0)
            // Marker, no staged record, no decision: nothing can commit any more.
            XCTAssertEqual(unlink(staged), 0)
            assertRetained(path, "no staged record or decision")
            // A killed worker's staged record is removed by the next operator run, even one the
            // host refuses, so readers can resolve the earlier run.
            try writePrivate(staged, "commit \(token)\n")
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) { throw SpaceOError.badRequest("host is not recovered") })
            XCTAssertFalse(FileManager.default.fileExists(atPath: staged))
            assertRetained(path, "after stale staged cleanup")
            try assertBlockedAndRecoverable(path)
        }
    }

    func testOnlyAnExactPrivateCommitRecordForTheMarkedTokenClears() throws {
        let token = UUID().uuidString
        let other = UUID().uuidString
        let record = "commit \(token)\n"
        try fixture(marked(token)) { path in
            try writePrivate(path + ".recovery-\(token)", record)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready, "control: the exact record clears")
        }
        let cases: [(String, (String) throws -> Void)] = [
            ("wrong bytes", { path in try self.writePrivate(path + ".recovery-\(token)", "commit \(token)!") }),
            ("extra byte", { path in try self.writePrivate(path + ".recovery-\(token)", record + "\n") }),
            ("mode 0644", { path in
                try self.writePrivate(path + ".recovery-\(token)", record)
                XCTAssertEqual(chmod(path + ".recovery-\(token)", 0o644), 0)
            }),
            ("hard link", { path in
                try self.writePrivate(path + ".recovery-\(token)", record)
                XCTAssertEqual(link(path + ".recovery-\(token)", path + ".second-name"), 0)
            }),
            ("symlink", { path in
                try self.writePrivate(path + ".record", record)
                XCTAssertEqual(symlink(path + ".record", path + ".recovery-\(token)"), 0)
            }),
            ("other token's record at this path", { path in try self.writePrivate(path + ".recovery-\(token)", "commit \(other)\n") }),
            ("receipt for another token", { path in try self.writePrivate(path + ".recovery-\(other)", "commit \(other)\n") }),
        ]
        for (label, prepare) in cases {
            try fixture(marked(token)) { path in
                try prepare(path)
                assertRetained(path, label)
                try assertBudgetsRetained(path)
            }
        }
    }

    func testValidCommitRecordCannotClearPendingMutationOrLiveCase() throws {
        let token = UUID().uuidString
        for key in ["pending", "liveTestPending"] {
            var journal = marked(token)
            journal[key] = true
            try fixture(journal) { path in
                try writePrivate(path + ".recovery-\(token)", "commit \(token)\n")
                XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked, key)
                XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire(), key)
                XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) { XCTFail("\(key) is never eligible") })
            }
        }
    }

    /// Commit point guard: once the exclusive rename lands, a failing later step (or an interposer
    /// throwing around the commit itself) must still report the cleared latch as success.
    func testFailureAfterCommitPointStillReportsSuccess() throws {
        struct Late: Error {}
        let variants: [(String, DisplayLifecycleLease.HostHealthRecoveryInterposer)] = [
            ("sync throws instead", { step, perform in if step == .sync { throw Late() }; try perform() }),
            ("sync throws after", { step, perform in try perform(); if step == .sync { throw Late() } }),
            ("commit throws after", { step, perform in try perform(); if step == .commit { throw Late() } }),
        ]
        for (label, interpose) in variants {
            try fixture(unknown) { path in
                let archive = try DisplayLifecycleLease.clearHostHealthLatch(path: path, interpose: interpose) {}
                XCTAssertTrue(FileManager.default.fileExists(atPath: archive), label)
                XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready, label)
                try assertBudgetsRetained(path)
            }
            try fixture(unknown) { path in
                XCTAssertNoThrow(try DisplaySafetyRecovery.clearHostHealthLatch(
                    path: path, worker: DisplayLifecycleCoordinator(), timeout: 5, interpose: interpose) { _ in }, label)
                XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready, label)
            }
        }
        // Contrast: the same failure before the commit point is reported and clears nothing.
        try fixture(unknown) { path in
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path, interpose: { step, perform in
                try perform(); if step == .journal { throw Late() }
            }) {})
            XCTAssertEqual(try records(path), [:])
            assertRetained(path, "pre-commit failure")
        }
    }

    func testRecoveryRefusalBeforeCommitIsNotTurnedIntoAnAbort() throws {
        try fixture(unknown) { path in
            let before = try Data(contentsOf: URL(fileURLWithPath: path))
            XCTAssertThrowsError(try DisplaySafetyRecovery.clearHostHealthLatch(
                path: path, worker: DisplayLifecycleCoordinator(), timeout: 1) { _ in
                throw SpaceOError.badRequest("host is not recovered")
            }) { error in XCTAssertEqual(error as? SpaceOError, .badRequest("host is not recovered")) }
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
            XCTAssertEqual(try records(path), [:])
        }
    }

    func testRecoveryRejectsNonPrivateAndMalformedJournal() throws {
        try fixture(unknown) { path in
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {})
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            try Data("{bad".utf8).write(to: URL(fileURLWithPath: path))
            XCTAssertThrowsError(try DisplayLifecycleLease.clearHostHealthLatch(path: path) {})
        }
    }
}
