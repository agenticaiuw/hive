import Capacitor
import Foundation
import Security

@objc(PendantSecureStoragePlugin)
public class PendantSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PendantSecureStoragePlugin"
    public let jsName = "PendantSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let account = "device-credential"

    private var service: String {
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.aipendant.app"
        return "\(bundleIdentifier).device-auth"
    }

    @objc func get(_ call: CAPPluginCall) {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }

        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject(
                "Could not read the device credential from Keychain.",
                nil,
                keychainError(status)
            )
            return
        }

        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), !value.isEmpty,
              let data = value.data(using: .utf8) else {
            call.reject("A non-empty credential value is required.")
            return
        }

        let status: OSStatus
        if SecItemCopyMatching(baseQuery as CFDictionary, nil) == errSecSuccess {
            status = SecItemUpdate(
                baseQuery as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
        } else {
            var item = baseQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }

        guard status == errSecSuccess else {
            call.reject("Could not save the device credential to Keychain.", nil, keychainError(status))
            return
        }

        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not remove the device credential from Keychain.", nil, keychainError(status))
            return
        }

        call.resolve()
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func keychainError(_ status: OSStatus) -> Error {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
        return NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
