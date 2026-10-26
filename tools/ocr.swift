// Prints every word Apple's Vision framework recognizes in an image, one JSON
// object per line, with its box in image pixels (origin top-left):
//
//   {"text":"Copy","line":"Copy","confidence":1.0,"x":812,"y":440,"w":38,"h":17}
//
//   agent-vhid-ocr IMAGE.png

import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: agent-vhid-ocr IMAGE.png\n".data(using: .utf8)!)
    exit(64)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("cannot read \(url.path)\n".data(using: .utf8)!)
    exit(1)
}
let width = Double(image.width)
let height = Double(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("recognition failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

func emit(_ text: String, line: String, confidence: Float, box: CGRect) {
    // Vision boxes are normalized with the origin at the bottom-left.
    let object: [String: Any] = [
        "text": text,
        "line": line,
        "confidence": Double(confidence),
        "x": (box.minX * width).rounded(),
        "y": ((1 - box.maxY) * height).rounded(),
        "w": (box.width * width).rounded(),
        "h": (box.height * height).rounded(),
    ]
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let line = candidate.string
    var emitted = false
    line.enumerateSubstrings(in: line.startIndex..., options: .byWords) { word, range, _, _ in
        guard let word, let box = try? candidate.boundingBox(for: range)?.boundingBox else { return }
        emit(word, line: line, confidence: candidate.confidence, box: box)
        emitted = true
    }
    if !emitted {
        emit(line, line: line, confidence: candidate.confidence, box: observation.boundingBox)
    }
}
