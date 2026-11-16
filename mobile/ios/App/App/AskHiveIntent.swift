import AppIntents
import Foundation

/*
 * "Hey Siri, ask Hive": Siri asks what to do and hands the words to Hive's agent in the cloud, the
 * same queue the dashboard, the browser extension and Hive's floating window send to. It runs with
 * the phone locked and the app closed, so the owner can say it through AirPods from across the room;
 * Hive's cloud agent then unlocks the phone itself and does the task. Nothing here touches the Mac.
 *
 * The key to Hive's cloud is Documents/hive.json ({"url", "key"}), a key that reaches only the
 * request queue (cloud/tasks/worker.js extensionAllowed). It's put there when the app is installed
 * on the phone, never built into the app.
 */
@available(iOS 16.0, *)
struct AskHive: AppIntent {
    static var title: LocalizedStringResource = "Ask Hive"
    static var description = IntentDescription("Tell Hive's agent in the cloud what to do.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "What to do", requestValueDialog: "What should Hive do?")
    var request: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let words = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return .result(dialog: "I didn't hear anything for Hive.") }
        guard let cloud = HiveCloud.load() else {
            return .result(dialog: "Hive isn't connected on this phone yet.")
        }
        var call = URLRequest(url: cloud.url.appendingPathComponent("v1/requests"))
        call.httpMethod = "POST"
        call.timeoutInterval = 15
        call.setValue("Bearer \(cloud.key)", forHTTPHeaderField: "Authorization")
        call.setValue("application/json", forHTTPHeaderField: "Content-Type")
        call.httpBody = try JSONSerialization.data(withJSONObject: ["text": words, "from": "siri"])
        do {
            let (_, response) = try await URLSession.shared.data(for: call)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return .result(dialog: "Hive didn't take it. Try again in a moment.")
            }
        } catch {
            return .result(dialog: "I couldn't reach Hive.")
        }
        return .result(dialog: "Sent to Hive.")
    }
}

@available(iOS 16.0, *)
struct HiveShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskHive(),
            phrases: [
                "Ask \(.applicationName)",
                "Tell \(.applicationName)",
                "\(.applicationName)",
            ]
        )
    }
}

/// Where Hive's cloud is and this phone's key to it.
struct HiveCloud {
    let url: URL
    let key: String

    static func load() -> HiveCloud? {
        guard let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? Data(contentsOf: folder.appendingPathComponent("hive.json")),
              let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let key = values["key"] as? String, !key.isEmpty,
              let text = values["url"] as? String, let url = URL(string: text) else { return nil }
        return HiveCloud(url: url, key: key)
    }
}
