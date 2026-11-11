import Foundation
import XCTest
@testable import SpaceOKit

final class WireEncodingTests: XCTestCase {
    /// A regular file cannot block on pipe capacity if a size-limit regression emits too much.
    private func writtenFrame(_ response: Response) throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        XCTAssertTrue(Transport.writeLine(response, to: handle.fileDescriptor))
        return try Data(contentsOf: url)
    }

    func testMaximumSlashHeavyImageFitsResponseFrameAndRoundTrips() throws {
        // Synthetic transport data, not a renderable PNG or captured user content.
        let image = (Data([137, 80, 78, 71, 13, 10, 26, 10])
            + Data(repeating: 255, count: Capture.maximumInMemoryPNGBytes - 8)).base64EncodedString()
        var response = Response(ok: true)
        response.imageBase64 = image
        let encoded = try Wire.encoder.encode(response)
        XCTAssertLessThan(encoded.count, 8 * 1_048_576)
        XCTAssertEqual(try Wire.decoder.decode(Response.self, from: encoded).imageBase64, image)

        // Exercise the real framing writer without sockets or a slow-reader timing fixture.
        let frame = try writtenFrame(response)
        XCTAssertEqual(frame.last, 10)
        XCTAssertEqual(frame.count, encoded.count + 1)
        let received = try Wire.decoder.decode(Response.self, from: frame.dropLast())
        XCTAssertTrue(received.ok, "a valid-sized image must not become the oversize fallback")
        XCTAssertEqual(received.imageBase64, image)
    }

    func testOversizedResponseStillUsesStructuredFailure() throws {
        var response = Response(ok: true)
        response.message = String(repeating: "/", count: 8 * 1_048_576)
        let data = try writtenFrame(response)
        XCTAssertEqual(data.last, 10)
        let received = try Wire.decoder.decode(Response.self, from: data.dropLast())
        XCTAssertFalse(received.ok)
        XCTAssertTrue(received.error?.contains("response exceeds the 8 MiB wire limit") == true)
        XCTAssertNil(received.message)
    }

    func testJSONEscapesFramingCharactersAndPreservesRequestValues() throws {
        let text = "https://example.invalid/a/b?x=1\n\r\t\0\"\\é😀</script>"
        var request = Request(cmd: "type")
        request.text = text
        let data = try Wire.encoder.encode(request)
        XCTAssertFalse(data.contains(10), "embedded newlines must never terminate a frame")
        XCTAssertFalse(data.contains(13))
        XCTAssertFalse(data.contains(0))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["text"] as? String, text)
        XCTAssertEqual(try Wire.decoder.decode(Request.self, from: data).text, text)

        // Older clients/daemons may still send escaped slashes; decoding stays compatible.
        let legacy = Data(#"{"cmd":"type","text":"https:\/\/example.invalid\/a"}"#.utf8)
        XCTAssertEqual(try Wire.decoder.decode(Request.self, from: legacy).text,
                       "https://example.invalid/a")
    }
}
