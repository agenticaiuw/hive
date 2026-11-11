import Foundation

/// Validate the transport encoding and PNG signature without allocating the whole decoded image.
/// This does not parse PNG chunks or prove that an image decoder can render the payload.
enum PNGBase64 {
    static func isValid(_ value: String, maximumDecodedBytes: Int) -> Bool {
        let (rounded, overflow) = maximumDecodedBytes.addingReportingOverflow(2)
        guard maximumDecodedBytes >= 8, !overflow else { return false }
        let (maximumEncodedBytes, encodedOverflow) = (rounded / 3).multipliedReportingOverflow(by: 4)
        guard !encodedOverflow else { return false }
        let bytes = value.utf8
        let count = bytes.count
        guard count >= 12, count <= maximumEncodedBytes, count % 4 == 0 else { return false }
        let tail = bytes.suffix(2)
        let padding = tail.last == 61 ? (tail.first == 61 ? 2 : 1) : 0
        guard count / 4 * 3 - padding <= maximumDecodedBytes else { return false }
        // Decode at most nine bytes, enough for the entire eight-byte PNG signature.
        guard let prefix = Data(base64Encoded: String(decoding: bytes.prefix(12), as: UTF8.self)),
              prefix.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { return false }
        // '=' is permitted only in the final one or two positions. Foundation's decoder alone
        // accepts some malformed padding, which need not work in downstream image clients.
        return containsOnlyAlphabet(bytes.dropLast(padding))
    }

    static func containsOnlyAlphabet<Bytes: Collection>(_ bytes: Bytes) -> Bool where Bytes.Element == UInt8 {
        bytes.withContiguousStorageIfAvailable { buffer in
            guard let base = buffer.baseAddress else { return buffer.isEmpty }
            var offset = 0
            // The subtraction form cannot overflow; each unaligned load stays inside this
            // buffer, including sliced storage. SIMD32 uses no heap-sized scratch buffer.
            while offset <= buffer.count - 32 {
                let values = UnsafeRawPointer(base.advanced(by: offset)).loadUnaligned(as: SIMD32<UInt8>.self)
                let letters = ((values | SIMD32(repeating: 32)) &- SIMD32(repeating: 97)) .<= SIMD32(repeating: 25)
                let digits = (values &- SIMD32(repeating: 48)) .<= SIMD32(repeating: 9)
                let valid = letters .| digits .| (values .== SIMD32(repeating: 43)) .| (values .== SIMD32(repeating: 47))
                guard all(valid) else { return false }
                offset += 32
            }
            return buffer[offset...].allSatisfy(isAlphabetByte)
        } ?? bytes.allSatisfy(isAlphabetByte)
    }

    private static func isAlphabetByte(_ byte: UInt8) -> Bool {
        ((byte | 32) &- 97) <= 25 || (byte &- 48) <= 9 || byte == 43 || byte == 47
    }
}
