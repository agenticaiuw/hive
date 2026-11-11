import CoreGraphics
import Foundation

extension AXNode {
    /// One shared representation for full reads, search hits, and incremental changes.
    func renderedLine(label override: String? = nil, indented: Bool = false) -> String {
        var line = ""
        appendRenderedLine(to: &line, label: override, indented: indented)
        return line
    }

    func appendRenderedLine(to output: inout String, label override: String? = nil, indented: Bool = false) {
        if indented {
            output += String(repeating: "  ", count: min(max(depth, 0), 12))
        }
        if let index {
            output += "[\(index)] "
        }
        // AX roles normally have one leading prefix. Append that suffix without allocating
        // a replacement string; retain the previous behavior for unusual embedded prefixes.
        if role.hasPrefix("AX"), !role.dropFirst(2).contains("AX") {
            output.append(contentsOf: role.dropFirst(2))
        } else if role.contains("AX") {
            output += role.replacingOccurrences(of: "AX", with: "")
        } else {
            output += role
        }
        let value = override ?? label
        if !value.isEmpty {
            output += " — "
            output += value
        }
        for state in states {
            output += " ["
            output += state
            output += "]"
        }
        if !enabled { output += "  (disabled)" }
    }

    /// Never fabricate or trap on coordinates from malformed/provider-specific geometry.
    /// Indexed addressing remains available when a centre cannot be represented safely.
    func renderedCenter(relativeTo origin: CGPoint = .zero) -> String? {
        guard let frame,
              frame.origin.x.isFinite, frame.origin.y.isFinite,
              frame.size.width.isFinite, frame.size.height.isFinite,
              frame.size.width >= 0, frame.size.height >= 0,
              let x = Int(exactly: (frame.midX - origin.x).rounded(.towardZero)),
              let y = Int(exactly: (frame.midY - origin.y).rounded(.towardZero)) else { return nil }
        return "(\(x),\(y))"
    }
}
