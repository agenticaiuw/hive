import ApplicationServices
import Foundation

/// Owner-run removal of the ColorSync state that per-attachment display identities left behind
/// (RA-057): `spaceo safety clean-display-identities`.
///
/// Each identity left two layers. Its factory profile is a file; its device registration lives in
/// ColorSync's any-user registry, survives deleting the profile and rebooting, and is what
/// ColorSync re-reads for every display request. `ColorSyncUnregisterDevice` reports success to a
/// non-root caller while removing nothing, so applying requires root, and success is judged only
/// by a fresh enumeration afterwards. Only devices whose *factory* profile names SpaceO's vendor and
/// product are touched; physical displays, Sidecar and other virtual-display tools are left alone,
/// even if someone assigned one of them a SpaceO profile.
public enum DisplayIdentityCleanup {
    public struct Registration: Sendable, Equatable {
        public var deviceClass: String
        public var deviceID: String
        /// Nil when ColorSync lists no readable profile for the device.
        public var profilePath: String?
        /// The profile macOS generated for the device, as opposed to one a person assigned.
        public var isFactory: Bool = false
    }

    public struct Plan: Sendable, Equatable {
        public var registrations: [Registration]
        /// SpaceO profile files, whether or not a registration still refers to them.
        public var profilePaths: [String]
        /// Devices with no readable profile; left alone because nothing identifies them as SpaceO's.
        public var unattributedWithoutProfile: Int
    }

    public struct Outcome: Sendable, Equatable {
        public var plan: Plan
        public var backup: String
        public var unregistered: Int
        public var remainingRegistrations: Int
        public var movedProfiles: Int
        /// The display inventory changed during cleanup, so no profile was removed.
        public var profileRemovalSkipped: Bool = false
        /// Unreferenced SpaceO profiles that are still present after removal was attempted.
        public var failedProfiles: [String] = []
        /// ColorSync could not be listed again after unregistration, so its effect is unknown and
        /// no profile was removed. `unregistered` is then zero and every registration is counted
        /// as remaining, because neither is confirmed.
        public var verificationFailed: Bool = false
        public var confirmed: Bool {
            remainingRegistrations == 0 && !profileRemovalSkipped && failedProfiles.isEmpty && !verificationFailed
        }
    }

    public struct DisplayInventory: Sendable, Equatable {
        public var spaceO: Int
        public var other: Int
    }

    public struct Environment {
        public var registrations: () throws -> [Registration]
        public var unregister: (Registration) -> Void
        public var profileDirectory: String
        public var registryPath: String
        public var isRoot: () -> Bool
        public var spaceOProcessRunning: () -> Bool
        public var displays: () throws -> DisplayInventory
        /// Takes the invoking user's display-lifecycle lock, which every display creator needs, and
        /// returns its release. Held from before the first check until the last profile is removed.
        public var acquireExclusion: () throws -> () -> Void
        public var removeProfile: (String) -> Void = { try? FileManager.default.removeItem(atPath: $0) }

        public static let live = Environment(
            registrations: { try DisplayIdentityCleanup.withDeadline(DisplayIdentityCleanup.listingDeadline,
                                                                     DisplayIdentityCleanup.liveRegistrations) },
            unregister: DisplayIdentityCleanup.liveUnregister,
            profileDirectory: DisplayIdentityResidue.profilesDirectory,
            registryPath: DisplayIdentityResidue.registryPath,
            isRoot: { geteuid() == 0 },
            spaceOProcessRunning: DisplayIdentityCleanup.liveSpaceOProcessRunning,
            displays: {
                let online = try Stage.checkedOnlineDisplayIDs()
                let spaceO = online.filter(Stage.isSpaceODisplay).count
                return DisplayInventory(spaceO: spaceO, other: online.count - spaceO)
            },
            acquireExclusion: DisplayIdentityCleanup.liveExclusion)
    }

    public enum Failure: Error, LocalizedError, Equatable {
        case requiresRoot
        case spaceOProcessRunning
        case spaceODisplayOnline
        case noDisplays
        case registryMissing
        case listingTruncated
        case listingTimedOut
        case profileInventoryTruncated
        case profileInventoryUnreadable
        case invokingUserUnknown
        case lifecycleJournalUnusable
        case backupFailed(String)

