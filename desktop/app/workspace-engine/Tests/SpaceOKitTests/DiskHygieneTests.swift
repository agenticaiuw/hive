import XCTest
@testable import SpaceOKit

/// SPAO-153: orphan collection only ever touches old, unreferenced SpaceO directories.
final class DiskHygieneTests: XCTestCase {

    private let fileManager = FileManager.default
    private var container: URL!
    private let now = Date(timeIntervalSince1970: 1_700_000_000) // 2023-11-14T22:13:20Z

    override func setUpWithError() throws {
        container = fileManager.temporaryDirectory.appendingPathComponent(
            "spaceo-disk-hygiene-tests-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: container, withIntermediateDirectories: false,
                                        attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        try? fileManager.removeItem(at: container)
    }

    private func makeDirectory(_ name: String, under parent: URL, age: TimeInterval,
                               payloadBytes: Int = 0) throws -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: true)
        try fileManager.createDirectory(at: url, withIntermediateDirectories: false)
        if payloadBytes > 0 {
            try Data(repeating: 0x41, count: payloadBytes)
                .write(to: url.appendingPathComponent("payload.bin"))
        }
        try fileManager.setAttributes([.modificationDate: now.addingTimeInterval(-age)],
                                      ofItemAtPath: url.path)
        return url
    }

    private func makeFile(_ name: String, under parent: URL, age: TimeInterval) throws -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: false)
        try Data("{}".utf8).write(to: url)
        try fileManager.setAttributes([.modificationDate: now.addingTimeInterval(-age)],
                                      ofItemAtPath: url.path)
        return url
    }

    // MARK: - Orphan candidates

    private struct Fixture {
        let temporary: URL
        let referenced: URL
        let orphan: URL
        let young: URL
        let outside: URL
    }

    private func makeFixture() throws -> Fixture {
        let temporary = container.appendingPathComponent("tmp", isDirectory: true)
        try fileManager.createDirectory(at: temporary, withIntermediateDirectories: false)
        let day: TimeInterval = 24 * 3600

        let referenced = try makeDirectory("spaceo-browser-1-REF", under: temporary, age: 2 * day)
        let orphan = try makeDirectory("spaceo-browser-1-OLD", under: temporary, age: 2 * day,
                                       payloadBytes: 1_024)
        let young = try makeDirectory("spaceo-browser-1-NEW", under: temporary, age: 3600)
        _ = try makeDirectory("unrelated-old", under: temporary, age: 2 * day)

        let outside = try makeDirectory("elsewhere", under: container, age: 2 * day,
                                        payloadBytes: 16)
        try fileManager.createSymbolicLink(
            at: temporary.appendingPathComponent("spaceo-e-1-LINK"),
            withDestinationURL: outside)
        return Fixture(temporary: temporary, referenced: referenced, orphan: orphan,
                       young: young, outside: outside)
    }

    func testOrphanCandidatesSkipReferencedYoungUnknownAndSymlinkedDirectories() throws {
        let fixture = try makeFixture()
        let candidates = try DiskHygiene.orphanCandidates(
            in: fixture.temporary,
            referenced: [fixture.referenced.path],
            now: now)
        XCTAssertEqual(candidates.map(\.lastPathComponent), ["spaceo-browser-1-OLD"])
    }

    func testReferencedPathsMatchEitherSpelling() throws {
        let fixture = try makeFixture()
        let resolved = fixture.orphan.resolvingSymlinksInPath().path
        let candidates = try DiskHygiene.orphanCandidates(
            in: fixture.temporary,
            referenced: [fixture.referenced.path, resolved],
            now: now)
        XCTAssertTrue(candidates.isEmpty)
    }

    func testDryRunReportsRemovalWithoutRemoving() throws {
        let fixture = try makeFixture()
        let candidates = try DiskHygiene.orphanCandidates(
            in: fixture.temporary, referenced: [fixture.referenced.path], now: now)

        let report = DiskHygiene.clean(candidates: candidates, dryRun: true)
        XCTAssertTrue(report.dryRun)
        XCTAssertEqual(report.scanned, 1)
        XCTAssertEqual(report.removedPaths, [fixture.orphan.standardizedFileURL.path])
        XCTAssertTrue(report.keptPaths.isEmpty)
        XCTAssertGreaterThanOrEqual(report.reclaimedBytes, 1_024)
        XCTAssertTrue(fileManager.fileExists(atPath: fixture.orphan.path))
        XCTAssertTrue(DiskHygiene.summaryLine(report).hasPrefix("dry run: would reclaim "))
    }

    func testCleanRemovesOnlyCandidates() throws {
        let fixture = try makeFixture()
        let candidates = try DiskHygiene.orphanCandidates(
            in: fixture.temporary, referenced: [fixture.referenced.path], now: now)

        let report = DiskHygiene.clean(candidates: candidates, dryRun: false)
        XCTAssertFalse(report.dryRun)
        XCTAssertEqual(report.removedPaths, [fixture.orphan.standardizedFileURL.path])
        XCTAssertGreaterThanOrEqual(report.reclaimedBytes, 1_024)
        XCTAssertFalse(fileManager.fileExists(atPath: fixture.orphan.path))
        XCTAssertTrue(fileManager.fileExists(atPath: fixture.referenced.path))
        XCTAssertTrue(fileManager.fileExists(atPath: fixture.young.path))
        XCTAssertTrue(fileManager.fileExists(atPath: fixture.outside.path))
        XCTAssertTrue(fileManager.fileExists(
            atPath: fixture.outside.appendingPathComponent("payload.bin").path))
    }

    func testCleanKeepsCandidateThatBecameSymlink() throws {
        let fixture = try makeFixture()
        let link = fixture.temporary.appendingPathComponent("spaceo-e-1-LINK")
        let report = DiskHygiene.clean(candidates: [link], dryRun: false)
        XCTAssertEqual(report.keptPaths, [link.standardizedFileURL.path])
        XCTAssertTrue(report.removedPaths.isEmpty)
        XCTAssertTrue(fileManager.fileExists(atPath: fixture.outside.path))
    }

    func testDirectorySizeCountsRegularFiles() throws {
        let fixture = try makeFixture()
        XCTAssertGreaterThanOrEqual(DiskHygiene.directorySize(fixture.orphan), 1_024)
        XCTAssertEqual(DiskHygiene.directorySize(fixture.young), 0)
    }

    // MARK: - Ledger quarantine

    func testQuarantineMovesOldForeignLedgersAndWritesWhy() throws {
        let root = container.appendingPathComponent("state", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: false)
        let day: TimeInterval = 24 * 3600
        let live = try makeFile("sessions-socket-live.json", under: root, age: 30 * day)
        let old = try makeFile("sessions-socket-abc.json", under: root, age: 8 * day)
        let recent = try makeFile("sessions-socket-new.json", under: root, age: 2 * day)
        let unrelated = try makeFile("notes.txt", under: root, age: 30 * day)

        let moved = try DiskHygiene.quarantineOrphanLedgers(
            rootDirectory: root, liveNamespace: "socket-live", now: now)

        XCTAssertEqual(moved.map(\.lastPathComponent), ["socket-abc-20231114221320"])
        let destination = root.appendingPathComponent("quarantine", isDirectory: true)
            .appendingPathComponent("socket-abc-20231114221320", isDirectory: true)
        XCTAssertEqual(moved.first?.standardizedFileURL.path, destination.standardizedFileURL.path)
        XCTAssertFalse(fileManager.fileExists(atPath: old.path))
        XCTAssertTrue(fileManager.fileExists(
            atPath: destination.appendingPathComponent("sessions-socket-abc.json").path))
        let why = try String(contentsOf: destination.appendingPathComponent("WHY.txt"), encoding: .utf8)
        XCTAssertTrue(why.contains("Reason:"))
        XCTAssertTrue(why.contains("socket-abc"))

        XCTAssertTrue(fileManager.fileExists(atPath: live.path))
        XCTAssertTrue(fileManager.fileExists(atPath: recent.path))
        XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))
    }

    func testQuarantineUnsupportedLedgerRecordsReasonAndRejectsOutsideRoot() throws {
        let root = container.appendingPathComponent("state", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: false)
        let ledger = try makeFile("sessions-socket-live.json", under: root, age: 0)

        let destination = try DiskHygiene.quarantineUnsupportedLedger(
            at: ledger, rootDirectory: root, reason: "schema 9 is unsupported", now: now)
        XCTAssertEqual(destination.lastPathComponent, "socket-live-20231114221320")
        XCTAssertFalse(fileManager.fileExists(atPath: ledger.path))
        let why = try String(contentsOf: destination.appendingPathComponent("WHY.txt"), encoding: .utf8)
        XCTAssertTrue(why.contains("schema 9 is unsupported"))

        let outside = try makeFile("sessions-socket-x.json", under: container, age: 0)
        XCTAssertThrowsError(try DiskHygiene.quarantineUnsupportedLedger(
            at: outside, rootDirectory: root, reason: "x", now: now))
        XCTAssertTrue(fileManager.fileExists(atPath: outside.path))
    }

    func testLedgerNamespaceParsing() {
        XCTAssertEqual(DiskHygiene.ledgerNamespace(fromFileName: "sessions-socket-abc.json"), "socket-abc")
        XCTAssertNil(DiskHygiene.ledgerNamespace(fromFileName: "sessions-.json"))
        XCTAssertNil(DiskHygiene.ledgerNamespace(fromFileName: "sessions-a/b.json"))
        XCTAssertNil(DiskHygiene.ledgerNamespace(fromFileName: "sessions-...json"))
        XCTAssertNil(DiskHygiene.ledgerNamespace(fromFileName: "other.json"))
    }

    // MARK: - Summary

    func testSummaryLineFormatting() {
        let report = DiskHygieneReport(
            scanned: 16,
            removedPaths: (0..<12).map { "/tmp/spaceo-browser-\($0)" },
            quarantinedPaths: ["/state/quarantine/x"],
            keptPaths: ["/tmp/a", "/tmp/b", "/tmp/c"],
            reclaimedBytes: 419 * 1_024 * 1_024,
            dryRun: false)
        XCTAssertEqual(DiskHygiene.summaryLine(report),
                       "reclaimed 419 MB from 12 orphaned directories (3 kept, 1 quarantined)")

        let single = DiskHygieneReport(scanned: 1, removedPaths: ["/tmp/x"],
                                       reclaimedBytes: 2_048, dryRun: true)
        XCTAssertEqual(DiskHygiene.summaryLine(single),
                       "dry run: would reclaim 2 KB from 1 orphaned directory (0 kept, 0 quarantined)")

        XCTAssertEqual(DiskHygiene.formatBytes(0), "0 B")
        XCTAssertEqual(DiskHygiene.formatBytes(1_023), "1023 B")
        XCTAssertEqual(DiskHygiene.formatBytes(3 * 1_024 * 1_024 * 1_024), "3 GB")
    }
}
