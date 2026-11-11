import AppKit
import CoreGraphics
import ImageIO
import Foundation
import UniformTypeIdentifiers

let args = CommandLine.arguments
if args.count != 2 { fputs("Usage: swift generate-hive-icons.swift output-directory\n", stderr); exit(2) }
let output = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
func image(_ size: Int) throws -> CGImage {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw NSError(domain:"HiveIcon", code:1) }
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setFillColor(CGColor(red: 23/255, green: 23/255, blue: 25/255, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    context.setFillColor(CGColor(red: 245/255, green: 200/255, blue: 66/255, alpha: 1))
    context.beginPath(); context.move(to: CGPoint(x: 512, y: 152))
    for point in [CGPoint(x:824,y:332), CGPoint(x:824,y:692), CGPoint(x:512,y:872), CGPoint(x:200,y:692), CGPoint(x:200,y:332)] { context.addLine(to: point) }
    context.closePath(); context.fillPath()
    guard let image = context.makeImage() else { throw NSError(domain:"HiveIcon", code:2) }
    return image
}
func writePNG(_ size: Int, _ path: URL) throws {
    guard let dest = CGImageDestinationCreateWithURL(path as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw NSError(domain:"HiveIcon", code:3) }
    CGImageDestinationAddImage(dest, try image(size), nil)
    guard CGImageDestinationFinalize(dest) else { throw NSError(domain:"HiveIcon", code:4) }
}
try writePNG(1024, output.appendingPathComponent("Hive-1024.png"))
let iconset = output.appendingPathComponent("Hive.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16.png",16),("icon_16x16@2x.png",32),("icon_32x32.png",32),("icon_32x32@2x.png",64),("icon_128x128.png",128),("icon_128x128@2x.png",256),("icon_256x256.png",256),("icon_256x256@2x.png",512),("icon_512x512.png",512),("icon_512x512@2x.png",1024)] { try writePNG(size, iconset.appendingPathComponent(name)) }
let extensionIcons = output.appendingPathComponent("extension", isDirectory: true)
try FileManager.default.createDirectory(at: extensionIcons, withIntermediateDirectories: true)
for size in [16, 32, 48, 128, 512] { try writePNG(size, extensionIcons.appendingPathComponent("icon-\(size).png")) }
