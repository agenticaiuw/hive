import XCTest
import Foundation
@testable import SpaceOKit
@testable import SpaceOMCP

/// Local diagnostic logging for improvement loops: settings resolution, the MCP agent journal,
/// its redaction rules, and the richer daemon request records. Files go to a temporary
/// directory; nothing reads or writes the host's real logs or settings.
final class LoggingJournalTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-logging-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var settingsFile: URL { directory.appendingPathComponent("logging.json") }

    private func monitor(_ settings: LoggingSettings, environment: [String: String] = [:]) throws -> LoggingSettingsMonitor {
        try settings.save(to: settingsFile)
        return LoggingSettingsMonitor(fileURL: settingsFile, environment: environment, interval: 0)
    }

    private func records(in journal: MCPJournal) throws -> [[String: Any]] {
        let url = try XCTUnwrap(journal.fileURL)
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }

    // MARK: Settings

    func testEnvironmentOverridesTheFileAndAnInvalidFileIsIgnored() throws {
        try LoggingSettings(journal: .metadata, requestMetrics: false).save(to: settingsFile)
        let resolved = LoggingSettings.resolve(
            environment: ["SPACEO_JOURNAL": "FULL", "SPACEO_LOG_METRICS": "1"], fileURL: settingsFile)
        XCTAssertTrue(resolved.fileExists)
        XCTAssertEqual(resolved.settings.journal, .full)
        XCTAssertTrue(resolved.settings.requestMetrics)
        XCTAssertEqual(resolved.environmentOverrides, ["SPACEO_JOURNAL=full", "SPACEO_LOG_METRICS=1"])

        try Data("{\"journal\":\"full\",\"requestMetrics\":true,\"retentionDays\":900,\"maxFileMegabytes\":5}".utf8)
            .write(to: settingsFile)
        XCTAssertEqual(LoggingSettings.load(environment: [:], fileURL: settingsFile), LoggingSettings(),
                       "an out-of-range file must not switch logging on or stop the daemon")
    }

    func testSavedSettingsAreOwnerOnlyAndBounded() throws {
        try LoggingSettings(journal: .full, requestMetrics: true).save(to: settingsFile)
        let mode = try FileManager.default.attributesOfItem(atPath: settingsFile.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        XCTAssertThrowsError(try LoggingSettings(retentionDays: 0).save(to: settingsFile))
        XCTAssertThrowsError(try LoggingSettings(maxFileMegabytes: 501).save(to: settingsFile))
    }

    func testEnableDefaultsToFullWithRequestMetricsAndDisableTurnsBothOff() throws {
        let enabled = try LoggingCommand.enabled(from: LoggingSettings(), level: nil,
                                                 retentionDays: 30, maxFileMegabytes: nil)
        XCTAssertEqual(enabled, LoggingSettings(journal: .full, requestMetrics: true, retentionDays: 30))
        XCTAssertEqual(try LoggingCommand.enabled(from: enabled, level: "metadata", retentionDays: nil,
                                                  maxFileMegabytes: 10).journal, .metadata)
        XCTAssertThrowsError(try LoggingCommand.enabled(from: enabled, level: "off", retentionDays: nil,
                                                        maxFileMegabytes: nil))
        let disabled = LoggingCommand.disabled(from: enabled)
        XCTAssertFalse(disabled.isEnabled)
        XCTAssertEqual(disabled.retentionDays, 30, "disabling keeps the operator's retention choice")
    }

    func testMonitorPicksUpAChangedFileWithoutARestart() throws {
        let watched = try monitor(LoggingSettings())
        XCTAssertEqual(watched.current.journal, .off)
        // A different modification time is what the monitor keys on.
        Thread.sleep(forTimeInterval: 1.1)
        try LoggingSettings(journal: .metadata, requestMetrics: true).save(to: settingsFile)
        XCTAssertEqual(watched.current.journal, .metadata)
        XCTAssertTrue(watched.current.requestMetrics)
    }

    func testStatusLinesNameEveryLocationAndTheReportCommand() {
        let resolution = LoggingSettings.Resolution(
            settings: LoggingSettings(journal: .full, requestMetrics: true), fileExists: true,
            environmentOverrides: [])
        let lines = LoggingCommand.statusLines(resolution, settingsFile: URL(fileURLWithPath: "/s.json"),
                                               journalDirectory: URL(fileURLWithPath: "/j"),
                                               daemonLog: URL(fileURLWithPath: "/d.log"))
        XCTAssertTrue(lines.contains { $0.hasPrefix("agent journal  : full") })
        XCTAssertTrue(lines.contains("daemon requests: every request"))
        XCTAssertTrue(lines.contains { $0.contains("journal-report.mjs /j --daemon-log /d.log") })
    }

    // MARK: Redaction

    func testTypedAndClipboardTextIsNeverJournaledButStaysComparable() {
        let journal = MCPJournal(monitor: LoggingSettingsMonitor(fileURL: settingsFile, environment: [:]),
                                 directory: directory)
        let redacted = MCPJournalRedaction.arguments(
            ["text": "hunter2", "session": "s", "steps": [["tool": "spaceo_type", "arguments": ["text": "hunter2"]]]],
            level: .full, fingerprint: { journal.fingerprint(of: $0) })
        let top = redacted["text"] as? [String: Any]
        XCTAssertEqual(top?["chars"] as? Int, 7)
        let nested = ((redacted["steps"] as? [[String: Any]])?.first?["arguments"] as? [String: Any])?["text"] as? [String: Any]
        XCTAssertEqual(nested?["fp"] as? String, top?["fp"] as? String, "equal text is recognisable within a connection")
        let other = MCPJournal(monitor: LoggingSettingsMonitor(fileURL: settingsFile, environment: [:]),
                               directory: directory)
        XCTAssertNotEqual(other.fingerprint(of: "hunter2"), journal.fingerprint(of: "hunter2"),
                          "fingerprints are keyed per connection, so they cannot be matched or guessed across files")
        let serialized = String(decoding: try! JSONSerialization.data(withJSONObject: redacted), as: UTF8.self)
        XCTAssertFalse(serialized.contains("hunter2"))
    }

    func testURLsLoseQueriesAndMetadataKeepsOnlyTheHostAndFileNames() {
        let raw = "https://user:pw@example.com/reset/confirm?token=SECRET#frag"
        XCTAssertEqual(MCPJournalRedaction.url(raw, level: .full), "https://example.com/reset/confirm")
        XCTAssertEqual(MCPJournalRedaction.url(raw, level: .metadata), "https://example.com")
        let metadata = MCPJournalRedaction.arguments(
            ["files": ["/Users/me/Taxes/2025.pdf"], "output": "/tmp/shot.png"], level: .metadata, fingerprint: { _ in "" })
        XCTAssertEqual(metadata["files"] as? [String], ["2025.pdf"])
        XCTAssertEqual(metadata["output"] as? String, "shot.png")
    }

    // MARK: Journal records

    private func call(_ tool: String, outcome: String = "ok", arguments: [String: Any] = [:],
                      text: String = "click: confirmed (accessibility-action)", response: Response? = nil) -> MCPJournalCall {
        var request = Request(cmd: "click")
        request.session = "agent-1"
        request.window = 42
        return MCPJournalCall(tool: tool, trace: "t-\(UUID().uuidString.prefix(4))", arguments: arguments,
                              startedAt: Date(), milliseconds: 12, outcome: outcome, request: request,
                              response: response, result: ["content": [["type": "text", "text": text]],
                                                           "isError": outcome != "ok"])
    }


    func testLifecycleRecordsOwnershipFactsWithoutLeaseCredentials() throws {
        let journal = MCPJournal(monitor: try monitor(LoggingSettings(journal: .metadata)), directory: directory)
        let json = """
        {"id":"retained","displayID":7,"x":0,"y":0,"width":1280,"height":800,
         "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,"spaces":[],
         "hasOwnSpace":false,"apps":[],"windows":[],
         "createdAt":"2026-07-28T00:00:00Z","teardownPending":false}
        """
        let credential = UUID()
        var response = Response.failure(SpaceOError.badRequest("synthetic launch failure"))
        response.session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        var create = call("spaceo_session_create", outcome: "tool_error", response: response)
        create.request = Request(cmd: "session.create")
        journal.toolCall(create)
        response.controllerLeaseID = credential
        create.response = response
        journal.toolCall(create)
        var destroy = call("spaceo_session_destroy", response: Response(ok: true))
        destroy.request = Request(cmd: "session.destroy")
        destroy.request?.session = "retained"
        journal.toolCall(destroy)
        destroy.response = Response(ok: false)
        destroy.outcome = "tool_error"
        journal.toolCall(destroy)
        destroy.releasedSessions = ["second"]
        journal.toolCall(destroy)
        let written = try records(in: journal)
        XCTAssertNil(written[0]["session_lifecycle"], "a response with no lease is not acquired ownership")
        XCTAssertEqual((written[1]["session_lifecycle"] as? [String: Any])?["acquired"] as? String, "retained")
        XCTAssertEqual((written[2]["session_lifecycle"] as? [String: Any])?["released"] as? [String], ["retained"])
        XCTAssertNil(written[3]["session_lifecycle"], "a failed destroy is not cleanup")
        XCTAssertEqual((written[4]["session_lifecycle"] as? [String: Any])?["released"] as? [String], ["second"],
                       "bulk failure still records its successful subset")
        let raw = try String(contentsOf: try XCTUnwrap(journal.fileURL), encoding: .utf8)
        XCTAssertFalse(raw.contains(credential.uuidString))
        XCTAssertFalse(raw.lowercased().contains(credential.uuidString.lowercased()))
    }

    func testControllerFailuresAreDistinctFromSchemaValidation() {
        let missing = MCPControllerError.missingLease("synthetic")
        XCTAssertEqual(missing.code, "lease_required")
        XCTAssertTrue(missing.description.contains("If creation failed"))
        XCTAssertTrue(missing.description.contains("retained-session receipt"))
        XCTAssertEqual(MCPControllerError.ambiguousSession(["a", "b"]).code, "ambiguous_session")
    }

    func testToolCallsCarryLoopContextErrorsAndCost() throws {
        let journal = MCPJournal(monitor: try monitor(LoggingSettings(journal: .full)), directory: directory)
        journal.connectionStarted(clientName: "claude-code", clientVersion: "2.1", protocolVersion: "2025-06-18")
        var failure = Response(ok: false)
        failure.errorCode = "stale_snapshot"
        failure.error = "there is no current accessibility snapshot"
        failure.recovery = RecoveryHint(tool: "spaceo_read_screen", then: "retry with a fresh index")
        journal.toolCall(call("spaceo_click", outcome: "tool_error", arguments: ["element": "3"],
                              text: "[stale_snapshot] there is no current accessibility snapshot", response: failure))
        journal.toolCall(call("spaceo_click", outcome: "tool_error", arguments: ["element": "3"],
                              text: "[stale_snapshot] again", response: failure))
        journal.toolCall(call("spaceo_read_screen", arguments: [:], text: "snapshot: s1\n[0] Button — OK"))
        journal.connectionEnded(reason: "eof")

        let written = try records(in: journal)
        XCTAssertEqual(written.map { $0["kind"] as? String },
                       ["connection.start", "tool_call", "tool_call", "tool_call", "connection.end"])
        XCTAssertTrue(written.allSatisfy { $0["v"] as? Int == MCPJournal.schemaVersion && $0["conn"] as? String == journal.connectionID })
        XCTAssertEqual((written[1]["client"] as? [String: String])?["name"], "claude-code")

        let first = written[1], retry = written[2], read = written[3]
        let error = try XCTUnwrap(first["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "stale_snapshot")
        XCTAssertEqual(error["recovery_tool"] as? String, "spaceo_read_screen")
        XCTAssertEqual(first["session"] as? String, "agent-1")
        XCTAssertEqual(first["window"] as? Int, 42)
        XCTAssertEqual(retry["repeat"] as? Bool, true, "the same call right after an error is a retry loop")
        XCTAssertEqual(retry["after_error"] as? Bool, true)
        XCTAssertEqual(read["prev_tool"] as? String, "spaceo_click")
        XCTAssertNotNil(read["gap_ms"] as? Int)
        let result = try XCTUnwrap(read["result"] as? [String: Any])
        XCTAssertEqual(result["text"] as? String, "snapshot: s1\n[0] Button — OK", "full keeps what the agent read")
        XCTAssertEqual(result["est_tokens"] as? Int, ("snapshot: s1\n[0] Button — OK".utf8.count + 3) / 4)
        let end = try XCTUnwrap(written.last)
        XCTAssertEqual(end["calls"] as? Int, 3)
        XCTAssertEqual((end["outcomes"] as? [String: Int])?["tool_error"], 2)
        let mode = try FileManager.default.attributesOfItem(atPath: try XCTUnwrap(journal.fileURL).path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    /// Live check: TextEdit echoed the typed text in the type receipt ("window text now: …") and
    /// in the next screen read, so the full journal held it. Echoes are scrubbed, in any case.
    func testTypedTextEchoedByTheAppIsScrubbedFromEveryLaterRecord() throws {
        let journal = MCPJournal(monitor: try monitor(LoggingSettings(journal: .full)), directory: directory)
        journal.toolCall(call("spaceo_type", arguments: ["text": "secret passphrase 123"],
                              text: "type: confirmed (per-pid-events)\nwindow text now: Secret passphrase 123"))
        journal.toolCall(call("spaceo_read_screen", text: "[0] TextArea — secret passphrase 123 [focused]"))
        journal.toolCall(call("spaceo_click", outcome: "tool_error",
                              text: "[bad_request] no element 'SECRET PASSPHRASE 123'"))
        let raw = try String(contentsOf: try XCTUnwrap(journal.fileURL), encoding: .utf8)
        XCTAssertFalse(raw.lowercased().contains("secret passphrase"), raw)
        let fingerprint = journal.fingerprint(of: "secret passphrase 123")
        XCTAssertEqual(raw.components(separatedBy: "‹typed \(fingerprint)›").count - 1, 6,
                       "receipt text; screen read text and first line; error message, text and first line")
        XCTAssertEqual(MCPJournalRedaction.secrets(in: ["text": "ok", "steps": [["arguments": ["text": "abc"]]]]), ["abc"],
                       "two-character texts are not worth scrubbing everywhere; batched steps are")
    }

    func testMetadataOmitsResultTextAndOffWritesNothing() throws {
        let metadata = MCPJournal(monitor: try monitor(LoggingSettings(journal: .metadata)), directory: directory)
        metadata.toolCall(call("spaceo_read_screen", text: "snapshot: s1\n[0] TextField — Card number"))
        let result = try XCTUnwrap(try records(in: metadata).first?["result"] as? [String: Any])
        XCTAssertNil(result["text"], "metadata keeps no screen content")
        XCTAssertEqual(result["first_line"] as? String, "snapshot: s1")

        let silent = MCPJournal(monitor: try monitor(LoggingSettings(journal: .off)),
                                directory: directory.appendingPathComponent("off"))
        silent.toolCall(call("spaceo_click"))
        silent.connectionEnded(reason: "eof")
        XCTAssertNil(silent.fileURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("off").path))
    }

    func testJournalStopsAtItsCapWithAFinalMarker() throws {
        let journal = MCPJournal(monitor: try monitor(LoggingSettings(journal: .full, maxFileMegabytes: 1)),
                                 directory: directory)
        let big = String(repeating: "x", count: 30_000)
        for _ in 0..<60 { journal.toolCall(call("spaceo_read_text", text: big)) }
        let url = try XCTUnwrap(journal.fileURL)
        let size = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        XCTAssertLessThanOrEqual(size, 1_048_576 + 128)
        XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).hasSuffix("\"kind\":\"journal.capped\",\"conn\":\"\(journal.connectionID)\",\"v\":1}\n"))
    }

    func testRetentionRemovesOnlyOldDateNamedFolders() throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let old = directory.appendingPathComponent(formatter.string(from: Date().addingTimeInterval(-40 * 86_400)))
        let recent = directory.appendingPathComponent(formatter.string(from: Date().addingTimeInterval(-2 * 86_400)))
        let unrelated = directory.appendingPathComponent("keep-me")
        for folder in [old, recent, unrelated] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        let journal = MCPJournal(monitor: try monitor(LoggingSettings(journal: .metadata, retentionDays: 14)),
                                 directory: directory)
        journal.toolCall(call("spaceo_pool_status"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recent.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }

    // MARK: Daemon log

    func testDaemonRecordsCarryErrorCodesRecoveryAndRequestShapeButNoPayload() throws {
        let url = directory.appendingPathComponent("daemon.log")
        let log = DaemonLog()
        try log.configure(fileURL: url)
        var request = Request(cmd: "type")
        request.diagnosticClient = "mcp"
        request.element = "7"
        request.text = "correct horse battery staple"
        var response = Response(ok: false)
        response.error = "window not found"
        response.errorCode = "window_not_ready"
        response.recovery = RecoveryHint(tool: "spaceo_open_app", then: "open an app")
        log.record(request: request, response: response, seconds: 0.01)
        let line = try XCTUnwrap(try String(contentsOf: url, encoding: .utf8).split(separator: "\n").first)
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String])
        XCTAssertEqual(record["client"], "mcp")
        XCTAssertEqual(record["error_code"], "window_not_ready")
        XCTAssertEqual(record["recovery_tool"], "spaceo_open_app")
        XCTAssertEqual(record["element"], "7")
        XCTAssertEqual(record["text_chars"], "28")
        XCTAssertFalse(line.contains("horse"), "typed text never reaches the daemon log")
    }

    func testFollowedSettingsTurnOnEveryRequestRecordsLive() throws {
        let url = directory.appendingPathComponent("daemon.log")
        let log = DaemonLog()
        try log.configure(fileURL: url)
        log.follow(try monitor(LoggingSettings(requestMetrics: false)))
        log.record(request: Request(cmd: "windows"), response: Response(ok: true), seconds: 0.01)
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "")
        Thread.sleep(forTimeInterval: 1.1)
        try LoggingSettings(requestMetrics: true).save(to: settingsFile)
        log.record(request: Request(cmd: "windows"), response: Response(ok: true), seconds: 0.01)
        XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains("\"kind\":\"request.ok\""))
    }

    func testDoctorShowsTheLoggingStateOnlyWhenKnown() throws {
        var report = DoctorReportTests.report(daemon: .notRunning)
        XCTAssertFalse(report.render().contains("\nLogging\n"))
        report.logging = LoggingSettings(journal: .off)
        XCTAssertTrue(report.render().contains("`spaceo logging enable` to journal every MCP call"))
        report.logging = LoggingSettings(journal: .full, requestMetrics: true)
        XCTAssertTrue(report.render().contains("every request"))
    }
}
