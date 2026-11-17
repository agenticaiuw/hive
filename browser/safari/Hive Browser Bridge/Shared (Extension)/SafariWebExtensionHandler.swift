//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Hive Browser Bridge.
//

import SafariServices

/*
 * What the extension asks of Hive on this Mac: the key to Hive's cloud (hive:key) and, from the
 * popup's ask box, Hive's own listening (hive:listen, hive:heard). sendNativeMessage reaches this
 * handler only from the one extension bundled inside this app; the OS enforces that.
 */
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

        switch type {
        case "hive:key":
            return hiveKey()

        case "hive:listen":
            return listen(dict)

        case "hive:heard":
            return heard()

        default:
            return [ "echo": dict ]
        }
    }

    /*
     * THE KEY TO HIVE'S CLOUD, without anyone pasting it. Hive on this Mac writes
     * ~/.config/hive/extension.json ({"url", "key"}: the cloud board and a key that reaches only
     * what the extension needs, hive-tasks extension-key), and this appex may read exactly that
     * one file (tools/HiveSafari.entitlements, a read-only home-relative exception). The sandbox
     * moves HOME into the appex's container, so the real home comes from the user database.
     */
    private func hiveKey() -> [String: Any] {
        guard let home = realHome() else {
            return [ "ok": false, "error": "no home folder" ]
        }
        let path = home + "/.config/hive/extension.json"
        guard let data = FileManager.default.contents(atPath: path),
              let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let key = values["key"] as? String, !key.isEmpty else {
            return [ "ok": false, "error": "Hive hasn't connected this browser yet" ]
        }
        return [ "ok": true, "key": key, "url": values["url"] as? String ?? "" ]
    }

    /*
     * THE MICROPHONE, through Hive. Safari gives an extension's popup no way to ask for the
     * microphone: its speech recognition answers not-allowed before anyone is asked. Hive.app has
     * the microphone, so the popup asks it to listen. This posts start, stop or cancel to Hive.app
     * (Hive's SafariListen, dashboard.swift) as a distributed notification, which a sandboxed
     * process may post as long as it carries no userInfo; the request id rides in the object.
     */
    private func listen(_ dict: [String: Any]) -> [String: Any] {
        let action = dict["action"] as? String ?? ""
        let id = dict["id"] as? String ?? ""
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        guard ["start", "stop", "cancel"].contains(action), !id.isEmpty, id.count <= 80,
              id.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            return [ "ok": false, "error": "hive:listen needs action (start, stop or cancel) and an id" ]
        }
        DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("local.hive.safari.listen"), object: "\(action):\(id)", userInfo: nil,
            deliverImmediately: true)
        return [ "ok": true ]
    }

    /// What Hive heard for the popup: ~/.config/hive/safari-heard.json ({id, state, text?, error?}),
    /// the second file this appex may read (tools/HiveSafari.entitlements).
    private func heard() -> [String: Any] {
        guard let home = realHome(),
              let data = FileManager.default.contents(atPath: home + "/.config/hive/safari-heard.json"),
              let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return [ "ok": false, "error": "Hive hasn't heard anything yet" ]
        }
        return [ "ok": true, "heard": values ]
    }

    /// The sandbox moves HOME into the appex's container, so the real home comes from the user database.
    private func realHome() -> String? {
        guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return nil }
        return String(cString: dir)
    }

}
