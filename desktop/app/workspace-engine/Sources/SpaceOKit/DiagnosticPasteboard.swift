import AppKit

/// The diagnostic algorithm's provider boundary. Production uses AppKit; deterministic tests
/// use memory without connecting to the user's pasteboard service.
protocol DiagnosticPasteboardItem {
    var types: [String] { get }
    func data(forType type: String) -> Data?
}

protocol DiagnosticPasteboard {
    associatedtype Item: DiagnosticPasteboardItem
    var changeCount: Int { get }
    var items: [Item] { get }
    func write(_ items: [[String: Data]]) -> Bool
}

struct SystemDiagnosticPasteboard: DiagnosticPasteboard {
    let pasteboard: NSPasteboard

    struct Item: DiagnosticPasteboardItem {
        let item: NSPasteboardItem
        var types: [String] { item.types.map(\.rawValue) }
        func data(forType type: String) -> Data? {
            item.data(forType: .init(type))
        }
    }

    var changeCount: Int { pasteboard.changeCount }
    var items: [Item] { (pasteboard.pasteboardItems ?? []).map { Item(item: $0) } }

    func write(_ items: [[String: Data]]) -> Bool {
        pasteboard.clearContents()
        guard !items.isEmpty else { return true }
        return pasteboard.writeObjects(items.map { payload in
            let item = NSPasteboardItem()
            for (type, data) in payload { item.setData(data, forType: .init(type)) }
            return item
        })
    }
}
