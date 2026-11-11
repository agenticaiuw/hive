import Foundation
import CoreGraphics

// SPAO-207 — incremental screen reads.
//
// An agent that re-reads a window after every action pays for the whole outline each time, even
// when one label changed. `AXSnapshotDiff` compares two node arrays by a structural identity that
// survives the value edits an agent itself makes, and reports only what moved. Everything here is
// pure: no Accessibility calls, no display access, deterministic for the same inputs.

public extension AXNode {

    /// Structural identity for diffing. Two nodes with the same key across snapshots are treated
    /// as the same control; see `identity(role:depth:frame:label:)` for the rule.
    var stableKey: String {
        Self.identity(role: role, depth: depth, frame: frame, label: label)
    }

    /// Roles whose accessible label is their *value* rather than their name. Editing such a
    /// control changes its label, so the label must not take part in its identity or every
    /// keystroke would look like a control being removed and another added.
    static let valueBearingRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider",
        "AXIncrementor", "AXStepper", "AXCheckBox", "AXRadioButton",
    ]

    /// The identity rule.
    ///
    /// `role | depth | frame` always contribute, with the frame snapped to a 4pt grid so
    /// sub-pixel relayout does not churn keys. The label contributes only for non-value-bearing
    /// roles (buttons, links, menu items, static text, …) where it *is* the control's name; for
    /// `valueBearingRoles` it is excluded so a value change reads as `changed`, not remove+add.
    static func identity(role: String, depth: Int, frame: CGRect?, label: String) -> String {
        var key = role + "|" + String(depth) + "|"
        if let frame, frame.origin.x.isFinite, frame.origin.y.isFinite,
           frame.size.width.isFinite, frame.size.height.isFinite {
            key += "\(snap(frame.origin.x)),\(snap(frame.origin.y)),"
                + "\(snap(frame.size.width))x\(snap(frame.size.height))"
        }
        key += "|"
        if !valueBearingRoles.contains(role) {
            key += label
        }
        return key
    }

    private static func snap(_ value: CGFloat) -> String {
        let snapped = (value / 4).rounded() * 4
        // Providers may return finite coordinates outside Int's range. Identity generation
        // must not trap on malformed geometry, including multiplication near Int.max.
        if let integer = Int(exactly: snapped) { return String(integer) }
        return String(Double(snapped))
    }
}

public struct SnapshotDiffLine: Equatable, Sendable {
    public var key: String
    public var line: String

    public init(key: String, line: String) {
        self.key = key
        self.line = line
    }
}

public enum AXSnapshotDiff {

    /// Compare a remembered snapshot with a fresh one.
    ///
    /// - `added`: lines for keys present only in `current`, in `current` order.
    /// - `removed`: lines for keys present only in `base`, in `base` order.
    /// - `changed`: same key, different label, enabled state, or actionable index. Value
    ///   changes use `old → new`; index changes include the old index after the current line.
    /// - `unchangedCount`: keys present in both with identical label, enabled state, and index.
    ///
    /// Duplicate keys within one snapshot (two identical buttons at the same depth and frame)
    /// are disambiguated deterministically by suffixing every key with `#1`, `#2`, … in
    /// document order (including the first occurrence to avoid literal-label collisions).
    /// `baseMissing` is always false here; the caller sets it when it had no base to compare.
    public static func diff(base: [AXNode], current: [AXNode], baseSnapshotID: String) -> ScreenDiff {
        var baseByKey: [String: Int] = [:]
        baseByKey.reserveCapacity(base.count)
        forEachKey(base) { key, index in baseByKey[key] = index }
        var matched = [Bool](repeating: false, count: base.count)

        var added: [String] = []
        var changed: [String] = []
        var unchanged = 0
        // Elements whose only difference is their index, remembered so that one insertion near
        // the top does not list every later control as "changed" (see `collapseUniformShift`).
        var renumbered: [(slot: Int, old: AXNode, new: AXNode)] = []
        forEachKey(current) { key, index in
            let node = current[index]
            guard let oldIndex = baseByKey.removeValue(forKey: key) else {
                added.append(render(node))
                return
            }
            matched[oldIndex] = true
            let old = base[oldIndex]
            if old.label == node.label && old.enabled == node.enabled && old.index == node.index
                && old.states == node.states {
                unchanged += 1
            } else {
                if old.label == node.label && old.enabled == node.enabled && old.states == node.states,
                   old.index != nil, node.index != nil {
                    renumbered.append((changed.count, old, node))
                }
                changed.append(renderChange(from: old, to: node))
            }
        }
        changed = collapseUniformShift(changed, renumbered: renumbered)
        var removed: [String] = []
        for index in base.indices where !matched[index] {
            removed.append(render(base[index]))
        }

        return ScreenDiff(
            baseSnapshotID: baseSnapshotID,
            added: added,
            removed: removed,
            changed: changed,
            unchangedCount: unchanged,
            baseMissing: false)
    }

