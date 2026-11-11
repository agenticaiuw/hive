import XCTest
@testable import SpaceOKit

/// Interactive setup, `doctor --fix`, and attention guidance.
///
/// Everything here is pure or confined to a temporary directory: no Settings pane is opened, no
/// grant is requested, and no test sleeps — the waiter's clock is injected precisely so its
/// timeout policy can be checked in microseconds.
final class SetupRemediesTests: XCTestCase {

    // MARK: SettingsPane

    func testSettingsPaneURLsAreExact() {
        XCTAssertEqual(
            SettingsPane.accessibility.url.absoluteString,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        XCTAssertEqual(
            SettingsPane.screenRecording.url.absoluteString,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        XCTAssertEqual(
            SettingsPane.focus.url.absoluteString,
            "x-apple.systempreferences:com.apple.Focus-Settings.extension")
    }

    // MARK: GrantWaiter

    /// A fake clock that advances only when the waiter sleeps.
    private final class FakeClock {
        var now = Date(timeIntervalSince1970: 1_000)
        var sleeps: [TimeInterval] = []
        func sleep(_ seconds: TimeInterval) {
            sleeps.append(seconds)
            now = now.addingTimeInterval(seconds)
        }
    }

    func testWaiterReturnsTrueOnceTheGrantLandsAfterSeveralTicks() {
        let clock = FakeClock()
        var probes = 0
        var ticks: [Int] = []
        let waiter = GrantWaiter(pane: .accessibility, deadline: 120, interval: 1)
        let granted = waiter.wait(
            predicate: { probes += 1; return probes == 4 },
            now: { clock.now },
            sleep: clock.sleep,
            onTick: { ticks.append($0) })
        XCTAssertTrue(granted)
        XCTAssertEqual(probes, 4)
        XCTAssertEqual(clock.sleeps, [1, 1, 1], "one sleep per unsuccessful probe")
        XCTAssertEqual(ticks, [120, 119, 118], "countdown is whole seconds remaining")
    }

    func testWaiterReturnsImmediatelyWhenAlreadyGranted() {
        let clock = FakeClock()
        var ticks: [Int] = []
        let granted = GrantWaiter(pane: .screenRecording).wait(
            predicate: { true }, now: { clock.now }, sleep: clock.sleep, onTick: { ticks.append($0) })
        XCTAssertTrue(granted)
        XCTAssertTrue(clock.sleeps.isEmpty)
        XCTAssertTrue(ticks.isEmpty)
    }

    func testWaiterTimesOutWithACountdownAndNeverOvershootsTheDeadline() {
        let clock = FakeClock()
        var ticks: [Int] = []
        let waiter = GrantWaiter(pane: .accessibility, deadline: 3, interval: 1)
        let granted = waiter.wait(
            predicate: { false }, now: { clock.now }, sleep: clock.sleep, onTick: { ticks.append($0) })
        XCTAssertFalse(granted)
        XCTAssertEqual(ticks, [3, 2, 1])
        XCTAssertEqual(clock.sleeps.reduce(0, +), 3, accuracy: 0.0001,
                       "total sleep equals the deadline exactly")
    }

    func testWaiterClampsTheFinalSleepToTheRemainingTime() {
        let clock = FakeClock()
        let waiter = GrantWaiter(pane: .accessibility, deadline: 2.5, interval: 1)
        _ = waiter.wait(predicate: { false }, now: { clock.now }, sleep: clock.sleep, onTick: { _ in })
        XCTAssertEqual(clock.sleeps, [1, 1, 0.5])
    }

    func testZeroDeadlineProbesOnceAndGivesUp() {
        let clock = FakeClock()
        var probes = 0
        let granted = GrantWaiter(pane: .accessibility, deadline: 0).wait(
            predicate: { probes += 1; return false }, now: { clock.now }, sleep: clock.sleep, onTick: { _ in })
        XCTAssertFalse(granted)
        XCTAssertEqual(probes, 1)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    // MARK: SetupProgressStore

    private func temporaryStore() throws -> (SetupProgressStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-setup-progress-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("nested/setup-state.json")
        return (SetupProgressStore(url: url), url)
    }

    func testProgressRoundTripsAndIsWrittenPrivately() throws {
        let (store, url) = try temporaryStore()
        XCTAssertEqual(store.load(), SetupProgress(), "missing file reads as empty")

        let first = Date(timeIntervalSince1970: 1_700_000_000)
        let second = Date(timeIntervalSince1970: 1_700_000_060)
        try store.markPassed("accessibility", at: first)
        try store.markPassed("screen recording", at: second)

        let loaded = SetupProgressStore(url: url).load()
        XCTAssertEqual(loaded.passedSteps.count, 2)
        XCTAssertEqual(loaded.passedSteps["accessibility"]?.timeIntervalSince1970 ?? 0,
                       first.timeIntervalSince1970, accuracy: 1, "ISO 8601 keeps whole seconds")
        XCTAssertEqual(loaded.passedSteps["screen recording"]?.timeIntervalSince1970 ?? 0,
                       second.timeIntervalSince1970, accuracy: 1)

        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
        XCTAssertEqual(leftovers, ["setup-state.json"], "no temporary files left behind")
    }

    func testMarkingAStepAgainOverwritesItsTimestamp() throws {
        let (store, _) = try temporaryStore()
        try store.markPassed("daemon", at: Date(timeIntervalSince1970: 10))
        try store.markPassed("daemon", at: Date(timeIntervalSince1970: 500))
        XCTAssertEqual(store.load().passedSteps["daemon"]?.timeIntervalSince1970 ?? 0, 500, accuracy: 1)
    }

    func testCorruptStateFileIsTreatedAsEmptyAndRecoversOnNextWrite() throws {
        let (store, url) = try temporaryStore()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{ this is not json".utf8).write(to: url)
        XCTAssertEqual(store.load(), SetupProgress())

        // Wrong shape but valid JSON must also be tolerated.
        try Data(#"{"passedSteps": "not a dictionary"}"#.utf8).write(to: url)
        XCTAssertEqual(store.load(), SetupProgress())

        try store.markPassed("runtime apis", at: Date(timeIntervalSince1970: 42))
        XCTAssertEqual(store.load().passedSteps.keys.sorted(), ["runtime apis"])
    }

    func testOversizedStateFileIsIgnored() throws {
        let (store, url) = try temporaryStore()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0x20, count: SetupProgressStore.maximumBytes + 1).write(to: url)
        XCTAssertEqual(store.load(), SetupProgress())
    }

    func testResetRemovesTheFileAndIsIdempotent() throws {
        let (store, url) = try temporaryStore()
        try store.markPassed("accessibility", at: Date())
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        try store.reset()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNoThrow(try store.reset(), "resetting an already-clean host is not an error")
        XCTAssertEqual(store.load(), SetupProgress())
    }

    func testDefaultURLLivesUnderApplicationSupport() {
        let url = SetupProgressStore.defaultURL()
        XCTAssertTrue(url.path.hasSuffix("/Library/Application Support/SpaceO/setup-state.json"), url.path)
    }

    // MARK: SetupNarration

    func testSkipLineNamesTheStepAndLocalTime() {
        // 14:02 UTC on a fixed day; pin the zone so the assertion is host-independent.
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 16
        components.hour = 14; components.minute = 2
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let at1402 = calendar.date(from: components)!
        XCTAssertEqual(
            SetupNarration.skipLine(step: "accessibility", passedAt: at1402, timeZone: TimeZone(identifier: "UTC")!),
            "step accessibility passed at 14:02; skipping")
    }

    // MARK: DoctorRemedy

    func testAReportWithNoFindingsYieldsNoRemedies() {
        XCTAssertEqual(DoctorRemedy.remedies(for: DoctorFindings()), [])
        XCTAssertEqual(
            DoctorRemedy.remedies(for: DoctorFindings(daemonRunning: true, daemonMatchesCLI: true, liveSessionCount: 3)),
            [], "a healthy, busy daemon needs nothing")
    }

    func testRemediesAreOrderedGrantsBuildHygieneDisplays() {
        let findings = DoctorFindings(
            accessibilityGranted: false,
            screenRecordingGranted: false,
            daemonRunning: true,
            daemonMatchesCLI: false,
            orphanedDisplayIDs: [7, 9],
            orphanLedgerNamespaces: ["ns-a", "ns-b"],
            orphanProfileDirectories: ["/tmp/spaceo-profile-1"],
            liveSessionCount: 2)
        XCTAssertEqual(DoctorRemedy.remedies(for: findings), [
            .openSettingsPane(.accessibility),
            .openSettingsPane(.screenRecording),
            .restartDaemonWhenIdle,
            .quarantineOrphanLedgers(["ns-a", "ns-b"]),
            .removeOrphanProfiles(["/tmp/spaceo-profile-1"]),
            .printDisplayWakeCommands([7, 9]),
        ])
    }

    func testRemedyTable() {
        let cases: [(DoctorFindings, [DoctorRemedy], String)] = [
            (DoctorFindings(accessibilityGranted: false), [.openSettingsPane(.accessibility)], "AX only"),
            (DoctorFindings(screenRecordingGranted: false), [.openSettingsPane(.screenRecording)], "capture only"),
            (DoctorFindings(daemonRunning: true, daemonMatchesCLI: nil), [.restartDaemonWhenIdle],
             "an unverifiable running build is treated as a mismatch, as Setup.daemonChecks does"),
            (DoctorFindings(daemonRunning: false, daemonMatchesCLI: nil), [],
             "no daemon means nothing to restart"),
            (DoctorFindings(orphanedDisplayIDs: [3]), [.printDisplayWakeCommands([3])], "displays print only"),
            (DoctorFindings(orphanLedgerNamespaces: ["x"]), [.quarantineOrphanLedgers(["x"])], "ledgers"),
            (DoctorFindings(orphanProfileDirectories: ["/p"]), [.removeOrphanProfiles(["/p"])], "profiles"),
        ]
        for (findings, expected, why) in cases {
            XCTAssertEqual(DoctorRemedy.remedies(for: findings), expected, why)
        }
    }

    func testEveryRemedyIsSafeWhileSessionsAreLiveAndHasATitle() {
        let all: [DoctorRemedy] = [
            .openSettingsPane(.accessibility), .openSettingsPane(.screenRecording),
            .restartDaemonWhenIdle, .quarantineOrphanLedgers(["n"]),
            .removeOrphanProfiles(["/p"]), .printDisplayWakeCommands([1]),
        ]
        for remedy in all {
            XCTAssertTrue(remedy.isSafeWhileSessionsAreLive, "\(remedy)")
            XCTAssertFalse(remedy.title.isEmpty)
            XCTAssertFalse(remedy.title.contains("\n"), "title is one prompt line: \(remedy)")
        }
    }

    func testOnlyTheDisplayRemedyCarriesAManualCommand() {
        let manual = DoctorRemedy.printDisplayWakeCommands([5]).manualCommand
        XCTAssertNotNil(manual)
        XCTAssertTrue(manual?.hasPrefix("pmset displaysleepnow") == true)
        XCTAssertTrue(manual?.contains("caffeinate -u -t 3") == true, "wake instructions follow the sleep")
        XCTAssertNil(DoctorRemedy.openSettingsPane(.focus).manualCommand)
        XCTAssertNil(DoctorRemedy.restartDaemonWhenIdle.manualCommand)
        XCTAssertNil(DoctorRemedy.quarantineOrphanLedgers(["n"]).manualCommand)
        XCTAssertNil(DoctorRemedy.removeOrphanProfiles(["/p"]).manualCommand)
        XCTAssertTrue(DoctorRemedy.printDisplayWakeCommands([5]).title.contains("not run"),
                      "the prompt itself says doctor will not run it")
    }

    // MARK: AttentionMitigation

    func testQuietAgentAppsStepIsSkippedWithoutLaunchedApps() {
        let step = AttentionMitigation.quietAgentAppsStep(launchedAppNames: [], focusActive: nil)
        XCTAssertEqual(step.name, "quiet agent apps")
        XCTAssertEqual(step.status, .skipped)
        XCTAssertNil(step.remedy)
        XCTAssertTrue(step.detail.contains("no agent apps launched yet"))
    }

    func testQuietAgentAppsStepListsAppsAndPointsAtFocus() {
        let step = AttentionMitigation.quietAgentAppsStep(
            launchedAppNames: ["TextEdit", "Google Chrome", "TextEdit", "  "], focusActive: false)
        XCTAssertEqual(step.status, .skipped, "informational: never a failure")
        XCTAssertTrue(step.detail.contains("no Focus is active"))
        XCTAssertTrue(step.detail.contains("TextEdit, Google Chrome"), step.detail)
        XCTAssertEqual(
            step.remedy,
            "Open System Settings ▸ Focus, create a Focus for agent work, and allow notifications "
                + "from everything except: TextEdit, Google Chrome")
        XCTAssertTrue(Setup.canSelfTest([step]), "the optional step never blocks the self-test")
    }

    func testFocusStatusLineCoversAllThreeStates() {
        XCTAssertTrue(AttentionMitigation.focusStatusLine(focusActive: true).contains("active"))
        XCTAssertTrue(AttentionMitigation.focusStatusLine(focusActive: false).hasPrefix("no Focus is active"))
        XCTAssertTrue(AttentionMitigation.focusStatusLine(focusActive: nil).contains("unknown"))
    }

    func testNotesAreHonestAboutLimits() {
        XCTAssertTrue(AttentionMitigation.dockAndCommandTabNote.contains("cannot hide"))
        XCTAssertTrue(AttentionMitigation.audioNote.contains("--mute-audio"))
        XCTAssertTrue(AttentionMitigation.audioNote.contains("no per-app mute"))
    }
}
