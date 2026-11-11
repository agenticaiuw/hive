import XCTest
@testable import SpaceOKit

/// Whether a keystroke actually reached a VS Code-family renderer.
///
/// These renderers accept synthetic per-PID keys without complaint and may do nothing with them.
/// Reporting that as success is the silent-success failure the project treats as worse than a
/// refusal, so the observable has to cover both kinds of keystroke: one that edits the document
/// and one that only moves the cursor.
final class ElectronTypingConfirmationTests: XCTestCase {
    private func state(
        version: Int,
        selections: [[Int]] = [[0, 0, 0, 0]]
    ) -> ElectronEditorBridge.EditorState {
        ElectronEditorBridge.EditorState(
            column: 1,
            document: "file:///tmp/a.txt",
            visible: [[0, 0, 40, 0]],
            selections: selections,
            version: version,
            lineCount: 200)
    }

    func testATypedCharacterBumpsTheDocumentVersion() {
        XCTAssertTrue(
            ElectronEffectConfirmation.changed(from: state(version: 7), to: state(version: 8)))
    }

    func testANavigationKeyMovesTheSelectionWithoutEditing() {
        XCTAssertTrue(
            ElectronEffectConfirmation.changed(
                from: state(version: 7, selections: [[0, 0, 0, 0]]),
                to: state(version: 7, selections: [[1, 0, 1, 0]])),
            "arrow keys never bump the version, so selection has to count as an effect")
    }

    func testAnIgnoredKeystrokeChangesNothing() {
        XCTAssertFalse(
            ElectronEffectConfirmation.changed(from: state(version: 7), to: state(version: 7)),
            "identical version and selection is exactly the case that must not report success")
    }

    func testConfirmationIsSkippedWithoutASemanticChannel() async {
        let note = await ElectronEffectConfirmation.confirm(
            nil, before: nil, action: "typing")
        XCTAssertNil(
            note,
            "a target with no adapter must behave exactly as it did before, not warn on every key")
    }
}
