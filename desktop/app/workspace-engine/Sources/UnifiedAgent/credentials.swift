// Credentials never enter model arguments, the clipboard, or activity logs.
// This code runs inside the signed Agent executable, including its --credential helper mode.
import AppKit
import ApplicationServices
import Security
import Carbon.HIToolbox
import Darwin

struct CredentialFailure: Error { let message: String }

struct AuthPromptPolicy {
    static let owners: Set<String> = ["com.apple.CoreAuthUI", "com.apple.LocalAuthentication.UIAgent",
                                     "com.apple.SecurityAgent", "com.apple.Passwords"]
    static func accepts(owner: String, text: String) -> Bool {
        let text = text.lowercased()
        guard owners.contains(owner) else { return false }
        let denied = ["make changes", "install", "administrator", "always allow", "allow access",
                      "export", "delete", "payment", "purchase", "apple pay", "transfer", "erase",
                      "reset", "change password", "new password", "incorrect", "wrong password", "try again"]
        guard !denied.contains(where: text.contains) else { return false }
        return owner == "com.apple.Passwords" || ["autofill", "passwords", "passkey", "sign in", "log in"].contains(where: text.contains)
    }
}

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
            : "Enter your Mac login password twice. Agent will store it in this Mac's Keychain and use it in supported Apple password/passkey prompts. Nothing is sent to the AI model."
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
    static func attr(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value
    }
    static func string(_ element: AXUIElement, _ key: String) -> String { attr(element, key) as? String ?? "" }
    static func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    static func nodes(_ root: AXUIElement) -> [AXUIElement] {
        var result: [AXUIElement] = [], pending: [(AXUIElement, Int)] = [(root, 0)]
        while let (node, depth) = pending.popLast(), result.count < 250 {
            result.append(node)
            if depth < 10, let children = attr(node, kAXChildrenAttribute) as? [AXUIElement] {
                pending += children.map { ($0, depth + 1) }
            }
        }
        return result
    }
    struct WorkspaceTarget {
        let pid: pid_t
        let windowID: CGWindowID
    }
    static func axWindowID(_ window: AXUIElement) -> CGWindowID? {
        typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> Int32
        guard let handle = dlopen(nil, RTLD_LAZY), let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
        let getWindow = unsafeBitCast(symbol, to: GetWindow.self)
        var id: UInt32 = 0
        return getWindow(window, &id) == 0 && id > 0 ? id : nil
    }
    static func prompt(allowPrivacySettings: Bool = false, target: WorkspaceTarget? = nil) throws -> (AXUIElement, [AXUIElement]) {
        guard AXIsProcessTrusted() else { throw CredentialFailure(message: "Agent needs Accessibility permission to recognize the system password prompt.") }
        let system = AXUIElementCreateSystemWide()
        let app: AXUIElement
        if let target {
            app = AXUIElementCreateApplication(target.pid)
        } else if allowPrivacySettings,
           let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first {
            app = AXUIElementCreateApplication(settings.processIdentifier)
        } else if let focused = element(attr(system, kAXFocusedApplicationAttribute)) {
            app = focused
        } else { throw CredentialFailure(message: "No focused authentication window.") }
        var pid: pid_t = 0
        AXUIElementGetPid(app, &pid)
        guard let running = NSRunningApplication(processIdentifier: pid),
              let owner = running.bundleIdentifier,
              AuthPromptPolicy.owners.contains(owner) || (allowPrivacySettings && owner == "com.apple.systempreferences") else {
            throw CredentialFailure(message: "The focused app is not a supported Apple authentication dialog. No credential was used.")
        }
        // Verify Apple's running code, not just a spoofable bundle name or webpage text.
        var code: SecCode?, requirement: SecRequirement?
        let attrs = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess,
              SecRequirementCreateWithString("anchor apple and identifier \"\(owner)\"" as CFString, [], &requirement) == errSecSuccess,
              let code, let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
            throw CredentialFailure(message: "The Apple authentication window could not be verified.")
        }
        let window: AXUIElement
        if let target {
            guard owner == "com.apple.Passwords", pid == target.pid,
                  let allWindows = attr(app, kAXWindowsAttribute) as? [AXUIElement] else {
                throw CredentialFailure(message: "The workspace Passwords window could not be verified.")
            }
            let matches = allWindows.filter { axWindowID($0) == target.windowID }
            guard matches.count == 1 else {
                throw CredentialFailure(message: "The workspace Passwords window changed or is ambiguous.")
            }
            window = matches[0]
        } else {
            guard let focused = element(attr(app, kAXFocusedWindowAttribute)) else {
                throw CredentialFailure(message: "The Apple authentication window could not be verified.")
            }
            window = focused
        }
        let all = nodes(window)
        let text = all.map { node -> String in
            // Never read any text field's value, including secure fields.
            let role = string(node, kAXRoleAttribute)
            let title = string(node, kAXTitleAttribute) + " " + string(node, kAXDescriptionAttribute)
            return role == kAXStaticTextRole ? title + " " + string(node, kAXValueAttribute) : title
        }.joined(separator: " ")
        let privacySettings = allowPrivacySettings &&
            (AuthPromptPolicy.owners.contains(owner) || owner == "com.apple.systempreferences") &&
            text.lowercased().contains("privacy & security is trying to modify your system settings") &&
            !["incorrect", "wrong password", "try again"].contains(where: text.lowercased().contains)
        guard privacySettings || AuthPromptPolicy.accepts(owner: owner, text: text) else {
            throw CredentialFailure(message: "This dialog is not a recognized account sign-in/autofill prompt. No credential was used.")
        }
        return (window, all)
    }
    static func fillMac(allowPrivacySettings: Bool = false, target: WorkspaceTarget? = nil) throws {
        var (_, all) = try prompt(allowPrivacySettings: allowPrivacySettings, target: target)
        let secure = { (node: AXUIElement) in string(node, kAXSubroleAttribute) == kAXSecureTextFieldSubrole }
        if !all.contains(where: secure) {
            let fallback = all.filter { string($0, kAXRoleAttribute) == kAXButtonRole &&
                ["use password", "enter password", "use password…", "enter password…"].contains(string($0, kAXTitleAttribute).lowercased()) }
            guard fallback.count == 1, AXUIElementPerformAction(fallback[0], kAXPressAction as CFString) == .success else {
                throw CredentialFailure(message: "This prompt does not expose a supported Use Password button.")
            }
            Thread.sleep(forTimeInterval: 0.25)
            (_, all) = try prompt(allowPrivacySettings: allowPrivacySettings, target: target)
        }
        let fields = all.filter(secure)
        guard fields.count == 1 else { throw CredentialFailure(message: "Expected one secure password field. No credential was used.") }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(fields[0], kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
            throw CredentialFailure(message: "macOS does not allow this password field to be filled automatically. Use Touch ID or enter it yourself.")
        }
        var data = try read("mac")
        defer { data.resetBytes(in: 0..<data.count) }
        guard let password = String(data: data, encoding: .utf8) else { throw CredentialFailure(message: "Invalid stored credential.") }
        // Revalidate after Keychain access; address the exact secure element, never the keyboard focus.
        let (_, current) = try prompt(allowPrivacySettings: allowPrivacySettings, target: target)
        guard current.contains(where: { CFEqual($0, fields[0]) }) else {
            throw CredentialFailure(message: "The authentication field changed. No credential was used.")
        }
        let buttons = current.filter { string($0, kAXRoleAttribute) == kAXButtonRole &&
            ["ok", "continue", "unlock", "log in", "sign in", "autofill"].contains(string($0, kAXTitleAttribute).lowercased()) }
        var rawActions: CFArray?
        let confirmAvailable = AXUIElementCopyActionNames(fields[0], &rawActions) == .success &&
            ((rawActions as? [String]) ?? []).contains("AXConfirm")
        guard buttons.count == 1 || (buttons.isEmpty && confirmAvailable) else {
            throw CredentialFailure(message: "Could not identify a supported sign-in confirmation.")
        }
        var attempt = query("attempt:mac")
        attempt[kSecValueData as String] = Data("unconfirmed".utf8)
        guard SecItemAdd(attempt as CFDictionary, nil) == errSecSuccess else {
            throw CredentialFailure(message: "A previous password attempt was not confirmed. Check the dialog and re-save the credential in Authentication before retrying.")
        }
        guard AXUIElementSetAttributeValue(fields[0], kAXValueAttribute as CFString, password as CFString) == .success else {
            throw CredentialFailure(message: "The authentication field changed or rejected autofill. No automatic retry.")
        }
        let (_, latest) = try prompt(allowPrivacySettings: allowPrivacySettings, target: target)
        guard latest.contains(where: { CFEqual($0, fields[0]) }) else {
            throw CredentialFailure(message: "The authentication dialog changed. No automatic retry.")
        }
        let submit: AXError
        if let button = buttons.first {
            guard latest.contains(where: { CFEqual($0, button) }) else {
                throw CredentialFailure(message: "The authentication dialog changed. No automatic retry.")
            }
            submit = AXUIElementPerformAction(button, kAXPressAction as CFString)
        } else {
            submit = AXUIElementPerformAction(fields[0], "AXConfirm" as CFString)
        }
        guard submit == .success else { throw CredentialFailure(message: "The authentication dialog rejected confirmation. No automatic retry.") }
        Thread.sleep(forTimeInterval: 0.8)
        if let (_, remaining) = try? prompt(allowPrivacySettings: allowPrivacySettings, target: target), remaining.contains(where: { CFEqual($0, fields[0]) }) {
            throw CredentialFailure(message: "Authentication has not been confirmed. Check the dialog yourself; no automatic retry.")
        }
        // Inspect the original window directly even when policy rejects an incorrect-password
        // message. A policy failure alone is never treated as successful authentication.
        var stillValid: CFTypeRef?
        let invalid = AXUIElementCopyAttributeValue(fields[0], kAXRoleAttribute as CFString, &stillValid) == .invalidUIElement
        let hidden = attr(fields[0], kAXHiddenAttribute) as? Bool == true
        guard invalid || hidden else {
            throw CredentialFailure(message: "Password submitted, but dismissal could not be verified. No automatic retry; check the screen.")
        }
        try remove("attempt:mac")
        print("Apple authentication dialog dismissed. Verify the account sign-in result on screen.")
    }
    static func diagnoseWorkspacePasswords(_ target: WorkspaceTarget) throws {
        let (_, all) = try prompt(target: target)
        let fields = all.filter { string($0, kAXSubroleAttribute) == kAXSecureTextFieldSubrole }
        guard fields.count == 1 else {
            throw CredentialFailure(message: "Expected one secure password field; no credential was accessed.")
        }
        var settable = DarwinBoolean(false)
        let checked = AXUIElementIsAttributeSettable(fields[0], kAXValueAttribute as CFString, &settable) == .success
        var actions: CFArray?
        let confirms = AXUIElementCopyActionNames(fields[0], &actions) == .success &&
            ((actions as? [String]) ?? []).contains("AXConfirm")
        let buttonCount = all.filter { string($0, kAXRoleAttribute) == kAXButtonRole &&
            ["ok", "continue", "unlock", "log in", "sign in", "autofill"].contains(string($0, kAXTitleAttribute).lowercased()) }.count
        print("secure_field=one value_settable=\(checked && settable.boolValue) confirm_action=\(confirms) confirmation_buttons=\(buttonCount)")
    }
    static func privacyField() throws -> (AXUIElement, AXUIElement) {
        let (window, all) = try prompt(allowPrivacySettings: true)
        let fields = all.filter { string($0, kAXSubroleAttribute) == kAXSecureTextFieldSubrole }
        guard fields.count == 1 else { throw CredentialFailure(message: "The privacy authorization field is unavailable.") }
        return (window, fields[0])
    }
    static func verifyPrivacyFocus() throws {
        let (_, field) = try privacyField()
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.systempreferences",
              attr(field, kAXFocusedAttribute) as? Bool == true else {
            throw CredentialFailure(message: "The privacy password field is not focused. No password was typed.")
        }
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
            case "fill-mac": try fillMac()
            case "fill-workspace-passwords":
                guard args.count == 3, let pid = Int32(args[1]), pid > 0,
                      let id = UInt32(args[2]), id > 0 else { return 2 }
                try fillMac(target: WorkspaceTarget(pid: pid, windowID: id))
            case "diagnose-workspace-passwords":
                guard args.count == 3, let pid = Int32(args[1]), pid > 0,
                      let id = UInt32(args[2]), id > 0 else { return 2 }
                try diagnoseWorkspacePasswords(WorkspaceTarget(pid: pid, windowID: id))
            case "fill-privacy-settings": try fillMac(allowPrivacySettings: true)
            case "prepare-privacy-keyboard":
                let (window, field) = try privacyField()
                guard let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first,
                      settings.activate(options: []) else {
                    throw CredentialFailure(message: "Could not activate the verified System Settings prompt.")
                }
                guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success,
                      AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                    throw CredentialFailure(message: "Could not focus the verified privacy password field.")
                }
                Thread.sleep(forTimeInterval: 0.15)
                try verifyPrivacyFocus()
            case "verify-privacy-keyboard": try verifyPrivacyFocus()
            case "submit-privacy-keyboard":
                try verifyPrivacyFocus()
                let (_, all) = try prompt(allowPrivacySettings: true)
                let buttons = all.filter { string($0, kAXRoleAttribute) == kAXButtonRole &&
                    string($0, kAXTitleAttribute) == "Modify Settings" }
                guard buttons.count == 1, AXUIElementPerformAction(buttons[0], kAXPressAction as CFString) == .success else {
                    throw CredentialFailure(message: "Could not submit the verified privacy authorization.")
                }
            case "read-privacy-keyboard":
                try verifyPrivacyFocus()
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
                guard AuthPromptPolicy.accepts(owner: "com.apple.CoreAuthUI", text: "Use your passkey to sign in"),
                      !AuthPromptPolicy.accepts(owner: "com.apple.Safari", text: "Passwords Use Password"),
                      !AuthPromptPolicy.accepts(owner: "com.apple.CoreAuthUI", text: "Passwords export"),
                      !AuthPromptPolicy.accepts(owner: "com.apple.SecurityAgent", text: "Installer wants to make changes") else { return 1 }
                print("Keychain round trip and authentication prompt policy passed; synthetic credential removed.")
            default: return 2
            }
            return 0
        } catch {
            fputs(((error as? CredentialFailure)?.message ?? "Authentication failed.") + "\n", stderr)
            return 1
        }
    }
}
