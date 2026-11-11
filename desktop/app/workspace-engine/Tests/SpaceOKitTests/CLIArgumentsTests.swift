import XCTest
@testable import SpaceOKit

/// Regression coverage for the greedy-flag bug: boolean flags used to consume the next positional
/// because the parser had no idea which flags took a value. `spaceo pool --json set 4` parsed as
/// `flags["json"] = "set"` with positional `["4"]`, so the subcommand was skipped, `--json` was
/// ignored, and the command still exited 0.
final class CLIArgumentsTests: XCTestCase {

    // MARK: - The exact reproductions from the report

    func testBooleanFlagBeforePositionalDoesNotSwallowIt() {
        let args = CLIArguments(["--web", "hello"])
        XCTAssertEqual(args.positional, ["hello"])
        XCTAssertTrue(args.bool("web"))
        XCTAssertNil(args.string("web"))
    }

    func testJSONFlagBeforeSubcommandDoesNotSwallowIt() {
        let args = CLIArguments(["--json", "list"])
        XCTAssertEqual(args.positional, ["list"])
        XCTAssertTrue(args.hasJSON)
    }

    /// The silent-success case: `pool --json set 4` must still reach `pool.configure` with 4.
    func testPoolSetParsesWithLeadingJSONFlag() {
        let args = CLIArguments(["--json", "set", "4"])
        XCTAssertTrue(args.hasJSON)
        XCTAssertEqual(args.positional, ["set", "4"])
        XCTAssertEqual(args.positional.first, "set")
        XCTAssertEqual(args.positional.dropFirst().first.flatMap { Int($0) }, 4)
    }

    func testTrailingBooleanFlagStillParses() {
        let args = CLIArguments(["hello", "--web"])
        XCTAssertEqual(args.positional, ["hello"])
        XCTAssertTrue(args.bool("web"))
    }

    // MARK: - Every command, both orderings

    /// Builds `<boolean flags> <positionals>` and the reverse for each command in the spec and
    /// asserts both parse identically. This is the property the old parser broke, and it is
    /// derived from `CLISpec` so a newly added command is covered automatically.
    func testFlagBeforePositionalForEveryCommand() {
        let positionals = ["alpha", "beta"]
        for (command, allowed) in CLISpec.allowedFlags {
            let booleans = allowed.intersection(CLISpec.booleanFlags).sorted()
            guard !booleans.isEmpty else { continue }
            let tokens = booleans.map { "--\($0)" }

            let flagsFirst = CLIArguments(tokens + positionals)
            let flagsLast = CLIArguments(positionals + tokens)

            XCTAssertEqual(flagsFirst.positional, positionals,
                           "\(command): leading \(tokens) swallowed a positional")
            XCTAssertEqual(flagsLast.positional, positionals, "\(command)")
            for name in booleans {
                XCTAssertTrue(flagsFirst.bool(name), "\(command): --\(name) lost when leading")
                XCTAssertTrue(flagsLast.bool(name), "\(command): --\(name) lost when trailing")
            }
            XCTAssertEqual(flagsFirst.suppliedNames, flagsLast.suppliedNames, "\(command)")
        }
    }

    /// Value flags placed before positionals must still take their value and leave the
    /// positionals alone.
    func testValueFlagBeforePositionalForEveryCommand() {
        for (command, allowed) in CLISpec.allowedFlags {
            let values = allowed.intersection(CLISpec.valueFlags).sorted()
            guard !values.isEmpty else { continue }
            let tokens = values.flatMap { ["--\($0)", "v-\($0)"] }

            let args = CLIArguments(tokens + ["alpha"])
            XCTAssertEqual(args.positional, ["alpha"], "\(command): \(tokens) ate the positional")
            for name in values {
                XCTAssertEqual(args.string(name), "v-\(name)", "\(command): --\(name)")
            }
        }
    }

    // MARK: - The guard that stops this bug coming back

    func testEveryAllowedFlagIsClassified() {
        for (command, allowed) in CLISpec.allowedFlags {
            for name in allowed {
                XCTAssertTrue(
                    CLISpec.knownFlags.contains(name),
                    "\(command) allows --\(name) but CLISpec classifies it as neither boolean "
                    + "nor value-taking, so the parser will guess")
            }
        }
    }

    func testBooleanAndValueFlagsAreDisjoint() {
        XCTAssertEqual(CLISpec.booleanFlags.intersection(CLISpec.valueFlags), [])
    }

    /// Nothing in the spec should be dead weight: every classified flag is reachable by some
    /// command, otherwise the table has drifted from the dispatch switch.
    func testEveryClassifiedFlagIsUsedBySomeCommand() {
        let used = CLISpec.allowedFlags.values.reduce(into: Set<String>()) { $0.formUnion($1) }
        XCTAssertEqual(CLISpec.knownFlags.subtracting(used), [])
    }

    // MARK: - Values that look like flags

    func testNegativeNumbersAreAcceptedAsValues() {
        let args = CLIArguments(["--x", "10", "--y", "20", "--dy", "-600", "--dx", "-0.5"])
        XCTAssertEqual(args.int("dy"), -600)
        XCTAssertEqual(args.double("dx"), -0.5)
        XCTAssertEqual(args.double("x"), 10)
        XCTAssertTrue(args.positional.isEmpty)
    }

