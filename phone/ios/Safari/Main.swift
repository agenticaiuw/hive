import Foundation

// iOS requires a principal class even though the browser node runs entirely in JavaScript.
final class Handler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
