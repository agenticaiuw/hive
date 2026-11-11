// Credentials never enter model arguments, the clipboard, or activity logs.
// This code runs inside the signed Agent executable, including its --credential helper mode.
import AppKit
import ApplicationServices
import Security
import Carbon.HIToolbox
import Darwin

struct CredentialFailure: Error { let message: String }

enum Credentials {
    static let service = "local.personal-agent.authentication"
    static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func save(_ account: String, _ data: Data) throws {
        var q = query(account)
        let changes: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(q as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var application: SecTrustedApplication?, access: SecAccess?
            guard SecTrustedApplicationCreateFromPath(nil, &application) == errSecSuccess,
                  let application,
                  SecAccessCreate("Personal Agent authentication" as CFString, [application] as CFArray, &access) == errSecSuccess,
                  let access else { throw CredentialFailure(message: "Could not restrict credential access to Agent.") }
            q[kSecAttrAccess as String] = access
            changes.forEach { q[$0.key] = $0.value }
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CredentialFailure(message: "Keychain could not save the credential (\(status)).") }
    }
    static func read(_ account: String) throws -> Data {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["CGSSessionScreenIsLocked"] as? Bool != true else {
            throw CredentialFailure(message: "Unlock this Mac before Agent can use stored credentials.")
        }
        // The local login Keychain and this signed executable's ACL protect the secret.
        // Don't trigger a second password dialog to retrieve it.
        SecKeychainSetUserInteractionAllowed(false)
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &found)
        guard status == errSecSuccess, let data = found as? Data else {
            throw CredentialFailure(message: "Credential unavailable or Keychain locked. Configure it in Agent → Authentication (\(status)).")
        }
        return data
    }
    static func remove(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialFailure(message: "Keychain could not remove the credential (\(status)).")
        }
    }
    @discardableResult static func configure(_ account: String) -> Bool {
        let phone = account.hasPrefix("phone:")
        let alert = NSAlert()
        alert.messageText = phone ? "Phone passcode for Agent" : "Mac password for Agent"
        alert.informativeText = phone
            ? "Enter your phone's numeric passcode twice. Agent will store it in this Mac's Keychain for the configured phone relay. It can use it only at a recognized system passcode screen. Nothing is sent to the AI model."
            : "Enter your Mac login password twice. Agent will store it in this Mac's Keychain and type it for you when it signs in (for example at the Passwords AutoFill prompt). Nothing is sent to the AI model."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Remove Saved Credential")
        let fields = [NSSecureTextField(frame: NSRect(x: 0, y: 38, width: 340, height: 24)),
                      NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))]
        fields[0].placeholderString = phone ? "Phone passcode" : "Mac login password"
        fields[1].placeholderString = "Enter it again"
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 64))
        fields.forEach { view.addSubview($0) }
        alert.accessoryView = view
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = fields[0]
        let response = alert.runModal()
        defer { fields.forEach { $0.stringValue = "" } }
        do {
            if response == .alertThirdButtonReturn { try remove(account); try remove("attempt:" + account); return true }
            guard response == .alertFirstButtonReturn else { return false }
            let value = fields[0].stringValue
            guard !value.isEmpty && value == fields[1].stringValue else {
                throw CredentialFailure(message: "The two entries must match and cannot be empty.")
            }
            if phone && (value.range(of: "^[0-9]{4,12}$", options: .regularExpression) == nil) {
                throw CredentialFailure(message: "Phone automation currently supports numeric passcodes of 4–12 digits.")
            }
            try save(account, Data(value.utf8))
            try remove("attempt:" + account)
            return true
        } catch { showError(error); return false }
    }
    static func showError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Authentication setup"
        alert.informativeText = (error as? CredentialFailure)?.message ?? "Authentication could not finish."
        alert.runModal()
    }
    static func command(_ args: [String]) -> Int32 {
        do {
            guard let action = args.first else { throw CredentialFailure(message: "Missing credential action.") }
            switch action {
            case "configure":
                guard args.count == 2, args[1] == "mac" || args[1].hasPrefix("phone:") else { return 2 }
                _ = NSApplication.shared
                NSApp.setActivationPolicy(.accessory)
                if !configure(args[1]) { return 3 }
            case "read-mac":
                // The agent's keyboard types this into the focused field; private pipe, never a tool result.
                var data = try read("mac")
                defer { data.resetBytes(in: 0..<data.count) }
                FileHandle.standardOutput.write(data)
            case "keyboard-layout":
                guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
                      let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
                    throw CredentialFailure(message: "Could not verify the keyboard layout.")
                }
                print(Unmanaged<CFString>.fromOpaque(ptr).takeUnretainedValue())
            case "read-phone":
                guard args.count == 2, args[1].hasPrefix("phone:") else { return 2 }
                var data = try read(args[1])
                defer { data.resetBytes(in: 0..<data.count) }
                FileHandle.standardOutput.write(data) // private pipe to local phone broker, never a tool result
            case "self-test":
                let key = "test:" + UUID().uuidString
                defer { try? remove(key) }
                try save(key, Data("synthetic-test-value".utf8))
                guard try read(key) == Data("synthetic-test-value".utf8) else { return 1 }
                print("Keychain round trip passed; synthetic credential removed.")
            default: return 2
            }
            return 0
        } catch {
            fputs(((error as? CredentialFailure)?.message ?? "Authentication failed.") + "\n", stderr)
            return 1
        }
    }
}
