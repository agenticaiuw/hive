import XCTest
import Darwin
@testable import SpaceOMCP

/// The MCP run loop reads stdin forever, so it has to tell "this line was bad" apart from
/// "this descriptor is dead".
///
/// Treating both as a parse error is what turns a closed stdin (`spaceo mcp 0<&-`) into a
/// process pinned to a core, writing `-32700` responses into the client's pipe as fast as the
/// kernel accepts them. A bad line is the peer's problem and the next one may be fine; a failed
/// `read()` will fail identically on every retry, so the only sane response is to stop.
final class MCPStdinFailureTests: XCTestCase {

    /// fd -1 is never valid and can never be recycled into something valid, so `read` reports
    /// EBADF deterministically — the same shape as stdin closed at launch, or a pty that hung up.
    private func deadDescriptorReader() -> BoundedLineReader {
        BoundedLineReader(handle: FileHandle(fileDescriptor: -1, closeOnDealloc: false))
    }

    func testADeadDescriptorEndsTheLoopInsteadOfBecomingAParseError() {
        guard case .fatal(let error) = MCPServer.nextInput(from: deadDescriptorReader()) else {
            return XCTFail("a failed read() must not be reported as a recoverable parse error")
        }
        XCTAssertEqual(error as? BoundedLineReader.ReaderError, .io(EBADF))
    }

    /// Even if a caller ignores the verdict, the reader must not keep hammering the descriptor.
    func testTheReaderStaysFailedRatherThanRetryingADeadDescriptor() {
        let reader = deadDescriptorReader()
        for attempt in 1...3 {
            XCTAssertThrowsError(try reader.next(), "attempt \(attempt)") { error in
                XCTAssertEqual(error as? BoundedLineReader.ReaderError, .io(EBADF))
            }
        }
    }

    /// The other half of the contract: a malformed line still has to leave the session alive.
    func testAnUnusableLineIsRecoverableAndTheNextMessageStillArrives() throws {
        let pipe = Pipe()
        let reader = BoundedLineReader(handle: pipe.fileHandleForReading, maximumBytes: 16)
        pipe.fileHandleForWriting.write(
            Data((String(repeating: "x", count: 20) + "\n{\"ok\":true}\n").utf8))
        try pipe.fileHandleForWriting.close()

        guard case .recoverable = MCPServer.nextInput(from: reader) else {
            return XCTFail("an oversized line must not kill the session")
        }
        guard case .line(let line) = MCPServer.nextInput(from: reader) else {
            return XCTFail("the message after a bad line must still be delivered")
        }
        XCTAssertEqual(try line.jsonObject() as? [String: Bool], ["ok": true])
        guard case .endOfInput = MCPServer.nextInput(from: reader) else {
            return XCTFail("a closed pipe is a clean exit, not a failure")
        }
    }

    func testChunkBoundariesUTF8AndOversizedRecovery() throws {
        let limit = 131_072
        let exact = String(repeating: "é", count: limit / 2)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var input = Data((exact + "\n\n").utf8)
        input.append(Data(repeating: 0x78, count: limit * 3))
        input.append(Data("\nvalid\n".utf8))
        input.append(0xFF)
        input.append(Data("\ntail".utf8))
        try input.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: limit)
        XCTAssertEqual(try reader.next(), exact)
        XCTAssertEqual(try reader.next(), "")
        XCTAssertThrowsError(try reader.next()) {
            XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .lineTooLong(limit))
        }
        XCTAssertEqual(try reader.next(), "valid")
        XCTAssertThrowsError(try reader.next()) {
            XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .invalidUTF8)
        }
        XCTAssertEqual(try reader.next(), "tail")
        XCTAssertNil(try reader.next())
    }

    func testOversizedUnterminatedInputReportsOneErrorThenEOF() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(repeating: 0x78, count: 200_000).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: 64)
        XCTAssertThrowsError(try reader.next()) {
            XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .lineTooLong(64))
        }
        XCTAssertNil(try reader.next())
    }

    func testCoalescedRequestsKeepPerLineBoundsAndRecoverAcrossReads() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var input = Data()
        for index in 0..<20_000 {
            input.append(Data("request-\(index)\n".utf8))
            if index == 1_500 {
                input.append(Data((String(repeating: "x", count: 65) + "\n").utf8))
                input.append(contentsOf: [0xFF, 0x0A, 0x0A])
            }
        }
        input.append(Data("tail".utf8))
        try input.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: 32)
        var first: String?
        for index in 0..<20_000 {
            let value = try reader.next()
            if index == 0 { first = value }
            XCTAssertEqual(value, "request-\(index)")
            if index == 1_500 {
                XCTAssertThrowsError(try reader.next()) {
                    XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .lineTooLong(32))
                }
                XCTAssertThrowsError(try reader.next()) {
                    XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .invalidUTF8)
                }
                XCTAssertEqual(try reader.next(), "")
            }
        }
        XCTAssertEqual(try reader.next(), "tail")
        XCTAssertNil(try reader.next())
        XCTAssertEqual(first, "request-0", "later buffer reuse must not alter returned strings")
    }

    func testPartialTailCompactionPreservesExactUTF8Limit() throws {
        let limit = 65_535
        let exact = String(repeating: "é", count: 32_767) + "x"
        let input = Data(("short\n" + exact + "\nlast\n").utf8)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try input.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: limit)
        XCTAssertEqual(try reader.next(), "short")
        XCTAssertEqual(try reader.next(), exact)
        XCTAssertEqual(try reader.next(), "last")
        XCTAssertNil(try reader.next())
    }

    /// A client may hand us a nonblocking stdin. Then "no data yet" arrives as EAGAIN — an error
    /// by the same classification, but retrying it in a tight loop is exactly the spin this all
    /// exists to prevent. The reader has to wait for readability and pick the line up.
    func testANonblockingStdinWaitsForDataInsteadOfFailingOrSpinning() throws {
        let pipe = Pipe()
        let descriptor = pipe.fileHandleForReading.fileDescriptor
        XCTAssertEqual(fcntl(descriptor, F_SETFL, O_NONBLOCK), 0)
        let reader = BoundedLineReader(handle: pipe.fileHandleForReading)

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
            pipe.fileHandleForWriting.write(Data("{\"jsonrpc\":\"2.0\"}\n".utf8))
            try? pipe.fileHandleForWriting.close()
        }

        let started = Date()
        XCTAssertEqual(try reader.next(), "{\"jsonrpc\":\"2.0\"}")
        // Returning far too early would mean it never blocked at all.
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.1)
        XCTAssertNil(try reader.next())
    }
}
