import XCTest
@testable import SpaceOMCP

/// `Sources/SpaceOMCP/Playbook.swift` is generated from `docs/playbook/*.md` and committed, so the
/// two can drift when someone edits one without regenerating. These tests pin them together and
/// check the shape the MCP prompt and resource handlers rely on.
final class PlaybookTests: XCTestCase {

    /// `Tests/SpaceOKitTests/PlaybookTests.swift` → repository root.
    private static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    private static let playbookDirectory = repoRoot.appendingPathComponent("docs/playbook", isDirectory: true)

    /// README.md documents the generator for maintainers and is excluded by the script too.
    private static let excluded: Set<String> = ["README.md"]

    private func markdownFiles() throws -> [String] {
        let contents = try FileManager.default.contentsOfDirectory(atPath: Self.playbookDirectory.path)
        return contents.filter { $0.hasSuffix(".md") && !Self.excluded.contains($0) }.sorted()
    }

    func testEveryMarkdownFileIsEmbeddedWithIdenticalContent() throws {
        let files = try markdownFiles()
        XCTAssertFalse(files.isEmpty, "no playbook sources found at \(Self.playbookDirectory.path)")
        let byName = Dictionary(uniqueKeysWithValues: Playbook.documents.map { ($0.name, $0) })

        for file in files {
            let name = String(file.dropLast(".md".count))
            let expected = try String(contentsOf: Self.playbookDirectory.appendingPathComponent(file), encoding: .utf8)
            guard let document = byName[name] else {
                XCTFail("\(file) has no Playbook.documents entry; run `node scripts/generate-playbook.mjs`")
                continue
            }
            XCTAssertEqual(document.markdown, expected,
                           "\(file) differs from the generated Swift; run `node scripts/generate-playbook.mjs`")
        }

        XCTAssertEqual(Set(byName.keys), Set(files.map { String($0.dropLast(".md".count)) }),
                       "Playbook.documents contains entries with no Markdown source")
    }

    func testDocumentsAreNonEmptyWithTitles() {
        for document in Playbook.documents {
            XCTAssertFalse(document.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                           "\(document.name) is empty")
            XCTAssertFalse(document.title.isEmpty, "\(document.name) has no title")
            XCTAssertFalse(document.name.isEmpty)
        }
    }

    func testURIsAreUniqueAndWellFormed() {
        let uris = Playbook.documents.map(\.uri)
        XCTAssertEqual(Set(uris).count, uris.count, "duplicate resource uri")
        for document in Playbook.documents {
            XCTAssertTrue(document.uri.hasPrefix("spaceo://docs/"), "\(document.uri) has the wrong scheme")
            XCTAssertEqual(document.uri, "spaceo://docs/\(document.name)")
        }
        let names = Playbook.documents.map(\.name)
        XCTAssertEqual(names, names.sorted(), "documents must be emitted in deterministic sorted order")
    }

    func testEveryPromptReferencesAnExistingDocument() {
        let names = Set(Playbook.documents.map(\.name))
        XCTAssertEqual(Set(Playbook.prompts.map(\.name)), ["drive-app", "drive-web", "hand-off-to-human"])
        for prompt in Playbook.prompts {
            XCTAssertTrue(names.contains(prompt.documentName),
                          "prompt \(prompt.name) references missing document \(prompt.documentName)")
            XCTAssertFalse(prompt.description.isEmpty)
            XCTAssertEqual(prompt.arguments.count, 1, "each playbook prompt takes exactly one argument")
            XCTAssertTrue(prompt.arguments.allSatisfy(\.required))
        }
        let argumentNames = Dictionary(uniqueKeysWithValues: Playbook.prompts.map { ($0.name, $0.arguments[0].name) })
        XCTAssertEqual(argumentNames["drive-app"], "app")
        XCTAssertEqual(argumentNames["drive-web"], "url")
        XCTAssertEqual(argumentNames["hand-off-to-human"], "reason")
    }

    func testSkillFileHasFrontmatterNameAndDescription() throws {
        let skill = try XCTUnwrap(Playbook.documents.first { $0.name == "SKILL" }, "SKILL.md is not embedded")
        let lines = skill.markdown.components(separatedBy: "\n")
        XCTAssertEqual(lines.first, "---", "SKILL.md must start with YAML frontmatter")
        let end = try XCTUnwrap(lines.dropFirst().firstIndex(of: "---"), "SKILL.md frontmatter is not closed")
        let frontmatter = lines[1..<end]
        let name = frontmatter.first { $0.hasPrefix("name:") }?.dropFirst("name:".count)
            .trimmingCharacters(in: .whitespaces)
        let description = frontmatter.first { $0.hasPrefix("description:") }?.dropFirst("description:".count)
            .trimmingCharacters(in: .whitespaces)
        XCTAssertEqual(name, "spaceo")
        XCTAssertFalse((description ?? "").isEmpty, "SKILL.md frontmatter needs a one-line description")
        XCTAssertFalse((description ?? "").contains("\n"))
    }

    func testSkillPointsAtEveryOtherDocument() throws {
        let skill = try XCTUnwrap(Playbook.documents.first { $0.name == "SKILL" })
        for document in Playbook.documents where document.name != "SKILL" {
            XCTAssertTrue(skill.markdown.contains(document.uri), "SKILL.md does not point at \(document.uri)")
        }
    }
}
