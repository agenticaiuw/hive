// Streams what the Mac is playing (every app's sound, mixed to mono) to stdout, so the voice
// agent can take it back out of what the microphone hears: its own voice, a video, music.
// The first line is "RATE CHANNELS"; float32 samples follow.
//
//   agent-vhid-tap | ...
//
// It's a Core Audio process tap (macOS 14.2 or later). macOS hands it silence unless the app it
// runs in (your terminal) is allowed under System Settings > Privacy & Security > Screen & System
// Audio Recording. It plays nothing and doesn't change your sound settings.

import AudioToolbox
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

func fail(_ message: String, _ status: OSStatus) -> Never {
    FileHandle.standardError.write("agent-vhid-tap: \(message) (OSStatus \(status))\n".data(using: .utf8)!)
    exit(1)
}

func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    if status != noErr { fail("can't read property \(selector)", status) }
    return value
}

// The tap rides on an aggregate device clocked by the current output device.
let output = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
                  AudioDeviceID(kAudioObjectUnknown))
let outputUID = read(output, kAudioDevicePropertyDeviceUID, Unmanaged<CFString>?.none)!.takeRetainedValue() as String

let tap = CATapDescription(monoGlobalTapButExcludeProcesses: [])
tap.uuid = UUID()
tap.name = "agent-vhid-tap"
tap.muteBehavior = .unmuted  // you still hear everything
tap.isPrivate = true         // gone when this process exits
var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tap, &tapID)
if status != noErr { fail("can't tap the Mac's sound", status) }

let description: [String: Any] = [
    kAudioAggregateDeviceNameKey: "agent-vhid-tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true,
                                       kAudioSubTapUIDKey: tap.uuid.uuidString]],
]
var aggregate = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregate)
if status != noErr { fail("can't create the aggregate device for the tap", status) }

let format = read(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
      format.mBitsPerChannel == 32 else {
    fail("the tap's format isn't float32 PCM", 0)
}
let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
fputs("\(Int(format.mSampleRate)) \(interleaved ? format.mChannelsPerFrame : 1)\n", stdout)

var proc: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, DispatchQueue(label: "agent-vhid-tap")) {
    _, input, _, _, _ in
    // Non-interleaved: the first channel is enough to cancel echo with.
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    if let buffer = buffers.first, let data = buffer.mData {
        fwrite(data, 1, Int(buffer.mDataByteSize), stdout)  // the reader is gone: SIGPIPE ends us
    }
}
if status != noErr { fail("can't read from the tap", status) }
status = AudioDeviceStart(aggregate, proc)
if status != noErr { fail("can't start the tap", status) }

dispatchMain()
