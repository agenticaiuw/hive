import XCTest
import CoreGraphics
import Darwin
@testable import SpaceOKit

final class SessionRecorderTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-recorder-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private let epoch = Date(timeIntervalSince1970: 1_800_000_000)

    private func fixedClock(_ start: Date, step: TimeInterval = 1) -> @Sendable () -> Date {
        let state = ClockState(next: start, step: step)
        return { state.tick() }
    }

    private final class ClockState: @unchecked Sendable {
        private var next: Date
        private let step: TimeInterval
        private let lock = NSLock()
        init(next: Date, step: TimeInterval) { self.next = next; self.step = step }
        func tick() -> Date {
            lock.withLock {
                defer { next = next.addingTimeInterval(step) }
                return next
            }
        }
    }

    private func makeRecorder(mode: RecordingMode = .actions,
                              capacity: Int = SessionRecorder.defaultCapacityBytes,
                              sessionID: String = "agent-1") throws -> SessionRecorder {
        try SessionRecorder(
            sessionID: sessionID, mode: mode, rootDirectory: root,
            capacityBytes: capacity, now: fixedClock(epoch))
    }

    private func readLines(_ recorder: SessionRecorder) throws -> [String] {
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }

    private func fakePNG(_ bytes: Int) -> Data {
        Data(repeating: 0x89, count: bytes)
    }

    // MARK: - Mode

    func testModeParse() throws {
        XCTAssertNil(try RecordingMode.parse(nil))
        XCTAssertEqual(try RecordingMode.parse("actions"), .actions)
        XCTAssertEqual(try RecordingMode.parse("actions+frames"), .actionsAndFrames)
        XCTAssertThrowsError(try RecordingMode.parse("video")) { error in
            guard case .badRequest? = error as? SpaceOError else {
                return XCTFail("expected badRequest, got \(error)")
            }
        }
    }

    // MARK: - Recording

    func testActionsModeNeverWritesSuppliedFrames() throws {
        let recorder = try makeRecorder(mode: .actions)
        let stored = try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true,
            beforeFrameStatus: "captured", afterFrameStatus: "captured"),
            beforeFrame: fakePNG(20), afterFrame: fakePNG(20))
        XCTAssertNil(stored.beforeFrame)
        XCTAssertNil(stored.afterFrame)
        XCTAssertNil(stored.beforeFrameStatus)
        XCTAssertNil(stored.afterFrameStatus)
        let files = try FileManager.default.contentsOfDirectory(atPath: recorder.directory.appendingPathComponent("frames").path)
        XCTAssertTrue(files.isEmpty)
    }

    func testCapacityOmissionHasTruthfulFrameStatusAndReportText() throws {
        let recorder = try makeRecorder(mode: .actionsAndFrames, capacity: 1_024)
        let stored = try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true,
            beforeFrameStatus: "captured", afterFrameStatus: "capture_unavailable"),
            beforeFrame: fakePNG(2_048))
        XCTAssertNil(stored.beforeFrame)
        XCTAssertNil(stored.afterFrame)
        XCTAssertEqual(stored.beforeFrameStatus, "capacity_exhausted")
        XCTAssertEqual(stored.afterFrameStatus, "capture_unavailable")
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        XCTAssertEqual(try SessionRecorder.decoder.decode(RecordedAction.self, from: data), stored)
        let html = try SessionReport.render(directory: recorder.directory)
        XCTAssertTrue(html.contains("actions+frames"), "unfinished frame recordings retain their mode when all images are omitted")
        XCTAssertTrue(html.contains("capacity_exhausted"))
        XCTAssertTrue(html.contains("capture_unavailable"))
        XCTAssertTrue(html.contains("frames may contain visible screen content"))
    }

    func testRecordsLinesAndFramesUnderSessionDirectory() throws {
        let recorder = try makeRecorder(mode: .actionsAndFrames)
        XCTAssertEqual(recorder.directory.lastPathComponent, "agent-1-20270115-080000")
        XCTAssertEqual(recorder.directory.deletingLastPathComponent().lastPathComponent, "recordings")

        try recorder.record(
            RecordedAction(seq: 1, at: epoch.addingTimeInterval(2), cmd: "click", ok: true,
                           route: "ax.press", completion: "confirmed", x: 10, y: 20, windowID: 42),
            beforeFrame: fakePNG(100), afterFrame: fakePNG(200))
        try recorder.record(
            RecordedAction(seq: 2, at: epoch.addingTimeInterval(3), cmd: "type", ok: false,
                           error: "no focused element", errorCode: "windowNotReady", payloadLength: 12))

        XCTAssertEqual(recorder.actionCount, 2)
        let lines = try readLines(recorder)
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].contains("\"beforeFrame\":\"frames/1-before.png\""))
        XCTAssertTrue(lines[0].contains("\"afterFrame\":\"frames/1-after.png\""))
        XCTAssertTrue(lines[1].contains("\"payloadLength\":12"))
        XCTAssertFalse(lines[1].contains("beforeFrame"))

        let frames = recorder.directory.appendingPathComponent("frames")
        XCTAssertEqual(try Data(contentsOf: frames.appendingPathComponent("1-before.png")).count, 100)
        XCTAssertEqual(try Data(contentsOf: frames.appendingPathComponent("1-after.png")).count, 200)
        XCTAssertEqual(recorder.bytesWritten, 300 + lines.reduce(0) { $0 + $1.utf8.count + 1 })

        let decoded = try SessionRecorder.decoder.decode(
            RecordedAction.self, from: Data(lines[0].utf8))
        XCTAssertEqual(decoded.cmd, "click")
        XCTAssertEqual(decoded.windowID, 42)
        XCTAssertEqual(decoded.at.timeIntervalSince1970, epoch.addingTimeInterval(2).timeIntervalSince1970, accuracy: 0.001)
    }

    func testFinishWritesManifestAndRejectsFurtherRecords() throws {
        let recorder = try makeRecorder()
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "screenshot", ok: true))
        try recorder.finish(reason: "session.destroyed")
        try recorder.finish(reason: "second call must be a no-op")

        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("manifest.json"))
        let manifest = try SessionRecorder.decoder.decode(RecordingManifest.self, from: data)
        XCTAssertEqual(manifest.sessionID, "agent-1")
        XCTAssertEqual(manifest.mode, .actions)
        XCTAssertEqual(manifest.reason, "session.destroyed")
        XCTAssertEqual(manifest.actionCount, 1)
        XCTAssertEqual(manifest.startedAt.timeIntervalSince1970, epoch.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(manifest.finishedAt.map { $0.timeIntervalSince1970 } ?? 0,
                       epoch.addingTimeInterval(1).timeIntervalSince1970, accuracy: 0.001)
        XCTAssertGreaterThan(manifest.bytes, 0)

        XCTAssertThrowsError(try recorder.record(RecordedAction(seq: 2, at: epoch, cmd: "click", ok: true)))
    }

    func testTypedPayloadIsStructurallyUnrecordable() throws {
        // The struct has no field that could carry typed text; only its length is stored.
        let labels = Set(Mirror(reflecting: RecordedAction(seq: 0, at: epoch, cmd: "type", ok: true))
            .children.compactMap { $0.label })
        XCTAssertFalse(labels.contains("text"))
        XCTAssertFalse(labels.contains("keys"))
        XCTAssertFalse(labels.contains("payload"))
        XCTAssertTrue(labels.contains("payloadLength"))

        let secret = "hunter2-correct-horse"
        let recorder = try makeRecorder()
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "type", ok: true,
                                           payloadLength: secret.utf8.count))
        let contents = try readLines(recorder).joined()
        XCTAssertFalse(contents.contains(secret))
        XCTAssertTrue(contents.contains("\"payloadLength\":\(secret.utf8.count)"))
    }

    func testSessionIDIsSanitizedForPaths() throws {
        let recorder = try makeRecorder(sessionID: "../evil/id with spaces")
        XCTAssertEqual(recorder.directory.lastPathComponent, "_evil_id_with_spaces-20270115-080000")
        XCTAssertEqual(recorder.directory.deletingLastPathComponent(),
                       root.appendingPathComponent("recordings", isDirectory: true))
    }

    func testSecondRecorderForSameSecondGetsSuffix() throws {
        let first = try makeRecorder()
        let second = try makeRecorder()
        XCTAssertNotEqual(first.directory, second.directory)
        XCTAssertEqual(second.directory.lastPathComponent, "agent-1-20270115-080000-2")
    }

    // MARK: - Capacity

    func testFramesAreDroppedBeforeReceiptsNearCapacity() throws {
        let recorder = try makeRecorder(mode: .actionsAndFrames, capacity: 600)
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true),
                            beforeFrame: fakePNG(1000))
        let lines = try readLines(recorder)
        XCTAssertEqual(lines.count, 1)
        XCTAssertFalse(lines[0].contains("beforeFrame"))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: recorder.directory.appendingPathComponent("frames/1-before.png").path))
    }

    func testCapacityExhaustedThrowsRatherThanOverrunning() throws {
        let recorder = try makeRecorder(capacity: 120)
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        XCTAssertThrowsError(try recorder.record(RecordedAction(seq: 2, at: epoch, cmd: "click", ok: true))) { error in
            guard case SessionRecorderError.capacityExhausted(_, let capacity)? = error as? SessionRecorderError else {
                return XCTFail("expected capacityExhausted, got \(error)")
            }
            XCTAssertEqual(capacity, 120)
        }
        XCTAssertLessThanOrEqual(recorder.bytesWritten, 120)
        XCTAssertEqual(recorder.actionCount, 1)
    }

    func testFramesThatFitAloneCannotConsumeReceiptSpace() throws {
        let action = RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true)
        let receiptBytes = try SessionRecorder.encoder.encode(action).count + 1
        let frame = fakePNG(100)
        let recorder = try makeRecorder(mode: .actionsAndFrames, capacity: receiptBytes + frame.count)
        try recorder.record(action, beforeFrame: frame)
        XCTAssertEqual(recorder.actionCount, 1)
        XCTAssertEqual(recorder.bytesWritten, receiptBytes)
        XCTAssertFalse(try readLines(recorder)[0].contains("beforeFrame"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: recorder.directory.appendingPathComponent("frames").path), [])
    }

    func testExactCapacityIncludesFramePathMetadata() throws {
        var action = RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true)
        action.beforeFrame = "frames/1-before.png"
        let frame = fakePNG(100)
        let capacity = try SessionRecorder.encoder.encode(action).count + 1 + frame.count
        let recorder = try makeRecorder(mode: .actionsAndFrames, capacity: capacity)
        try recorder.record(action, beforeFrame: frame)
        XCTAssertEqual(recorder.bytesWritten, capacity)
        XCTAssertTrue(try readLines(recorder)[0].contains("beforeFrame"))
    }

    func testInvalidReceiptDoesNotWriteOrphanFrames() throws {
        let recorder = try makeRecorder(mode: .actionsAndFrames)
        XCTAssertThrowsError(try recorder.record(
            RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true, x: .nan),
            beforeFrame: fakePNG(100)))
        XCTAssertEqual(recorder.bytesWritten, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: recorder.directory.appendingPathComponent("frames").path), [])
    }

    // MARK: - Pruning

    private func makeFinishedRecording(name: String, startedAt: Date, fillerBytes: Int) throws -> URL {
        let recordings = root.appendingPathComponent("recordings", isDirectory: true)
        let directory = recordings.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("frames"), withIntermediateDirectories: true)
        let manifest = RecordingManifest(
            sessionID: name, mode: .actionsAndFrames, startedAt: startedAt,
            finishedAt: startedAt.addingTimeInterval(10), reason: "test", actionCount: 1, bytes: fillerBytes)
        try SessionRecorder.encoder.encode(manifest).write(to: directory.appendingPathComponent("manifest.json"))
        try Data().write(to: directory.appendingPathComponent("actions.jsonl"))
        try fakePNG(fillerBytes).write(to: directory.appendingPathComponent("frames/1-before.png"))
        return directory
    }

    func testDirectoryAccountingMatchesVisibleRegularFilesWithoutFollowingLinks() throws {
        let directory = root.appendingPathComponent("accounting")
        let nested = directory.appendingPathComponent("frames/子目录")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 17).write(to: directory.appendingPathComponent("actions.jsonl"))
        let frame = nested.appendingPathComponent("é.png")
        try Data(repeating: 2, count: 31).write(to: frame)
        try FileManager.default.linkItem(at: frame, to: directory.appendingPathComponent("hard-link.png"))
        try Data(repeating: 3, count: 1_000).write(to: directory.appendingPathComponent(".hidden"))
        let hidden = directory.appendingPathComponent(".cache")
        try FileManager.default.createDirectory(at: hidden, withIntermediateDirectories: false)
        try Data(repeating: 4, count: 2_000).write(to: hidden.appendingPathComponent("ignored.png"))
        let flagged = directory.appendingPathComponent("finder-hidden.png")
        try Data(repeating: 7, count: 3_000).write(to: flagged)
        XCTAssertEqual(flagged.path.withCString { chflags($0, UInt32(UF_HIDDEN)) }, 0)
        let outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try Data(repeating: 5, count: 4_000).write(to: outside.appendingPathComponent("outside.png"))
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("outside-link"), withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(at: nested.appendingPathComponent("cycle"), withDestinationURL: directory)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("file-link"), withDestinationURL: frame)
        let cwd = FileManager.default.currentDirectoryPath
        XCTAssertEqual(try SessionRecorder.directorySize(directory), 17 + 31 + 31)
        XCTAssertEqual(FileManager.default.currentDirectoryPath, cwd, "accounting must never change the process working directory")
        try Data(repeating: 6, count: 53).write(to: frame)
        XCTAssertEqual(try SessionRecorder.directorySize(directory), 17 + 53 + 53,
                       "completed recordings are measured afresh, including in-place edits")
    }

    func testDirectoryAccountingRejectsMissingEntriesInsteadOfReportingZero() throws {
        XCTAssertThrowsError(try SessionRecorder.directorySize(root.appendingPathComponent("missing"))) { error in
            guard case SessionRecorderError.invalidRecording = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testUnreadableVisibleSubtreeFailsAccountingInsteadOfUndercounting() throws {
        guard geteuid() != 0 else { throw XCTSkip("root bypasses directory permission checks") }
        let directory = root.appendingPathComponent("accounting")
        let blocked = directory.appendingPathComponent("blocked")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 100).write(to: blocked.appendingPathComponent("frame.png"))
        XCTAssertEqual(blocked.path.withCString { chmod($0, 0) }, 0)
        defer { _ = blocked.path.withCString { chmod($0, 0o700) } }
        XCTAssertThrowsError(try SessionRecorder.directorySize(directory)) { error in
            guard case SessionRecorderError.invalidRecording = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testRetentionRecountsCompletedFrameChangesBetweenActions() throws {
        let archived = try makeFinishedRecording(name: "old", startedAt: epoch.addingTimeInterval(-100), fillerBytes: 100)
        let recorder = try makeRecorder(capacity: 2_000)
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: archived.path))
        // A directory timestamp need not change when an existing frame grows.
        let frame = archived.appendingPathComponent("frames/1-before.png")
        let handle = try FileHandle(forWritingTo: frame)
        try handle.truncate(atOffset: 4_000)
        try handle.close()
        try recorder.record(RecordedAction(seq: 2, at: epoch, cmd: "click", ok: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: archived.path))
        XCTAssertEqual(recorder.actionCount, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: recorder.directory.path))
    }

    func testPruneRemovesOldestUntilUnderCapacityAndProtectsActive() throws {
        // Directory names are deliberately out of chronological order so the test proves
        // ordering comes from the manifest, not the listing.
        let oldest = try makeFinishedRecording(name: "zzz-old", startedAt: epoch.addingTimeInterval(-300), fillerBytes: 1000)
        let middle = try makeFinishedRecording(name: "aaa-mid", startedAt: epoch.addingTimeInterval(-200), fillerBytes: 1000)
        let newest = try makeFinishedRecording(name: "mmm-new", startedAt: epoch.addingTimeInterval(-100), fillerBytes: 1000)
        let active = try makeFinishedRecording(name: "active", startedAt: epoch.addingTimeInterval(-1000), fillerBytes: 1000)

        let removed = try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("recordings"),
            capacityBytes: 2500,
            protecting: active)

        // 4000 filler bytes plus manifests; removing the two oldest unprotected gets under 2500.
        XCTAssertEqual(removed.map(\.lastPathComponent), ["zzz-old", "aaa-mid"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldest.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: middle.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: newest.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: active.path),
                      "the active directory must survive even though it is the oldest")
    }

    func testPruneIsNoOpUnderCapacityOrWithoutRoot() throws {
        _ = try makeFinishedRecording(name: "only", startedAt: epoch, fillerBytes: 10)
        XCTAssertEqual(try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("recordings"), capacityBytes: 10_000), [])
        XCTAssertEqual(try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("missing"), capacityBytes: 1), [])
    }

    func testRecordPrunesOlderRecordingsAutomatically() throws {
        let stale = try makeFinishedRecording(name: "stale", startedAt: epoch.addingTimeInterval(-500), fillerBytes: 5000)
        let recorder = try makeRecorder(mode: .actionsAndFrames, capacity: 4000)
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true), beforeFrame: fakePNG(500))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recorder.directory.path))
    }

    func testPruningProtectsEveryLiveRecorderUntilItFinishes() throws {
        let first = try makeRecorder(mode: .actionsAndFrames, capacity: 500, sessionID: "first")
        let second = try makeRecorder(mode: .actionsAndFrames, capacity: 500, sessionID: "second")
        let action = RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true)
        try first.record(action, beforeFrame: fakePNG(250))
        try second.record(action, beforeFrame: fakePNG(250))
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.directory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.directory.path))
        XCTAssertLessThanOrEqual(first.bytesWritten + second.bytesWritten, 500)
        XCTAssertFalse(try readLines(second)[0].contains("beforeFrame"))
        // Closing cannot exceed the cap merely to add metadata. It still retires the writer,
        // so a later prune may reclaim the now-inactive recording.
        XCTAssertThrowsError(try first.finish(reason: "done"))
        try second.record(RecordedAction(seq: 2, at: epoch, cmd: "click", ok: true))
        try second.record(RecordedAction(seq: 3, at: epoch, cmd: "click", ok: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.directory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.directory.path))
    }

    func testFinishingCannotWriteManifestPastCapacity() throws {
        let recorder = try makeRecorder(capacity: 120)
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        XCTAssertThrowsError(try recorder.finish(reason: "done"))
        XCTAssertThrowsError(try recorder.finish(reason: "retry must preserve the failure"))
        XCTAssertLessThanOrEqual(recorder.bytesWritten, 120)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: recorder.directory.appendingPathComponent("manifest.json").path))
    }

    func testReleasedRecorderDoesNotStayProtectedOrRetained() throws {
        var recorder: SessionRecorder? = try makeRecorder()
        weak var observed: SessionRecorder?
        observed = recorder
        let directory = try XCTUnwrap(recorder).directory
        try recorder?.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        recorder = nil
        XCTAssertNil(observed)
        let removed = try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("recordings"), capacityBytes: 1)
        XCTAssertEqual(removed.map(\.lastPathComponent), [directory.lastPathComponent])
    }

    func testFinishedRecorderReleaseCannotUnregisterReplacementAtSamePath() throws {
        var first: SessionRecorder? = try makeRecorder()
        let path = try XCTUnwrap(first).directory
        try first?.finish(reason: "done")
        _ = try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("recordings"), capacityBytes: 1)
        let replacement = try makeRecorder()
        XCTAssertEqual(replacement.directory, path)
        first = nil
        try replacement.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        XCTAssertEqual(try SessionRecorder.prune(
            recordingsRoot: root.appendingPathComponent("recordings"), capacityBytes: 1), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
    }

    func testConcurrentRecordersReserveCapacityWithoutDeletingEachOther() throws {
        let recorders = try ["a", "b"].map {
            try makeRecorder(mode: .actionsAndFrames, capacity: 5_000, sessionID: $0)
        }
        let at = epoch
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            do {
                try recorders[index % 2].record(
                    RecordedAction(seq: index + 1, at: at, cmd: "click", ok: true),
                    beforeFrame: Data(repeating: 1, count: 50))
            } catch SessionRecorderError.capacityExhausted {
                // Refusing a receipt that cannot fit is expected; deleting a live writer isn't.
            } catch {
                XCTFail("unexpected recording failure: \(error)")
            }
        }
        XCTAssertLessThanOrEqual(recorders.reduce(0) { $0 + $1.bytesWritten }, 5_000)
        for recorder in recorders {
            XCTAssertTrue(FileManager.default.fileExists(atPath: recorder.directory.path))
            XCTAssertEqual(try readLines(recorder).count, recorder.actionCount)
        }
    }

    // MARK: - Frames

    private func solidImage(width: Int, height: Int) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }

    private func pngSize(_ data: Data) -> (width: Int, height: Int)? {
        guard data.count >= 24 else { return nil }
        func be32(_ offset: Int) -> Int {
            data[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
        }
        return (be32(16), be32(20))
    }

    func testDownscaledPNGBoundsLongestEdge() throws {
        let wide = try SessionRecorder.downscaledPNG(try solidImage(width: 1920, height: 1080), maxEdge: 480)
        XCTAssertEqual(pngSize(wide)?.width, 480)
        XCTAssertEqual(pngSize(wide)?.height, 270)

        let tall = try SessionRecorder.downscaledPNG(try solidImage(width: 300, height: 960), maxEdge: 480)
        XCTAssertEqual(pngSize(tall)?.width, 150)
        XCTAssertEqual(pngSize(tall)?.height, 480)

        let small = try SessionRecorder.downscaledPNG(try solidImage(width: 100, height: 50), maxEdge: 480)
        XCTAssertEqual(pngSize(small)?.width, 100)
        XCTAssertEqual(pngSize(small)?.height, 50)

        XCTAssertThrowsError(try SessionRecorder.downscaledPNG(try solidImage(width: 10, height: 10), maxEdge: 0))
    }

    // MARK: - Report

    private func sampleManifest() -> RecordingManifest {
        RecordingManifest(
            sessionID: "agent-<1>", mode: .actionsAndFrames, startedAt: epoch,
            finishedAt: epoch.addingTimeInterval(12.5), reason: "session.destroyed",
            actionCount: 3, bytes: 4242)
    }

    private func sampleActions() -> [RecordedAction] {
        [
            RecordedAction(seq: 1, at: epoch.addingTimeInterval(0.25), cmd: "click", ok: true,
                           route: "ax.press", completion: "confirmed", message: "pressed \"OK\" & closed",
                           x: 12, y: 34.5, windowID: 7,
                           beforeFrame: "frames/1-before.png", afterFrame: "frames/1-after.png"),
            RecordedAction(seq: 2, at: epoch.addingTimeInterval(1.5), cmd: "type", ok: true,
                           route: "cgevent", payloadLength: 9),
            RecordedAction(seq: 3, at: epoch.addingTimeInterval(12), cmd: "click", ok: false,
                           error: "<script>alert('x')</script>", errorCode: "windowNotFound",
                           beforeFrame: "../../etc/passwd", afterFrame: "https://evil.example/x.png"),
        ]
    }

    func testRenderEscapesAndListsEveryAction() throws {
        let html = SessionReport.render(manifest: sampleManifest(), actions: sampleActions())

        XCTAssertTrue(html.hasPrefix("<!DOCTYPE html>"))
        XCTAssertEqual(html.components(separatedBy: "<tr class=\"").count - 1, 3, "one row per action")
        XCTAssertTrue(html.contains("agent-&lt;1&gt;"))
        XCTAssertTrue(html.contains("pressed &quot;OK&quot; &amp; closed"))
        XCTAssertTrue(html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"))
        XCTAssertFalse(html.lowercased().contains("<script"))
        XCTAssertFalse(html.contains("http://"), "no external resources")
        XCTAssertFalse(html.contains("https://"), "unsafe frame paths are dropped, not escaped into a URL")
        XCTAssertFalse(html.contains("passwd"))

        XCTAssertTrue(html.contains("+0.250s"))
        XCTAssertTrue(html.contains("+12.000s"))
        XCTAssertTrue(html.contains("<img src=\"frames/1-before.png\""))
        XCTAssertTrue(html.contains("<img src=\"frames/1-after.png\""))
        XCTAssertTrue(html.contains("badge ok"))
        XCTAssertTrue(html.contains("badge error\">windowNotFound<"))
        XCTAssertTrue(html.contains("payload 9 bytes"))
        XCTAssertTrue(html.contains("at 12, 34.5 · window 7"))
        XCTAssertTrue(html.contains("3 actions, 1 failed."))
        XCTAssertTrue(html.contains("actions+frames"))
        XCTAssertTrue(html.contains("session.destroyed"))
    }

    func testRenderIsDeterministic() {
        let a = SessionReport.render(manifest: sampleManifest(), actions: sampleActions())
        let b = SessionReport.render(manifest: sampleManifest(), actions: sampleActions())
        XCTAssertEqual(a, b)
    }

    func testRenderFromDirectoryUsesManifestAndSkipsMalformedLines() throws {
        let recorder = try makeRecorder(mode: .actionsAndFrames)
        for action in sampleActions() {
            try recorder.record(action, beforeFrame: action.seq == 1 ? fakePNG(10) : nil)
        }
        try recorder.finish(reason: "operator.stop")
        // Corrupt a line after the fact; the report must still render the rest.
        let actionsURL = recorder.directory.appendingPathComponent("actions.jsonl")
        var data = try Data(contentsOf: actionsURL)
        data.append(Data("not json\n".utf8))
        try data.write(to: actionsURL)

        let html = try SessionReport.render(directory: recorder.directory)
        XCTAssertEqual(html.components(separatedBy: "<tr class=\"").count - 1, 3)
        XCTAssertTrue(html.contains("operator.stop"))
        XCTAssertTrue(html.contains("1 unreadable line skipped"))
        XCTAssertTrue(html.contains("<img src=\"frames/1-before.png\""))
        XCTAssertFalse(html.contains("1-after.png"), "the recorder was given no after frame")
        XCTAssertFalse(html.contains(root.path), "the page must not leak the on-disk location")
    }

    func testRenderFromUnfinishedDirectorySaysSo() throws {
        let recorder = try makeRecorder()
        try recorder.record(RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true))
        let html = try SessionReport.render(directory: recorder.directory)
        XCTAssertTrue(html.contains("not finished"))
        XCTAssertTrue(html.contains("unfinished"))
        XCTAssertEqual(html.components(separatedBy: "<tr class=\"").count - 1, 1)
    }

    func testStreamedReportMatchesPureReportAcrossChunkBoundaries() throws {
        var actions = sampleActions()
        actions[0].message = String(repeating: "👩🏽‍💻&<>é", count: 4_096)
        let manifest = sampleManifest()
        try SessionRecorder.encoder.encode(manifest).write(
            to: root.appendingPathComponent("manifest.json"))
        var data = Data("\nnot json\n \n".utf8)
        for (index, action) in actions.enumerated() {
            data.append(try SessionRecorder.encoder.encode(action))
            if index < actions.count - 1 { data.append(contentsOf: [13, 10]) }
        }
        try data.write(to: root.appendingPathComponent("actions.jsonl"))
        XCTAssertEqual(try SessionReport.render(directory: root),
                       SessionReport.render(manifest: manifest, actions: actions, malformedLines: 2))
    }

    func testStreamedUnfinishedMetadataComesFromSameOrderedPass() throws {
        var actions = sampleActions()
        actions.swapAt(0, 2) // Origin is the first valid action, not the earliest timestamp.
        var data = Data("bad\n\n".utf8)
        for action in actions {
            data.append(try SessionRecorder.encoder.encode(action))
            data.append(10)
        }
        try data.write(to: root.appendingPathComponent("actions.jsonl"))
        let manifest = RecordingManifest(
            sessionID: root.lastPathComponent, mode: .actionsAndFrames, startedAt: actions[0].at,
            reason: "unfinished", actionCount: actions.count, bytes: data.count)
        XCTAssertEqual(try SessionReport.render(directory: root),
                       SessionReport.render(manifest: manifest, actions: actions, malformedLines: 1))
    }

    func testStreamedReportPreservesEmptyAndMalformedOnlyRecordings() throws {
        for (text, malformed) in [("", 0), ("\n\n", 0), ("not json\n", 1), ("\r\n", 1)] {
            let data = Data(text.utf8)
            try data.write(to: root.appendingPathComponent("actions.jsonl"))
            let manifest = RecordingManifest(
                sessionID: root.lastPathComponent, mode: .actions, startedAt: .distantPast,
                reason: "unfinished", actionCount: 0, bytes: data.count)
            XCTAssertEqual(try SessionReport.render(directory: root),
                           SessionReport.render(manifest: manifest, actions: [], malformedLines: malformed))
        }
    }

    func testBoundedChunkReadRefusesGrowthAfterInitialSizeCheck() throws {
        let url = root.appendingPathComponent("growing.jsonl")
        try Data(repeating: 42, count: 16_384).write(to: url)
        let writer = try FileHandle(forWritingTo: url)
        defer { try? writer.close() }
        var received = 0
        XCTAssertThrowsError(try SessionRecorder.readBoundedChunks(url, maximumBytes: 16_384) { chunk in
            received += chunk.count
            try writer.seekToEnd()
            try writer.write(contentsOf: Data([1]))
        })
        XCTAssertEqual(received, 16_384, "overflow bytes must never reach the consumer")
    }

    func testBoundedChunkReadPreservesBytesAndRejectsOversizeBeforeCallback() throws {
        let url = root.appendingPathComponent("chunks")
        let data = Data((0..<40_000).map { UInt8(truncatingIfNeeded: $0) })
        try data.write(to: url)
        var observed = Data()
        let count = try SessionRecorder.readBoundedChunks(url, maximumBytes: data.count) { chunk in
            XCTAssertLessThanOrEqual(chunk.count, 16_384)
            observed.append(contentsOf: chunk)
        }
        XCTAssertEqual(count, data.count)
        XCTAssertEqual(observed, data)
        XCTAssertThrowsError(try SessionRecorder.readBoundedChunks(url, maximumBytes: data.count - 1) { _ in
            XCTFail("oversized files must be rejected before a chunk is delivered")
        })
    }

    func testRenderRejectsOversizedSidecar() throws {
        let recorder = try makeRecorder()
        try recorder.finish(reason: "test")
        let big = recorder.directory.appendingPathComponent("actions.jsonl")
        let handle = try FileHandle(forWritingTo: big)
        try handle.truncate(atOffset: UInt64(SessionReport.maximumActionsBytes + 1))
        try handle.close()
        XCTAssertThrowsError(try SessionReport.render(directory: recorder.directory)) { error in
            guard case SessionRecorderError.invalidRecording? = error as? SessionRecorderError else {
                return XCTFail("expected invalidRecording, got \(error)")
            }
        }
    }

    func testRenderRejectsOversizedManifestBeforeLoadingIt() throws {
        let recorder = try makeRecorder()
        try recorder.finish(reason: "done")
        let handle = try FileHandle(forWritingTo: recorder.directory.appendingPathComponent("manifest.json"))
        try handle.truncate(atOffset: 1_000_000_000)
        try handle.close()
        XCTAssertThrowsError(try SessionReport.render(directory: recorder.directory))
    }

    func testBoundedReadRejectsNonRegularFilesAndSymlinks() throws {
        let target = root.appendingPathComponent("target")
        try Data([1, 2, 3]).write(to: target)
        XCTAssertEqual(try SessionRecorder.readBoundedFile(target, maximumBytes: 3), Data([1, 2, 3]))
        XCTAssertThrowsError(try SessionRecorder.readBoundedFile(target, maximumBytes: 2))
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try SessionRecorder.readBoundedFile(link, maximumBytes: 3))
        XCTAssertThrowsError(try SessionRecorder.readBoundedFile(root, maximumBytes: 3))
    }

    func testReportFormatsExtremeCoordinatesWithoutIntegerConversionTraps() {
        let html = SessionReport.render(manifest: sampleManifest(), actions: [
            RecordedAction(seq: 1, at: epoch, cmd: "click", ok: true,
                           x: Double.greatestFiniteMagnitude, y: -.infinity),
        ])
        XCTAssertTrue(html.contains("class=\"target\""))
        XCTAssertTrue(html.contains(", ?"))
    }
}
