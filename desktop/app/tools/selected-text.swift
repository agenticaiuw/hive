// Read the current selection straight from Accessibility, without touching the clipboard.
import AppKit
import ApplicationServices

func get(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}
let system = AXUIElementCreateSystemWide()
guard AXIsProcessTrusted(), let focused = get(system, kAXFocusedUIElementAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID() else {
    fputs("Cannot read the focused selection; Accessibility access is required.\n", stderr); exit(1)
}
let element = focused as! AXUIElement
let role = get(element, kAXSubroleAttribute) as? String ?? ""
guard role != kAXSecureTextFieldSubrole else {
    fputs("Secure password fields cannot be read.\n", stderr); exit(1)
}
guard let text = get(element, kAXSelectedTextAttribute) as? String, !text.isEmpty else {
    fputs("This app did not expose selected text. Select text in an accessible field and try again.\n", stderr); exit(1)
}
guard text.utf8.count <= 500_000 else {
    fputs("Selection exceeds 500 KB and cannot safely fit in one context request.\n", stderr); exit(1)
}
FileHandle.standardOutput.write(Data(text.utf8))
