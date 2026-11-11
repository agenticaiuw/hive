import XCTest
import Foundation
@testable import SpaceOKit

final class DaemonLogTests: XCTestCase {
    private final class LoggerReference: @unchecked Sendable {
        // Set before the worker starts, then only read by the timestamp callback.
        weak var value: DaemonLog?
    }

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-daemon-log-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeLog(
        rotationLimitBytes: Int = 5_000_000,
        timestamp: @escaping () -> Date = { Date(timeIntervalSince1970: 1_000) }
    ) throws -> (DaemonLog, URL) {
        let url = directory.appendingPathComponent("daemon.log")
        let log = DaemonLog(rotationLimitBytes: rotationLimitBytes, timestamp: timestamp)
        try log.configure(fileURL: url)
        return (log, url)
    }

    private func lines(at url: URL) throws -> [[String: String]] {
        let text = try String(contentsOf: url, encoding: .utf8)
        return try text.split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(
                with: Data($0.utf8)) as? [String: String])
        }
    }

    func testUnconfiguredLogIsANoOp() {
        let log = DaemonLog()
        XCTAssertFalse(log.isConfigured)
        log.event("daemon.started", ["socket": "/tmp/x"])  // must not crash or write anywhere
    }

    func testEventWritesOneTimestampedJSONLine() throws {
        let (log, url) = try makeLog()
        log.event("daemon.started", ["socket": "/tmp/x", "pid": "42"])

        let written = try lines(at: url)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["kind"], "daemon.started")
        XCTAssertEqual(written[0]["socket"], "/tmp/x")
        XCTAssertEqual(written[0]["pid"], "42")
        XCTAssertEqual(written[0]["ts"], "1970-01-01T00:16:40.000Z")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testTimestampCallbackCanInspectLoggerWithoutDeadlocking() async throws {
        let reference = LoggerReference()
        let url = directory.appendingPathComponent("reentrant-clock.log")
        let log = DaemonLog(timestamp: {
            XCTAssertTrue(reference.value?.isConfigured == true)
            XCTAssertEqual(reference.value?.location, url)
            return Date(timeIntervalSince1970: 1000)
        })
        reference.value = log
        try log.configure(fileURL: url)
        let finished = expectation(description: "reentrant clock completed")
        DispatchQueue.global().async {
            log.event("synthetic")
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 2)
        let record = try XCTUnwrap(lines(at: url).first)
        XCTAssertEqual(record["kind"], "synthetic")
        XCTAssertEqual(record["ts"], "1970-01-01T00:16:40.000Z")
    }

    func testRecordLogsFailuresWithContextAndNeverTheLease() throws {
        let (log, url) = try makeLog()
        var request = Request(cmd: "run")
        request.session = "agent-1"
        request.app = "TextEdit"
        request.diagnosticTraceID = "trace-123"
        request.diagnosticRunID = "run-123"
        request.controllerLeaseID = UUID()
        request.controllerOwner = DurableSessionOwner(
            id: "mcp-1", kind: .mcp, label: "Test")
        var response = Response(ok: false)
        response.error = "launch failed: TextEdit exited"
        log.record(request: request, response: response, seconds: 0.25)

        let written = try lines(at: url)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["kind"], "request.failed")
        XCTAssertEqual(written[0]["cmd"], "run")
        XCTAssertEqual(written[0]["session"], "agent-1")
        XCTAssertEqual(written[0]["app"], "TextEdit")
        XCTAssertEqual(written[0]["controller"], "mcp:mcp-1")
        XCTAssertEqual(written[0]["ms"], "250")
        XCTAssertEqual(written[0]["trace"], "trace-123")
        XCTAssertEqual(written[0]["run"], "run-123")
        XCTAssertEqual(written[0]["error"], "launch failed: TextEdit exited")
        XCTAssertNotNil(UInt64(written[0]["rss_bytes"] ?? ""))
        XCTAssertNotNil(UInt64(written[0]["physical_footprint_bytes"] ?? ""))
        XCTAssertNotNil(UInt64(written[0]["peak_rss_bytes"] ?? ""))

        let raw = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(
            raw.contains(request.controllerLeaseID!.uuidString),
            "the lease credential must never reach the log")
    }

    func testRecordSkipsSuccessesByDefault() throws {
        let (log, url) = try makeLog()
        let request = Request(cmd: "windows")
        log.record(request: request, response: Response(ok: true), seconds: 0.01)

        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertEqual(text, "", "successes are debug-only; the failure log stays readable")
    }

    func testRequestCanOptIntoMetricsOnASharedDaemon() throws {
        let (log, url) = try makeLog()
        var request = Request(cmd: "windows")
        request.diagnosticMetrics = true
        request.diagnosticRunID = "shared-client-run"
        log.record(request: request, response: Response(ok: true), seconds: 0.01)

        let written = try lines(at: url)
        XCTAssertEqual(written[0]["kind"], "request.ok")
        XCTAssertEqual(written[0]["run"], "shared-client-run")
    }

    func testRecordIncludesTeardownDetail() throws {
        let (log, url) = try makeLog()
        var report = TeardownReport()
        report.pendingSessionIDs = ["cu-electron"]
        var response = Response(ok: false)
        response.error = "teardown incomplete"
        response.teardown = report
        log.record(request: Request(cmd: "session.destroy"), response: response, seconds: 1)

        let written = try lines(at: url)
        XCTAssertEqual(written.count, 1)
        XCTAssertTrue(
            written[0]["teardown"]?.contains("cu-electron") == true,
            "the surviving-resource detail is the whole point of the log")
    }

    func testRotationKeepsOnePredecessor() throws {
        let (log, url) = try makeLog(rotationLimitBytes: 200)
        for index in 0..<20 {
            log.event("daemon.started", ["fill": String(repeating: "x", count: 40),
                                         "n": String(index)])
        }

        let rotated = url.appendingPathExtension("1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: rotated.path))
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let liveSize = (try FileManager.default
            .attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        XCTAssertLessThan(liveSize, 400, "the live file restarts after rotation")
        // Every line in both files stays parseable — rotation must not tear a record.
        _ = try lines(at: url)
        _ = try lines(at: rotated)
    }

    func testEventBoundsEveryFreeTextField() throws {
        let (log, url) = try makeLog()
        let exact = String(repeating: "😀", count: DaemonLog.maximumFieldCharacters)
        log.event("request.failed", [
            "error": String(repeating: "x", count: DaemonLog.maximumFieldCharacters + 500),
            "exact_byte_fit": exact + "extra",
        ])

        let written = try lines(at: url)
        XCTAssertEqual(written[0]["error"]?.count, DaemonLog.maximumFieldCharacters)
        XCTAssertEqual(written[0]["exact_byte_fit"], exact)
    }

    func testUnconfiguredRecordsRemainNoOpsForFailuresAndExplicitMetrics() {
        let log = DaemonLog(timestamp: { XCTFail("unconfigured logs must not format a record"); return Date() })
        var request = Request(cmd: "synthetic")
        request.diagnosticMetrics = true
        log.record(request: request, response: .success(), seconds: .infinity)
        log.record(request: request, response: Response(ok: false), seconds: .nan)
        XCTAssertFalse(log.isConfigured)
        XCTAssertNil(log.location)
    }

    func testExtremeTelemetryNeverTrapsOrInventsFiniteDurations() throws {
        let (log, url) = try makeLog()
        var request = Request(cmd: "synthetic")
        request.diagnosticMetrics = true
        let initial = ProcessMetricsSnapshot(residentBytes: .max, physicalFootprintBytes: .max,
            peakResidentBytes: .max, userCPUSeconds: .nan, systemCPUSeconds: -.infinity)
        for duration in [Double.nan, .infinity, -.infinity, .greatestFiniteMagnitude,
                         -.greatestFiniteMagnitude, 0, 0.0015, -0.0015] {
            log.record(request: request, response: .success(), seconds: duration, metricsStarted: initial)
        }
        let records = try lines(at: url)
        XCTAssertEqual(records.map { $0["ms"] }, Array(repeating: "unavailable", count: 5) + ["0", "2", "-2"])
        for record in records {
            XCTAssertEqual(record["cpu_user_ms"], "unavailable")
            XCTAssertEqual(record["cpu_system_ms"], "unavailable")
            for (current, delta) in [("rss_bytes", "rss_delta_bytes"),
                                     ("physical_footprint_bytes", "physical_footprint_delta_bytes")] {
                let value = try XCTUnwrap(UInt64(try XCTUnwrap(record[current])))
                XCTAssertEqual(record[delta], "-" + String(UInt64.max - value))
            }
        }
    }

    func testFailedRotationPreservesActiveLogAndUnexpectedDirectoryThenRecovers() throws {
        let (log, url) = try makeLog(rotationLimitBytes: 1)
        log.event("before")
        let original = try Data(contentsOf: url)
        let predecessor = url.appendingPathExtension("1")
        try FileManager.default.createDirectory(at: predecessor, withIntermediateDirectories: false)
        let marker = predecessor.appendingPathComponent("preserve.txt")
        try Data("synthetic sentinel".utf8).write(to: marker)
        log.event("refused")
        XCTAssertEqual(try Data(contentsOf: url), original)
        XCTAssertEqual(try String(contentsOf: marker), "synthetic sentinel")
        try FileManager.default.removeItem(at: predecessor)
        log.event("after")
        XCTAssertEqual(try Data(contentsOf: predecessor), original)
        XCTAssertEqual(try lines(at: url).map { $0["kind"] }, ["after"])
    }

    func testEventBoundsKeyCountAndPathologicalUnicodePayloads() throws {
        let (log, url) = try makeLog()
        var fields = Dictionary(uniqueKeysWithValues: (0..<1_000).map {
            (String(format: "k%04d", $0), "value")
        })
        fields["error"] = "a" + String(repeating: "\u{0301}", count: 100_000)
        fields[String(repeating: "A", count: DaemonLog.maximumKeyBytes + 1)] = "omit"
        log.event(String(repeating: "😀", count: 100), fields)
        let record = try XCTUnwrap(lines(at: url).first)
        XCTAssertEqual(record["error"], "…", "an oversized single grapheme must not escape the byte cap")
        XCTAssertLessThanOrEqual(record.count, DaemonLog.maximumFieldCount + 3)
        XCTAssertTrue(record.keys.allSatisfy { $0.utf8.count <= DaemonLog.maximumKeyBytes })
        XCTAssertTrue(record.values.allSatisfy { $0.utf8.count <= DaemonLog.maximumFieldBytes })
        XCTAssertLessThanOrEqual(record["kind"]?.utf8.count ?? 0, DaemonLog.maximumKindBytes)
        XCTAssertNotNil(record["k0030"])
        XCTAssertNil(record["k0031"])
    }

    func testProcessMetricsSnapshotUsesFiniteNonNegativeCounters() {
        let snapshot = ProcessMetricsSnapshot.capture()
        XCTAssertGreaterThan(snapshot.residentBytes, 0)
        XCTAssertGreaterThan(snapshot.physicalFootprintBytes, 0)
        XCTAssertGreaterThan(snapshot.peakResidentBytes, 0)
        XCTAssertGreaterThanOrEqual(snapshot.userCPUSeconds, 0)
        XCTAssertGreaterThanOrEqual(snapshot.systemCPUSeconds, 0)
    }

    func testCurrentExecutableFingerprintIsAFullSHA256() {
        let hash = RuntimeIdentity.currentExecutableSHA256()
        XCTAssertEqual(hash?.count, 64)
        XCTAssertTrue(hash?.allSatisfy { $0.isHexDigit } == true)
    }

    func testCurrentExecutableBuildUUIDIsAvailable() {
        let value = RuntimeIdentity.currentExecutableBuildUUID()
        XCTAssertNotNil(value)
        XCTAssertNotNil(value.flatMap(UUID.init(uuidString:)))
    }
}
