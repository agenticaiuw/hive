// Live-only positive control: captures only the explicitly supplied agent display region.
import Foundation
import ScreenCaptureKit
import ImageIO
import CoreGraphics

func markerPixels(_ image: CGImage) throws -> Int {
    let width = image.width, height = image.height
    guard width > 0, height > 0, width <= 8192, height <= 8192 else {
        throw NSError(domain: "Marker", code: 1)
    }
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let count = pixels.withUnsafeMutableBytes { bytes -> Int in
        guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return -1 }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: bytes.count, by: 4).reduce(0) { count, i in
            count + (bytes[i] > 120 && bytes[i + 1] < 40 && bytes[i + 2] > 120 ? 1 : 0)
        }
    }
    guard count >= 0 else { throw NSError(domain: "Marker", code: 2) }
    return count
}

@main struct CaptureMarker {
    static func main() async throws {
        let args = CommandLine.arguments
        if args.count == 3, args[1] == "count" {
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw NSError(domain: "Invalid PNG", code: 5)
            }
            print(try markerPixels(image))
            return
        }
        guard args.count == 8, let displayID = UInt32(args[1]), let pid = Int32(args[6]), pid > 0,
              let x = Double(args[2]), let y = Double(args[3]),
              let width = Double(args[4]), let height = Double(args[5]),
              [x, y, width, height].allSatisfy({ $0.isFinite }), x >= 0, y >= 0,
              width > 0, height > 0, width <= 8192, height <= 8192 else {
            throw NSError(domain: "Expected agent-display-id x y width height fixture-pid output.png", code: 6)
        }
        let region = CGRect(x: x, y: y, width: width, height: height)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }),
              CGRect(origin: .zero, size: display.frame.size).contains(region) else {
            throw NSError(domain: "Display unavailable or region out of bounds", code: 7)
        }
        let globalRegion = region.offsetBy(dx: display.frame.minX, dy: display.frame.minY)
        let foreign = content.windows.filter { $0.owningApplication?.processID == pid }
        let overlap = foreign.map { $0.frame.intersection(globalRegion) }
            .filter { !$0.isNull }.reduce(0.0) { $0 + $1.width * $1.height }
        guard overlap > 0 else { throw NSError(domain: "No actual foreign-window overlap", code: 3) }
        let config = SCStreamConfiguration()
        config.width = Int(region.width); config.height = Int(region.height)
        config.sourceRect = region; config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
        guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[7]) as CFURL,
            "public.png" as CFString, 1, nil) else { throw NSError(domain: "PNG destination", code: 8) }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "PNG write", code: 4) }
        let report: [String: Any] = ["markerPixels": try markerPixels(image), "overlapArea": overlap,
            "foreignWindowIDs": foreign.map(\.windowID)]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: .sortedKeys), as: UTF8.self))
    }
}
