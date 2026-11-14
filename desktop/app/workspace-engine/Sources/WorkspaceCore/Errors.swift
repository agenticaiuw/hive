import Foundation

/// A refusal or failure the agent sees as `[code] message`. The codes are part of the engine's
/// interface: Hive's bridge reads some of them (unknown_session, display_creation_failed).
public struct WorkspaceError: Error, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "[\(code)] \(message)" }
}
