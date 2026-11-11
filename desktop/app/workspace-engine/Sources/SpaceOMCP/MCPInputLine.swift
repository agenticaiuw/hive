import Foundation

/// Keep ordinary JSON requests as bytes. Unicode input retains the existing strict UTF-8
/// conversion and Foundation whitespace semantics, including non-JSON whitespace at the edges.
enum MCPInputLine {
    case ascii(Data)
    case unicode(String)

    init?(data: Data) {
        if Self.isASCII(data) {
            self = .ascii(data)
        } else if let text = String(data: data, encoding: .utf8) {
            self = .unicode(text)
        } else {
            return nil
        }
    }

    /// nil means an ignored blank line, not JSON null (which is represented by NSNull).
    func jsonObject() throws -> Any? {
        switch self {
        case .ascii(let data):
            // These are exactly CharacterSet.whitespaces' ASCII members. Leave CR and other
            // controls to JSON parsing, preserving the old behavior for nonempty lines.
            var start = data.startIndex
            var end = data.endIndex
            while start < end, data[start] == 9 || data[start] == 32 { start += 1 }
            while start < end, data[end - 1] == 9 || data[end - 1] == 32 { end -= 1 }
            guard start < end else { return nil }
            return try JSONSerialization.jsonObject(with: data[start..<end])
        case .unicode(let text):
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            return try JSONSerialization.jsonObject(with: Data(trimmed.utf8))
        }
    }

    static func isASCII(_ data: Data) -> Bool {
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var offset = 0
            // Unaligned reads stay wholly inside the supplied slice, including short tails.
            while offset <= bytes.count - 32 {
                let value = bytes.loadUnaligned(fromByteOffset: offset, as: SIMD32<UInt8>.self)
                guard all(value .< SIMD32(repeating: 128)) else { return false }
                offset += 32
            }
            return bytes[offset...].allSatisfy { $0 < 128 }
        }
    }
}
