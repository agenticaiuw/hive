// Generates AppIcon.icns for the AI Pendant companion app.
// Usage: xcrun swift Tools/make-icon.swift <output-path/AppIcon.icns>
// Draws a 1024x1024 dark rounded-square gradient tile with a white
// "waveform.circle.fill" SF Symbol glyph, emits the .iconset PNG sizes,
// and assembles the .icns with iconutil.

import AppKit

guard CommandLine.arguments.count == 2 else {
    fputs("usage: swift make-icon.swift <output.icns>\n", stderr)
    exit(1)
}
let outURL = URL(fileURLWithPath: CommandLine.arguments[1])

func bitmap(_ px: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    return rep
}

// Master 1024x1024 artwork.
let masterRep = bitmap(1024)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: masterRep)

// macOS icon grid: 824x824 rounded square centered on a 1024 canvas.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.22, green: 0.25, blue: 0.42, alpha: 1.0), // slate top
    NSColor(calibratedRed: 0.05, green: 0.06, blue: 0.12, alpha: 1.0), // near-black bottom
])!
gradient.draw(in: tilePath, angle: -90)

// White pendant glyph.
let glyphConfig = NSImage.SymbolConfiguration(pointSize: 470, weight: .medium)
    .applying(.init(paletteColors: [.white]))
if let glyph = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: nil)?
    .withSymbolConfiguration(glyphConfig) {
    let side: CGFloat = 560
    glyph.draw(in: NSRect(x: (1024 - side) / 2, y: (1024 - side) / 2, width: side, height: side),
               from: .zero, operation: .sourceOver, fraction: 1.0)
} else {
    fputs("warning: SF Symbol unavailable, icon will be background only\n", stderr)
}
NSGraphicsContext.restoreGraphicsState()

let master = NSImage(size: NSSize(width: 1024, height: 1024))
master.addRepresentation(masterRep)

// Emit the iconset.
let fm = FileManager.default
let iconsetDir = outURL.deletingLastPathComponent().appendingPathComponent("AppIcon.iconset")
try? fm.removeItem(at: iconsetDir)
try! fm.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

let entries: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in entries {
    let rep = bitmap(px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    master.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    let png = rep.representation(using: .png, properties: [:])!
    try! png.write(to: iconsetDir.appendingPathComponent("\(name).png"))
}

// Assemble the .icns.
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconsetDir.path, "-o", outURL.path]
try! iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    fputs("iconutil failed (status \(iconutil.terminationStatus))\n", stderr)
    exit(1)
}
try? fm.removeItem(at: iconsetDir)
print("Wrote \(outURL.path)")
