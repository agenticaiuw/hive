import Foundation
import XCTest
@testable import SpaceOKit

/// RA-057: every display identity leaves permanent ColorSync and WindowServer state, so identities
/// must come from a bounded set that survives process restarts. These tests use a temporary
/// generations file and plain objects in place of displays; nothing touches the display server.
final class DisplayIdentityAllocatorTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-identities-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var path: String { directory.appendingPathComponent("display-identities.json").path }

    func testSerialIsAPureNonzeroFunctionOfGeometrySlotAndGeneration() {
        let key = DisplayIdentityAllocator.key(width: 1_920, height: 1_080, hiDPI: true)
        XCTAssertEqual(key, "1920x1080@2")
        let serial = DisplayIdentityAllocator.serial(key: key, slot: 0, generation: 0)
        XCTAssertNotEqual(serial, 0)
        XCTAssertEqual(serial, DisplayIdentityAllocator.serial(key: key, slot: 0, generation: 0),
                       "a restarted daemon must derive the same identity")
        XCTAssertNotEqual(serial, DisplayIdentityAllocator.serial(key: key, slot: 1, generation: 0))
        XCTAssertNotEqual(serial, DisplayIdentityAllocator.serial(key: key, slot: 0, generation: 1))
        XCTAssertNotEqual(serial, DisplayIdentityAllocator.serial(key: "1920x1080@1", slot: 0, generation: 0))
    }

    func testEverySlotOfACommonGeometryHasADistinctSerial() {
        for key in ["1920x1080@2", "1920x1080@1", "2560x1440@2", "1280x800@2"] {
            let serials = (0..<DisplayIdentityAllocator.slotCount).map {
                DisplayIdentityAllocator.serial(key: key, slot: $0, generation: 0)
            }
            XCTAssertEqual(Set(serials).count, serials.count, key)
        }
    }

    func testSequentialLifecyclesReuseOneIdentity() throws {
        let allocator = DisplayIdentityAllocator(path: path)
        var serials = Set<UInt32>()
        for _ in 0..<100 {
            let identity = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true,
                                                         onlineSerials: []))
            autoreleasepool {
                let display = NSObject()
                allocator.bind(identity, to: display)
            }
            serials.insert(identity.serial)
        }
        XCTAssertEqual(serials.count, 1, "a display that is gone frees its identity for the next one")
    }

    func testLiveDisplaysAndPendingClaimsHoldTheirSlots() throws {
        let allocator = DisplayIdentityAllocator(path: path)
        let first = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        let pending = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        XCTAssertEqual([first.slot, pending.slot], [0, 1], "an unbound claim is still busy")

        let display = NSObject()
        allocator.bind(first, to: display)
        let third = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        XCTAssertEqual(third.slot, 2)

        allocator.abandon(pending)
        allocator.abandon(first)
        XCTAssertEqual(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: [])?.slot, 1,
                       "abandon frees an unbound claim but never a bound display")
        withExtendedLifetime(display) {}
    }

    func testIdentitiesOnlineInAnyProcessAreSkipped() throws {
        let other = DisplayIdentityAllocator(path: path)
        let online: Set<UInt32> = [
            try XCTUnwrap(try other.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: [])).serial,
            try XCTUnwrap(try other.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: [])).serial,
        ]
        let allocator = DisplayIdentityAllocator(path: path)
        let identity = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true,
                                                         onlineSerials: online))
        XCTAssertEqual(identity.slot, 2)
        XCTAssertFalse(online.contains(identity.serial))
    }

    func testANewIdentityNeverTakesASerialAlreadyOnline() throws {
        let key = DisplayIdentityAllocator.key(width: 1_920, height: 1_080, hiDPI: true)
        let foreign = DisplayIdentityAllocator.serial(key: key, slot: 0, generation: 0)
        let allocator = DisplayIdentityAllocator(path: path)
        let identity = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true,
                                                         onlineSerials: [foreign]))
        XCTAssertNotEqual(identity.serial, foreign, "for example a display from an older version")
    }

    func testGeometriesHaveIndependentSlots() throws {
        let allocator = DisplayIdentityAllocator(path: path)
        let small = try XCTUnwrap(try allocator.claim(width: 1_280, height: 800, hiDPI: true, onlineSerials: []))
        let large = try XCTUnwrap(try allocator.claim(width: 2_560, height: 1_440, hiDPI: true, onlineSerials: []))
        XCTAssertEqual([small.slot, large.slot], [0, 0])
        XCTAssertNotEqual(small.serial, large.serial)
    }

    func testAllSlotsBusyRefusesInsteadOfMintingAnIdentity() throws {
        let allocator = DisplayIdentityAllocator(path: path)
        for _ in 0..<DisplayIdentityAllocator.slotCount {
            XCTAssertNotNil(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        }
        XCTAssertNil(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
    }

    func testRotationRetiresAPoisonedIdentityAcrossRestarts() throws {
        let allocator = DisplayIdentityAllocator(path: path)
        let poisoned = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        XCTAssertTrue(allocator.rotate(poisoned))
        XCTAssertTrue(allocator.rotate(poisoned), "a stale rotation is a no-op, not a second bump")
        allocator.abandon(poisoned)

        let restarted = DisplayIdentityAllocator(path: path)
        XCTAssertEqual(try restarted.generation(key: poisoned.key, slot: 0), 1)
        let next = try XCTUnwrap(try restarted.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        XCTAssertEqual(next.slot, 0)
        XCTAssertEqual(next.generation, 1)
        XCTAssertNotEqual(next.serial, poisoned.serial)

        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testAnExistingRecordThatCannotBeValidatedRefusesCreation() throws {
        let key = DisplayIdentityAllocator.key(width: 1_920, height: 1_080, hiDPI: true)
        for contents in ["not json", #"{"version":2,"generations":{},"serials":{}}"#,
                         #"{"version":1,"generations":{"1920x1080@2/0":-3},"serials":{}}"#,
                         #"{"version":1,"generations":{},"serials":{"a/0/0":7,"b/0/0":7}}"#,
                         #"{"version":1,"generations":{}}"#] {
            try Data(contents.utf8).write(to: URL(fileURLWithPath: path))
            let allocator = DisplayIdentityAllocator(path: path)
            XCTAssertThrowsError(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []),
                                 contents) {
                XCTAssertEqual($0 as? DisplayIdentityAllocator.RecordError, .unreadable(path), contents)
            }
            XCTAssertFalse(allocator.rotate(.init(key: key, slot: 0, generation: 0, serial: 1)), contents)
        }
        // Moving the record aside takes effect without a restart.
        let allocator = DisplayIdentityAllocator(path: path)
        XCTAssertThrowsError(try allocator.generation(key: key, slot: 0))
        try FileManager.default.removeItem(atPath: path)
        XCTAssertEqual(try allocator.generation(key: key, slot: 0), 0)
        try Data(#"{"version":1,"generations":{"1920x1080@2/0":4},"serials":{}}"#.utf8)
            .write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(try DisplayIdentityAllocator(path: path).generation(key: key, slot: 0), 4)
    }

    func testDistinctIdentitiesNeverShareASerialAcrossRestarts() throws {
        // These two sizes hash to the same unsalted serial at slot 0, generation 0.
        XCTAssertEqual(DisplayIdentityAllocator.serial(key: "7210x4000@1", slot: 0, generation: 0),
                       DisplayIdentityAllocator.serial(key: "330x5800@2", slot: 0, generation: 0))
        let allocator = DisplayIdentityAllocator(path: path)
        let first = try XCTUnwrap(try allocator.claim(width: 7_210, height: 4_000, hiDPI: false, onlineSerials: []))
        allocator.abandon(first)
        let restarted = DisplayIdentityAllocator(path: path)
        let second = try XCTUnwrap(try restarted.claim(width: 330, height: 5_800, hiDPI: true, onlineSerials: []))
        XCTAssertNotEqual(first.serial, second.serial)
        restarted.abandon(second)
        let again = DisplayIdentityAllocator(path: path)
        XCTAssertEqual(try again.claim(width: 7_210, height: 4_000, hiDPI: false, onlineSerials: [])?.serial,
                       first.serial)
        XCTAssertEqual(try again.claim(width: 330, height: 5_800, hiDPI: true, onlineSerials: [])?.serial,
                       second.serial, "an issued serial is recorded, not re-derived")
    }

    func testRecordedIdentitiesAreBounded() throws {
        let allocator = DisplayIdentityAllocator(path: nil)
        for width in 0..<DisplayIdentityAllocator.maximumIdentities {
            let identity = try XCTUnwrap(try allocator.claim(width: UInt32(100 + width), height: 100, hiDPI: false,
                                                             onlineSerials: []))
            allocator.abandon(identity)
        }
        XCTAssertThrowsError(try allocator.claim(width: 99, height: 100, hiDPI: false, onlineSerials: [])) {
            XCTAssertEqual($0 as? DisplayIdentityAllocator.RecordError, .full)
        }
        XCTAssertNotNil(try allocator.claim(width: 100, height: 100, hiDPI: false, onlineSerials: []),
                        "an identity already recorded is still offered")
    }

    func testAFullRecordStillOffersALaterSlotsRecordedIdentity() throws {
        var serials: [String: Int] = ["1920x1080@2/1/0": 77]
        for index in 0..<(DisplayIdentityAllocator.maximumIdentities - 1) { serials["filler\(index)/0/0"] = 1_000 + index }
        let record: [String: Any] = ["version": 1, "generations": ["1920x1080@2/0": 1], "serials": serials]
        try JSONSerialization.data(withJSONObject: record).write(to: URL(fileURLWithPath: path))
        let allocator = DisplayIdentityAllocator(path: path)
        let identity = try XCTUnwrap(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: []))
        XCTAssertEqual(identity.slot, 1, "slot 0's retired identity has no room for a new serial; slot 1 is reusable")
        XCTAssertEqual(identity.serial, 77)
        XCTAssertThrowsError(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: [])) {
            XCTAssertEqual($0 as? DisplayIdentityAllocator.RecordError, .full)
        }
    }

    func testAnUnsavableRecordRefusesANewIdentity() throws {
        let locked = directory.appendingPathComponent("locked")
        try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
        let allocator = DisplayIdentityAllocator(path: locked.appendingPathComponent("display-identities.json").path)
        XCTAssertThrowsError(try allocator.claim(width: 1_920, height: 1_080, hiDPI: true, onlineSerials: [])) {
            guard case .unsaved = $0 as? DisplayIdentityAllocator.RecordError else { return XCTFail("\($0)") }
        }
    }
}

/// Doctor counts SpaceO's leftover ColorSync profiles by their `mmod` tag, not by file name.
final class DisplayIdentityResidueTests: XCTestCase {
    private func profile(vendor: UInt32, product: UInt32, tagged: Bool = true) -> Data {
        func word(_ value: UInt32) -> [UInt8] { withUnsafeBytes(of: value.bigEndian, Array.init) }
        var bytes = [UInt8](repeating: 0, count: 128)
        bytes += word(tagged ? 2 : 1)
        bytes += word(0x6465_7363) + word(200) + word(12)       // 'desc', ignored
        if tagged { bytes += word(0x6D6D_6F64) + word(156) + word(40) }  // 'mmod'
        bytes += [UInt8](repeating: 0, count: 156 - bytes.count)
        bytes += word(0x6D6D_6F64) + word(0) + word(vendor) + word(product) + word(42)
        bytes += [UInt8](repeating: 0, count: 64)
        return Data(bytes)
    }

    func testATruncatedScanIsNeverReportedAsBounded() {
        let residue = DisplayIdentityResidue(spaceOProfiles: 3, totalProfiles: 5_000, truncated: true, registryBytes: nil)
        XCTAssertTrue(residue.needsCleanup)
        XCTAssertFalse(residue.summary.contains("bounded"))
        XCTAssertTrue(residue.summary.contains("incomplete; it found at least 3 SpaceO"), residue.summary)
        XCTAssertFalse(residue.summary.contains("4096"), "an incomplete scan claims no directory size")
    }

    func testProfileListingStopsAtItsBound() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-listing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for index in 0..<10 { try Data().write(to: directory.appendingPathComponent("\(index).icc")) }
        for index in 0..<10 { try Data().write(to: directory.appendingPathComponent("\(index).txt")) }
        let all = try DisplayIdentityResidue.profileNames(in: directory.path, maximum: 10, maximumEntries: 20)
        XCTAssertEqual(all.names.count, 10)
        XCTAssertFalse(all.truncated)
        let profiles = try DisplayIdentityResidue.profileNames(in: directory.path, maximum: 3, maximumEntries: 100)
        XCTAssertEqual(profiles.names.count, 3)
        XCTAssertTrue(profiles.truncated)
        XCTAssertTrue(try DisplayIdentityResidue.profileNames(in: directory.path, maximum: 100, maximumEntries: 5).truncated)
        XCTAssertThrowsError(try DisplayIdentityResidue.profileNames(in: directory.appendingPathComponent("none").path))
    }

    func testParsesTheMakeAndModelTag() throws {
        let model = try XCTUnwrap(DisplayIdentityResidue.displayModel(profile: profile(vendor: 0x1AF2, product: 1)))
        XCTAssertEqual(model.vendor, 0x1AF2)
        XCTAssertEqual(model.product, 1)
        XCTAssertNil(DisplayIdentityResidue.displayModel(profile: profile(vendor: 0x1AF2, product: 1, tagged: false)))
        XCTAssertNil(DisplayIdentityResidue.displayModel(profile: Data([0, 1, 2])))
        var truncated = profile(vendor: 0x1AF2, product: 1)
        truncated.removeLast(70)
        XCTAssertNil(DisplayIdentityResidue.displayModel(profile: truncated))
    }

    func testScanCountsOnlySpaceOProfilesAndFlagsAccumulation() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-residue-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for index in 0..<70 {
            try profile(vendor: 0x1AF2, product: 1).write(to: directory.appendingPathComponent("test-\(index).icc"))
        }
        try profile(vendor: 0x610, product: 0xA05E).write(to: directory.appendingPathComponent("Color LCD.icc"))
        try profile(vendor: 0x1AF2, product: 2).write(to: directory.appendingPathComponent("SpaceO display 1.icc"))
        try Data("x".utf8).write(to: directory.appendingPathComponent("notes.txt"))
        let registry = directory.appendingPathComponent("registry")
        try Data(count: 4_096).write(to: registry)

        let residue = try XCTUnwrap(DisplayIdentityResidue.scan(directory: directory.path, registry: registry.path))
        XCTAssertEqual(residue.spaceOProfiles, 70)
        XCTAssertEqual(residue.totalProfiles, 72)
        XCTAssertEqual(residue.registryBytes, 4_096)
        XCTAssertTrue(residue.needsCleanup)
        XCTAssertTrue(residue.summary.contains("docs/DISPLAY_SAFETY.md#display-identity-residue"))
        XCTAssertNil(DisplayIdentityResidue.scan(directory: directory.appendingPathComponent("missing").path))
    }
}

