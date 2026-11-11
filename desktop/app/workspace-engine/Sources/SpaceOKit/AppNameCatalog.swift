import Foundation

/// Name lookup for applications a caller refers to the way a person would ("google chrome",
/// "Activity Monitor", "Photoshop 2024"), and near-miss suggestions when nothing matches.
///
/// `AppLauncher.resolve` first tries the exact spellings (a path, a bundle identifier, a
/// `<Name>.app` in a standard folder). This is the fallback: one bounded scan of the standard
/// application folders — plus one level of vendor subfolders, where suites such as Adobe's live —
/// matching the bundle's file name and its declared display names case- and
/// diacritic-insensitively. There is no non-deprecated public LaunchServices call that looks an
/// app up by display name, so the folders are the source of truth.
enum AppNameCatalog {

    struct Entry: Equatable {
        /// The bundle's file name without `.app`; what suggestions show.
        let name: String
        let url: URL
        /// `CFBundleDisplayName` / `CFBundleName` when they differ from the file name.
        let aliases: [String]
    }

    static var standardDirectories: [String] {
        [
            "/Applications", "/Applications/Utilities",
            "/System/Applications", "/System/Applications/Utilities",
            NSHomeDirectory() + "/Applications",
            "/System/Library/CoreServices/Applications",
        ]
    }

    /// Bounds for one scan. A folder listing is cheap; the Info.plist reads are what cost, and
    /// they happen only on this failure-path fallback.
    static let maximumEntries = 2_000
    static let maximumSubfolders = 200
    /// Names longer than this are not app names; they are also where edit distance gets costly.
    static let maximumNameCharacters = 128

    /// A miss followed by a suggestion lookup, or a caller probing several candidate browsers,
    /// should not re-read every Info.plist each time. Installs are rare; a short reuse is safe.
    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: (at: Date, entries: [Entry])?
    static let cacheLifetime: TimeInterval = 30

    static func cachedEntries(now: Date = Date()) -> [Entry] {
        if let cached = cacheLock.withLock({ cache }),
           now.timeIntervalSince(cached.at) >= 0,
           now.timeIntervalSince(cached.at) < cacheLifetime {
            return cached.entries
        }
        let fresh = entries()
        cacheLock.withLock { cache = (now, fresh) }
        return fresh
    }

    static func entries(in directories: [String] = standardDirectories,
                        fileManager: FileManager = .default) -> [Entry] {
        var found: [Entry] = []
        var seen = Set<String>()
        var subfolders: [URL] = []

        func list(_ directory: URL, collectingSubfolders: Bool) {
            guard found.count < maximumEntries,
                  let names = try? fileManager.contentsOfDirectory(atPath: directory.path) else { return }
            for name in names.sorted() where !name.hasPrefix(".") {
                guard found.count < maximumEntries else { return }
                let url = directory.appendingPathComponent(name)
                if name.lowercased().hasSuffix(".app") {
                    let resolved = url.resolvingSymlinksInPath().path
                    guard seen.insert(resolved).inserted else { continue }
                    found.append(entry(for: url))
                } else if collectingSubfolders, subfolders.count < maximumSubfolders {
                    var isDirectory: ObjCBool = false
                    if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory),
                       isDirectory.boolValue {
                        subfolders.append(url)
                    }
                }
            }
        }

        for directory in directories {
            list(URL(fileURLWithPath: directory, isDirectory: true), collectingSubfolders: true)
        }
        for folder in subfolders { list(folder, collectingSubfolders: false) }
        return found
    }

    private static func entry(for url: URL) -> Entry {
        let name = String(url.deletingPathExtension().lastPathComponent)
        let plist = url.appendingPathComponent("Contents/Info.plist")
        var aliases: [String] = []
        if let info = NSDictionary(contentsOf: plist) {
            for key in ["CFBundleDisplayName", "CFBundleName"] {
                if let alias = info[key] as? String, !alias.isEmpty,
                   alias.count <= maximumNameCharacters,
                   normalized(alias) != normalized(name),
                   !aliases.contains(alias) {
                    aliases.append(alias)
                }
            }
        }
        return Entry(name: name, url: url, aliases: aliases)
    }

    static func normalized(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasSuffix(".app") { value.removeLast(4) }
        value = value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func compact(_ text: String) -> String {
        String(normalized(text).unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0)
        }.map(Character.init))
    }

    /// The bundle a display name refers to, when exactly one spelling-insensitive match exists
    /// (or one bundle matches more precisely than every other). Ambiguity resolves to nil so a
    /// caller is never handed a different app than it meant.
    static func match(_ query: String, in entries: [Entry]) -> URL? {
        let wanted = normalized(query)
        guard !wanted.isEmpty, wanted.count <= maximumNameCharacters else { return nil }
        let exact = entries.filter { entry in
            ([entry.name] + entry.aliases).contains { normalized($0) == wanted }
        }
        if exact.count == 1 { return exact[0].url }
        if exact.count > 1 { return nil }
        let loose = compact(query)
        guard !loose.isEmpty else { return nil }
        let spelled = entries.filter { entry in
            ([entry.name] + entry.aliases).contains { compact($0) == loose }
        }
        return spelled.count == 1 ? spelled[0].url : nil
    }

    static func suggestions(for query: String, in entries: [Entry], limit: Int = 3) -> [String] {
        let wanted = normalized(query)
        guard !wanted.isEmpty, wanted.count <= maximumNameCharacters, limit > 0 else { return [] }
        var scored: [(score: Int, name: String)] = []
        for entry in entries {
            var best: Int?
            for candidate in [entry.name] + entry.aliases {
                let name = normalized(candidate)
                guard name.count <= maximumNameCharacters else { continue }
                let score: Int
                if name.contains(wanted) || (wanted.count >= 4 && wanted.contains(name)) {
                    score = 0
                } else {
                    let distance = editDistance(wanted, name)
                    guard distance <= max(2, wanted.count / 3) else { continue }
                    score = distance
                }
                best = min(best ?? score, score)
            }
            if let best { scored.append((best, entry.name)) }
        }
        var names: [String] = []
        for item in scored.sorted(by: { ($0.score, $0.name) < ($1.score, $1.name) })
        where !names.contains(item.name) {
            names.append(item.name)
            if names.count == limit { break }
        }
        return names
    }

    static func editDistance(_ lhs: String, _ rhs: String) -> Int {
        let a = Array(lhs.prefix(maximumNameCharacters))
        let b = Array(rhs.prefix(maximumNameCharacters))
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        var current = Array(repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                let substitution = previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                current[j] = min(previous[j] + 1, current[j - 1] + 1, substitution)
            }
            swap(&previous, &current)
        }
        return previous[b.count]
    }
}