        public var errorDescription: String? {
            switch self {
            case .requiresRoot:
                return "ColorSync ignores unregistration from a normal account; rerun with sudo"
            case .spaceOProcessRunning:
                return "a SpaceO daemon, MCP server or Viewer is running; stop them first (`spaceo daemon stop --operator`, quit the Viewer and MCP clients)"
            case .spaceODisplayOnline:
                return "a SpaceO display is online; stop every SpaceO daemon and Viewer first"
            case .noDisplays:
                return "this process sees no display; run it from a Terminal in the logged-in user's session"
            case .registryMissing:
                return "nothing was removed: ColorSync's device registry is not at \(DisplayIdentityResidue.registryPath), so it cannot be backed up"
            case .listingTruncated:
                return "nothing was removed: ColorSync listed more devices or profile data than this command examines"
            case .listingTimedOut:
                return "nothing was removed: ColorSync did not finish listing its devices in time; it may be saturated, "
                    + "so log out and back in, then rerun"
            case .profileInventoryTruncated:
                return "nothing was removed: \(DisplayIdentityResidue.profilesDirectory) holds more profiles than this command examines"
            case .lifecycleJournalUnusable:
                return "the account's SpaceO display-safety journal cannot be locked; inspect it with `spaceo doctor`"
            case .profileInventoryUnreadable:
                return "nothing was removed: \(DisplayIdentityResidue.profilesDirectory) could not be listed"
            case .invokingUserUnknown:
                return "run this with sudo from the account that uses SpaceO, so it can hold that account's display lock"
            case .backupFailed(let reason):
                return "nothing was removed: the backup failed (\(reason))"
            }
        }
    }

    static let maximumRegistryBytes = 268_435_456
    /// Listing took 24 seconds on a Mac with 525 leftover devices; a stalled ColorSync never returns.
    static let listingDeadline: TimeInterval = 180
    /// A generated display profile is about 3.4 KB.
    static let maximumProfileBytes = 1_048_576
    static let maximumProfileBackupBytes = 268_435_456

    public static func plan(_ environment: Environment = .live) throws -> Plan {
        let profiles = try spaceOProfiles(in: environment.profileDirectory)
        let (registrations, unattributed) = try spaceODevices(in: try environment.registrations())
        return Plan(registrations: registrations, profilePaths: profiles, unattributedWithoutProfile: unattributed)
    }

    /// ColorSync lists a device once per profile; a device is SpaceO's when its factory profile says so.
    /// Each distinct profile is read once, and all of them within the scan's total read budget.
    static func spaceODevices(in listing: [Registration], budget: Int = DisplayIdentityResidue.maximumScanBytes)
        throws -> (devices: [Registration], unattributed: Int) {
        var registrations: [Registration] = []
        var spaceO = Set<String>(), profiled = Set<String>(), devices = Set<String>()
        var classified: [String: Bool?] = [:], remaining = budget, unreadable = Set<String>()
        for registration in listing {
            devices.insert(registration.deviceID)
            guard let path = registration.profilePath else { continue }
            profiled.insert(registration.deviceID)
            guard registration.isFactory, !spaceO.contains(registration.deviceID) else { continue }
            let isSpaceO: Bool?
            if let known = classified[path] {
                isSpaceO = known
            } else {
                guard remaining > 0 else { throw Failure.listingTruncated }
                let prefix = DisplayIdentityResidue.maximumProfilePrefix
                // An unreadable profile is not SpaceO's evidence; a budget-shortened read is unknown.
                let read = DisplayIdentityResidue.readPrefix(path, maximum: min(prefix, remaining))
                if let read, !read.complete(prefix: prefix) { throw Failure.listingTruncated }
                remaining -= max(read?.data.count ?? 0, 1)
                isSpaceO = read.map { DisplayIdentityResidue.isSpaceOProfile($0.data) }
                classified[path] = isSpaceO
            }
            switch isSpaceO {
            case true?:
                spaceO.insert(registration.deviceID)
                registrations.append(registration)
            case nil:
                // Unreadable (often a profile someone deleted): unattributed, never touched.
                unreadable.insert(registration.deviceID)
            case false?:
                break
            }
        }
        let unattributed = devices.subtracting(profiled).union(unreadable.subtracting(spaceO))
        return (registrations, unattributed.count)
    }

    /// Every SpaceO profile in the directory, or a refusal; never a partial or substituted list.
    static func spaceOProfiles(in directory: String) throws -> [String] {
        let found: (paths: [String], examined: Int, truncated: Bool, unreadable: Int)
        do { found = try DisplayIdentityResidue.spaceOProfiles(in: directory) }
        catch DisplayIdentityResidue.ListingError.missing { return [] }
        catch { throw Failure.profileInventoryUnreadable }
        guard !found.truncated else { throw Failure.profileInventoryTruncated }
        // Any unreadable entry could be SpaceO residue this cleanup would silently leave behind.
        guard found.unreadable == 0 else { throw Failure.profileInventoryUnreadable }
        return found.paths
    }

    private static func requireQuiescent(_ environment: Environment) throws {
        guard !environment.spaceOProcessRunning() else { throw Failure.spaceOProcessRunning }
        let displays = try environment.displays()
        guard displays.spaceO == 0 else { throw Failure.spaceODisplayOnline }
        // A process outside the login session can read an empty list successfully.
        guard displays.other > 0 else { throw Failure.noDisplays }
    }

