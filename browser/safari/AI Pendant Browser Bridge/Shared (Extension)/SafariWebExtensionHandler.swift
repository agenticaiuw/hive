//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Evan Liu on 8/2/26.
//

import SafariServices
import os.log

/*
 * CREDENTIAL ESCROW — why a native handler holds a copy of the pairing.
 *
 * The owner, 2026-08-12: "we likely gonna keep updating the extension, make
 * sure this issue doesn't happen again." Twice (2026-08-10, 2026-08-12) an
 * extension update reset Safari's extension-storage identity and wiped the
 * stored pairing, forcing a re-pair. browser.storage.local belongs to Safari
 * and dies with that identity; THIS process's UserDefaults belong to the
 * appex's own sandbox container (~/Library/Containers/
 * com.evanliu.aipendant.browserbridge.Extension) and survive any Safari-side
 * storage reset, app rebuild, or in-place update. So the extension worker
 * escrows the credential here right after a successful pair, and silently
 * restores from here when it wakes up unpaired.
 *
 * WHY UserDefaults.standard AND NOT AN APP GROUP. The Xcode project has no
 * .entitlements files and no com.apple.security.application-groups anywhere
 * in the pbxproj (verified 2026-08-12) — only ENABLE_APP_SANDBOX=YES. A
 * UserDefaults(suiteName:) without the matching App Group entitlement fails
 * SILENTLY on macOS (writes go nowhere), which is the worst possible failure
 * mode for an escrow. standard UserDefaults of the sandboxed appex needs no
 * new entitlement, and "survives Safari extension-storage resets" is the only
 * durability this feature needs — the app never reads it.
 *
 * WHY THE CHANNEL IS SAFE WITHOUT ITS OWN AUTH. sendNativeMessage only
 * reaches this handler from the one extension bundled inside this app; the
 * OS enforces that pairing. Nothing else can speak to this process.
 *
 * The blob is stored as JSON Data rather than a plist dictionary because the
 * escrowed values legitimately contain JSON null (pairExpiresAt for a
 * "forever" pairing), and null is not a property-list type — a dictionary
 * store would drop or crash on it depending on bridging mood.
 */
private let escrowDefaultsKey = "aiPendantPairingEscrow"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let body = handle(message: message)

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: body ]
        } else {
            response.userInfo = [ "message": body ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    private func handle(message: Any?) -> [String: Any] {
        guard let dict = message as? [String: Any],
              let type = dict["type"] as? String else {
            // Unknown shape: keep the original echo behavior so the channel
            // stays probe-able from the worker's console.
            return [ "echo": message ?? NSNull() ]
        }

        let defaults = UserDefaults.standard

        switch type {
        case "escrow:store":
            guard let values = dict["values"] as? [String: Any],
                  JSONSerialization.isValidJSONObject(values),
                  let data = try? JSONSerialization.data(withJSONObject: values) else {
                return [ "ok": false, "error": "escrow:store needs a JSON `values` object" ]
            }
            defaults.set(data, forKey: escrowDefaultsKey)
            os_log(.default, "Escrow stored (%d bytes)", data.count)
            return [ "ok": true ]

        case "escrow:fetch":
            guard let data = defaults.data(forKey: escrowDefaultsKey),
                  let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return [ "ok": true, "values": NSNull() ]
            }
            return [ "ok": true, "values": values ]

        case "escrow:clear":
            defaults.removeObject(forKey: escrowDefaultsKey)
            os_log(.default, "Escrow cleared")
            return [ "ok": true ]

        default:
            return [ "echo": dict ]
        }
    }

}
