// Draws Hive's icon (branding/hive.svg at the repository's root, the only copy) at the sizes
// each place needs. AppKit draws SVG itself.
//
//   hive-icon <svg> icns <out.icns>        the Mac app's icon, through iconutil
//   hive-icon <svg> png <size> <out.png>   one square PNG (the Chrome extension's icons)
import AppKit

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

let usage = "usage: hive-icon <svg> icns <out.icns> | hive-icon <svg> png <size> <out.png>"
let args = CommandLine.arguments
guard args.count >= 4 else { fail(usage) }
guard let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])), image.isValid else {
    fail("hive-icon: can't read \(args[1])")
}

switch (args[2], args.count) {
case ("png", 5):
    guard let size = Int(args[3]), size > 0 else { fail(usage) }
    try png(image, size).write(to: URL(fileURLWithPath: args[4]))
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