    public static func isEmpty(_ diff: ScreenDiff) -> Bool {
        diff.added.isEmpty && diff.removed.isEmpty && diff.changed.isEmpty
    }

    /// Every node with its deduplicated key, in document order.
    public static func lines(_ nodes: [AXNode]) -> [SnapshotDiffLine] {
        var result: [SnapshotDiffLine] = []
        result.reserveCapacity(nodes.count)
        forEachKey(nodes) { key, index in
            result.append(SnapshotDiffLine(key: key, line: render(nodes[index])))
        }
        return result
    }

    // MARK: - Internals

    private static func forEachKey(_ nodes: [AXNode], _ visit: (String, Int) -> Void) {
        var seen: [String: Int] = [:]
        seen.reserveCapacity(nodes.count)
        for (index, node) in nodes.enumerated() {
            let base = node.stableKey
            let occurrence = (seen[base] ?? 0) + 1
            seen[base] = occurrence
            // Always suffix the occurrence: a literal label ending in "#2" cannot collide
            // with the second occurrence of another label.
            visit(base + "#\(occurrence)", index)
        }
    }

    static func render(_ node: AXNode) -> String {
        node.renderedLine(indented: true)
    }

    /// When at least three controls changed nothing but their index, all by the same amount,
    /// one line states the shift exactly; nothing an agent needs is lost. Mixed shifts keep the
    /// per-element lines, because then no single rule maps old indices to new ones.
    static func collapseUniformShift(_ changed: [String],
                                     renumbered: [(slot: Int, old: AXNode, new: AXNode)]) -> [String] {
        guard renumbered.count >= 3,
              let first = renumbered.first, let firstOld = first.old.index, let firstNew = first.new.index
        else { return changed }
        let delta = firstNew - firstOld
        guard renumbered.allSatisfy({ ($0.new.index ?? 0) - ($0.old.index ?? 0) == delta }) else {
            return changed
        }
        let slots = Set(renumbered.map(\.slot))
        var result = changed.enumerated().filter { !slots.contains($0.offset) }.map(\.element)
        let newIndices = renumbered.compactMap(\.new.index)
        let span = "[\(newIndices.min() ?? 0)]…[\(newIndices.max() ?? 0)]"
        result.append("\(renumbered.count) element(s) otherwise unchanged were renumbered by "
            + (delta > 0 ? "+\(delta)" : "\(delta)") + " (now \(span)); add \(delta) to any index "
            + "you read before this change")
        return result
    }

    private static func renderChange(from old: AXNode, to new: AXNode) -> String {
        var label = new.label
        if old.label != new.label {
            label = "\(old.label.isEmpty ? "(empty)" : old.label) → "
                + "\(new.label.isEmpty ? "(empty)" : new.label)"
        }
        var line = new.renderedLine(label: label, indented: true)
        if old.enabled != new.enabled && new.enabled { line += "  (enabled)" }
        if old.index != new.index {
            let previous = old.index.map { "[\($0)]" } ?? "none"
            line += "  (previous index: \(previous))"
        }
        return line
    }
}

