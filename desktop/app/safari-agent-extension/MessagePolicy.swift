import Foundation

/// Native-messaging protocol v1: a capability probe only, not a window controller.
/// Never reflect untrusted fields or profile identifiers into the response.
enum MessagePolicy {
    static func reply(_ message: Any?) -> [String: String] {
        guard let dict = message as? [String: Any],
              Set(dict.keys) == Set(["version", "operation"]),
              let version = dict["version"] as? String, version == "1",
              let operation = dict["operation"] as? String, operation == "capabilities" else {
            return ["status": "rejected"]
        }
        return ["status": "ok", "version": "1", "window_control": "unsupported",
                "session_sharing": "unverified", "input_isolation": "unverified"]
    }
}
