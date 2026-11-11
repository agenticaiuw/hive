import Foundation
import CryptoKit
import MachO

/// Stable identities for the executable image a process started from.
///
/// Version strings are intentionally unchanged during ordinary development, so they cannot
/// detect the stale-daemon case on their own. Hashing once at startup costs bounded I/O and lets
/// every client prove which installed image is actually serving requests.
public enum RuntimeIdentity {
    /// Bound fingerprinting for CLI and Viewer binaries. An oversized or non-regular
    /// executable path is unknown identity, never a partial fingerprint or an unbounded read.
    static let maximumExecutableBytes = 64 * 1_048_576
    /// Prefer the loaded build UUID; re-signing an embedded helper changes only its file hash.
    public static func matches(
        _ daemon: DaemonRuntimeInfo?,
        executableBuildUUID: String?,
        executableSHA256: String?
    ) -> Bool? {
        matches(daemon, executableBuildUUID: executableBuildUUID,
                loadExecutableSHA256: { executableSHA256 })
    }

    /// Diagnostic polling normally compares the loaded UUID, without rereading the binary.
    /// Keep the file-based fallback fresh rather than caching an identity for a replaced path.
    public static func matchesCurrentExecutable(_ daemon: DaemonRuntimeInfo?) -> Bool? {
        matches(daemon, executableBuildUUID: currentExecutableBuildUUID(),
                loadExecutableSHA256: { currentExecutableSHA256() })
    }

    static func matches(
        _ daemon: DaemonRuntimeInfo?,
        executableBuildUUID: String?,
        loadExecutableSHA256: () -> String?
    ) -> Bool? {
        if let executableBuildUUID, let daemonUUID = daemon?.executableBuildUUID {
            return executableBuildUUID == daemonUUID
        }
        guard let daemonSHA = daemon?.executableSHA256,
              let executableSHA256 = loadExecutableSHA256() else { return nil }
        return executableSHA256 == daemonSHA
    }

    /// Linker-issued Mach-O UUID. Code signing changes the file SHA but preserves this UUID, so
    /// an installed CLI and the separately signed copy embedded in SpaceO Viewer can still prove
    /// that they came from the same build.
    public static func currentExecutableBuildUUID() -> String? {
        guard let imageHeader = _dyld_get_image_header(0),
              imageHeader.pointee.magic == MH_MAGIC_64 else {
            return nil
        }
        let header = UnsafeRawPointer(imageHeader)
            .assumingMemoryBound(to: mach_header_64.self)
        var pointer = UnsafeRawPointer(header)
            .advanced(by: MemoryLayout<mach_header_64>.size)
        for _ in 0..<Int(header.pointee.ncmds) {
            let command = pointer.load(as: load_command.self)
            guard command.cmdsize >= MemoryLayout<load_command>.size else { return nil }
            if command.cmd == LC_UUID {
                guard command.cmdsize >= MemoryLayout<uuid_command>.size else { return nil }
                let rawUUID = pointer.load(as: uuid_command.self).uuid
                let bytes = withUnsafeBytes(of: rawUUID) { Array($0) }
                guard bytes.count == 16 else { return nil }
                let value: uuid_t = (
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                    bytes[8], bytes[9], bytes[10], bytes[11],
                    bytes[12], bytes[13], bytes[14], bytes[15])
                return UUID(uuid: value).uuidString.lowercased()
            }
            pointer = pointer.advanced(by: Int(command.cmdsize))
        }
        return nil
    }

    public static func currentExecutableSHA256(
        executableURL: URL? = Bundle.main.executableURL
    ) -> String? {
        guard let executableURL,
              let data = try? BoundedRegularFile.read(executableURL, maximumBytes: maximumExecutableBytes) else {
            return nil
        }
        return sha256Hex(data)
    }
}

/// Lowercase hex SHA-256, the form every SpaceO identity and token uses.
func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
