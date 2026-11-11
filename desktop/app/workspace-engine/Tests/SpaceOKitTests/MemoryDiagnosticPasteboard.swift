import Foundation
@testable import SpaceOKit

/// Locked memory provider; no AppKit object or pasteboard service is created.
final class MemoryDiagnosticPasteboard: DiagnosticPasteboard, @unchecked Sendable {
    struct Item: DiagnosticPasteboardItem {
        let readTypes: () -> [String]
        let readData: (String) -> Data?
        var types: [String] { readTypes() }
        func data(forType type: String) -> Data? { readData(type) }
        init(_ payload: [String: Data]) {
            readTypes = { payload.keys.sorted() }
            readData = { payload[$0] }
        }
        init(types: @escaping () -> [String], data: @escaping (String) -> Data?) {
            readTypes = types
            readData = data
        }
    }

    private let lock = NSLock()
    private var count = 0
    private var stored: [Item] = []
    // Configure hooks before transferring the provider to the snapshot worker.
    var beforeChangeCount: (() -> Void)?
    var beforeItems: (() -> Void)?
    var changeCount: Int { beforeChangeCount?(); return lock.withLock { count } }
    var items: [Item] { beforeItems?(); return lock.withLock { stored } }
    func replace(_ items: [Item]) { lock.withLock { stored = items; count += 1 } }
    func write(_ items: [[String: Data]]) -> Bool {
        replace(items.map(Item.init))
        return true
    }
    func setString(_ value: String) { _ = write([["text": Data(value.utf8)]]) }
    var string: String? {
        items.first?.data(forType: "text").flatMap { String(data: $0, encoding: .utf8) }
    }
}
