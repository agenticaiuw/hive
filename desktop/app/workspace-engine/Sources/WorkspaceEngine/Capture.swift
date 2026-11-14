// Screenshots of the workspace display, at one pixel per point so their coordinates are the ones
// the tools take.
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import WorkspaceCore

enum Capture {
    static func image(displayID: UInt32, size: CGSize) throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else {
            throw WorkspaceError("permission", "Hive doesn't have Screen Recording permission, so the workspace can't be seen")
        }
        final class Box { var image: CGImage?; var error: Error? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    throw WorkspaceError("session_detached", "the workspace display \(displayID) is not online")
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let configuration = SCStreamConfiguration()
                configuration.width = Int(size.width)
                configuration.height = Int(size.height)
                configuration.showsCursor = false
                box.image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            } catch {
                box.error = error
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + 15) == .success else {
            throw WorkspaceError("timeout", "the screenshot took longer than 15 seconds")
        }
        if let error = box.error as? WorkspaceError { throw error }
        guard let image = box.image else {
            throw WorkspaceError("capture_failed", box.error?.localizedDescription ?? "no picture came back")
        }
        return image
    }

    static func encode(_ image: CGImage, png: Bool) throws -> Data {
        let data = NSMutableData()
        let type = (png ? "public.png" : "public.jpeg") as CFString
        guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
            throw WorkspaceError("capture_failed", "the picture couldn't be encoded")
        }
        let options = png ? nil : [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { throw WorkspaceError("capture_failed", "the picture couldn't be encoded") }
        return data as Data
    }
}
