import XCTest
import CoreGraphics
@testable import SpaceOKit

/// SPAO-213: set-of-marks tags are pure geometry plus offscreen drawing.
final class CaptureAnnotationTests: XCTestCase {

    private func node(_ index: Int?, frame: CGRect?) -> AXNode {
        AXNode(index: index, role: "AXButton", label: "b\(index ?? -1)", frame: frame,
               actions: ["AXPress"], depth: 1, enabled: true)
    }

    func testTagsConvertGlobalPointsToImagePixelsAndClip() {
        let nodes = [
            node(1, frame: CGRect(x: 110, y: 220, width: 50, height: 30)),
            node(nil, frame: CGRect(x: 110, y: 220, width: 50, height: 30)),
            node(2, frame: nil),
            node(3, frame: CGRect(x: 0, y: 0, width: 10, height: 10)),
            node(4, frame: CGRect(x: 290, y: 340, width: 50, height: 30)),
            node(1, frame: CGRect(x: 120, y: 230, width: 5, height: 5)),
        ]
        let result = CaptureAnnotation.tags(
            from: nodes, windowOrigin: CGPoint(x: 100, y: 200), scale: 2,
            imageSize: CGSize(width: 400, height: 300))

        XCTAssertFalse(result.partial)
        XCTAssertEqual(result.tags.map(\.index), [1, 4])
        XCTAssertEqual(result.tags[0].frame, CGRect(x: 20, y: 40, width: 100, height: 60))
        XCTAssertEqual(result.tags[1].frame, CGRect(x: 380, y: 280, width: 20, height: 20))
    }

    func testTagsRejectInvalidGeometry() {
        let nodes = [node(1, frame: CGRect(x: 0, y: 0, width: 10, height: 10))]
        XCTAssertTrue(CaptureAnnotation.tags(from: nodes, windowOrigin: .zero, scale: 0,
                                             imageSize: CGSize(width: 10, height: 10)).tags.isEmpty)
        XCTAssertTrue(CaptureAnnotation.tags(from: nodes, windowOrigin: .zero, scale: 1,
                                             imageSize: .zero).tags.isEmpty)
    }

    func testTagsAreCappedAndReportPartial() {
        let nodes = (0..<250).map { index in
            node(index, frame: CGRect(x: Double(index % 20) * 10, y: Double(index / 20) * 10,
                                      width: 8, height: 8))
        }
        let result = CaptureAnnotation.tags(
            from: nodes, windowOrigin: .zero, scale: 1,
            imageSize: CGSize(width: 400, height: 300))
        XCTAssertTrue(result.partial)
        XCTAssertEqual(result.tags.count, CaptureAnnotation.maximumTags)
        XCTAssertEqual(result.tags.first?.index, 0)
        XCTAssertEqual(result.tags.last?.index, CaptureAnnotation.maximumTags - 1)
    }

    func testAnnotateDrawsAtTagAndLeavesFarPixelUntouched() throws {
        let image = try whiteImage(width: 200, height: 100)
        let tag = AnnotationTag(index: 7, frame: CGRect(x: 20, y: 10, width: 60, height: 40))
        let annotated = try CaptureAnnotation.annotate(image, tags: [tag])

        XCTAssertEqual(annotated.width, 200)
        XCTAssertEqual(annotated.height, 100)

        let badgePixel = try pixel(annotated, x: 22, y: 12)
        XCTAssertNotEqual(badgePixel, [255, 255, 255, 255], "badge must change the tag corner")
        let outlinePixel = try pixel(annotated, x: 50, y: 49)
        XCTAssertNotEqual(outlinePixel, [255, 255, 255, 255], "frame outline must be drawn")
        let farPixel = try pixel(annotated, x: 150, y: 80)
        XCTAssertEqual(farPixel, [255, 255, 255, 255], "pixels away from tags stay untouched")

        // The source image is never modified.
        XCTAssertEqual(try pixel(image, x: 22, y: 12), [255, 255, 255, 255])
    }

    func testAnnotateRefusesTooManyTags() throws {
        let image = try whiteImage(width: 10, height: 10)
        let tags = (0...CaptureAnnotation.maximumTags).map {
            AnnotationTag(index: $0, frame: CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        XCTAssertThrowsError(try CaptureAnnotation.annotate(image, tags: tags)) { error in
            guard case SpaceOError.captureFailed = error else {
                return XCTFail("expected captureFailed, got \(error)")
            }
        }
    }

    func testEmptyAnnotationsReuseTheOriginalBitmap() throws {
        let image = try whiteImage(width: 64, height: 64)
        let unchanged = try CaptureAnnotation.annotate(image, tags: [])
        XCTAssertTrue(unchanged === image, "zero marks must not allocate/copy a full bitmap")
    }

    func testLegendText() {
        let tags = (0..<37).map { AnnotationTag(index: $0, frame: .zero) }
        XCTAssertEqual(CaptureAnnotation.legend(tags, partial: false),
                       "annotated 37 element(s); tags match spaceo_read_screen indices")
        let partial = CaptureAnnotation.legend(tags, partial: true)
        XCTAssertTrue(partial.hasPrefix("annotated 37 element(s); tags match spaceo_read_screen indices;"))
        XCTAssertTrue(partial.contains("first 200"))
    }

    // MARK: - Helpers

    private func whiteImage(width: Int, height: Int) throws -> CGImage {
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw XCTSkip("could not allocate bitmap") }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { throw XCTSkip("could not make image") }
        return image
    }

    /// RGBA at a top-left-origin pixel coordinate.
    private func pixel(_ image: CGImage, x: Int, y: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                | CGBitmapInfo.byteOrder32Big.rawValue
        ) else { throw XCTSkip("could not allocate probe bitmap") }
        context.interpolationQuality = .none
        // Draw the image so that (x, y) lands on the single probe pixel.
        let originY = -(image.height - 1 - y)
        context.draw(image, in: CGRect(x: -x, y: originY, width: image.width, height: image.height))
        return bytes
    }
}
