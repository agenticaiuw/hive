import CoreGraphics
import Foundation

/// A bounded set of virtual display identities (RA-057).
///
/// macOS keeps per-identity state that nothing ever removes: a ColorSync device registration and a
/// factory `.icc` profile per (vendor, product, serial), plus WindowServer display mappings.
/// ColorSync re-reads its whole device registry for every display-info request WindowServer makes,
/// so a fresh random serial per attachment — SpaceO's original choice — grew that registry with
/// every display ever created (760 of 766 display profiles on one development Mac) until each
/// request took ~85 ms, ColorSync saturated, WindowServer exhausted its dispatch threads and the
/// watchdog killed the login session.
///
/// An identity is derived from the requested geometry, a slot and a generation, and every serial
/// ever issued is recorded, so distinct identities never share a serial across restarts and a host
/// accumulates at most one identity per (geometry, slot, generation). A slot is reused once no
/// online display and no live object in this process still holds it. The random serial existed
/// because a reused identity once restored a saved configuration that left the display online but
/// inactive, without its own Space; publication rejects such a display, and `rotate` then retires
/// that identity by advancing the slot's persisted generation.
///
/// The record fails closed: an existing record that cannot be read or validated refuses creation
/// instead of silently reissuing identities it may have retired.
final class DisplayIdentityAllocator: @unchecked Sendable {
    struct Identity: Equatable, Sendable {
        let key: String
        let slot: Int
        let generation: Int
        let serial: UInt32
    }

    enum RecordError: Error, Equatable, LocalizedError {
        case unreadable(String)
        case full
        case unsaved(String)

        var errorDescription: String? {
            switch self {
            case .unreadable(let path):
                return "the display identity record at \(path) is unreadable; move it aside only after "
                    + "confirming no SpaceO display is online (see docs/DISPLAY_SAFETY.md)"
            case .full:
                return "the display identity record holds its maximum of \(DisplayIdentityAllocator.maximumIdentities) "
                    + "identities; use fewer display sizes"
            case .unsaved(let path):
                return "a new display identity could not be recorded in \(path)"
            }
        }
    }

    static let shared = DisplayIdentityAllocator()
    static let slotCount = 32
    /// Bounds the record, and with it how many identities this host can ever accumulate.
    static let maximumIdentities = 1_024
    static let maximumRecordBytes = 262_144
    static let maximumGeneration = 1_000_000

    /// Busy while a claim awaits its display (`pending`) or while that display object is alive.
    private final class Holder {
        var pending = true
        weak var value: AnyObject?
        var busy: Bool { pending || value != nil }
    }

    struct Record: Codable, Equatable {
        var version = 1
        /// "<key>/<slot>" → current generation; absent means zero.
        var generations: [String: Int] = [:]
        /// "<key>/<slot>/<generation>" → the serial issued for that identity.
        var serials: [String: UInt32] = [:]
    }

    private let lock = NSLock()
    private let path: String?
    private var record: Record?
    private var holders: [UInt32: Holder] = [:]

    init(path: String? = DisplayIdentityAllocator.defaultPath) {
        self.path = path
    }

