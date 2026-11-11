import Foundation
import CoreGraphics
import CoreText

/// One numbered mark drawn onto a screenshot. `frame` is in image-pixel space, so a tag can be
/// drawn without knowing the window origin or the capture scale that produced the image.
public struct AnnotationTag: Equatable, Sendable {
    /// The same index `spaceo_read_screen` reports, so a mark on the image and an
    /// `--element` argument name the same control.
    public var index: Int
    public var frame: CGRect

    public init(index: Int, frame: CGRect) {
        self.index = index
        self.frame = frame
    }
}

/// Set-of-marks annotation for screenshots (SPAO-213).
///
/// Agents that reason over pixels lose the link between what they see and the indexed
/// Accessibility elements they should press. Drawing the read-screen indices onto the capture
/// restores that link without a second round trip. Everything here is pure CoreGraphics on an
/// offscreen bitmap: nothing is drawn on any display, and no window or process is touched.
public enum CaptureAnnotation {
    /// More marks than this stop being legible and start hiding the content they annotate.
    public static let maximumTags = 200

    /// Offscreen bitmaps are allocated in this process; refuse to double a capture that is
    /// already unreasonably large instead of trapping on allocation.
    public static let maximumPixelCount = 64 * 1_024 * 1_024

    /// Badge geometry in image pixels. Kept small so the badge covers the control's corner, not
    /// its label.
    static let badgeHeight: CGFloat = 14
    static let badgeMinimumWidth: CGFloat = 16
    static let badgeCornerRadius: CGFloat = 3
    static let fontSize: CGFloat = 11

    /// Convert actionable nodes into image-space tags.
    ///
    /// Node frames are global points. The capture the tags will be drawn onto starts at
    /// `windowOrigin` and was scaled by `scale`, so pixel = (point - origin) * scale. Frames that
    /// fall outside the image are clipped away, duplicate indices keep their first frame, and the
    /// result is capped at `maximumTags` with `partial` set so callers can say so.
    public static func tags(from nodes: [AXNode],
                            windowOrigin: CGPoint,
                            scale: Double,
                            imageSize: CGSize) -> (tags: [AnnotationTag], partial: Bool) {
        guard scale.isFinite, scale > 0,
              imageSize.width.isFinite, imageSize.height.isFinite,
              imageSize.width >= 1, imageSize.height >= 1,
              windowOrigin.x.isFinite, windowOrigin.y.isFinite else {
            return ([], false)
        }
        let bounds = CGRect(origin: .zero, size: imageSize)
        var seen = Set<Int>()
        var tags: [AnnotationTag] = []
        for node in nodes {
            guard let index = node.index, let frame = node.frame else { continue }
            guard !seen.contains(index) else { continue }
            guard frame.origin.x.isFinite, frame.origin.y.isFinite,
                  frame.width.isFinite, frame.height.isFinite else { continue }
            let pixelFrame = CGRect(
                x: (frame.origin.x - windowOrigin.x) * scale,
                y: (frame.origin.y - windowOrigin.y) * scale,
                width: frame.width * scale,
                height: frame.height * scale)
            let clipped = pixelFrame.intersection(bounds)
            guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { continue }
            seen.insert(index)
            tags.append(AnnotationTag(index: index, frame: clipped))
        }
        tags.sort { $0.index < $1.index }
        let partial = tags.count > maximumTags
        if partial {
            tags.removeSubrange(maximumTags...)
        }
        return (tags, partial)
    }

    public static func annotate(_ image: CGImage, tags: [AnnotationTag]) throws -> CGImage {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else {
            throw SpaceOError.captureFailed("cannot annotate an empty image")
        }
        guard width <= maximumPixelCount, height <= maximumPixelCount,
              width * height <= maximumPixelCount else {
            throw SpaceOError.captureFailed(
                "image of \(width)x\(height) pixels exceeds the \(maximumPixelCount)-pixel annotation bound")
        }
        guard tags.count <= maximumTags else {
            throw SpaceOError.captureFailed(
                "\(tags.count) tags exceed the \(maximumTags)-tag annotation bound")
        }

        guard !tags.isEmpty else { return image }

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                | CGBitmapInfo.byteOrder32Big.rawValue
        ) else {
            throw SpaceOError.captureFailed("could not allocate the annotation bitmap")
        }

        let canvas = CGRect(x: 0, y: 0, width: width, height: height)
        context.interpolationQuality = .none
        context.draw(image, in: canvas)

        // Tags arrive in top-left image coordinates; CoreGraphics bitmaps are bottom-left.
        // Flipping the CTM once keeps the drawing code in image coordinates; text is drawn with a
        // local un-flip so glyphs are not mirrored.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)

        let outline = CGColor(srgbRed: 1.0, green: 0.35, blue: 0.0, alpha: 0.95)
        let badge = CGColor(srgbRed: 0.85, green: 0.15, blue: 0.05, alpha: 1.0)
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, fontSize, nil)
        let textColor = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

        for tag in tags {
            let frame = tag.frame.intersection(canvas)
            guard !frame.isNull, frame.width > 0, frame.height > 0 else { continue }

            context.setStrokeColor(outline)
            context.setLineWidth(1)
            context.stroke(frame.insetBy(dx: 0.5, dy: 0.5))

            let line = CTLineCreateWithAttributedString(NSAttributedString(
                string: String(tag.index),
                attributes: [
                    NSAttributedString.Key(kCTFontAttributeName as String): font,
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): textColor,
                ]))
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            let textWidth = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
            let badgeWidth = max(badgeMinimumWidth, ceil(textWidth) + 6)

            var badgeRect = CGRect(x: frame.minX, y: frame.minY,
                                   width: badgeWidth, height: badgeHeight)
            badgeRect.origin.x = max(0, min(badgeRect.origin.x, canvas.maxX - badgeWidth))
            badgeRect.origin.y = max(0, min(badgeRect.origin.y, canvas.maxY - badgeHeight))

            context.setFillColor(badge)
            context.addPath(CGPath(roundedRect: badgeRect,
                                   cornerWidth: badgeCornerRadius,
                                   cornerHeight: badgeCornerRadius,
                                   transform: nil))
            context.fillPath()

            context.saveGState()
            // Un-flip locally around the baseline so CoreText renders upright glyphs.
            let baselineY = badgeRect.minY + (badgeHeight + ascent - descent) / 2
            context.translateBy(x: 0, y: baselineY)
            context.scaleBy(x: 1, y: -1)
            context.textPosition = CGPoint(
                x: badgeRect.minX + (badgeWidth - textWidth) / 2, y: 0)
            CTLineDraw(line, context)
            context.restoreGState()
        }

        guard let result = context.makeImage() else {
            throw SpaceOError.captureFailed("could not finalize the annotated image")
        }
        return result
    }

    /// Text that accompanies an annotated capture so the agent knows what the numbers mean and
    /// whether every element received one.
    public static func legend(_ tags: [AnnotationTag], partial: Bool) -> String {
        var text = "annotated \(tags.count) element(s); tags match spaceo_read_screen indices"
        if partial {
            text += "; only the first \(maximumTags) elements are tagged, "
                + "use spaceo_read_screen for the rest"
        }
        return text
    }
}