/// The owner-run cleanup touches only SpaceO's registrations, backs up first, and judges success
/// by a fresh listing, never by ColorSync's return value. ColorSync itself is replaced here.
final class DisplayIdentityCleanupTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-cleanup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("Displays"),
                                                withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func writeProfile(_ name: String, vendor: UInt32, product: UInt32) throws -> String {
        func word(_ value: UInt32) -> [UInt8] { withUnsafeBytes(of: value.bigEndian, Array.init) }
        var bytes = [UInt8](repeating: 0, count: 128) + word(1) + word(0x6D6D_6F64) + word(144) + word(40)
        bytes += word(0x6D6D_6F64) + word(0) + word(vendor) + word(product) + [UInt8](repeating: 0, count: 40)
        let url = directory.appendingPathComponent("Displays/\(name).icc")
        try Data(bytes).write(to: url)
        return url.path
    }

    private final class FakeColorSync {
        var registrations: [DisplayIdentityCleanup.Registration] = []
        var ignoresUnregister = false
        var unregistered: [String] = []
        var displays = [DisplayIdentityCleanup.DisplayInventory(spaceO: 0, other: 1)]
        var displayReads = 0
        var listingFails = false
        var listingFailsAfterUnregister = false
        var locked = false
        var lockHeldDuringRemoval = true
        var lockRefused = false
        var undeletable: Set<String> = []
    }

    private func environment(_ colorSync: FakeColorSync, root: Bool = true, processRunning: Bool = false,
                             registry: Bool = true) -> DisplayIdentityCleanup.Environment {
        let registryURL = directory.appendingPathComponent("registry")
        if registry { try? Data(count: 512).write(to: registryURL) }
        return DisplayIdentityCleanup.Environment(
            registrations: {
                if colorSync.listingFails { throw DisplayIdentityCleanup.Failure.listingTruncated }
                if colorSync.listingFailsAfterUnregister, !colorSync.unregistered.isEmpty {
                    throw DisplayIdentityCleanup.Failure.listingTruncated
                }
                return colorSync.registrations
            },
            unregister: { registration in
                colorSync.unregistered.append(registration.deviceID)
                if !colorSync.ignoresUnregister {
                    colorSync.registrations.removeAll { $0.deviceID == registration.deviceID }
                }
            },
            profileDirectory: directory.appendingPathComponent("Displays").path,
            registryPath: registryURL.path,
            isRoot: { root },
            spaceOProcessRunning: { processRunning },
            displays: {
                defer { colorSync.displayReads += 1 }
                return colorSync.displays[min(colorSync.displayReads, colorSync.displays.count - 1)]
            },
            acquireExclusion: {
                if colorSync.lockRefused { throw DisplayIdentityCleanup.Failure.spaceOProcessRunning }
                colorSync.locked = true
                return { colorSync.locked = false }
            },
            removeProfile: { path in
                if !colorSync.locked { colorSync.lockHeldDuringRemoval = false }
                if !colorSync.undeletable.contains(URL(fileURLWithPath: path).lastPathComponent) {
                    try? FileManager.default.removeItem(atPath: path)
                }
            })
    }

    private func fixture() throws -> FakeColorSync {
        let colorSync = FakeColorSync()
        let spaceO = try writeProfile("SpaceO display 1-A", vendor: 0x1AF2, product: 1)
        let test = try writeProfile("test-multi-1-B", vendor: 0x1AF2, product: 1)
        let builtIn = try writeProfile("Color LCD-C", vendor: 0x610, product: 0xA05E)
        let otherTool = try writeProfile("Other-D", vendor: 0x1AF2, product: 2)
        _ = try writeProfile("SpaceO display 2-E", vendor: 0x1AF2, product: 1)  // no registration
        let assigned = try writeProfile("Assigned-G", vendor: 0x1AF2, product: 1)
        colorSync.registrations = [
            .init(deviceClass: "mntr", deviceID: "A", profilePath: spaceO, isFactory: true),
            .init(deviceClass: "mntr", deviceID: "A", profilePath: builtIn),  // custom profile on a SpaceO device
            .init(deviceClass: "mntr", deviceID: "B", profilePath: test, isFactory: true),
            .init(deviceClass: "mntr", deviceID: "C", profilePath: builtIn, isFactory: true),
            .init(deviceClass: "mntr", deviceID: "D", profilePath: otherTool, isFactory: true),
            .init(deviceClass: "mntr", deviceID: "F", profilePath: nil),
            .init(deviceClass: "mntr", deviceID: "G", profilePath: assigned),  // a person assigned a SpaceO profile
        ]
        return colorSync
    }

    func testPlanSelectsOnlySpaceORegistrationsAndProfiles() throws {
        let colorSync = try fixture()
        let plan = try DisplayIdentityCleanup.plan(environment(colorSync))
        XCTAssertEqual(plan.registrations.map(\.deviceID), ["A", "B"],
                       "G only has a SpaceO profile a person assigned; it is not a SpaceO device")
        XCTAssertEqual(plan.profilePaths.map { URL(fileURLWithPath: $0).lastPathComponent },
                       ["Assigned-G.icc", "SpaceO display 1-A.icc", "SpaceO display 2-E.icc", "test-multi-1-B.icc"])
        XCTAssertEqual(plan.unattributedWithoutProfile, 1, "a registration without a profile is left alone")
    }

    func testApplyRefusesUnlessRootQuiescentAndBackedUp() throws {
        let backupRoot = directory.appendingPathComponent("b").path
        func refusal(_ environment: DisplayIdentityCleanup.Environment) -> DisplayIdentityCleanup.Failure? {
            do { _ = try DisplayIdentityCleanup.apply(environment, backupRoot: backupRoot); return nil }
            catch { return error as? DisplayIdentityCleanup.Failure }
        }
        let colorSync = try fixture()
        XCTAssertEqual(refusal(environment(colorSync, root: false)), .requiresRoot)
        colorSync.lockRefused = true
        XCTAssertEqual(refusal(environment(colorSync)), .spaceOProcessRunning, "a lifecycle owner holds the lock")
        colorSync.lockRefused = false
        XCTAssertEqual(refusal(environment(colorSync, processRunning: true)), .spaceOProcessRunning)
        colorSync.displays = [.init(spaceO: 1, other: 1)]
        XCTAssertEqual(refusal(environment(colorSync)), .spaceODisplayOnline)
        colorSync.displays = [.init(spaceO: 0, other: 0)]
        XCTAssertEqual(refusal(environment(colorSync)), .noDisplays, "an empty inventory is not proof of quiet")
        colorSync.displays = [.init(spaceO: 0, other: 1)]
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("registry"))
        XCTAssertEqual(refusal(environment(colorSync, registry: false)), .registryMissing)
        colorSync.listingFails = true
        XCTAssertEqual(refusal(environment(colorSync)), .listingTruncated)
        XCTAssertTrue(colorSync.unregistered.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: backupRoot))
    }

    func testADisplayAppearingDuringCleanupKeepsEveryProfile() throws {
        let colorSync = try fixture()
        colorSync.displays = [.init(spaceO: 0, other: 1), .init(spaceO: 1, other: 1)]
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertTrue(outcome.profileRemovalSkipped)
        XCTAssertFalse(outcome.confirmed)
        XCTAssertEqual(outcome.movedProfiles, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: directory.appendingPathComponent("Displays").path).count, 6)
    }

    func testEveryProfileOfASurvivingRegistrationIsKept() throws {
        let colorSync = try fixture()
        let second = try writeProfile("SpaceO display 1-A2", vendor: 0x1AF2, product: 1)
        colorSync.registrations.append(.init(deviceClass: "mntr", deviceID: "A", profilePath: second, isFactory: true))
        colorSync.ignoresUnregister = true
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertEqual(outcome.remainingRegistrations, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: second), "a device's second profile is still referenced")
        XCTAssertEqual(outcome.movedProfiles, 1)
    }

    func testApplyBacksUpUnregistersAndRemovesSpaceOProfiles() throws {
        let colorSync = try fixture()
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertTrue(outcome.confirmed)
        XCTAssertEqual(colorSync.unregistered, ["A", "B"])
        XCTAssertEqual(outcome.unregistered, 2)
        XCTAssertEqual(outcome.movedProfiles, 3)
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("Displays").path)
        XCTAssertEqual(Set(left), ["Color LCD-C.icc", "Other-D.icc", "Assigned-G.icc"],
                       "a SpaceO profile assigned to another device stays with it")
        let backedUp = try FileManager.default.contentsOfDirectory(atPath: outcome.backup + "/Profiles")
        XCTAssertEqual(backedUp.count, 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: outcome.backup + "/com.apple.colorsync.devices"))
    }

    func testIgnoredUnregistrationIsReportedAndKeepsItsProfiles() throws {
        let colorSync = try fixture()
        colorSync.ignoresUnregister = true
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertFalse(outcome.confirmed, "ColorSync's success is never trusted without a fresh listing")
        XCTAssertEqual(outcome.remainingRegistrations, 2)
        XCTAssertEqual(outcome.unregistered, 0)
        XCTAssertEqual(outcome.movedProfiles, 1, "only the unregistered orphan profile is removed")
    }

    func testTheLifecycleLockIsHeldThroughProfileRemovalAndReleased() throws {
        let colorSync = try fixture()
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertTrue(outcome.confirmed)
        XCTAssertTrue(colorSync.lockHeldDuringRemoval)
        XCTAssertFalse(colorSync.locked)
    }

    func testAProfileThatCannotBeRemovedIsReported() throws {
        let colorSync = try fixture()
        colorSync.undeletable = ["test-multi-1-B.icc"]
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertEqual(outcome.remainingRegistrations, 0)
        XCTAssertEqual(outcome.failedProfiles.map { URL(fileURLWithPath: $0).lastPathComponent }, ["test-multi-1-B.icc"])
        XCTAssertFalse(outcome.confirmed)
    }

    func testAnUnlistableProfileDirectoryRefuses() throws {
        let colorSync = try fixture()
        let displays = directory.appendingPathComponent("Displays")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: displays.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: displays.path) }
        XCTAssertThrowsError(try DisplayIdentityCleanup.plan(environment(colorSync))) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .profileInventoryUnreadable)
        }
    }

    func testTooManyProfilesRefusesInsteadOfCleaningAPrefix() throws {
        let colorSync = FakeColorSync()
        for index in 0...DisplayIdentityResidue.maximumProfiles {
            try Data().write(to: directory.appendingPathComponent("Displays/\(index).icc"))
        }
        XCTAssertThrowsError(try DisplayIdentityCleanup.plan(environment(colorSync))) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .profileInventoryTruncated)
        }
    }

    func testAFailedVerificationListingIsReportedAsUnconfirmedAndKeepsProfiles() throws {
        let colorSync = try fixture()
        colorSync.listingFailsAfterUnregister = true
        let outcome = try DisplayIdentityCleanup.apply(environment(colorSync),
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertTrue(outcome.verificationFailed)
        XCTAssertFalse(outcome.confirmed)
        XCTAssertEqual(colorSync.unregistered, ["A", "B"])
        XCTAssertEqual(outcome.movedProfiles, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: outcome.backup + "/com.apple.colorsync.devices"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(
            atPath: directory.appendingPathComponent("Displays").path).count, 6)
    }

    func testARegistryThatIsNotABoundedRegularFileIsNotCopied() throws {
        let colorSync = try fixture()
        var environment = environment(colorSync)
        let registry = directory.appendingPathComponent("registry-directory")
        try FileManager.default.createDirectory(at: registry, withIntermediateDirectories: true)
        environment.registryPath = registry.path
        XCTAssertThrowsError(try DisplayIdentityCleanup.apply(environment,
                                                              backupRoot: directory.appendingPathComponent("b").path)) {
            guard case .backupFailed = $0 as? DisplayIdentityCleanup.Failure else { return XCTFail("\($0)") }
        }
        XCTAssertTrue(colorSync.unregistered.isEmpty)
    }

    func testEveryColorSyncCallbackCountsTowardTheListingLimit() {
        let collector = DisplayIdentityCleanup.Collector()
        let printer: [String: Any] = [kColorSyncDeviceClass.takeUnretainedValue() as String: "prtr"]
        var stopped = false
        for _ in 0...DisplayIdentityCleanup.Collector.limit where !collector.accept(printer) { stopped = true }
        XCTAssertTrue(stopped)
        XCTAssertTrue(collector.truncated)
        XCTAssertTrue(collector.registrations.isEmpty)
        let display: [String: Any] = [
            kColorSyncDeviceClass.takeUnretainedValue() as String: kColorSyncDisplayDeviceClass.takeUnretainedValue() as String,
            kColorSyncDeviceID.takeUnretainedValue() as String: CFUUIDCreate(nil) as Any,
            kColorSyncDeviceProfileURL.takeUnretainedValue() as String: URL(fileURLWithPath: "/tmp/x.icc"),
            kColorSyncDeviceProfileIsFactory.takeUnretainedValue() as String: true,
        ]
        let fresh = DisplayIdentityCleanup.Collector()
        XCTAssertTrue(fresh.accept(display))
        XCTAssertEqual(fresh.registrations.first?.profilePath, "/tmp/x.icc")
        XCTAssertEqual(fresh.registrations.first?.isFactory, true)
    }

    func testAPlannedDeviceStillListedWithChangedMetadataIsNotConfirmed() throws {
        let colorSync = try fixture()
        let profileA = directory.appendingPathComponent("Displays/SpaceO display 1-A.icc").path
        var environment = environment(colorSync)
        let unregister = environment.unregister
        environment.unregister = { registration in
            unregister(registration)
            if registration.deviceID == "A" {
                // Still registered, but now listed without its profile.
                colorSync.registrations.append(.init(deviceClass: "mntr", deviceID: "A", profilePath: nil))
            }
        }
        let outcome = try DisplayIdentityCleanup.apply(environment,
                                                       backupRoot: directory.appendingPathComponent("backup").path)
        XCTAssertEqual(outcome.remainingRegistrations, 1)
        XCTAssertFalse(outcome.confirmed)
        XCTAssertTrue(FileManager.default.fileExists(atPath: profileA), "the surviving device keeps its profile")
    }

    func testTheProfileScanHasATotalReadBudget() throws {
        _ = try fixture()
        let displays = directory.appendingPathComponent("Displays").path
        let complete = try DisplayIdentityResidue.spaceOProfiles(in: displays)
        XCTAssertFalse(complete.truncated)
        XCTAssertEqual(complete.paths.count, 4)
        let partial = try DisplayIdentityResidue.spaceOProfiles(in: displays, budget: 300)
        XCTAssertTrue(partial.truncated)
        XCTAssertLessThan(partial.examined, 6)
    }

    func testAnUnreadableProfileIsNeverTreatedAsExamined() throws {
        let colorSync = try fixture()
        let hidden = directory.appendingPathComponent("Displays/SpaceO display 2-E.icc").path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: hidden)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: hidden) }
        XCTAssertThrowsError(try DisplayIdentityCleanup.plan(environment(colorSync))) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .profileInventoryUnreadable)
        }
        let residue = try XCTUnwrap(DisplayIdentityResidue.scan(directory: directory.appendingPathComponent("Displays").path))
        XCTAssertTrue(residue.truncated, "an unreadable profile makes the count a lower bound")
    }

    func testAnOversizedProfileIsNotBackedUpOrCleaned() throws {
        let colorSync = try fixture()
        let path = directory.appendingPathComponent("Displays/SpaceO display 1-A.icc")
        var data = try Data(contentsOf: path)
        data.append(Data(count: DisplayIdentityCleanup.maximumProfileBytes))
        try data.write(to: path)
        XCTAssertThrowsError(try DisplayIdentityCleanup.apply(environment(colorSync),
                                                              backupRoot: directory.appendingPathComponent("b").path)) {
            guard case .backupFailed = $0 as? DisplayIdentityCleanup.Failure else { return XCTFail("\($0)") }
        }
        XCTAssertTrue(colorSync.unregistered.isEmpty)
    }

    func testRegistrationProfilesAreReadOnceAndWithinABudget() throws {
        let colorSync = try fixture()
        let spaceO = colorSync.registrations[0]
        // Many devices listing the same profile read it once.
        let repeated = (0..<5_000).map {
            DisplayIdentityCleanup.Registration(deviceClass: "mntr", deviceID: "R\($0)",
                                                profilePath: spaceO.profilePath, isFactory: true)
        }
        XCTAssertEqual(try DisplayIdentityCleanup.spaceODevices(in: repeated, budget: 1_024).devices.count, 5_000)
        // Distinct profiles beyond the budget refuse instead of reading without bound.
        XCTAssertThrowsError(try DisplayIdentityCleanup.spaceODevices(in: colorSync.registrations, budget: 200)) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .listingTruncated)
        }
    }

    func testABudgetThatShortensTheLastProfileMarksTheScanIncomplete() throws {
        _ = try fixture()
        let displays = directory.appendingPathComponent("Displays").path
        let sizes = try FileManager.default.contentsOfDirectory(atPath: displays).map {
            try FileManager.default.attributesOfItem(atPath: displays + "/" + $0)[.size] as! Int
        }
        let total = sizes.reduce(0, +)
        XCTAssertFalse(try DisplayIdentityResidue.spaceOProfiles(in: displays, budget: total).truncated)
        XCTAssertTrue(try DisplayIdentityResidue.spaceOProfiles(in: displays, budget: total - 10).truncated)
        let colorSync = try fixture()
        XCTAssertThrowsError(try DisplayIdentityCleanup.spaceODevices(in: colorSync.registrations, budget: 300)) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .listingTruncated)
        }
    }

    func testAnUnreadableRegistrationProfileIsLeftAloneAsUnattributed() throws {
        let colorSync = try fixture()
        colorSync.registrations.append(.init(deviceClass: "mntr", deviceID: "H",
                                             profilePath: directory.appendingPathComponent("Displays/gone.icc").path,
                                             isFactory: true))
        let plan = try DisplayIdentityCleanup.plan(environment(colorSync))
        XCTAssertFalse(plan.registrations.map(\.deviceID).contains("H"))
        XCTAssertEqual(plan.unattributedWithoutProfile, 2)
    }

    func testColorSyncListingHasADeadline() {
        XCTAssertThrowsError(try DisplayIdentityCleanup.withDeadline(0.05) { () -> Int in usleep(500_000); return 1 }) {
            XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .listingTimedOut)
        }
        XCTAssertEqual(try DisplayIdentityCleanup.withDeadline(5) { 7 }, 7)
        XCTAssertThrowsError(try DisplayIdentityCleanup.withDeadline(5) { () -> Int in
            throw DisplayIdentityCleanup.Failure.listingTruncated
        }) { XCTAssertEqual($0 as? DisplayIdentityCleanup.Failure, .listingTruncated) }
    }
}
