import XCTest
import CoreGraphics
import AppKit
import Darwin
import SpaceOPrivate
@testable import SpaceOKit
@testable import SpaceOMCP

/// Counts handlers that have started but not finished, and remembers the high-water mark.
private final class InFlightTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private var highWater = 0

    var peak: Int { lock.withLock { highWater } }

    func enter() {
        lock.withLock {
            current += 1
            highWater = max(highWater, current)
        }
    }

    func leave() { lock.withLock { current -= 1 } }
}

/// Pure-logic tests. No WindowServer state, no permissions, must pass anywhere.
final class UnitTests: XCTestCase {

    func testWindowWaitPreflightReportsMissingAccessibility() throws {
        XCTAssertNoThrow(try WindowPlacement.requireAccessibility(trusted: true))
        XCTAssertThrowsError(try WindowPlacement.requireAccessibility(trusted: false)) { error in
            XCTAssertEqual(error as? SpaceOError, .accessibilityDenied)
        }
    }

    func testDisplayRetirementRequiresRemovalFromTheOnlineInventory() {
        XCTAssertFalse(Stage.displayIsRetired(291, onlineDisplayIDs: [1, 4, 291]),
                       "an inactive-but-online virtual display is still attached")
        XCTAssertTrue(Stage.displayIsRetired(291, onlineDisplayIDs: [1, 4]))
        XCTAssertTrue(Stage.displayIsRetired(0, onlineDisplayIDs: [1, 4]))
    }

    // MARK: - Key parsing

    func testKeyComboParsesPlainKeys() throws {
        XCTAssertEqual(try KeyCombo.parse("a").keyCode, 0)
        XCTAssertEqual(try KeyCombo.parse("return").keyCode, 36)
        XCTAssertEqual(try KeyCombo.parse("esc").keyCode, 53)
        XCTAssertTrue(try KeyCombo.parse("a").flags.isEmpty)
    }

    func testKeyComboParsesModifiers() throws {
        let combo = try KeyCombo.parse("cmd+shift+s")
        XCTAssertEqual(combo.keyCode, 1)
        XCTAssertTrue(combo.flags.contains(.maskCommand))
        XCTAssertTrue(combo.flags.contains(.maskShift))
        XCTAssertFalse(combo.flags.contains(.maskAlternate))
    }

    func testKeyComboRejectsGarbage() {
        XCTAssertThrowsError(try KeyCombo.parse("hyper+s"))
        XCTAssertThrowsError(try KeyCombo.parse("cmd+notakey"))
        XCTAssertThrowsError(try KeyCombo.parse(""))
        XCTAssertThrowsError(
            try KeyCombo.parse("a" + String(repeating: "\u{0301}", count: 128)),
            "one pathological grapheme must not bypass the byte limit")
    }

    func testFunctionKeys() throws {
        XCTAssertEqual(try KeyCombo.parse("f1").keyCode, 122)
        XCTAssertEqual(try KeyCombo.parse("f12").keyCode, 111)
    }

    func testTypingDurationIsBoundedBeforeInputRoutingChanges() {
        XCTAssertNoThrow(try InputRouter.validateTyping("ordinary text"))
        XCTAssertThrowsError(
            try InputRouter.validateTyping(
                String(repeating: "\n", count: 8_000)))
        XCTAssertThrowsError(
            try InputRouter.validateTyping(
                String(repeating: "x", count: 200),
                charactersPerSecond: 1))
    }

    /// Windows line endings are one line break. Sending two Returns for "\r\n" doubles every
    /// blank line an agent types into a form or an editor.
    func testTypingEstimateCollapsesCRLFToOneReturn() {
        XCTAssertEqual(
            InputRouter.estimatedTypingSeconds("a\r\nb", charactersPerSecond: 90),
            InputRouter.estimatedTypingSeconds("a\nb", charactersPerSecond: 90))
        XCTAssertEqual(
            InputRouter.estimatedTypingSeconds("\r\r\n\n", charactersPerSecond: 90),
            3 * 0.045,
            accuracy: 0.0001,
            "\\r + \\r\\n + \\n is three line breaks, not four")
    }

    // MARK: - Isolation snapshot

    func testSnapshotDriftDetectsFrontmostChange() {
        let a = IsolationSnapshot(frontmostPID: 100, windowServerFrontPID: 100,
                                  cursor: .zero, activeSpace: 1, agentPIDs: [200],
                                  coverage: .observed)
        let b = IsolationSnapshot(frontmostPID: 200, windowServerFrontPID: 100,
                                  cursor: .zero, activeSpace: 1, agentPIDs: [200],
                                  coverage: .observed)
        XCTAssertFalse(b.isUndisturbed(comparedTo: a))
        XCTAssertTrue(b.drift(from: a).contains { $0.contains("took the menu bar") })
    }

