import XCTest
@testable import SpaceOKit

/// TCC attribution lookup.
///
/// The host decides whether the responsibility symbol exists and what it answers, so these tests
/// tolerate a nil result but never a self-inconsistent one: an attribution that names a pid other
/// than the one the kernel returned would send the user to the wrong Privacy row.
final class ResponsibleProcessTests: XCTestCase {
    func testAttributionIsConsistentWithResponsiblePID() {
        let responsible = ResponsibleProcess.responsiblePID(for: getpid())
        let attribution = ResponsibleProcess.attribution(for: getpid())
        guard let responsible else {
            XCTAssertNil(attribution, "no responsible pid must mean no attribution")
            return
        }
        XCTAssertGreaterThan(responsible, 0)
        // A responsible pid resolves to a process we can name, or to nothing at all.
        if let attribution {
            XCTAssertEqual(attribution.pid, responsible)
            XCTAssertEqual(attribution.isSelf, responsible == getpid())
            XCTAssertFalse(attribution.name.isEmpty)
        }
    }

    func testInvalidPIDsNeverResolve() {
        XCTAssertNil(ResponsibleProcess.responsiblePID(for: 0))
        XCTAssertNil(ResponsibleProcess.responsiblePID(for: -1))
        XCTAssertNil(ResponsibleProcess.attribution(for: -1))
    }

    func testGrantPhraseFallsBackWithoutInventingAnApp() {
        XCTAssertEqual(
            ResponsibleProcess.grantPhrase(nil), "the terminal or app running spaceo")
    }

    func testGrantPhraseNamesAppAndPath() {
        let cursor = ResponsibleProcess.Attribution(
            pid: 42, name: "Cursor", bundleIdentifier: "com.todesktop.230313mzl4w4u92",
            path: "/Applications/Cursor.app", isSelf: false)
        XCTAssertEqual(ResponsibleProcess.grantPhrase(cursor), "Cursor (/Applications/Cursor.app)")

        let bare = ResponsibleProcess.Attribution(
            pid: 43, name: "sshd", bundleIdentifier: nil, path: nil, isSelf: true)
        XCTAssertEqual(ResponsibleProcess.grantPhrase(bare), "sshd")
    }

    func testDescribeCurrentIncludesPathWhenKnown() {
        guard let description = ResponsibleProcess.describeCurrent() else {
            XCTAssertNil(ResponsibleProcess.attribution(for: getpid()))
            return
        }
        let attribution = ResponsibleProcess.attribution(for: getpid())
        XCTAssertNotNil(attribution)
        if let path = attribution?.path, !path.isEmpty {
            XCTAssertTrue(description.contains("("), description)
            XCTAssertTrue(description.hasSuffix("(\(path))"), description)
        } else {
            XCTAssertEqual(description, attribution?.name)
        }
    }

    func testExecutablePathResolvesForTheCurrentProcess() {
        let path = ResponsibleProcess.executablePath(of: getpid())
        XCTAssertNotNil(path)
        XCTAssertTrue(path?.hasPrefix("/") ?? false)
        XCTAssertNil(ResponsibleProcess.executablePath(of: -1))
    }
}
