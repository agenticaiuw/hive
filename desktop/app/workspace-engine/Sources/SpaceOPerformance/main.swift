import CoreGraphics
import Foundation
import SpaceOKit

// Synthetic workloads only. No daemon, WindowServer, applications, or user files.
let arguments = Array(CommandLine.arguments.dropFirst())
let workloads = ["settings", "settings-legacy", "hash", "png", "events", "metrics"]
guard arguments.count == 2, workloads.contains(arguments[0]),
      let iterations = Int(arguments[1]), (1...1_000).contains(iterations) else {
    FileHandle.standardError.write(Data("usage: SpaceOPerformance settings|settings-legacy|hash|png|events|metrics ITERATIONS(1...1000)\n".utf8))
    exit(2)
}
let workload = arguments[0]
let directory = FileManager.default.temporaryDirectory.appendingPathComponent("spaceo-perf-" + UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                      attributes: [.posixPermissions: 0o700])
defer { try? FileManager.default.removeItem(at: directory) }
let settings = directory.appendingPathComponent("settings.json")
if workload.hasPrefix("settings") {
    // Sparse, invalid 64 MiB settings file: old behavior materializes it before rejecting.
    FileManager.default.createFile(atPath: settings.path, contents: Data(), attributes: [.posixPermissions: 0o600])
    let file = try FileHandle(forWritingTo: settings)
    try file.truncate(atOffset: 64 * 1_048_576)
    try file.close()
}
let bus = EventBus()
var image: CGImage?
if workload == "hash" || workload == "png" {
    let width = 1920, height = 1080
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
        for i in 0..<bytes.count { bytes[i] = UInt8(truncatingIfNeeded: i &* 31 &+ i / 4096) }
    }
    image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: CGDataProvider(data: pixels as CFData)!, decode: nil,
        shouldInterpolate: false, intent: .defaultIntent)
}
func operation() throws -> UInt64 {
    switch workload {
    case "settings":
        return LoggingSettings.resolve(environment: [:], fileURL: settings).fileExists ? 1 : 0
    case "settings-legacy":
        let data = FileManager.default.contents(atPath: settings.path)
        return data.map { $0.count <= 16_384 ? 1 : 0 } ?? 0
    case "hash": return Capture.frameHash(image!)
    case "png": return UInt64(try Capture.pngData(image!).count)
    case "events":
        for _ in 0..<100 {
            bus.publish(kind: "synthetic", session: nil, detail: ["route": "fixture"])
        }
        return UInt64(bus.replay(since: bus.latestSeq - 100).events.count)
    default: return ProcessMetricsSnapshot.capture().residentBytes
    }
}
// Warm up lazy framework work. Fresh process per workload keeps high-water marks interpretable.
_ = try autoreleasepool { try operation() }
let before = ProcessMetricsSnapshot.capture()
var latencies: [Double] = []
latencies.reserveCapacity(iterations)
var checksum: UInt64 = 0
let start = ContinuousClock.now
for _ in 0..<iterations {
    let began = ContinuousClock.now
    checksum &+= try autoreleasepool { try operation() }
    let elapsed = began.duration(to: .now).components
    latencies.append(Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15)
}
let elapsed = start.duration(to: .now).components
let wall = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
let after = ProcessMetricsSnapshot.capture()
latencies.sort()
func percentile(_ fraction: Double) -> Double {
    latencies[max(0, Int(ceil(Double(iterations) * fraction)) - 1)]
}
let report: [String: Any] = [
    "schemaVersion": 1, "workload": workload, "iterations": iterations,
    "wallMs": wall * 1_000, "p50Ms": percentile(0.5), "p95Ms": percentile(0.95),
    "operationsPerSecond": Double(iterations) / wall,
    "cpuUserMs": (after.userCPUSeconds - before.userCPUSeconds) * 1_000,
    "cpuSystemMs": (after.systemCPUSeconds - before.systemCPUSeconds) * 1_000,
    "rssBytes": after.residentBytes, "physicalFootprintBytes": after.physicalFootprintBytes,
    "peakRSSBytes": after.peakResidentBytes,
    "rssDeltaBytes": Double(after.residentBytes) - Double(before.residentBytes),
    "physicalFootprintDeltaBytes": Double(after.physicalFootprintBytes) - Double(before.physicalFootprintBytes),
    "gpu": "not measured; use Instruments on a live workload",
    "checksum": checksum,
]
let encoded = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data([10]))