    func testScrollFlagsBeforePositionalKeepNegativeValues() {
        let args = CLIArguments(["--dy", "-600", "--web", "leftover"])
        XCTAssertEqual(args.int("dy"), -600)
        XCTAssertTrue(args.bool("web"))
        XCTAssertEqual(args.positional, ["leftover"])
    }

    func testBareNegativeNumberIsPositionalNotFlag() {
        let args = CLIArguments(["-5"])
        XCTAssertEqual(args.positional, ["-5"])
        XCTAssertTrue(args.suppliedNames.isEmpty)
    }

    func testShortValueFlagStillTakesItsValue() {
        let args = CLIArguments(["-o", "/tmp/shot.png"])
        XCTAssertEqual(args.string("output", "o"), "/tmp/shot.png")
        XCTAssertTrue(args.positional.isEmpty)
    }

    /// The short branch used to consume unconditionally, so an unknown short flag ate the
    /// positional. Now it registers as an unknown switch that `validateFlags` will reject.
    func testUnknownShortFlagDoesNotConsumePositional() {
        let args = CLIArguments(["-w", "hello"])
        XCTAssertEqual(args.positional, ["hello"])
        XCTAssertTrue(args.wasSupplied("w"))
        XCTAssertFalse(CLISpec.knownFlags.contains("w"))
    }

    /// A value flag must not silently eat the *next flag* as its value.
    func testValueFlagStopsAtNextKnownFlag() {
        let args = CLIArguments(["--output", "--full"])
        XCTAssertNil(args.string("output"))
        XCTAssertTrue(args.wasSupplied("output"), "--output must still count as supplied")
        XCTAssertTrue(args.bool("full"), "--full must not be swallowed as --output's value")
    }

    func testValueFlagAtEndOfArgvIsSuppliedWithoutValue() {
        let args = CLIArguments(["--session"])
        XCTAssertNil(args.string("session"))
        XCTAssertTrue(args.wasSupplied("session"))
    }

    // MARK: - Explicit forms

    func testEqualsFormForcesValue() {
        let args = CLIArguments(["--session=--weird-name", "positional"])
        XCTAssertEqual(args.string("session"), "--weird-name")
        XCTAssertEqual(args.positional, ["positional"])
    }

    func testEqualsFormOnBooleanFlag() {
        XCTAssertTrue(CLIArguments(["--json=true"]).hasJSON)
        XCTAssertFalse(CLIArguments(["--json=false"]).hasJSON)
        XCTAssertTrue(CLIArguments(["--json=false"]).wasSupplied("json"),
                      "--json=false is still an explicit choice")
    }

    /// `--json=1` used to be indistinguishable from "not supplied". It is now reported so the
    /// CLI can fail instead of quietly emitting prose with exit 0.
    func testMalformedBooleanValueIsReported() {
        XCTAssertEqual(CLIArguments(["--json=1"]).malformedBooleanValues, ["json"])
        XCTAssertEqual(CLIArguments(["--json=true"]).malformedBooleanValues, [])
        XCTAssertEqual(CLIArguments(["--session=1"]).malformedBooleanValues, [])
    }

    func testEqualsFormWithValueContainingEquals() {
        XCTAssertEqual(CLIArguments(["--session=a=b"]).string("session"), "a=b")
    }

    func testDoubleDashPassesEverythingThrough() {
        let args = CLIArguments(["--json", "--", "--web", "-o", "text"])
        XCTAssertTrue(args.hasJSON)
        XCTAssertEqual(args.positional, ["--web", "-o", "text"])
        XCTAssertFalse(args.bool("web"))
    }

    // MARK: - Real command lines from the README and usage text

    func testDocumentedInvocationsParse() {
        let type = CLIArguments(["--web", "hello from an agent"])
        XCTAssertEqual(type.positional.first, "hello from an agent")
        XCTAssertTrue(type.bool("web"))

        let key = CLIArguments(["--web", "cmd+s"])
        XCTAssertEqual(key.positional.first, "cmd+s")

        let destroy = CLIArguments(["--all", "--keep-apps", "--session", "research"])
        XCTAssertTrue(destroy.bool("all"))
        XCTAssertTrue(destroy.bool("keep-apps"))
        XCTAssertEqual(destroy.string("session"), "research")

        let run = CLIArguments(["--json", "TextEdit", "~/notes.txt"])
        XCTAssertTrue(run.hasJSON)
        XCTAssertEqual(run.positional, ["TextEdit", "~/notes.txt"])

        let screenshot = CLIArguments(["--full", "-o", "/tmp/agent.png", "--scale", "2"])
        XCTAssertTrue(screenshot.bool("full"))
        XCTAssertEqual(screenshot.string("output", "o"), "/tmp/agent.png")
        XCTAssertEqual(screenshot.int("scale"), 2)

        let demo = CLIArguments(["--keep", "--no-capture", "--app", "TextEdit", "--sessions", "2"])
        XCTAssertTrue(demo.bool("keep"))
        XCTAssertTrue(demo.bool("no-capture"))
        XCTAssertEqual(demo.string("app"), "TextEdit")
        XCTAssertEqual(demo.int("sessions"), 2)

        let click = CLIArguments(["--element", "3", "--modifiers", "cmd,shift", "--count", "2"])
        XCTAssertEqual(click.string("element"), "3")
        XCTAssertEqual(click.string("modifiers"), "cmd,shift")
        XCTAssertEqual(click.int("count"), 2)
    }
}
