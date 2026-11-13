// Draws Hive's icon (branding/hive.svg at the repository's root, the only copy) at the sizes
// each place needs. AppKit draws SVG itself.
//
//   hive-icon <svg> icns <out.icns>                 the Mac app's icon, through iconutil
//   hive-icon <svg> png <size> <out.png> [opaque]   one square PNG; `opaque` drops the alpha
//                                                   channel, as iOS app icons need
// mobile/tools/sync-icons.mjs uses it for every other place that shows the icon.
import AppKit
import ImageIO
import UniformTypeIdentifiers

func fail(_ said: String) -> Never {
    FileHandle.standardError.write((said + "\n").data(using: .utf8)!)
    exit(1)
}

func png(_ image: NSImage, _ size: Int) -> Data {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)
    else { fail("hive-icon: no bitmap for \(size) px") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else { fail("hive-icon: no PNG") }
    return data
}

/// The same picture with no alpha channel (anything see-through comes out black).
func opaquePNG(_ image: NSImage, _ size: Int) -> Data {
    guard let drawn = NSBitmapImageRep(data: png(image, size))?.cgImage,
          let context = CGContext(
            data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { fail("hive-icon: no opaque bitmap for \(size) px") }
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    context.draw(drawn, in: CGRect(x: 0, y: 0, width: size, height: size))
    let data = NSMutableData()
    guard let flat = context.makeImage(),
          let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
    else { fail("hive-icon: no opaque PNG") }
    CGImageDestinationAddImage(dest, flat, nil)
    guard CGImageDestinationFinalize(dest) else { fail("hive-icon: no opaque PNG") }
    return data as Data
}

let usage = "usage: hive-icon <svg> icns <out.icns> | hive-icon <svg> png <size> <out.png> [opaque]"
let args = CommandLine.arguments
guard args.count >= 4 else { fail(usage) }
guard let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])), image.isValid else {
    fail("hive-icon: can't read \(args[1])")
}

switch (args[2], args.count) {
case ("png", 5), ("png", 6):
    guard let size = Int(args[3]), size > 0 else { fail(usage) }
    let opaque = args.count == 6
    guard !opaque || args[5] == "opaque" else { fail(usage) }
    try (opaque ? opaquePNG(image, size) : png(image, size)).write(to: URL(fileURLWithPath: args[4]))
case ("icns", 4):
    let fm = FileManager.default
    let iconset = fm.temporaryDirectory.appendingPathComponent("hive-icon-\(getpid()).iconset")
    try? fm.removeItem(at: iconset)
    try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: iconset) }
    for points in [16, 32, 128, 256, 512] {
        try png(image, points).write(to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
        try png(image, points * 2).write(to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
    }
    let iconutil = Process()
    iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    iconutil.arguments = ["-c", "icns", iconset.path, "-o", args[3]]
    try iconutil.run()
    iconutil.waitUntilExit()
    guard iconutil.terminationStatus == 0 else { fail("hive-icon: iconutil failed") }
default:
    fail(usage)
}
