"""The microphone, with whatever the Mac itself is playing taken back out (echo cancellation), so
the voice agent can listen while it talks and you can cut in, and a video or music playing out
loud isn't heard as you.

build/agent-vhid-tap (tools/tap.swift) streams everything the Mac plays; WebRTC's echo canceller
(the one in Chrome and Meet, from the livekit package, running on this Mac) subtracts it from
what the microphone picks up. What's left is the room: you.

macOS only lets the tap hear the Mac's sound if the app you run ./voice.sh in is allowed under
System Settings > Privacy & Security > Screen & System Audio Recording (the agent's screenshots
need that too). Without it the microphone still works; it just hears everything.
"""

from __future__ import annotations

import atexit
import os
import queue
import subprocess
import threading
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

import audio  # noqa: E402

TAP = os.path.join(ROOT, "build", "agent-vhid-tap")
RATE = 16000
FRAME = 160  # 10 ms, what the echo canceller works on
SILENT = 1e-4  # quieter than this, the Mac isn't playing anything
TAIL = 0.3  # seconds a room keeps echoing after the Mac goes quiet


class Microphone:
    """on_audio(samples, playing) gets 16 kHz mono float32, 10 ms at a time, from a background
    thread; playing says the Mac was playing something then (so there may be a little echo left).

    devices=False opens neither the microphone nor the tap; from_mic() and from_mac() take the
    audio instead (the tests use it)."""

    def __init__(self, on_audio, devices: bool = True):
        self.on_audio = on_audio
        self.name = ""             # the microphone's
        self.error: str | None = None
        self.tap_error: str | None = None
        self.heard_mac_at = 0.0    # when the tap last carried some sound (time.monotonic())
        self._queue: queue.Queue = queue.Queue()  # ("mic" | "mac", samples), in the order they came
        self._canceller = None
        self.canceller_error: str | None = None
        try:
            from livekit import rtc
            self._rtc = rtc
            self._canceller = rtc.AudioProcessingModule(echo_cancellation=True, high_pass_filter=True)
            self._canceller.set_stream_delay_ms(60)  # a starting guess; it measures the real delay
        except Exception as e:  # not installed
            self.canceller_error = str(e) or type(e).__name__
        threading.Thread(target=self._process, daemon=True).start()
        if devices:
            threading.Thread(target=self._keep_open, daemon=True).start()

    def describe(self) -> str:
        if self._canceller is None:
            return f"off ({self.canceller_error})"
        if self.tap_error:
            return f"off ({self.tap_error})"
        return "on (it takes what the Mac plays out of what it hears)"

    def hears_the_mac(self) -> bool:
        """The echo canceller is getting what the Mac plays, so the agent's voice won't be heard as you."""
        return self._canceller is not None and time.monotonic() - self.heard_mac_at < 1.0

    def from_mic(self, samples: np.ndarray):
        self._queue.put(("mic", samples))

    def from_mac(self, samples: np.ndarray):
        """What the Mac is playing, 16 kHz mono."""
        self._queue.put(("mac", samples))

    # -- the echo canceller's thread --

    def _frame(self, samples: np.ndarray):
        pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
        return self._rtc.AudioFrame(pcm, RATE, 1, FRAME)

    def _process(self):
        mic = mac = np.zeros(0, np.float32)
        quiet_for = TAIL * RATE  # samples since the Mac last played something
        while True:
            kind, samples = self._queue.get()
            if kind == "mac":
                if np.abs(samples).max(initial=0) > SILENT:
                    self.heard_mac_at = time.monotonic()
                    quiet_for = 0
                else:
                    quiet_for += len(samples)
                if self._canceller is None:
                    continue
                mac = np.concatenate([mac, samples])
                while len(mac) >= FRAME:
                    self._canceller.process_reverse_stream(self._frame(mac[:FRAME]))
                    mac = mac[FRAME:]
                continue
            mic = np.concatenate([mic, samples])
            while len(mic) >= FRAME:
                frame, mic = mic[:FRAME], mic[FRAME:]
                if self._canceller is not None:
                    data = self._frame(frame)
                    self._canceller.process_stream(data)
                    frame = np.frombuffer(data.data, np.int16).astype(np.float32) / 32768
                self.on_audio(frame, quiet_for < TAIL * RATE)

    # -- keeping the microphone and the tap open --

    def _keep_open(self):
        """Reopens the microphone when you switch microphones (audio.microphone() picks which), and
        the tap when you switch speakers."""
        try:
            import sounddevice
        except ImportError as e:
            self.error = str(e)
            return
        quitting = threading.Event()
        atexit.register(quitting.set)  # runs before sounddevice's own exit handler shuts PortAudio down
        stream = mic_device = tap = out_device = None
        tap_tried = 0.0
        while not quitting.is_set():
            current = audio.microphone()
            try:
                active = stream is not None and stream.active
            except sounddevice.PortAudioError:
                if quitting.is_set():
                    return  # PortAudio shut down under it as the program ends
                raise
            if not active or current != mic_device:
                if stream is not None:
                    stream.close()
                    sounddevice._terminate()  # PortAudio only reads the device list when it starts
                    sounddevice._initialize()
                mic_device = current
                wanted = audio.name(mic_device)
                index = next((i for i, d in enumerate(sounddevice.query_devices())
                              if d["name"] == wanted and d["max_input_channels"] > 0), None)
                try:
                    stream = sounddevice.InputStream(device=index, samplerate=RATE, channels=1, dtype="float32",
                                                     blocksize=FRAME, latency="low",
                                                     callback=lambda data, *_: self.from_mic(data[:, 0].copy()))
                    stream.start()
                    self.name, self.error = audio.name(mic_device), None
                except Exception as e:  # no microphone, or it's busy
                    stream, self.error = None, str(e)
            output = audio.default_output()
            if self._canceller is not None and (tap is None or tap.poll() is not None or output != out_device) \
                    and time.monotonic() - tap_tried > 5:
                if tap is not None and tap.poll() is None:
                    tap.terminate()
                out_device, tap_tried = output, time.monotonic()
                tap = self._start_tap()
            quitting.wait(1)

    def _start_tap(self) -> subprocess.Popen | None:
        if not os.path.exists(TAP):
            self.tap_error = "build/agent-vhid-tap isn't built; run make"
            return None
        tap = subprocess.Popen([TAP], stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        threading.Thread(target=self._read_tap, args=(tap,), daemon=True).start()
        return tap

    def _read_tap(self, tap: subprocess.Popen):
        import soxr
        header = tap.stdout.readline().split()
        if len(header) != 2:
            tap.wait()
            self.tap_error = (tap.stderr.read().decode().strip().removeprefix("agent-vhid-tap: ")
                              or f"the tap stopped ({tap.returncode})")
            return
        self.tap_error = None
        rate, channels = int(header[0]), int(header[1])
        resampler = soxr.ResampleStream(rate, RATE, 1, dtype="float32")
        leftover = b""
        while chunk := tap.stdout.read1(8192):
            chunk, leftover = leftover + chunk, b""
            usable = len(chunk) - len(chunk) % (4 * channels)
            chunk, leftover = chunk[:usable], chunk[usable:]
            samples = np.frombuffer(chunk, np.float32).reshape(-1, channels).mean(axis=1)
            self.from_mac(resampler.resample_chunk(samples))
        tap.wait()