    /// Back up, unregister, verify, then remove the profiles. A registration that is still listed
    /// afterwards keeps every profile it references, and is reported, never assumed removed.
    public static func apply(_ environment: Environment = .live, backupRoot: String,
                             now: Date = Date()) throws -> Outcome {
        guard environment.isRoot() else { throw Failure.requiresRoot }
        let release = try environment.acquireExclusion()
        defer { release() }
        try requireQuiescent(environment)
        let profilePaths = try spaceOProfiles(in: environment.profileDirectory)
        let listing = try environment.registrations()
        let (devices, unattributed) = try spaceODevices(in: listing)
        let plan = Plan(registrations: devices, profilePaths: profilePaths, unattributedWithoutProfile: unattributed)
        let manager = FileManager.default
        guard manager.fileExists(atPath: environment.registryPath) else { throw Failure.registryMissing }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = formatter.string(from: now)
        let backup = URL(fileURLWithPath: backupRoot).appendingPathComponent("colorsync-\(stamp)")
        do {
            try manager.createDirectory(at: backup.appendingPathComponent("Profiles"),
                                        withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
            // Bounded: a corrupt or runaway registry must not fill the disk under root.
            let registry: Data
            do {
                registry = try BoundedRegularFile.read(URL(fileURLWithPath: environment.registryPath),
                                                       maximumBytes: Self.maximumRegistryBytes)
            } catch {
                throw Failure.backupFailed("ColorSync's registry is not a regular file of at most "
                    + "\(Self.maximumRegistryBytes / 1_048_576) MB")
            }
            try registry.write(to: backup.appendingPathComponent("com.apple.colorsync.devices"), options: [.withoutOverwriting])
            // Bounded per file and in total: a corrupt profile must not fill the disk under root.
            var budget = Self.maximumProfileBackupBytes
            for path in plan.profilePaths {
                let name = URL(fileURLWithPath: path).lastPathComponent
                let data: Data
                do {
                    data = try BoundedRegularFile.read(URL(fileURLWithPath: path),
                                                       maximumBytes: min(Self.maximumProfileBytes, budget))
                } catch {
                    throw Failure.backupFailed("\(name) is not a regular profile within the backup limits")
                }
                budget -= data.count
                try data.write(to: backup.appendingPathComponent("Profiles/\(name)"), options: [.withoutOverwriting])
            }
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.backupFailed(error.localizedDescription)
        }

        for registration in plan.registrations { environment.unregister(registration) }
        let after: [Registration]
        do { after = try environment.registrations() } catch {
            // Unregistration may already have taken effect: report it, keep every profile.
            return Outcome(plan: plan, backup: backup.path, unregistered: 0,
                           remainingRegistrations: plan.registrations.count, movedProfiles: 0,
                           verificationFailed: true)
        }
        // A planned device still listed in any form counts as remaining, even if its profile
        // metadata changed so it no longer looks like SpaceO's.
        let planned = Set(plan.registrations.map(\.deviceID))
        let remainingIDs = planned.intersection(after.map(\.deviceID))
        let remaining = remainingIDs.count
        var outcome = Outcome(plan: plan, backup: backup.path,
                              unregistered: plan.registrations.count - remaining,
                              remainingRegistrations: remaining, movedProfiles: 0)
        // The lifecycle lock keeps SpaceO creators out; anything else attaching a SpaceO display
        // (an old binary, a direct private-API user) would own one of these profiles.
        do { try requireQuiescent(environment) } catch {
            outcome.profileRemovalSkipped = true
            return outcome
        }
        // Never remove a profile that any registration still references, or one a surviving planned
        // device referenced before; ColorSync would recreate it.
        let referenced = Set(after.compactMap(\.profilePath))
            .union(listing.filter { remainingIDs.contains($0.deviceID) }.compactMap(\.profilePath))
        for path in plan.profilePaths where !referenced.contains(path) {
            environment.removeProfile(path)
            if manager.fileExists(atPath: path) { outcome.failedProfiles.append(path) }
            else { outcome.movedProfiles += 1 }
        }
        return outcome
    }

    // MARK: - ColorSync

    final class Collector {
        static let limit = 65_536
        var registrations: [Registration] = []
        var callbacks = 0
        var truncated = false

        /// One ColorSync callback; false stops the walk. Every callback counts toward the limit,
        /// so printers or malformed entries cannot extend it.
        func accept(_ info: [String: Any]) -> Bool {
            callbacks += 1
            guard callbacks <= Self.limit else {
                truncated = true
                return false
            }
            guard let deviceClass = info[kColorSyncDeviceClass.takeUnretainedValue() as String] as? String,
                  deviceClass == kColorSyncDisplayDeviceClass.takeUnretainedValue() as String,
                  let rawID = info[kColorSyncDeviceID.takeUnretainedValue() as String],
                  CFGetTypeID(rawID as CFTypeRef) == CFUUIDGetTypeID() else { return true }
            let deviceID = CFUUIDCreateString(nil, (rawID as! CFUUID)) as String
            let url = info[kColorSyncDeviceProfileURL.takeUnretainedValue() as String] as? URL
            let factory = info[kColorSyncDeviceProfileIsFactory.takeUnretainedValue() as String] as? Bool ?? false
            registrations.append(Registration(deviceClass: deviceClass, deviceID: deviceID,
                                              profilePath: url?.isFileURL == true ? url?.path : nil,
                                              isFactory: factory))
            return true
        }
    }

    static func liveRegistrations() throws -> [Registration] {
        let collector = Collector()
        let context = Unmanaged.passUnretained(collector).toOpaque()
        ColorSyncIterateDeviceProfiles({ info, context in
            guard let context else { return false }
            let collector = Unmanaged<Collector>.fromOpaque(context).takeUnretainedValue()
            return collector.accept(info as? [String: Any] ?? [:])
        }, context)
        guard !collector.truncated else { throw Failure.listingTruncated }
        return collector.registrations
    }

    private final class DeadlineResult<T>: @unchecked Sendable {
        let lock = NSLock()
        var value: Result<T, Error>?
    }

    /// Runs `body` on its own thread and waits at most `seconds`. A call that outlives the deadline
    /// cannot be cancelled; its thread is left to finish or to end with the process, and the
    /// caller gets `listingTimedOut`. Before any change that is a refusal; after unregistration,
    /// `apply` reports it as an unconfirmed outcome.
    static func withDeadline<T>(_ seconds: TimeInterval, _ body: @escaping () throws -> T) throws -> T {
        let result = DeadlineResult<T>()
        let done = DispatchSemaphore(value: 0)
        let thread = Thread {
            let value = Result { try body() }
            result.lock.withLock { result.value = value }
            done.signal()
        }
        thread.stackSize = 1 << 20
        thread.start()
        guard done.wait(timeout: .now() + seconds) == .success,
              let value = result.lock.withLock({ result.value }) else { throw Failure.listingTimedOut }
        return try value.get()
    }

    /// Any other `spaceo` process (daemon, MCP server, CLI) or the Viewer could attach a display
    /// during the tens of seconds cleanup takes. An unreadable process list counts as running.
    static func liveSpaceOProcessRunning() -> Bool {
        let me = getpid()
        var pids = [pid_t](repeating: 0, count: 16_384)
        let count = pids.withUnsafeMutableBytes {
            proc_listallpids($0.baseAddress, Int32($0.count))
        }
        guard count > 0, Int(count) < pids.count else { return true }
        for pid in pids.prefix(Int(count)) where pid > 0 && pid != me {
            var name = [CChar](repeating: 0, count: 256)
            guard proc_name(pid, &name, UInt32(name.count)) > 0 else { continue }
            let process = String(cString: name)
            if process == "spaceo" || process == "SpaceO Viewer" { return true }
        }
        return false
    }

    /// The invoking account's lifecycle journal lock (`sudo` sets `SUDO_UID`). Every SpaceO display
    /// creator takes it, so holding it keeps the daemon, Viewer and MCP servers from attaching a
    /// display mid-cleanup. A journal created here belongs to that account, never to root; an empty
    /// journal is the state SpaceO starts from.
    static func liveExclusion() throws -> () -> Void {
        guard let text = ProcessInfo.processInfo.environment["SUDO_UID"], let uid = uid_t(text), uid != 0,
              let entry = getpwuid(uid), let home = entry.pointee.pw_dir else {
            throw Failure.invokingUserUnknown
        }
        let gid = entry.pointee.pw_gid
        let directory = String(cString: home) + "/Library/Application Support/SpaceO"
        var directoryInfo = stat()
        guard lstat(directory, &directoryInfo) == 0, directoryInfo.st_mode & S_IFMT == S_IFDIR,
              directoryInfo.st_uid == uid else { throw Failure.invokingUserUnknown }
        let path = directory + "/display-safety.json"
        let fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw Failure.lifecycleJournalUnusable }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else {
            close(fd)
            throw Failure.lifecycleJournalUnusable
        }
        // Only a journal this call just created (root-owned and empty) changes owner.
        if info.st_uid != uid {
            guard info.st_uid == 0, info.st_size == 0, fchown(fd, uid, gid) == 0 else {
                close(fd)
                throw Failure.lifecycleJournalUnusable
            }
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw Failure.spaceOProcessRunning
        }
        return { close(fd) }
    }

    static func liveUnregister(_ registration: Registration) {
        guard let uuid = CFUUIDCreateFromString(nil, registration.deviceID as CFString) else { return }
        _ = ColorSyncUnregisterDevice(registration.deviceClass as CFString, uuid)
    }
}
