import Darwin
import Foundation

/// Read the opened file, never a size-checked path followed by an unbounded second open.
/// Symlinks to regular files are supported for user-managed configuration directories.
enum BoundedRegularFile {
    enum ReadError: Error, Equatable {
        case missing
        case unreadable
        case tooLarge(Int)
    }

    static func read(_ url: URL, maximumBytes: Int) throws -> Data {
        guard url.isFileURL, !url.path.utf8.contains(0), maximumBytes >= 0 else {
            throw ReadError.unreadable
        }
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else {
            // A dangling symlink is existing configuration, not permission to overwrite it.
            if errno == ENOENT {
                var info = stat()
                if lstat(url.path, &info) < 0, errno == ENOENT { throw ReadError.missing }
            }
            throw ReadError.unreadable
        }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size >= 0 else { throw ReadError.unreadable }
        guard info.st_size <= maximumBytes else {
            throw ReadError.tooLarge(Int(clamping: info.st_size))
        }
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = Darwin.read(descriptor, &chunk, chunk.count)
            if count == 0 { return data }
            if count < 0 {
                if errno == EINTR { continue }
                throw ReadError.unreadable
            }
            // The file may have grown since fstat. Never append beyond the limit.
            guard count <= maximumBytes - data.count else {
                throw ReadError.tooLarge(maximumBytes == Int.max ? Int.max : maximumBytes + 1)
            }
            data.append(contentsOf: chunk.prefix(count))
        }
    }
}
