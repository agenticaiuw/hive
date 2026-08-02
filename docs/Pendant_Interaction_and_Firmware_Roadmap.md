# Pendant interaction, offline programs, and remote firmware control

## What is possible on the current prototype

The nRF9160 can receive commands from the cloud over LTE. The safe design is
not to let an agent rewrite arbitrary firmware while it is running. Instead,
the relay should publish a small, versioned, allowlisted command queue and the
pendant should poll it:

- `play_audio`: play a named file or response from microSD.
- `list_recordings`: return bounded recording metadata, not raw files.
- `upload_recording`: upload one recording selected by its opaque ID.
- `set_config`: change validated values such as recording duration or volume.
- `delete_recording`: delete one named recording after an explicit user action.
- `install_update`: download and install a signed firmware image.

Every command needs a unique ID, expiry time, device ID, schema version, and
result acknowledgement. The pendant should reject unknown commands, replayed
IDs, expired commands, paths containing directory traversal, and unsigned
firmware. The cloud agent can choose *which* supported operation to request,
but cannot inject executable code.

Firmware updates do not require a permanent USB-C connection once Nordic
MCUboot/FOTA is added. A production update flow should use two image slots,
signature verification, a battery threshold, rollback after a failed health
check, and staged rollout. Until that is implemented, flashing through the
development kit's USB/J-Link connection is the supported route.

## Offline behavior

Recording does not need internet. Store the recording and a compact metadata
record on microSD, add it to an outbox, and upload it after connectivity
returns. The device should always announce whether a request was completed
locally, queued, or failed.

Useful offline programs do not need general speech recognition:

- Speak the current time.
- Timer and stopwatch.
- Voice memo recording.
- Play recent saved audio.
- Battery and connectivity status.
- Retry or cancel queued uploads.

The nRF9160 has low-power counters, but wall-clock time is only trustworthy
after it has been synchronized from LTE/GNSS or set by another device. A cold
boot with no retained/synchronized time cannot answer “what time is it?”
correctly merely because a timer peripheral exists. Persist the last trusted
UTC value plus monotonic uptime and mark it stale when uncertainty is too high.

Pre-record short prompts such as “hours,” “minutes,” “start,” “saved,”
“offline,” and “upload queued.” This makes the programs discoverable without a
screen or an on-device speech recognizer.

## Recommended five-way control

Use one five-way navigation switch (center, up, down, left, right) rather than
five unrelated buttons. It is physically compact, cheap, and maps cleanly to
the interaction model.

Global gestures:

| Gesture | Result |
| --- | --- |
| Center short press | Ask the cloud agent; record until the next center press |
| Center double press | Start/stop a local voice memo |
| Center long press | Enter the offline-program carousel |
| Left/right | Previous/next program or field |
| Up/down | Increase/decrease the selected value |
| Center in a program | Confirm/start/pause |
| Center long press in a program | Cancel and return to ready |

Timer example:

1. Long-press center and use left/right until the device says “timer.”
2. Press center. The device says “hours.”
3. Use up/down to change the value and left/right to select hours, minutes, or
   seconds.
4. Press center to start. Press center again to pause or resume.
5. Long-press center to cancel.

The firmware should implement this as an explicit state machine with debounced
`PRESS`, `DOUBLE_PRESS`, `LONG_PRESS`, and directional events. Audio capture,
LTE work, file I/O, and button handling must remain separate tasks so a network
timeout never makes the controls unresponsive.

## LED meanings

The current prototype intentionally blinks LED1 while recording and uses finite
flash counts for failures. Repeated flashing immediately after power-on is not
a universal “failed boot” signal; the serial log and flash pattern determine
the cause. On the current breadboard, an intermittent microSD ground caused
storage initialization/capture failures. Production firmware should use
distinct colors or cadences for ready, recording, queued offline, uploading,
reply ready, and fault, and should always stop fault blinking after a bounded
diagnostic code.

## Recommended delivery order

1. Keep the current one-button Opus pipeline stable.
2. Add the local recording outbox and trusted-time model.
3. Prototype the five-way switch and offline timer/stopwatch state machine.
4. Add the allowlisted device-command queue with per-device credentials.
5. Add signed MCUboot/FOTA with rollback.
6. Only then allow an agent to schedule configuration changes or firmware
   updates through the queue.
