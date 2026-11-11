import CoreGraphics
import CryptoKit
import Foundation

extension Capture {
    /// Fingerprint the full pixel payload and its layout, ignoring row padding.
    /// Returns zero for unreadable images for source compatibility. Stability waits use the
    /// throwing variant so unreadable frames never count as evidence of stability.
    public static func frameHash(_ image: CGImage) -> UInt64 {
        (try? validatedFrameHash(image)) ?? 0
    }

    static func validatedFrameHash(_ image: CGImage) throws -> UInt64 {
        let trace = PerformanceTrace.signposter.beginInterval("Capture.Hash", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Capture.Hash", trace) }
        guard let data = image.dataProvider?.data,
              let base = CFDataGetBytePtr(data) else {
            throw SpaceOError.captureFailed("frame pixels are unavailable")
        }
        defer { withExtendedLifetime(data) {} }
        let rowBytes = try frameRowByteCount(width: image.width, height: image.height,
                                            bitsPerPixel: image.bitsPerPixel, bytesPerRow: image.bytesPerRow,
                                            availableBytes: CFDataGetLength(data))

        var hash = SHA256()
        // Keep differently shaped/formatted buffers distinct even when their bytes match.
        let layout = [image.width, image.height, image.bitsPerComponent, image.bitsPerPixel,
                      Int(image.bitmapInfo.rawValue), Int(image.renderingIntent.rawValue)]
        layout.withUnsafeBytes { hash.update(bufferPointer: $0) }
        hash.update(data: Data((image.colorSpace?.name as String? ?? "").utf8))
        // The provider may materialize its data. Do not allocate a second full-frame bitmap
        // or Data copy; feed row views directly to the accelerated hash implementation.
        if image.bytesPerRow == rowBytes {
            hash.update(bufferPointer: UnsafeRawBufferPointer(start: base, count: rowBytes * image.height))
        } else {
            for row in 0..<image.height {
                hash.update(bufferPointer: UnsafeRawBufferPointer(
                    start: base.advanced(by: row * image.bytesPerRow), count: rowBytes))
            }
        }
        return hash.finalize().prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }

    /// Check every offset calculation before constructing unsafe row views.
    static func frameRowByteCount(width: Int, height: Int, bitsPerPixel: Int,
                                 bytesPerRow: Int, availableBytes: Int) throws -> Int {
        guard width > 0, height > 0, bitsPerPixel > 0, bytesPerRow > 0, availableBytes > 0 else {
            throw SpaceOError.captureFailed("frame pixels have an invalid layout")
        }
        let (rowBits, bitsOverflow) = width.multipliedReportingOverflow(by: bitsPerPixel)
        let (roundedBits, roundingOverflow) = rowBits.addingReportingOverflow(7)
        let rowBytes = roundedBits / 8
        let (lastRow, strideOverflow) = (height - 1).multipliedReportingOverflow(by: bytesPerRow)
        let (requiredBytes, lengthOverflow) = lastRow.addingReportingOverflow(rowBytes)
        guard !bitsOverflow, !roundingOverflow, !strideOverflow, !lengthOverflow,
              rowBytes > 0, rowBytes <= bytesPerRow, availableBytes >= requiredBytes else {
            throw SpaceOError.captureFailed("frame pixel buffer is incomplete or has an invalid layout")
        }
        return rowBytes
    }
}
