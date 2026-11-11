import Foundation

/// Diagnostic construction must not amplify malformed request dictionaries or Unicode names.
enum MCPDiagnostic {
    static let maximumNames = 8
    static let maximumNameBytes = 96

    static func unexpected<Keys: Sequence>(_ keys: Keys, allowed: Set<String>) -> String?
        where Keys.Element == String {
        var count = 0
        var names: [String] = []
        for key in keys where !allowed.contains(key) {
            count += 1
            let rendered = name(key)
            if names.count == maximumNames, let last = names.last, rendered >= last { continue }
            if names.isEmpty { names.reserveCapacity(maximumNames) }
            if names.count == maximumNames { names.removeLast() }
            let index = names.firstIndex(where: { rendered < $0 }) ?? names.endIndex
            names.insert(rendered, at: index)
        }
        guard count > 0 else { return nil }
        let omitted = count - names.count
        return "unexpected argument(s): " + names.joined(separator: ", ")
            + (omitted == 0 ? "" : " (and \(omitted) more)")
    }

    static func name(_ value: String) -> String {
        value.isEmpty ? "\"\"" : preview(value, maximumBytes: maximumNameBytes, escapeCommas: true)
    }

    /// Render only a bounded scalar prefix. Do not use Character prefixes: one grapheme may
    /// contain the entire input. The original tool error body is independent of its log preview.
    static func preview(_ value: String, maximumBytes: Int = 600, escapeCommas: Bool = false) -> String {
        guard maximumBytes >= 3 else { return "" }
        if value.utf8.count <= maximumBytes,
           value.utf8.allSatisfy({ $0 >= 32 && $0 < 127 && $0 != 92 && (!escapeCommas || $0 != 44) }) {
            return value
        }
        var result = ""
        var bytes = 0
        for scalar in value.unicodeScalars {
            let piece: String
            switch scalar.value {
            case 10: piece = "\\n"
            case 13: piece = "\\r"
            case 9: piece = "\\t"
            case 92: piece = "\\\\"
            case 44 where escapeCommas: piece = "\\,"
            default:
                switch scalar.properties.generalCategory {
                case .control, .format, .lineSeparator, .paragraphSeparator:
                    piece = String(format: "\\u{%X}", scalar.value)
                default: piece = String(scalar)
                }
            }
            let size = piece.utf8.count
            guard size <= maximumBytes - 3 - bytes else { return result + "..." }
            result += piece
            bytes += size
        }
        return result
    }
}