/// Recent snapshots the daemon can diff against, keyed by snapshot UUID string.
///
/// Bounded on purpose: at most `capacity` entries in total (oldest evicted first) and at most
/// `maximumNodes` nodes per entry. A separate byte budget bounds retained node/string payloads;
/// an entry that cannot fit is omitted so the next diff falls back to a full read.
public final class AXSnapshotHistory: @unchecked Sendable {

    public static let defaultCapacity = 8
    public static let maximumNodes = 4000
    public static let maximumRetainedBytes = 8 * 1_024 * 1_024

    private struct Entry {
        let snapshotID: String
        let windowID: UInt32
        let nodes: [AXNode]
        let bytes: Int
    }

    private let lock = NSLock()
    private let capacity: Int
    private let maximumBytes: Int
    private var entries: [Entry] = []
    private var retainedBytes = 0

    public init(capacity: Int = AXSnapshotHistory.defaultCapacity,
                maximumBytes: Int = AXSnapshotHistory.maximumRetainedBytes) {
        self.capacity = min(max(capacity, 1), AXSnapshotHistory.defaultCapacity)
        self.maximumBytes = min(max(maximumBytes, 1), Self.maximumRetainedBytes)
    }

    /// Remember a snapshot. Re-remembering an existing ID replaces it and moves it to newest.
    public func remember(snapshotID: String, windowID: UInt32, nodes: [AXNode]) {
        let key = Self.normalize(snapshotID)
        let bounded = nodes.count <= Self.maximumNodes ? nodes : Array(nodes.prefix(Self.maximumNodes))
        let bytes = payloadBytes(bounded, snapshotID: key)
        lock.lock()
        defer { lock.unlock() }
        removeEntries { $0.snapshotID == key }
        guard let bytes else { return }
        while !entries.isEmpty && (entries.count >= capacity || retainedBytes > maximumBytes - bytes) {
            retainedBytes -= entries.removeFirst().bytes
        }
        entries.append(Entry(snapshotID: key, windowID: windowID, nodes: bounded, bytes: bytes))
        retainedBytes += bytes
    }

    public func nodes(for snapshotID: String, windowID: UInt32? = nil) -> [AXNode]? {
        let key = Self.normalize(snapshotID)
        lock.lock()
        defer { lock.unlock() }
        return entries.first {
            $0.snapshotID == key && (windowID == nil || $0.windowID == windowID)
        }?.nodes
    }

    public func forget(windowID: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        removeEntries { $0.windowID == windowID }
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
        retainedBytes = 0
    }

    /// Logical retained payload, including node/action storage and UTF-8 strings, not RSS.
    public var byteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return retainedBytes
    }

    private func removeEntries(where predicate: (Entry) -> Bool) {
        entries.removeAll { entry in
            guard predicate(entry) else { return false }
            retainedBytes -= entry.bytes
            return true
        }
    }

    private func payloadBytes(_ nodes: [AXNode], snapshotID: String) -> Int? {
        var total = 0
        func add(_ bytes: Int) -> Bool {
            guard bytes <= maximumBytes - total else { return false }
            total += bytes
            return true
        }
        guard add(snapshotID.utf8.count) else { return nil }
        for node in nodes {
            guard add(MemoryLayout<AXNode>.stride), add(node.role.utf8.count),
                  add(node.label.utf8.count), add(node.name?.utf8.count ?? 0) else { return nil }
            for action in node.actions + node.states {
                guard add(MemoryLayout<String>.stride), add(action.utf8.count) else { return nil }
            }
        }
        return total
    }

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    private static func normalize(_ snapshotID: String) -> String {
        snapshotID.lowercased()
    }
}