    func testSnapshotDriftDetectsSpaceSwitch() {
        let a = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1, cursor: .zero,
                                  activeSpace: 1, agentSpaces: [7], coverage: .observed)
        let b = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1, cursor: .zero,
                                  activeSpace: 7, agentSpaces: [7], coverage: .observed)
        XCTAssertTrue(b.drift(from: a).contains { $0.contains("pulled onto an agent") })
    }

    func testSnapshotDetectsAgentInputRouteTheft() {
        let before = IsolationSnapshot(
            frontmostPID: 10, windowServerFrontPID: 10,
            keyFocusPID: 10, typingFocusPID: 10,
            cursor: .zero, activeSpace: 1, agentPIDs: [777], coverage: .observed)
        let after = IsolationSnapshot(
            frontmostPID: 10, windowServerFrontPID: 10,
            keyFocusPID: 777, typingFocusPID: 777,
            cursor: .zero, activeSpace: 1, agentPIDs: [777], coverage: .observed)

        XCTAssertFalse(after.isUndisturbed(comparedTo: before))
        XCTAssertTrue(after.breaches(from: before).contains { $0.contains("key-input") })
        XCTAssertTrue(after.breaches(from: before).contains { $0.contains("text-input") })
    }

    func testSnapshotToleratesSubPixelCursorNoise() {
        let a = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                  cursor: CGPoint(x: 100, y: 100), activeSpace: 1,
                                  coverage: .observed)
        let b = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                  cursor: CGPoint(x: 100.4, y: 100.4), activeSpace: 1,
                                  coverage: .observed)
        XCTAssertTrue(b.isUndisturbed(comparedTo: a), "sub-pixel jitter is not a disturbance")
    }

    /// Bare cursor movement, with no agent screen involved and no warp by us, is the user —
    /// see the blame-attribution tests below. It must show up as observable drift but not as
    /// a breach.
    func testSnapshotReportsCursorMovementAsDriftButNotBreach() {
        let a = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                  cursor: CGPoint(x: 100, y: 100), activeSpace: 1,
                                  coverage: .observed)
        let b = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                  cursor: CGPoint(x: 400, y: 100), activeSpace: 1,
                                  coverage: .observed)
        XCTAssertTrue(b.isUndisturbed(comparedTo: a))
        XCTAssertFalse(b.drift(from: a).isEmpty, "the movement should still be visible in drift")
    }

    // MARK: - Errors

    func testErrorsCarryRemedies() {
        XCTAssertTrue(SpaceOError.accessibilityDenied.description.contains("System Settings"))
        XCTAssertTrue(SpaceOError.screenRecordingDenied.description.contains("System Settings"))
        XCTAssertTrue(SpaceOError.unavailable(capability: "x").description.contains("spaceo doctor"))
    }

    func testIncompatibleFocusRecordCapabilityRemainsUnavailable() {
        let available = Capabilities().items.first {
            $0.name == "focus-without-raise"
        }?.available
        XCTAssertEqual(available, false)
        XCTAssertTrue(
            Capabilities().items.first { $0.name == "focus-without-raise" }?
                .unavailableReason?.contains("direct per-PID delivery") == true)
    }

    func testVirtualDisplayCapabilityMatchesClassInventory() {
        let classes = [
            "CGVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplayMode",
            "CGVirtualDisplaySettings",
        ]
        let classesPresent = classes.allSatisfy { NSClassFromString($0) != nil }
        let available = Capabilities().items.first {
            $0.name == "virtual-display"
        }?.available
        XCTAssertEqual(available, classesPresent)
    }

    // MARK: - Pasteboard guard

    func testPasteboardGuardRestoresPriorContents() {
        let pasteboard = MemoryDiagnosticPasteboard()
        let sentinel = "user-copied-\(UUID().uuidString)"
        pasteboard.setString(sentinel)
        PasteboardGuard.preserving(pasteboard: pasteboard) {
            pasteboard.setString("agent scribble")
        }
        XCTAssertEqual(pasteboard.string, sentinel)
    }

    func testPasteboardGuardHandlesEmptyClipboard() {
        let pasteboard = MemoryDiagnosticPasteboard()
        let snapshot = PasteboardGuard.snapshot(from: pasteboard)
        pasteboard.setString("agent")
        PasteboardGuard.restore(snapshot, to: pasteboard)
        XCTAssertNil(pasteboard.string)
    }

    // MARK: - Capture heuristics

    func testVisualEntropyIsZeroForFlatImage() throws {
        let image = try makeImage(width: 64, height: 64) { context in
            context.setFillColor(CGColor(gray: 0.5, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        XCTAssertLessThan(Capture.visualEntropy(image), 0.02)
        XCTAssertFalse(Capture.looksRendered(image), "a flat surface must not read as rendered UI")
    }

    func testVisualEntropyIsHighForVariedImage() throws {
        let image = try makeImage(width: 64, height: 64) { context in
            for i in 0..<64 {
                context.setFillColor(CGColor(gray: Double(i) / 64.0, alpha: 1))
                context.fill(CGRect(x: i, y: 0, width: 1, height: 64))
            }
        }
        XCTAssertGreaterThan(Capture.visualEntropy(image), 0.02)
        XCTAssertTrue(Capture.looksRendered(image))
    }

    func testCaptureDimensionsRejectInvalidGeometryWithoutProductCaps() throws {
        let ordinary = try Capture.validatedDimensions(width: 1_920, height: 1_080, scale: 2)
        XCTAssertEqual(ordinary.width, 3_840)
        XCTAssertEqual(ordinary.height, 2_160)
        let large = try Capture.validatedDimensions(width: 16_384, height: 16_384)
        XCTAssertEqual(large.width, 16_384)
        XCTAssertEqual(large.height, 16_384)

        for dimensions in [
            (Double.nan, 100.0, 1.0),
            (100.0, Double.infinity, 1.0),
            (0.0, 100.0, 1.0),
            (Double(Int.max / 8), 16.0, 1.0), // pixel-count overflow
            (Double(Int.max / 8), 4.0, 1.0), // RGBA byte-count overflow
        ] {
            XCTAssertThrowsError(
                try Capture.validatedDimensions(
                    width: dimensions.0, height: dimensions.1, scale: dimensions.2))
        }
    }

    func testWindowPlacementRejectsInvalidGeometryBeforeTouchingAccessibility() {
        for frame in [
            CGRect(x: CGFloat.nan, y: 0, width: 100, height: 100),
            CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100),
            CGRect(x: 0, y: 0, width: 0, height: 100),
        ] {
            XCTAssertThrowsError(try WindowPlacement.validate(frame: frame))
        }
        XCTAssertNoThrow(
            try WindowPlacement.validate(
                frame: CGRect(x: 0, y: 0, width: 16_384, height: 16_384)))
    }

    func testAXTreeRejectsPathologicalWalkLimitsBeforeTouchingAccessibility() {
        XCTAssertThrowsError(
            try AXTree.snapshot(pid: getpid(), maxDepth: Int.max, maxNodes: 1))
        XCTAssertThrowsError(
            try AXTree.snapshot(pid: getpid(), maxDepth: 1, maxNodes: Int.max))
        XCTAssertThrowsError(
            try AXTree.snapshot(pid: getpid(), maxDepth: -1, maxNodes: 1))
    }

    private func makeImage(width: Int, height: Int, _ draw: (CGContext) -> Void) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
                                              bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        draw(context)
        return try XCTUnwrap(context.makeImage())
    }

    // MARK: - App resolution

    func testResolveFindsSystemApp() {
        XCTAssertNotNil(AppLauncher.resolve("TextEdit"))
        XCTAssertNotNil(AppLauncher.resolve("com.apple.TextEdit"))
    }

    func testResolveRejectsNonsense() {
        XCTAssertNil(AppLauncher.resolve("DefinitelyNotAnApp-\(UUID().uuidString)"))
    }

    // MARK: - Wire protocol

    func testRequestResponseRoundTrip() throws {
        var request = Request(cmd: "type")
        request.session = "agent-1"
        request.text = "hello"
        request.diagnosticTraceID = "trace-123"
        request.diagnosticRunID = "run-123"
        request.diagnosticMetrics = true
        let data = try Wire.encoder.encode(request)
        let decoded = try Wire.decoder.decode(Request.self, from: data)
        XCTAssertEqual(decoded.cmd, "type")
        XCTAssertEqual(decoded.text, "hello")
        XCTAssertEqual(decoded.session, "agent-1")
        XCTAssertEqual(decoded.diagnosticTraceID, "trace-123")
        XCTAssertEqual(decoded.diagnosticRunID, "run-123")
        XCTAssertEqual(decoded.diagnosticMetrics, true)

        let runtime = DaemonRuntimeInfo(
            version: "1.0.0",
            executableSHA256: String(repeating: "a", count: 64),
            executableBuildUUID: "12345678-1234-1234-1234-123456789abc",
            pid: 42,
            instanceID: UUID(),
            startedAt: Date(timeIntervalSince1970: 1_000),
            accessibilityGranted: false,
            screenRecordingGranted: true,
            canDrive: false,
            canCapture: true)
        var response = Response(ok: true)
        response.daemon = runtime
        let responseData = try Wire.encoder.encode(response)
        XCTAssertEqual(
            try Wire.decoder.decode(Response.self, from: responseData).daemon,
            runtime)
    }

    func testResponseFailureCarriesDescription() throws {
        let response = Response.failure(SpaceOError.unknownSession("nope"))
        XCTAssertFalse(response.ok)
        XCTAssertTrue(response.error?.contains("nope") == true)
    }

    func testMCPStillSupportsTheOlderOverlapProtocolVersion() {
        XCTAssertTrue(MCPServer.supportedVersions.contains("2024-11-05"),
                      "older installed clients still need an overlap version")
    }

    func testMCPRejectsWindowIDsThatWouldTrapNumericConversion() {
        for value: Any in [-1, 0, Double.greatestFiniteMagnitude, 1.5, true, "42"] {
            XCTAssertThrowsError(
                try MCPServer.toolRequest(
                    name: "spaceo_screenshot",
                    arguments: ["window": value]),
                "unsafe window id \(value) should be a tool error, never a process crash")
        }

        XCTAssertEqual(
            try MCPServer.toolRequest(
                name: "spaceo_screenshot",
                arguments: ["window": 42]).window,
            42)
    }

    func testMCPValidatesClickShapeAndBounds() {
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_click",
            arguments: ["x": 10]))
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_click",
            arguments: ["element": "3", "x": 10, "y": 20]))
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_click",
            arguments: ["element": "3", "count": 1_000_000]))
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_click",
            arguments: ["x": 10.5, "y": 20, "button": "right", "count": 2]))
    }

    func testMCPBoundsUTF8AndFileCollectionsNotOnlyGraphemes() {
        let oversizedGrapheme = "a" + String(repeating: "\u{0301}", count: 16_000)
        XCTAssertEqual(oversizedGrapheme.count, 1)
        XCTAssertGreaterThan(oversizedGrapheme.utf8.count, 32_000)
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_type",
            arguments: ["text": oversizedGrapheme]))

        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_open_app",
            arguments: [
                "app": "TextEdit",
                "files": Array(repeating: "/tmp/file", count: 257),
            ]))

        XCTAssertEqual(
            try? MCPServer.toolRequest(
                name: "spaceo_press_key",
                arguments: ["key": "return", "web": true]).web,
            true)
    }

    func testMCPScreenshotReaderCannotReadUnexpectedOrUnsafeFiles() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-mcp-shot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }

        let expected = directory.appendingPathComponent("expected.png")
        let other = directory.appendingPathComponent("other.png")
        let pngHeader = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        try pngHeader.write(to: expected)
        try pngHeader.write(to: other)

        XCTAssertEqual(
            try MCPServer.screenshotData(
                responsePath: expected.path, expectedPath: expected.path),
            pngHeader)
        XCTAssertThrowsError(
            try MCPServer.screenshotData(
                responsePath: other.path, expectedPath: expected.path))

        let symlink = directory.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(
            at: symlink, withDestinationURL: expected)
        XCTAssertThrowsError(
            try MCPServer.screenshotData(
                responsePath: symlink.path, expectedPath: symlink.path))
    }

    func testMCPLineReaderBoundsInputWithoutLosingTheNextMessage() throws {
        let pipe = Pipe()
        let reader = BoundedLineReader(handle: pipe.fileHandleForReading, maximumBytes: 16)
        pipe.fileHandleForWriting.write(Data((String(repeating: "x", count: 20)
                                              + "\n{\"ok\":true}\n").utf8))
        try pipe.fileHandleForWriting.close()

        XCTAssertThrowsError(try reader.next()) { error in
            XCTAssertTrue("\(error)".contains("16 bytes"))
        }
        XCTAssertEqual(try reader.next(), "{\"ok\":true}")
        XCTAssertNil(try reader.next())
    }

    func testMCPLineReaderReturnsBeforeAClientClosesItsPipe() throws {
        let pipe = Pipe()
        let reader = BoundedLineReader(handle: pipe.fileHandleForReading)
        pipe.fileHandleForWriting.write(Data("{\"jsonrpc\":\"2.0\"}\n".utf8))

        // Close after a delay only as a deadlock escape hatch. A streaming reader must return
        // the complete line immediately while the MCP client's stdin pipe remains open.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            try? pipe.fileHandleForWriting.close()
        }
        let started = Date()
        XCTAssertEqual(try reader.next(), "{\"jsonrpc\":\"2.0\"}")
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        try? pipe.fileHandleForWriting.close()
    }

    func testMCPLineReaderKeepsRegularFileReadsBounded() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-mcp-input-\(UUID().uuidString)")
        var contents = Data(repeating: 0x78, count: 2_000_000)
        contents.append(Data("\n{\"ok\":true}\n".utf8))
        try contents.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: 1_048_576)
        XCTAssertThrowsError(try reader.next())
        XCTAssertEqual(try reader.next(), "{\"ok\":true}")
    }

    func testDaemonRejectsUnboundedInputBeforeResolvingASession() async {
        var tooManyClicks = Request(cmd: "click")
        tooManyClicks.count = Int.max
        let clickResponse = await SessionManager().handle(tooManyClicks)
        XCTAssertFalse(clickResponse.ok)
        XCTAssertTrue(clickResponse.error?.contains("1 through 3") == true)

        var tooMuchText = Request(cmd: "type")
        tooMuchText.text = String(repeating: "x", count: 8_001)
        let typeResponse = await SessionManager().handle(tooMuchText)
        XCTAssertFalse(typeResponse.ok)
        XCTAssertTrue(typeResponse.error?.contains("maximum 8000") == true)

        var pathologicalText = Request(cmd: "type")
        pathologicalText.text = "a" + String(repeating: "\u{0301}", count: 16_000)
        let byteResponse = await SessionManager().handle(pathologicalText)
        XCTAssertFalse(byteResponse.ok)
        XCTAssertTrue(byteResponse.error?.contains("32000 UTF-8 bytes") == true)

        var tooManyFiles = Request(cmd: "run")
        tooManyFiles.app = "TextEdit"
        tooManyFiles.files = Array(repeating: "/tmp/file", count: 257)
        let filesResponse = await SessionManager().handle(tooManyFiles)
        XCTAssertFalse(filesResponse.ok)
        XCTAssertTrue(filesResponse.error?.contains("at most 256") == true)
    }

    func testTransportReadLineFramesChunkedInput() throws {
        // Framing must be identical whether the line arrives byte-by-byte or in one chunk.
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data("{\"cmd\":\"ping\"}\ntrailing-noise".utf8))
        try pipe.fileHandleForWriting.close()
        XCTAssertEqual(
            Transport.readLine(from: pipe.fileHandleForReading.fileDescriptor),
            "{\"cmd\":\"ping\"}")

        let empty = Pipe()
        empty.fileHandleForWriting.write(Data("\n".utf8))
        try empty.fileHandleForWriting.close()
        XCTAssertNil(Transport.readLine(from: empty.fileHandleForReading.fileDescriptor),
                     "an empty line is not a message")

        let unterminated = Pipe()
        unterminated.fileHandleForWriting.write(Data("tail-without-newline".utf8))
        try unterminated.fileHandleForWriting.close()
        XCTAssertNil(
            Transport.readLine(from: unterminated.fileHandleForReading.fileDescriptor),
            "a peer that dies mid-message has not sent a message; handing back the prefix "
                + "makes truncation indistinguishable from a complete line")

        let oversized = Pipe()
        oversized.fileHandleForWriting.write(Data((String(repeating: "x", count: 64) + "\n").utf8))
        try oversized.fileHandleForWriting.close()
        XCTAssertNil(
            Transport.readLine(from: oversized.fileHandleForReading.fileDescriptor,
                               maximumBytes: 16),
            "a line over the limit must be rejected even when it fits in one chunk")
    }

    /// Connects a bare fd so a test can pace its own writes; `Transport.send` always sends the
    /// whole line at once and cannot reproduce a straddled message.
    private func connectedClient(to path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        // A daemon that hangs up mid-message must surface as EPIPE on the next write, not as a
        // SIGPIPE that takes the whole test process down with it.
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                   socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else { close(fd); return nil }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                _ = strcpy($0, path)
            }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { close(fd); return nil }
        return fd
    }

    func testDaemonExecutesARequestSplitAcrossTheReceiveTimeout() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-split-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path

        // Echoing the command back proves the daemon decoded the *whole* line, not a prefix.
        let server = Transport.Server(path: path) { .success($0.cmd) }
        try server.start()
        defer { server.stop() }

        let fd = try XCTUnwrap(connectedClient(to: path), "could not reach the test daemon")
        defer { close(fd) }

        func send(_ text: String) {
            var bytes = Array(text.utf8)
            XCTAssertEqual(Foundation.write(fd, &bytes, bytes.count), bytes.count)
        }
        // The pause exceeds the former per-read socket timeout (2s), but not the current
        // event-driven reader's 3s framing deadline. Preserve the original regression:
        // a temporarily idle peer must not cause a partial request to be decoded.
        send("{\"cmd\":\"pi")
        Thread.sleep(forTimeInterval: 2.5)
        send("ng\"}\n")

        let reply = try XCTUnwrap(
            Transport.readLine(
                from: fd,
                deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
                    &+ 5_000_000_000),
            "the daemon closed without a reply")
        let response = try Wire.decoder.decode(Response.self, from: Data(reply.utf8))
        XCTAssertTrue(response.ok, "unexpected error: \(response.error ?? "none")")
        XCTAssertEqual(response.message, "ping")
    }

    func testTransportWriteFinishesTheBodyForASlowReader() throws {
        var pair: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        let writer = pair[0], reader = pair[1]
        defer { close(writer); close(reader) }
        // Exercise compatibility with blocking descriptors that yield EAGAIN via a socket
        // timeout. Production sockets now remain nonblocking and use absolute poll deadlines.
        var bufferBytes: Int32 = 8 * 1_024
        setsockopt(writer, SOL_SOCKET, SO_SNDBUF, &bufferBytes,
                   socklen_t(MemoryLayout<Int32>.size))
        setsockopt(reader, SOL_SOCKET, SO_RCVBUF, &bufferBytes,
                   socklen_t(MemoryLayout<Int32>.size))
        var sendTimeout = timeval(tv_sec: 0, tv_usec: 50_000)
        setsockopt(writer, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout,
                   socklen_t(MemoryLayout<timeval>.size))

        let body = String(repeating: "x", count: 512 * 1_024)
        let response = Response.success(body)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            Transport.write(
                response,
                to: writer,
                deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
                    &+ 10_000_000_000)
            finished.signal()
        }

        // Stall well past the send timeout so the writer must survive at least one EAGAIN.
        Thread.sleep(forTimeInterval: 0.3)
        let line = Transport.readLine(
            from: reader,
            deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds &+ 10_000_000_000)
        XCTAssertEqual(finished.wait(timeout: .now() + 10), .success)
        let decoded = try Wire.decoder.decode(
            Response.self, from: Data(try XCTUnwrap(line, "the response body was abandoned").utf8))
        XCTAssertEqual(decoded.message?.count, body.count,
                       "a blocked write must resume, not drop the tail")
    }

    func testTransportRejectsOverlongSocketPathWithoutCopyingIt() {
        let path = "/" + String(repeating: "x", count: 512)
        XCTAssertThrowsError(try Transport.send(Request(cmd: "ping"), to: path)) { error in
            XCTAssertTrue("\(error)".contains("too long"))
        }
        XCTAssertThrowsError(
            try Transport.send(
                Request(cmd: "ping"), to: "/tmp/spaceo\u{0}truncated.sock")) { error in
            XCTAssertTrue("\(error)".contains("too long")
                          || "\(error)".contains("NUL"))
        }
    }

    func testTransportRejectsInvalidTimeouts() {
        for timeout in [0, -1, .infinity, .nan] {
            XCTAssertThrowsError(
                try Transport.send(Request(cmd: "ping"),
                                   to: "/tmp/does-not-matter.sock",
                                   timeout: timeout))
        }
    }

    func testTransportRejectsOversizedRequestsBeforeOpeningASocket() {
        var request = Request(cmd: "type")
        request.text = String(repeating: "x", count: 1_100_000)
        XCTAssertThrowsError(
            try Transport.send(
                request, to: "/tmp/does-not-exist.sock", timeout: 1)) { error in
            XCTAssertTrue("\(error)".contains("1 MiB"))
        }
    }

    func testServerStopIsSafeWhenCalledConcurrently() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-stop-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path
        let server = Transport.Server(path: path) { _ in .success() }
        try server.start()

        DispatchQueue.concurrentPerform(iterations: 16) { _ in server.stop() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testSameServerCannotStartTwiceOrDisruptItsFirstListener() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-repeat-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path

        let server = Transport.Server(path: path) { _ in .success("first") }
        try server.start()
        defer { server.stop() }

        XCTAssertThrowsError(try server.start()) { error in
            XCTAssertTrue("\(error)".contains("already"), "unexpected error: \(error)")
        }
        XCTAssertTrue(Transport.ping(path),
                      "a rejected second start must leave the first listener healthy")
    }

    func testSecondServerCannotUnlinkAHealthyDaemonSocket() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path

        let first = Transport.Server(path: path) { _ in .success("first") }
        try first.start()
        defer { first.stop() }

        let second = Transport.Server(path: path) { _ in .success("second") }
        XCTAssertThrowsError(try second.start()) { error in
            XCTAssertTrue("\(error)".contains("already"))
        }
        XCTAssertTrue(Transport.ping(path),
                      "the rejected duplicate must not unlink the first daemon")
    }

    func testAcceptFailureClassificationSeparatesTheEnvironmentFromTheListener() {
        for code in [EMFILE, ENFILE, ECONNABORTED, EAGAIN, EWOULDBLOCK, ENOBUFS, ENOMEM] {
            XCTAssertTrue(
                Transport.Server.acceptFailureIsTransient(code),
                """
                errno \(code) leaves the listener bound and connectable. Giving up on it \
                strands a daemon that answers connect() and never accepts.
                """)
        }
        // These mean the descriptor is no longer a usable listener. Retrying spins forever;
        // the loop must release it so start() can re-arm.
        for code in [EBADF, ENOTSOCK, EINVAL, EOPNOTSUPP, EFAULT] {
            XCTAssertFalse(Transport.Server.acceptFailureIsTransient(code),
                           "errno \(code) is a dead listener, not a transient condition")
        }
    }

    /// The P0: any non-EINTR accept() error used to end the only accept thread while leaving
    /// `listenFD` set and `ownsSocket` true. The socket stayed bound and connectable, so every
    /// command hung, `daemon stop` could not be delivered, and a fresh daemon refused to start
    /// because the pathname looked occupied. Only `kill -9` recovered.
    func testAListenerDeathReleasesTheSocketSoTheDaemonCanReArm() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-rearm-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path

        let server = Transport.Server(path: path) { _ in .success("alive") }
        try server.start()
        defer { server.stop() }
        XCTAssertTrue(Transport.ping(path), "precondition: the daemon answers")

        // Kill the listener the way the kernel would if the descriptor went away underneath a
        // blocked accept(). Overwriting the fd number with /dev/null rather than closing it
        // keeps the number un-reusable, so the retry deterministically sees ENOTSOCK instead
        // of racing whatever another thread might open into that slot.
        let listener = server.listeningDescriptorForTesting
        XCTAssertGreaterThanOrEqual(listener, 0)
        let devNull = Darwin.open("/dev/null", O_RDWR)
        XCTAssertGreaterThanOrEqual(devNull, 0)
        defer { close(devNull) }
        XCTAssertEqual(dup2(devNull, listener), listener)

        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, server.listeningDescriptorForTesting >= 0 {
            usleep(20_000)
        }
        XCTAssertLessThan(server.listeningDescriptorForTesting, 0,
                          "a dead listener must be released, not left bound and deaf")

        // The whole point of releasing it: the daemon can come back without kill -9.
        try server.start()
        XCTAssertTrue(Transport.ping(path),
                      "the daemon must be reachable again after re-arming")
    }

    func testInFlightHandlersAreBoundedSoRequestVolumeCannotExhaustDescriptors() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-flight-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("daemon.sock").path

        let cap = Transport.Server.maximumInFlightConnections
        let tracker = InFlightTracker()
        let server = Transport.Server(path: path) { _ in
            tracker.enter()
            // Await rather than block: a blocking handler would starve the cooperative pool
            // and cap concurrency at the thread count instead of at the ceiling under test.
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            tracker.leave()
            return .success()
        }
        try server.start()
        defer { server.stop() }

        // Raw sockets, written but never read. Each occupies a handler slot without costing a
        // thread — exactly the shape that used to grow the Task count, and the fd table, without
        // bound until accept() failed with EMFILE and the loop returned for good.
        var clients: [Int32] = []
        defer { for fd in clients { close(fd) } }
        let payload = try Wire.encoder.encode(Request(cmd: "ping")) + Data([0x0A])
        for _ in 0..<(cap + 8) {
            // A full backlog is a transient condition, not a verdict on the daemon; give the
            // accept thread a moment rather than recording a phantom refusal.
            var attempt = Self.connectRaw(to: path)
            for _ in 0..<50 where attempt == nil {
                usleep(20_000)
                attempt = Self.connectRaw(to: path)
            }
            guard let fd = attempt else { continue }
            payload.withUnsafeBytes { buffer in
                _ = Foundation.write(fd, buffer.baseAddress!, buffer.count)
            }
            clients.append(fd)
        }
        XCTAssertGreaterThan(clients.count, cap,
                             "the test must actually push past the ceiling")

        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, tracker.peak < cap { usleep(20_000) }
        XCTAssertEqual(tracker.peak, cap,
                       "every slot must be usable, and none beyond the ceiling")

        // The surplus is shed with an answer, not queued and not dropped on the floor.
        var accepted = 0
        var shed = 0
        for fd in clients {
            let replyDeadline = DispatchTime.now().uptimeNanoseconds &+ 10_000_000_000
            guard let line = Transport.readLine(
                from: fd, deadlineUptimeNanoseconds: replyDeadline),
                  let reply = try? Wire.decoder.decode(Response.self, from: Data(line.utf8))
            else { continue }
            if reply.ok { accepted += 1 } else if reply.error?.contains("busy") == true {
                shed += 1
            }
        }
        XCTAssertEqual(accepted, cap, "every slot must have produced a real response")
        XCTAssertEqual(shed, clients.count - cap,
                       "every surplus connection must get a busy reply, not silence")
    }

    private static func connectRaw(to path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                _ = strcpy($0, path)
            }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { close(fd); return nil }
        return fd
    }

    func testServerRefusesToReplaceANonSocketFile() throws {
        let directory = URL(
            fileURLWithPath: "/tmp/so-file-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("keep.txt")
        try "sentinel".write(to: target, atomically: true, encoding: .utf8)

        let server = Transport.Server(path: target.path) { _ in .success() }
        XCTAssertThrowsError(try server.start()) { error in
            XCTAssertTrue("\(error)".contains("non-socket"))
        }
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "sentinel")
    }

    func testServerRefusesToUnlinkAnotherProtocolsLiveSocket() throws {
        // sockaddr_un paths are only 104 bytes on Darwin. Keep this fixture deliberately short.
        let path = "/tmp/spaceo-foreign-\(UUID().uuidString.prefix(12)).sock"
        defer { unlink(path) }

        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        defer { close(listener) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                _ = strcpy($0, path)
            }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(listener, 2), 0)

        let acceptor = Thread {
            for _ in 0..<2 {
                let client = accept(listener, nil, nil)
                if client >= 0 { close(client) }
            }
        }
        acceptor.start()

        let server = Transport.Server(path: path) { _ in .success() }
        XCTAssertThrowsError(try server.start()) { error in
            XCTAssertTrue("\(error)".contains("not SpaceO"), "unexpected error: \(error)")
        }
        acceptor.cancel()

        var info = stat()
        XCTAssertEqual(lstat(path, &info), 0,
                       "a live foreign socket must remain at its original pathname")
    }

    func testTemporaryBrowserProfileCleanupIsScopedAndEffective() throws {
        let profile = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-browser-test-\(UUID().uuidString)",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: profile,
                                                withIntermediateDirectories: false)
        try "cache".write(to: profile.appendingPathComponent("data"),
                          atomically: true, encoding: .utf8)

        let app = LaunchedApp(pid: 999_999,
                              identity: ProcessIdentity(pid: 999_999,
                                                        startedAtMicroseconds: 1),
                              bundleIdentifier: "test",
                              name: "test",
                              url: URL(fileURLWithPath: "/Applications/Test.app"),
                              startedByUs: true,
                              devToolsPort: 9_222,
                              temporaryProfile: profile)
        XCTAssertTrue(AppLauncher.cleanupTemporaryProfile(for: app))
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.path))
    }

    func testTemporaryElectronControlCleanupIsScopedAndEffective() throws {
        let root = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("spaceo-e-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try "private".write(
            to: root.appendingPathComponent("extension.js"),
            atomically: true,
            encoding: .utf8)

        let app = LaunchedApp(
            pid: 999_999,
            identity: ProcessIdentity(pid: 999_999, startedAtMicroseconds: 1),
            bundleIdentifier: "test",
            name: "test",
            url: URL(fileURLWithPath: "/Applications/Test.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil,
            temporaryControlRoot: root)
        XCTAssertTrue(AppLauncher.cleanupTemporaryProfile(for: app))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))

        let unrelated = URL(fileURLWithPath: "/tmp/not-spaceo-\(UUID().uuidString)")
        XCTAssertFalse(AppLauncher.removeTemporaryControlRoot(at: unrelated))
    }

    // MARK: - Blame attribution
    //
    // An isolation check that flags the user's own mouse movement as an agent breach cries wolf,
    // and a check that cries wolf gets ignored. These pin down who gets blamed for what.

    func testUserMovingTheirOwnMouseIsNotABreach() {
        let stage = CGRect(x: 2000, y: 0, width: 1000, height: 1000)
        let before = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                       cursor: CGPoint(x: 100, y: 100), activeSpace: 1,
                                       stageRects: [stage], coverage: .observed)
        let after = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                      cursor: CGPoint(x: 700, y: 400), activeSpace: 1,
                                      stageRects: [stage], coverage: .observed)
        XCTAssertTrue(after.isUndisturbed(comparedTo: before),
                      "the user moving their mouse on their own display is not our doing")
        XCTAssertEqual(after.ambientChanges(from: before).count, 1)
    }

    func testUserSwitchingTheirOwnAppsIsNotABreach() {
        let before = IsolationSnapshot(frontmostPID: 10, windowServerFrontPID: 10,
                                       cursor: .zero, activeSpace: 1, agentPIDs: [777],
                                       coverage: .observed)
        let after = IsolationSnapshot(frontmostPID: 20, windowServerFrontPID: 20,
                                      cursor: .zero, activeSpace: 1, agentPIDs: [777],
                                      coverage: .observed)
        XCTAssertTrue(after.isUndisturbed(comparedTo: before),
                      "the user switching between their own apps is not our doing")
        XCTAssertTrue(after.ambientChanges(from: before).contains { $0.contains("own apps") })
    }

    func testAgentAppTakingFocusIsABreach() {
        let before = IsolationSnapshot(frontmostPID: 10, windowServerFrontPID: 10,
                                       cursor: .zero, activeSpace: 1, agentPIDs: [777],
                                       coverage: .observed)
        let after = IsolationSnapshot(frontmostPID: 777, windowServerFrontPID: 777,
                                      cursor: .zero, activeSpace: 1, agentPIDs: [777],
                                      coverage: .observed)
        XCTAssertFalse(after.isUndisturbed(comparedTo: before))
        XCTAssertTrue(after.breaches(from: before).contains { $0.contains("took the menu bar") })
    }

    func testBeingPulledOntoAnAgentSpaceIsABreach() {
        let before = IsolationSnapshot(frontmostPID: 10, windowServerFrontPID: 10,
                                       cursor: .zero, activeSpace: 1, agentSpaces: [637],
                                       coverage: .observed)
        let after = IsolationSnapshot(frontmostPID: 10, windowServerFrontPID: 10,
                                      cursor: .zero, activeSpace: 637, agentSpaces: [637],
                                      coverage: .observed)
        XCTAssertFalse(after.isUndisturbed(comparedTo: before))
        XCTAssertTrue(after.breaches(from: before).contains { $0.contains("pulled onto an agent") })
    }

    func testCursorPulledOntoAnAgentScreenIsABreach() {
        let stage = CGRect(x: 2000, y: 0, width: 1000, height: 1000)
        let before = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                       cursor: CGPoint(x: 100, y: 100), activeSpace: 1,
                                       stageRects: [stage], coverage: .observed)
        let after = IsolationSnapshot(frontmostPID: 1, windowServerFrontPID: 1,
                                      cursor: CGPoint(x: 2500, y: 500), activeSpace: 1,
                                      stageRects: [stage], coverage: .observed)
        XCTAssertFalse(after.isUndisturbed(comparedTo: before))
        XCTAssertTrue(after.breaches(from: before).contains { $0.contains("agent screen") })
    }

    func testCursorEvidenceKeepsASeparateAgentDisplay() throws {
        let rects: [CGDirectDisplayID: CGRect] = [
            1: CGRect(x: 0, y: 0, width: 1512, height: 982),
            22: CGRect(x: 2000, y: 0, width: 1920, height: 1080),
        ]
        let stages = IsolationSnapshot.cursorStageRects(
            agentDisplayIDs: [22],
            onlineDisplayIDs: [1, 22],
            bounds: { rects[$0] ?? .null })

        XCTAssertEqual(try XCTUnwrap(stages), [rects[22]])
    }

    func testCursorEvidenceIsUnknownWhenDisplayCoordinatesOverlap() {
        let shared = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let stages = IsolationSnapshot.cursorStageRects(
            agentDisplayIDs: [22],
            onlineDisplayIDs: [1, 22],
            bounds: { _ in shared })

        XCTAssertNil(stages,
                     "one global point cannot identify which overlapping display owns it")
    }

    func testCursorEvidenceAllowsDisplaysThatOnlyTouchAtAnEdge() throws {
        let rects: [CGDirectDisplayID: CGRect] = [
            1: CGRect(x: 0, y: 0, width: 1512, height: 982),
            22: CGRect(x: 1512, y: 0, width: 1920, height: 1080),
        ]
        let stages = IsolationSnapshot.cursorStageRects(
            agentDisplayIDs: [22],
            onlineDisplayIDs: [1, 22],
            bounds: { rects[$0] ?? .null })

        XCTAssertEqual(try XCTUnwrap(stages), [rects[22]])
    }

    func testUnpressableElementErrorDoesNotBlameTheApp() {
        let error = SpaceOError.elementNotPressable(role: "AXTextArea", actions: ["AXShowMenu"])
        XCTAssertTrue(error.description.contains("not pressable"))
        XCTAssertFalse(error.description.contains("canvas"),
                       "picking a non-button element is a caller mistake, not an app limitation")
        XCTAssertTrue(error.description.contains("click by coordinates"), "the error should point at the way out")
    }

    /// Live dogfood: TextEdit turned the typed "hello from spaceo" into "Hello from spaceo" and
    /// the receipt said nothing. Evident rewrites are reported; unrelated text is not guessed at.
    func testTypedTextRewrittenByTheAppIsReportedOnlyWhenEvident() {
        let note = SessionManager.typedTextAlterationNote(typed: "hello from spaceo", fieldValue: "Hello from spaceo")
        XCTAssertNotNil(note)
        XCTAssertTrue(note?.contains("typed \"hello from spaceo\"") == true, note ?? "")
        XCTAssertNotNil(SessionManager.typedTextAlterationNote(typed: "don't -- stop", fieldValue: "Don\u{2019}t \u{2014} stop"))
        XCTAssertNil(SessionManager.typedTextAlterationNote(typed: "hello", fieldValue: "say hello"), "unchanged text")
        XCTAssertNil(SessionManager.typedTextAlterationNote(typed: "hello", fieldValue: "Address bar"), "a different field")
        XCTAssertNil(SessionManager.typedTextAlterationNote(typed: "hello", fieldValue: nil))
        XCTAssertNil(SessionManager.typedTextAlterationNote(typed: "", fieldValue: "x"))
    }

    /// Live dogfood read "AXRuler exposes no press action (available: AXPress)": the action was
    /// advertised and refused, which is a different fact from it being absent.
    func testAdvertisedButRefusedPressIsNotReportedAsMissing() {
        let error = SpaceOError.elementNotPressable(role: "AXRuler", actions: ["AXPress", "AXShowMenu"])
        XCTAssertTrue(error.description.contains("refused its press: AXRuler advertises AXPress"), error.description)
        XCTAssertFalse(error.description.contains("exposes no press action"), error.description)
        XCTAssertEqual(error.code, "unsupported_target")
    }

    // MARK: - Tiling
    //
    // Displays are expensive to composite, so sessions share one. These pin down the packing.

    func testSingleSessionGetsTheWholeDisplay() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tiles = TileLayout.rects(in: bounds, capacity: 1)
        XCTAssertEqual(tiles.count, 1)
        XCTAssertEqual(tiles[0], bounds)
    }

    func testTwoSessionsSplitSideBySide() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tiles = TileLayout.rects(in: bounds, capacity: 2)
        XCTAssertEqual(tiles.count, 2)
        XCTAssertEqual(tiles[0], CGRect(x: 0, y: 0, width: 960, height: 1080))
        XCTAssertEqual(tiles[1], CGRect(x: 960, y: 0, width: 960, height: 1080))
    }

    func testFourSessionsMakeQuadrants() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tiles = TileLayout.rects(in: bounds, capacity: 4)
        XCTAssertEqual(tiles.count, 4)
        XCTAssertEqual(tiles[3], CGRect(x: 960, y: 540, width: 960, height: 540))
    }

    /// Overlapping tiles would let one agent's window land in another agent's screenshot,
    /// which is a context-leak between agents, not just a cosmetic bug.
    func testTilesNeverOverlap() {
        let bounds = CGRect(x: -3000, y: 500, width: 2560, height: 1440)
        for capacity in 1...12 {
            let tiles = TileLayout.rects(in: bounds, capacity: capacity)
            XCTAssertEqual(tiles.count, capacity)
            for i in tiles.indices {
                for j in tiles.indices where j > i {
                    XCTAssertFalse(tiles[i].intersects(tiles[j]),
                                   "capacity \(capacity): tile \(i) overlaps tile \(j)")
                }
                XCTAssertTrue(bounds.contains(tiles[i]),
                              "capacity \(capacity): tile \(i) escapes the display")
            }
        }
    }

    func testTilesRespectDisplayOrigin() {
        let bounds = CGRect(x: -1600, y: 900, width: 1600, height: 1000)
        let tiles = TileLayout.rects(in: bounds, capacity: 2)
        XCTAssertEqual(tiles[0].origin.x, -1600)
        XCTAssertEqual(tiles[0].origin.y, 900)
    }

    /// The two tiling APIs must describe the same display.
    ///
    /// `rects` used to build its grid from the materialization-bounded count, so above 64 it
    /// laid out a different, coarser grid than `rect` did — at capacity 100, 240x135 tiles
    /// against 192x108 ones. A caller mixing the two (diagnostics, tile overlays) then placed
    /// two sessions on rects that overlap, which is the cross-agent context leak tiling exists
    /// to prevent.
    func testFullLayoutAgreesWithSingleTileLookupAcrossTheMaterializationBound() {
        let bounds = CGRect(x: -900, y: 120, width: 3840, height: 2160)
        for capacity in Array(1...12) + [63, 64, 65, 100, 1000] {
            let tiles = TileLayout.rects(in: bounds, capacity: capacity)
            XCTAssertEqual(tiles.count, min(TileLayout.maximumMaterializedCapacity, capacity),
                           "capacity \(capacity): the prefix must be the whole layout or the bound")
            for i in tiles.indices {
                XCTAssertEqual(tiles[i],
                               TileLayout.rect(in: bounds, capacity: capacity, index: i),
                               "capacity \(capacity): tile \(i) disagrees between the two APIs")
            }
        }
    }

    /// Above the materialization bound the tiles are still a real, non-overlapping layout —
    /// a truncated list of correct rects, not a whole layout recomputed at the wrong density.
    func testTilesAboveTheMaterializationBoundStillDoNotOverlap() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tiles = TileLayout.rects(in: bounds, capacity: 100)
        XCTAssertEqual(tiles.count, TileLayout.maximumMaterializedCapacity)
        XCTAssertEqual(tiles[0], CGRect(x: 0, y: 0, width: 192, height: 108),
                       "the grid must come from capacity 100, not from the clamped count")
        for i in tiles.indices {
            for j in tiles.indices where j > i {
                XCTAssertFalse(tiles[i].intersects(tiles[j]),
                               "tile \(i) overlaps tile \(j)")
            }
            XCTAssertTrue(bounds.contains(tiles[i]), "tile \(i) escapes the display")
        }
    }

    /// Full-layout materialization remains technically bounded.
    func testTilingMaterializationIsBounded() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tiles = TileLayout.rects(in: bounds, capacity: 4_097)
        XCTAssertEqual(tiles.count, TileLayout.maximumMaterializedCapacity)
        XCTAssertEqual(tiles.first?.origin, bounds.origin)
    }

    func testSingleTileLookupDoesNotInheritTheMaterializationBound() {
        let bounds = CGRect(x: 40, y: 60, width: 1_000_000, height: 1_000_000)
        let capacity = 1_000_000_000
        let last = capacity - 1
        let tile = TileLayout.rect(in: bounds,
                                   capacity: capacity, index: last)
        XCTAssertNotNil(tile)
        XCTAssertGreaterThan(tile?.width ?? 0, 0)
        XCTAssertNil(TileLayout.rect(in: bounds,
                                     capacity: capacity,
                                     index: capacity))
    }

    func testTilingStillRequiresPositiveCapacity() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        XCTAssertTrue(TileLayout.rects(in: bounds, capacity: 0).isEmpty)
        XCTAssertTrue(TileLayout.rects(in: bounds, capacity: -1).isEmpty)
    }

    func testPoolAcceptsUnrestrictedTechnicallyRepresentableDensity() {
        let pool = DisplayPool(sessionsPerDisplay: 1,
                               displaySize: CGSize(width: 100_000, height: 100_000),
                               budget: .unrestricted)
        XCTAssertNoThrow(try pool.setSessionsPerDisplay(4))
        XCTAssertEqual(pool.sessionsPerDisplay, 4)
        XCTAssertNoThrow(try pool.setSessionsPerDisplay(4_097))
        XCTAssertThrowsError(try pool.setSessionsPerDisplay(0))
        XCTAssertEqual(pool.sessionsPerDisplay, 4_097,
                       "a refused density must not replace the last accepted value")
    }

    func testPoolAcceptsLargeDisplaysButRejectsInvalidGeometry() {
        // Large is still fine — a virtual display is not a panel anyone has to buy.
        let large = DisplayPool(displaySize: CGSize(width: 5_120, height: 2_880))
        XCTAssertNoThrow(try large.setSessionsPerDisplay(1))

        for invalidSize in [
            CGSize(width: 0, height: 600),
            CGSize(width: -1, height: 600),
            CGSize(width: 1_280.5, height: 800),
            CGSize(width: CGFloat.infinity, height: 800),
            CGSize(width: CGFloat(UInt32.max) + 1, height: 800),
        ] {
            let pool = DisplayPool(displaySize: invalidSize)
            XCTAssertThrowsError(try pool.setSessionsPerDisplay(1),
                                 "invalid display geometry \(invalidSize) must be rejected")
        }
    }

    func testSessionNamesRejectEmptyAndControlCharacters() async {
        let manager = SessionManager()
        for invalid in [" \n", "../escape", #"folder\escape"#] {
            do {
                _ = try await manager.create(name: invalid)
                XCTFail("unsafe session id should fail")
            } catch {
                XCTAssertTrue("\(error)".contains("session id"))
            }
        }
    }

    func testSessionNamesAreStoredInCanonicalTrimmedForm() throws {
        XCTAssertEqual(
            try SessionManager.canonicalSessionID("  canonical  "),
            "canonical")
    }

    // MARK: - Browser detection and bridge validation

    func testChromiumFamilyDetectedFromTheBundle() {
        if let chrome = AppLauncher.resolve("Google Chrome") {
            XCTAssertTrue(AppLauncher.isChromiumFamily(chrome))
        }
        let textEdit = AppLauncher.resolve("TextEdit")!
        XCTAssertFalse(AppLauncher.isChromiumFamily(textEdit),
                       "TextEdit is not a browser and must not be launched with browser flags")
    }

    func testDevToolsEndpointMustStayOnTheExactLoopbackPort() {
        XCTAssertNotNil(
            ChromiumBridge.validatedWebSocketURL(
                "ws://127.0.0.1:43123/devtools/page/abc",
                port: 43_123))
        XCTAssertNotNil(
            ChromiumBridge.validatedWebSocketURL(
                "ws://localhost:43123/devtools/page/abc",
                port: 43_123))
        XCTAssertNil(
            ChromiumBridge.validatedWebSocketURL(
                "ws://example.com:43123/devtools/page/abc",
                port: 43_123))
        XCTAssertNil(
            ChromiumBridge.validatedWebSocketURL(
                "ws://127.0.0.1:43124/devtools/page/abc",
                port: 43_123))
        XCTAssertNil(
            ChromiumBridge.validatedWebSocketURL(
                "wss://127.0.0.1:43123/devtools/page/abc",
                port: 43_123))
    }

    func testDevToolsPortComesFromThePrivateProfileMarker() throws {
        let profile = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-browser-port-test-\(UUID().uuidString)",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: profile,
                                                withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: profile) }
        let marker = profile.appendingPathComponent("DevToolsActivePort")

        try "43123\n/devtools/browser/example\n".write(
            to: marker, atomically: true, encoding: .utf8)
        XCTAssertEqual(AppLauncher.devToolsPort(in: profile), 43_123)
        try "not-a-port\n".write(to: marker, atomically: true, encoding: .utf8)
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
    }

    // MARK: - CLI output contracts

    func testVersionJSONIsOneMachineReadableDocument() throws {
        let result = try runSpaceO(["version", "--json"])
        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertTrue(result.standardError.isEmpty)

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: result.standardOutput) as? [String: Any])
        XCTAssertEqual(object["version"] as? String, SpaceOVersion.current)
        XCTAssertEqual(object["ok"] as? Bool, true, "every --json result carries the ok envelope")
        XCTAssertEqual(object.count, 2, "version JSON should stay small and stable")
    }

    func testDoctorJSONIsStructuredEvenWhenTheHostIsUnhealthy() throws {
        // Isolate the probe from a daemon the developer may already be running. `doctor` is
        // allowed to exit 1 when TCC or private capabilities are missing; its JSON contract must
        // remain parseable in that case so an agent can explain the failed health check.
        let socketPath = "/tmp/so-doctor-\(UUID().uuidString.prefix(12)).sock"
        let result = try runSpaceO(["doctor", "--json", "--socket", socketPath])
        XCTAssertTrue(result.status == 0 || result.status == 1,
                      "doctor exited \(result.status): \(result.standardError)")

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: result.standardOutput) as? [String: Any],
            "doctor did not emit one JSON object: \(result.standardOutputText)")
        XCTAssertNotNil(object["ok"] as? Bool)
        XCTAssertNotNil(object["macOS"] as? String)
        XCTAssertNotNil(object["canDrive"] as? Bool)
        XCTAssertNotNil(object["canCapture"] as? Bool)
        XCTAssertNotNil(object["builtWithARC"] as? Bool)
        XCTAssertNotNil(object["missingSymbols"] as? [Any])

        let capabilities = try XCTUnwrap(object["capabilities"] as? [[String: Any]])
        XCTAssertFalse(capabilities.isEmpty)
        for capability in capabilities {
            XCTAssertNotNil(capability["name"] as? String)
            XCTAssertNotNil(capability["available"] as? Bool)
            XCTAssertNotNil(capability["detail"] as? String)
        }

        let daemon = try XCTUnwrap(object["daemon"] as? [String: Any])
        XCTAssertEqual(daemon["socket"] as? String, socketPath)
        XCTAssertEqual(daemon["running"] as? Bool, false)

        let displays = try XCTUnwrap(object["displays"] as? [String: Any])
        for key in ["spaceO", "orphanedSpaceO", "userOnline", "userActive", "mirroredUser"] {
            XCTAssertNotNil(displays[key] as? [Any], "missing displays.\(key)")
        }
    }

    private struct CLIResult {
        let status: Int32
        let standardOutput: Data
        let standardError: String

        var standardOutputText: String {
            String(data: standardOutput, encoding: .utf8) ?? "<non-UTF-8 output>"
        }
    }

    private func runSpaceO(_ arguments: [String]) throws -> CLIResult {
        // SwiftPM places sibling executable products next to the XCTest bundle. Deriving the
        // path from the bundle keeps this independent of architecture-specific `.build` paths.
        let executable = Bundle(for: UnitTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("spaceo")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw XCTSkip("spaceo executable was not built next to the test bundle")
        }

        let process = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = standardOutput
        process.standardError = standardError
        try process.run()
        process.waitUntilExit()

        let outputData = standardOutput.fileHandleForReading.readDataToEndOfFile()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        return CLIResult(
            status: process.terminationStatus,
            standardOutput: outputData,
            standardError: String(data: errorData, encoding: .utf8) ?? "<non-UTF-8 stderr>")
    }

}
