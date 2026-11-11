import Foundation

/// Locate the registration table without reserializing unrelated TOML. This is a boundary
/// scanner, not a complete TOML validator: strings, comments and nested arrays cannot supply
/// table headers, and ambiguous/unfinished boundaries are refused before rewriting anything.
enum TOMLTableScanner {
    private static let target = ["mcp_servers", "spaceo"]

    /// Only assignments outside multiline values are configuration keys. Doctor must not
    /// probe an executable named by a line of example text inside a registration's string.
    static func assignments(lines: ArraySlice<String>) throws -> [(key: [String], value: String)] {
        var state = ValueState()
        var result: [(key: [String], value: String)] = []
        for line in lines {
            let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if state.atBoundary, !text.isEmpty, !text.hasPrefix("#") {
                var parser = KeyParser(text)
                let key = try parser.path(endingAt: "=")
                guard parser.take("=") else { throw invalid("expected a key/value assignment") }
                let value = String(String.UnicodeScalarView(parser.scalars[parser.index...]))
                    .trimmingCharacters(in: .whitespaces)
                result.append((key, value))
            }
            try state.consume(line)
        }
        guard state.atBoundary else { throw invalid("unfinished registration value") }
        return result
    }

    static func spaceOTableRange(lines: [String]) throws -> Range<Int>? {
        var state = ValueState()
        var table: [String] = []
        var start: Int?
        var end: Int?
        for (lineNumber, line) in lines.enumerated() {
            let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if state.atBoundary, text.hasPrefix("[") {
                var parser = KeyParser(text)
                parser.index += 1
                let array = parser.take("[")
                let path = try parser.path(endingAt: "]")
                guard parser.take("]"), !array || parser.take("]"), parser.atCommentOrEnd else {
                    throw invalid("invalid table header")
                }
                if start != nil, end == nil { end = lineNumber }
                if path == target {
                    guard !array, start == nil else {
                        throw invalid("spaceo must have one ordinary table, not duplicate or array tables")
                    }
                    start = lineNumber
                }
                table = path
                continue
            }
            if state.atBoundary, !text.isEmpty, !text.hasPrefix("#") {
                var parser = KeyParser(text)
                let key = try parser.path(endingAt: "=")
                guard parser.take("=") else { throw invalid("expected a key/value assignment") }
                let fullKey = table + key
                if !table.starts(with: target),
                   fullKey == ["mcp_servers"] || fullKey.starts(with: target) {
                    throw invalid("inline or dotted spaceo registration cannot be safely rewritten; use [mcp_servers.spaceo]")
                }
            }
            try state.consume(line)
        }
        guard state.atBoundary else { throw invalid("unfinished string, array, or inline table") }
        guard let start else { return nil }
        var boundary = end ?? lines.count
        while boundary > start + 1 {
            let text = lines[boundary - 1].trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.isEmpty || text.hasPrefix("#") else { break }
            boundary -= 1
        }
        return start..<boundary
    }

    private static func invalid(_ reason: String) -> MCPClientConfigError {
        .malformedTOML(reason)
    }

    private struct ValueState {
        var quote: UInt8?
        var multiline = false
        var containers: [UInt8] = []
        var atBoundary: Bool { quote == nil && containers.isEmpty }

        mutating func consume(_ line: String) throws {
            let bytes = Array(line.utf8)
            var index = 0
            while index < bytes.count {
                let byte = bytes[index]
                if let quote {
                    if quote == 34, byte == 92 { index += 2; continue }
                    if byte == quote {
                        if multiline {
                            var end = index
                            while end < bytes.count, bytes[end] == quote { end += 1 }
                            if end - index >= 3 {
                                guard end - index <= 5 else { throw invalid("invalid multiline string delimiter") }
                                self.quote = nil
                                multiline = false
                            }
                            index = end
                            continue
                        }
                        self.quote = nil
                    }
                } else {
                    if byte == 35 { break }
                    if byte == 34 || byte == 39 {
                        quote = byte
                        multiline = index + 2 < bytes.count && bytes[index + 1] == byte && bytes[index + 2] == byte
                        if multiline { index += 2 }
                    } else if byte == 91 || byte == 123 {
                        containers.append(byte)
                    } else if byte == 93 || byte == 125 {
                        guard containers.popLast() == (byte == 93 ? 91 : 123) else {
                            throw invalid("unbalanced array or inline table")
                        }
                    }
                }
                index += 1
            }
            if quote != nil, !multiline { throw invalid("unterminated single-line string") }
        }
    }

    private struct KeyParser {
        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ text: String) { scalars = Array(text.unicodeScalars) }

        mutating func whitespace() {
            while index < scalars.count, scalars[index] == " " || scalars[index] == "\t" { index += 1 }
        }

        mutating func take(_ scalar: Unicode.Scalar) -> Bool {
            whitespace()
            guard index < scalars.count, scalars[index] == scalar else { return false }
            index += 1
            return true
        }

        var atCommentOrEnd: Bool {
            mutating get {
                whitespace()
                return index == scalars.count || scalars[index] == "#"
            }
        }

        mutating func path(endingAt end: Unicode.Scalar) throws -> [String] {
            var result: [String] = []
            while true {
                whitespace()
                guard index < scalars.count else { throw invalid("unfinished key") }
                let first = scalars[index]
                if first == "\"" || first == "'" {
                    result.append(try quoted())
                } else {
                    let start = index
                    while index < scalars.count, Self.isBare(scalars[index]) { index += 1 }
                    guard index > start else { throw invalid("invalid key") }
                    result.append(String(String.UnicodeScalarView(scalars[start..<index])))
                }
                whitespace()
                guard index < scalars.count else { throw invalid("unfinished key") }
                if scalars[index] == end { return result }
                guard take(".") else { throw invalid("invalid dotted key") }
            }
        }

        static func isBare(_ scalar: Unicode.Scalar) -> Bool {
            let value = scalar.value
            return (65...90).contains(value) || (97...122).contains(value)
                || (48...57).contains(value) || value == 95 || value == 45
        }

        mutating func quoted() throws -> String {
            let quote = scalars[index]
            index += 1
            var value = String.UnicodeScalarView()
            while index < scalars.count {
                let scalar = scalars[index]
                index += 1
                if scalar == quote { return String(value) }
                guard scalar.value >= 32 || scalar == "\t", scalar.value != 127 else {
                    throw invalid("control character in key")
                }
                if quote == "\"", scalar == "\\" {
                    guard index < scalars.count else { throw invalid("unfinished key escape") }
                    let escape = scalars[index]
                    index += 1
                    switch escape {
                    case "\"", "\\": value.append(escape)
                    case "b": value.append("\u{8}")
                    case "t": value.append("\t")
                    case "n": value.append("\n")
                    case "f": value.append("\u{c}")
                    case "r": value.append("\r")
                    case "u", "U":
                        let length = escape == "u" ? 4 : 8
                        guard scalars.count - index >= length else { throw invalid("unfinished Unicode escape") }
                        let hex = String(String.UnicodeScalarView(scalars[index..<(index + length)]))
                        guard let code = UInt32(hex, radix: 16), let decoded = Unicode.Scalar(code) else {
                            throw invalid("invalid Unicode escape")
                        }
                        value.append(decoded)
                        index += length
                    default: throw invalid("invalid key escape")
                    }
                } else { value.append(scalar) }
            }
            throw invalid("unterminated quoted key")
        }
    }
}
