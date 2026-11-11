import AppKit
import SwiftUI

/// The canonical product mark bundled by `make-viewer-app.sh` and derived from the same source
/// as the app icon and README artwork.
struct SpaceOBrandMark: View {
    var body: some View {
        Image(nsImage: Self.image)
            .resizable()
            .scaledToFit()
            .accessibilityHidden(true)
    }

    /// An 18-point template rendering of `Assets/Brand/spaceo-menubar.svg` for the menu bar
    /// extra, so it follows the bar's tint. Drawn as vector paths rather than loaded from the
    /// SVG so it stays sharp at every backing scale on every supported macOS.
    static let menuBarImage: NSImage = {
        let target = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
            drawMenuBarMark(in: rect)
            return true
        }
        target.isTemplate = true
        target.accessibilityDescription = "SpaceO"
        return target
    }()

    /// Three tilted rings, each thick on the left and thin on the right like the lit edge of
    /// the glass logo. Geometry is in the SVG's 18×18, y-down space; keep the two in step.
    private static func drawMenuBarMark(in rect: NSRect) {
        // (x, y, width, corner radius, stroke thickness, hole shift to the right)
        let rings: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (0.8, 0.8, 16.4, 4.8, 1.05, 0.45),
            (4.4, 3.5, 10.0, 3.1, 1.0, 0.42),
            (7.9, 6.1, 4.3, 1.7, 0.95, 0.35),
        ]
        let path = NSBezierPath()
        path.windingRule = .evenOdd
        for (x, y, width, radius, thickness, shift) in rings {
            path.appendRoundedRect(
                NSRect(x: x, y: y, width: width, height: width),
                xRadius: radius, yRadius: radius)
            let inner = max(radius - thickness, 0.3)
            path.appendRoundedRect(
                NSRect(
                    x: x + thickness + shift, y: y + thickness,
                    width: width - 2 * thickness, height: width - 2 * thickness),
                xRadius: inner, yRadius: inner)
        }

        // The SVG's transform="matrix(0.95 0.075 0 0.93 0.5 -0.3)", then fit to the rect.
        path.transform(using: AffineTransform(m11: 0.95, m12: 0.075, m21: 0, m22: 0.93, tX: 0.5, tY: -0.3))
        path.transform(using: AffineTransform(
            m11: rect.width / 18, m12: 0, m21: 0, m22: rect.height / 18, tX: rect.minX, tY: rect.minY))

        NSColor.black.setFill()
        path.fill()
    }

    /// The app icon first: it has the macOS icon shape with transparent corners, where the logo
    /// PNG is an opaque square that reads as a pale tile on a dark window.
    private static let image: NSImage = {
        if let url = Bundle.main.url(forResource: "SpaceO", withExtension: "icns"),
           let image = NSImage(contentsOf: url) {
            return image
        }

        if let url = Bundle.main.url(forResource: "spaceo-logo", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            return image
        }

        return NSApplication.shared.applicationIconImage
    }()
}
