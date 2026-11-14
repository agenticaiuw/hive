// What the engine did, newest last, for the `workspace_events` tool and the viewer. Only the tool's
// name, when, whether it worked and a short note: never typed text or anything read off the screen.
import Foundation

public final class EventLog {
    let url: URL
    static let keep = 300

    public init(state: URL) {
        url = Paths.engineDir(state: state).appendingPathComponent("events.jsonl")
    }

    public func add(_ tool: String, ok: Bool, note: String) {
        let entry: [String: Any] = [
            "at": ISO8601DateFormatter().string(from: Date()), "tool": tool, "ok": ok,
            "note": String(note.prefix(160)),
        ]
        guard let lock = try? FileLock(url.appendingPathExtension("lock")) else { return }
        defer { lock.release() }
        var lines = (try? String(contentsOf: url, encoding: .utf8))?.split(separator: "\n").map(String.init) ?? []
        lines.append(JSONFile.string(entry, pretty: false))
        if lines.count > EventLog.keep { lines.removeFirst(lines.count - EventLog.keep) }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    public func recent(_ limit: Int) -> [[String: Any]] {
        let lines = (try? String(contentsOf: url, encoding: .utf8))?.split(separator: "\n") ?? []
        return lines.suffix(max(1, min(limit, EventLog.keep))).compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
    }
}