    static var defaultPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/SpaceO/display-identities.json").path
    }

    static func key(width: UInt32, height: UInt32, hiDPI: Bool) -> String {
        "\(width)x\(height)@\(hiDPI ? 2 : 1)"
    }

    /// FNV-1a over a versioned description; never zero, which the descriptor treats as unset.
    /// A nonzero `salt` only resolves a collision with a serial already issued to another identity.
    static func serial(key: String, slot: Int, generation: Int, salt: Int = 0) -> UInt32 {
        var hash: UInt32 = 2_166_136_261
        let text = "spaceo-display-v1|\(key)|\(slot)|\(generation)" + (salt == 0 ? "" : "|\(salt)")
        for byte in text.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return hash == 0 ? 1 : hash
    }

    /// The lowest slot whose identity is neither online (`onlineSerials`, any process) nor held by a
    /// live display object of this process. Nil only when every slot is busy. A first use records
    /// the identity's serial before returning it.
    func claim(width: UInt32, height: UInt32, hiDPI: Bool,
               onlineSerials: Set<UInt32>) throws -> Identity? {
        let key = Self.key(width: width, height: height, hiDPI: hiDPI)
        return try lock.withLock {
            var record = try loadedRecord()
            var needsNewIdentity = false
            for slot in 0..<Self.slotCount {
                let generation = record.generations["\(key)/\(slot)"] ?? 0
                let id = "\(key)/\(slot)/\(generation)"
                if let serial = record.serials[id] {
                    guard !onlineSerials.contains(serial), holders[serial]?.busy != true else { continue }
                    holders[serial] = Holder()
                    return Identity(key: key, slot: slot, generation: generation, serial: serial)
                }
                // A full record can still offer a later slot's recorded identity.
                guard record.serials.count < Self.maximumIdentities else { needsNewIdentity = true; continue }
                let issued = Set(record.serials.values)
                guard let serial = (0..<64).lazy
                    .map({ Self.serial(key: key, slot: slot, generation: generation, salt: $0) })
                    .first(where: { !issued.contains($0) && !onlineSerials.contains($0) }) else { continue }
                record.serials[id] = serial
                guard persist(record) else { throw RecordError.unsaved(path ?? "memory") }
                self.record = record
                holders[serial] = Holder()
                return Identity(key: key, slot: slot, generation: generation, serial: serial)
            }
            if needsNewIdentity { throw RecordError.full }
            return nil
        }
    }

    /// Tie the claim to the display object; the slot frees itself when that object is released.
    func bind(_ identity: Identity, to display: AnyObject) {
        lock.withLock {
            let holder = Holder()
            holder.value = display
            holder.pending = false
            holders[identity.serial] = holder
        }
    }

    /// A claim whose display was never created.
    func abandon(_ identity: Identity) {
        lock.withLock {
            if let holder = holders[identity.serial], holder.pending { holders.removeValue(forKey: identity.serial) }
        }
    }

    /// This identity came back unusable (inactive, mirrored, without its own Space): do not offer
    /// it again. False when the new generation could not be saved; this process still skips it.
    @discardableResult
    func rotate(_ identity: Identity) -> Bool {
        lock.withLock {
            guard var record = try? loadedRecord() else { return false }
            let slotKey = "\(identity.key)/\(identity.slot)"
            guard (record.generations[slotKey] ?? 0) == identity.generation else { return true }
            guard identity.generation + 1 < Self.maximumGeneration,
                  record.generations[slotKey] != nil || record.generations.count < Self.maximumIdentities else {
                return false
            }
            record.generations[slotKey] = identity.generation + 1
            self.record = record
            return persist(record)
        }
    }

    func generation(key: String, slot: Int) throws -> Int {
        try lock.withLock { try loadedRecord().generations["\(key)/\(slot)"] ?? 0 }
    }

    // MARK: - Persistence (caller holds `lock`)

    /// A missing record is empty. An existing one must be fully valid; it is not cached until it is,
    /// so moving a bad record aside takes effect without a restart.
    private func loadedRecord() throws -> Record {
        if let record { return record }
        guard let path else { record = Record(); return Record() }
        let data: Data
        do { data = try BoundedRegularFile.read(URL(fileURLWithPath: path), maximumBytes: Self.maximumRecordBytes) }
        catch BoundedRegularFile.ReadError.missing { record = Record(); return Record() }
        catch { throw RecordError.unreadable(path) }
        guard let loaded = try? JSONDecoder().decode(Record.self, from: data), Self.isValid(loaded) else {
            throw RecordError.unreadable(path)
        }
        record = loaded
        return loaded
    }

    static func isValid(_ record: Record) -> Bool {
        guard record.version == 1,
              record.generations.count <= maximumIdentities, record.serials.count <= maximumIdentities,
              record.generations.values.allSatisfy({ (0..<maximumGeneration).contains($0) }),
              !record.serials.values.contains(0),
              Set(record.serials.values).count == record.serials.count else { return false }
        return true
    }

    private func persist(_ record: Record) -> Bool {
        guard let path else { return true }
        let url = URL(fileURLWithPath: path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(record), data.count <= Self.maximumRecordBytes else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try data.write(to: url, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            return true
        } catch {
            return false
        }
    }
}
