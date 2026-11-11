import XCTest
@testable import SpaceOKit

/// SPAO-163 follow-up: the one-sentence verdict is derived only from the report.
final class IsolationSummaryTests: XCTestCase {

    private func passed(_ dimension: IsolationDimension) -> IsolationCheckReport {
        IsolationCheckReport(dimension: dimension, coverage: .observed, status: .passed,
                             evidence: "\(dimension.rawValue) unchanged")
    }

    private func unknown(_ dimension: IsolationDimension, evidence: String) -> IsolationCheckReport {
        IsolationCheckReport(dimension: dimension, coverage: .unknown, status: .unknown,
                             evidence: evidence)
    }

    private func failed(_ dimension: IsolationDimension, _ failure: String) -> IsolationCheckReport {
        IsolationCheckReport(dimension: dimension, coverage: .observed, status: .failed,
                             evidence: failure, failures: [failure])
    }

    func testIntactSentence() {
        let report = IsolationReport(checks: IsolationDimension.allCases.map(passed))
        XCTAssertEqual(report.verdict, .intact)
        XCTAssertEqual(report.summarySentence,
                       "No disturbance to your desktop was observed and every required check was covered.")
        XCTAssertEqual(report.nextStepLine, "Continue.")
    }

    func testPartialSentenceNamesBothUnknownChecksAndAccessibilityCause() {
        let report = IsolationReport(checks: [
            passed(.menuBarOwner), passed(.windowServerFrontProcess),
            unknown(.keyInputRoute, evidence: "Accessibility is not granted to this process"),
            unknown(.textInputRoute, evidence: "no safe text-input observation"),
            passed(.cursorLocation), passed(.activeSpace),
        ], accessibilityGranted: false)
        XCTAssertEqual(report.verdict, .partial)
        XCTAssertEqual(report.partialCause, .accessibilityMissing)
        XCTAssertEqual(report.summarySentence,
                       "No disturbance to your desktop was observed; keyboard routing and "
                       + "text-input routing could not be checked because Accessibility is "
                       + "missing on the daemon.")
        XCTAssertEqual(report.nextStepLine,
                       "Grant Accessibility to the daemon's host app to cover them. Until then, "
                       + "continue for reversible steps and treat unknown checks as untested; for "
                       + "irreversible steps (sending, deleting, paying) use strict isolation, "
                       + "which refuses to act without full evidence.")
        XCTAssertEqual(report.summarySentence.filter { $0 == "." }.count, 1)
    }

    /// The production evidence for an unobserved keyboard route names Accessibility whether or
    /// not the grant is present. A host that HAS the grant must not be told to grant it.
    func testGrantedHostWithProductionEvidenceIsNotToldToGrantAccessibility() throws {
        let evidence = "Accessibility focused-application proxy was unavailable; "
            + "the keyboard/text route was not ruled out"
        let report = IsolationReport(checks: [
            passed(.menuBarOwner), passed(.windowServerFrontProcess),
            unknown(.keyInputRoute, evidence: evidence),
            unknown(.textInputRoute, evidence: evidence),
            passed(.cursorLocation), passed(.activeSpace),
        ], accessibilityGranted: true)
        XCTAssertEqual(report.partialCause, .focusNotReported)
        XCTAssertEqual(report.summarySentence,
                       "No disturbance to your desktop was observed; keyboard routing and "
                       + "text-input routing could not be checked because the system did not "
                       + "report which app has keyboard focus.")
        XCTAssertFalse(report.summarySentence.contains("missing"))
        XCTAssertFalse(report.nextStepLine.contains("Grant Accessibility"))
        XCTAssertEqual(report.nextStepLine,
                       "You may continue for reversible steps and treat unknown checks as "
                       + "untested; for irreversible steps (sending, deleting, paying) use strict "
                       + "isolation, which refuses to act without full evidence.")

        // The grant state survives the wire, and an older daemon that omits it gets no guess.
        let decoded = try Wire.decoder.decode(IsolationReport.self, from: Wire.encoder.encode(report))
        XCTAssertEqual(decoded.accessibilityGranted, true)
        let legacy = IsolationReport(checks: report.checks)
        XCTAssertEqual(legacy.partialCause, .noObservation)
        XCTAssertFalse(legacy.nextStepLine.contains("Grant Accessibility"))
    }

    func testReportsCarryTheSnapshotGrantAndMissingAtEitherEndWins() {
        var before = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1, cursor: .zero, activeSpace: 1)
        var after = before
        before.accessibilityGranted = true
        after.accessibilityGranted = true
        XCTAssertEqual(after.report(comparedTo: before).accessibilityGranted, true)
        XCTAssertEqual(after.currentReport().accessibilityGranted, true)
        before.accessibilityGranted = false
        XCTAssertEqual(after.report(comparedTo: before).accessibilityGranted, false)
        before.accessibilityGranted = nil
        after.accessibilityGranted = nil
        XCTAssertNil(after.report(comparedTo: before).accessibilityGranted)
        let merged = IsolationReport(checks: [], accessibilityGranted: true)
            .includingCurrentFailures(IsolationReport(checks: []))
        XCTAssertEqual(merged.accessibilityGranted, true)
    }

    func testPartialSentenceFallsBackToNoObservationCause() {
        let report = IsolationReport(checks: [
            passed(.menuBarOwner), passed(.windowServerFrontProcess),
            passed(.keyInputRoute), passed(.textInputRoute),
            unknown(.cursorLocation, evidence: "no stage rectangle identifies the display"),
            passed(.activeSpace),
        ])
        XCTAssertEqual(report.summarySentence,
                       "No disturbance to your desktop was observed; cursor location could not "
                       + "be checked because no usable observation was available.")
    }

    func testPartialSentenceListsThreeChecksWithOxfordAnd() {
        let report = IsolationReport(checks: [
            unknown(.menuBarOwner, evidence: "x"),
            unknown(.windowServerFrontProcess, evidence: "y"),
            unknown(.activeSpace, evidence: "z"),
        ])
        XCTAssertTrue(report.summarySentence.contains(
            "menu bar owner, front process, and active Space could not be checked"))
    }

    func testBreachedSentenceListsAtMostTwoFailuresWithoutInnerPeriods() {
        let report = IsolationReport(checks: [
            failed(.menuBarOwner, "menu bar owner changed to pid 42."),
            failed(.windowServerFrontProcess, "front process changed"),
            failed(.activeSpace, "active Space changed"),
        ])
        XCTAssertEqual(report.verdict, .breached)
        XCTAssertEqual(report.summarySentence,
                       "Your desktop WAS disturbed: menu bar owner changed to pid 42; "
                       + "front process changed; SpaceO paused the session's agent input.")
        XCTAssertEqual(report.nextStepLine, "Resolve the breach, then explicitly resume the session.")
        XCTAssertEqual(report.summarySentence.filter { $0 == "." }.count, 1)
    }

    func testToolDescriptionLine() {
        XCTAssertEqual(IsolationVerdictGuidance.toolDescriptionLine(),
                       "verdict intact: continue; partial: continue but unknown checks were not "
                       + "tested; breached: input is paused, resolve and resume.")
    }
}
