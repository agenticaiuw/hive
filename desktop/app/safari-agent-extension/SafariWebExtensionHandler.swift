import Foundation
import SafariServices

/// Intentionally not installed or included in the Agent app build yet.
/// No logging, storage, profile inspection, or browser/window commands.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let reply = NSExtensionItem()
        reply.userInfo = [SFExtensionMessageKey: MessagePolicy.reply(item?.userInfo?[SFExtensionMessageKey])]
        context.completeRequest(returningItems: [reply], completionHandler: nil)
    }
}
