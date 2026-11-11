import Foundation

/// Shared output bounds for event and log diagnostics. These limit scratch/output storage;
/// callers still own their source strings and dictionaries.
enum BoundedDiagnosticText {
    /// The retained set is deterministic; callers must not depend on its iteration order.
    static func smallestKeys<Keys: Collection>(
        _ keys: Keys, limit: Int, maximumBytes: Int
    ) -> [String] where Keys.Element == String {
        guard limit > 0 else { return [] }
        if keys.count <= limit { return keys.filter { $0.utf8.count <= maximumBytes } }
        var selected: [String] = []
        selected.reserveCapacity(limit)
        for key in keys where key.utf8.count <= maximumBytes {
            if selected.count == limit, let last = selected.last, key >= last { continue }
            let position = selected.firstIndex(where: { key < $0 }) ?? selected.endIndex
            if selected.count == limit { selected.removeLast() }
            selected.insert(key, at: position)
        }
        return selected
    }

    /// Match character-prefix-then-byte-clipping without walking an oversized grapheme.
    static func prefix<Text: StringProtocol>(
        _ value: Text, maximumBytes: Int, maximumCharacters: Int = Int.max
    ) -> String {
        guard maximumCharacters > 0 else { return "" }
        guard value.utf8.count > maximumBytes else {
            return maximumCharacters == Int.max ? String(value) : String(value.prefix(maximumCharacters))
        }
        guard maximumBytes >= 0 else { return "" }
        // Grapheme rules use left context and the next scalar (UAX #29 §3.1.1).
        // Four lookahead bytes preserve every boundary at or before the byte cap. Any
        // replacement from a partial final scalar lies beyond it and cannot be returned.
        // The oversized-input guard implies maximumBytes < Int.max. Subtracting before
        // adding avoids overflow even for theoretical near-Int.max byte limits.
        let lookahead = min(4, Int.max - maximumBytes)
        let sample = String(decoding: value.utf8.prefix(maximumBytes + lookahead), as: UTF8.self)
        let contentLimit = maximumBytes - 3
        var end = sample.startIndex
        var clippedEnd = end
        var bytes = 0
        var characters = 0
        while end != sample.endIndex {
            let next = sample.index(after: end)
            let characterBytes = sample[end..<next].utf8.count
            guard characterBytes <= maximumBytes - bytes else { break }
            bytes += characterBytes
            characters += 1
            end = next
            // The original log contract silently clips at its character cap before
            // deciding whether an ellipsis is needed for the byte cap.
            if characters == maximumCharacters { return String(sample[..<end]) }
            if bytes <= contentLimit { clippedEnd = end }
        }
        guard maximumBytes >= 3 else { return "" }
        return String(sample[..<clippedEnd]) + "…"
    }
}
