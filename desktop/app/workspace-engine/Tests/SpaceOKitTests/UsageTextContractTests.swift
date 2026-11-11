import XCTest
@testable import SpaceOKit

/// `spaceo`'s usage text is the only documentation most callers — human or agent — ever read, and
/// nothing checked it against the parser.
///
/// Commit 925fe29 inserted the `select` entry between `scroll` and the two continuation lines that
/// explain `--dy` / `--dx`, so the sign convention for scrolling was printed underneath `select`,
/// a command that accepts neither flag. The same entry advertised a positional `<id>` argument
/// that `case "select"` never reads: `spaceo select doc-7 --x 10 ...` was accepted and the
/// `doc-7` silently discarded, because `validateFlags` only inspects flag names.
///
/// So this pins the one invariant that makes the text answerable by the code: every long flag
/// printed inside a command's block is a flag that command actually accepts.
final class UsageTextContractTests: XCTestCase {

    /// One documented command and every flag its block mentions, continuation lines included.
    private struct UsageBlock {
        let command: String
        let flags: Set<String>
        let lines: [String]
    }

    /// Usage keys the flag table stores as `command.subcommand`.
    private static let subcommandKeys: Set<String> = [
        "daemon.stop", "daemon.restart", "daemon.drain", "daemon.wait", "session.create", "session.list", "session.heartbeat",
        "session.claim",
        "session.pause", "session.resume", "session.destroy", "session.annotate", "clipboard.get",
        "logging.status", "logging.enable", "logging.disable",
    ]

    /// The text the binary itself prints, so this cannot pass by reading a copy of the string that
    /// has drifted from the one users see. `spaceo` with no arguments prints usage and exits 0.
    private func printedUsage() throws -> String {
        // SwiftPM places sibling executable products next to the XCTest bundle.
        let executable = Bundle(for: UsageTextContractTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("spaceo")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw XCTSkip("spaceo executable was not built next to the test bundle")
        }
        let process = Process()
        let standardOutput = Pipe()
        process.executableURL = executable
        process.standardOutput = standardOutput
        process.standardError = Pipe()
        try process.run()
        let data = standardOutput.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? "<non-UTF-8 output>"
    }

    private func usageBlocks() throws -> [UsageBlock] {
        let usage = try printedUsage()
        var blocks: [UsageBlock] = []
        var current: (command: String, lines: [String])?

        func close() {
            guard let open = current else { return }
            blocks.append(UsageBlock(command: open.command,
                                     flags: Self.flags(in: open.lines),
                                     lines: open.lines))
            current = nil
        }

        for rawLine in usage.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            // The banner and the trailing "Controller create:" / "Global:" / "Env:" notes are
            // unindented prose about the whole CLI, not about any one command.
            guard line.hasPrefix(" ") else { close(); continue }
            let fields = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            if fields.first == "spaceo", fields.count > 1, !fields[1].hasPrefix("-") {
                close()
                var key = fields[1]
                if fields.count > 2, Self.subcommandKeys.contains("\(key).\(fields[2])") {
                    key += ".\(fields[2])"
                }
                current = (key, [line])
            } else if current != nil {
                current?.lines.append(line)
            }
        }
        close()

        XCTAssertFalse(blocks.isEmpty, "could not read any commands out of `spaceo` usage")
        return blocks
    }

    /// Long flags only. `-o` and `-h` are aliases the table stores under their long spellings,
    /// and a bare `-600` in an example is a value, not a flag.
    private static func flags(in lines: [String]) -> Set<String> {
        var found: Set<String> = []
        for line in lines {
            var rest = Substring(line)
            while let range = rest.range(of: "--") {
                rest = rest[range.upperBound...]
                let name = rest.prefix { $0.isLetter || $0.isNumber || $0 == "-" }
                if !name.isEmpty { found.insert(String(name)) }
            }
        }
        return found
    }

    func testEveryFlagPrintedForACommandIsAFlagThatCommandAccepts() throws {
        for block in try usageBlocks() {
            guard let allowed = CLISpec.allowedFlags[block.command] else {
                XCTFail("""
                    usage documents `spaceo \(block.command)` but CLISpec has no flag spec for it, \
                    so `validateFlags` would exit with an internal error.
                    """)
                continue
            }
            let undocumentable = block.flags.subtracting(allowed)
            XCTAssertTrue(undocumentable.isEmpty, """
                `spaceo \(block.command)` prints \(undocumentable.sorted().map { "--\($0)" }) in \
                its usage block, but the command rejects them with "unknown option(s)". Either the \
                text drifted onto the wrong command, or the flag was never wired up.
                Block:
                \(block.lines.joined(separator: "\n"))
                """)
        }
    }

    /// The other half of the same drift: a command whose block advertises a positional the parser
    /// never reads. Only `select` is asserted, because it is the one the regression produced and
    /// the commands that *do* take positionals (`run`, `type`, `key`, `pool set`, `session <sub>`,
    /// `demo`) make a blanket rule wrong.
    func testSelectDoesNotAdvertiseAPositionalArgumentItIgnores() throws {
        let block = try XCTUnwrap(usageBlocks().first { $0.command == "select" },
                                  "usage no longer documents `spaceo select`")
        let header = try XCTUnwrap(block.lines.first)
        let afterCommand = header
            .split(separator: " ", omittingEmptySubsequences: true)
            .drop { $0 != "select" }
            .dropFirst()
        XCTAssertTrue(
            afterCommand.first?.hasPrefix("-") ?? true,
            """
            `\(header.trimmingCharacters(in: .whitespaces))` advertises a positional argument, but \
            `case "select"` builds its request from flags alone — anything positional is parsed \
            into `CLIArguments.positional` and dropped without a word.
            """)
    }
}
