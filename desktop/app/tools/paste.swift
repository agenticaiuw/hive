// Types what it reads on stdin into the app in front, the way you would paste it: the text goes on
// the clipboard, it presses ⌘V, and then puts back what the clipboard had before (unless something
// else has been copied since). For dictation (python/voice_agent.py).
//
// Pressing keys in another app needs Accessibility (System Settings › Privacy & Security) for the
// app it runs from: Agent, or the terminal. Without it, macOS is asked to show you where to allow
// that, the text is left on the clipboard to paste yourself, and it exits with 2.
//
//   echo -n "hello" | build/agent-vhid-paste

import AppKit

let text = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
if text.isEmpty {
    exit(0)
}
let pasteboard = NSPasteboard.general

guard CGPreflightPostEventAccess() else {
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    CGRequestPostEventAccess()
    FileHandle.standardError.write(Data(("it isn't allowed to press keys; allow it under System Settings › "
                                         + "Privacy & Security › Accessibility\n").utf8))
    exit(2)
}

// Every type of every item on the clipboard, to put back afterwards.
let saved: [NSPasteboardItem] = (pasteboard.pasteboardItems ?? []).map { item in
    let copy = NSPasteboardItem()
    for type in item.types {
        if let data = item.data(forType: type) {
            copy.setData(data, forType: type)
        }
    }
    return copy
}
pasteboard.clearContents()
pasteboard.setString(text, forType: .string)
// Clipboard managers that follow nspasteboard.org leave this out of their history.
pasteboard.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
let ours = pasteboard.changeCount

let source = CGEventSource(stateID: .hidSystemState)
let v: CGKeyCode = 9  // kVK_ANSI_V
for down in [true, false] {
    let event = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: down)
    event?.flags = .maskCommand
    event?.post(tap: .cghidEventTap)
}

// The app reads the clipboard when the ⌘V gets to it; give it time before putting it back.
Thread.sleep(forTimeInterval: 0.5)
if pasteboard.changeCount == ours {
    pasteboard.clearContents()
    if !saved.isEmpty {
        pasteboard.writeObjects(saved)
    }
}
