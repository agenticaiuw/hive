"""Persistent local lip-reading worker: in-memory camera capture and rolling partial transcripts.

The model is FLARE Large (<lipread>/flare), or USR 2.0 Huge (<lipread>/usr2,
scripts/lipread_usr2.py) with LIPREAD_MODEL=usr2. Commands and events are JSON lines tagged with
a session number. No microphone, MP4 files, network requests or agent actions. The camera is
opened only for an explicit start command.
"""
import json
import base64
import os
from pathlib import Path
import sys
import threading
import time

from lipread_stream import Stream

OUTPUT_LOCK = threading.Lock()


def say(**event):
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(event) + '\n')
        sys.stdout.flush()


class Recorder:
    def __init__(self, model, session):
        self.session = session
        self.model = model
        self.stop = threading.Event()
        self.cancelled = False
        self.stream = Stream(model, self.emit)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def emit(self, **event):
        if not self.cancelled:
            say(session=self.session, **event)

    def run(self):
        import cv2
        camera = crops = None
        error = None
        try:
            deadline = time.monotonic() + 30
            while not self.stop.is_set():
                camera = cv2.VideoCapture(0)
                if camera.isOpened():
                    break
                camera.release()
                camera = None
                if time.monotonic() >= deadline:
                    raise RuntimeError('Camera unavailable. Allow Agent in Privacy & Security › Camera.')
                self.emit(camera='waiting')
                self.stop.wait(1)
            if self.stop.is_set():
                return
            crops = self.model.crops()
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            camera.set(cv2.CAP_PROP_FPS, 25)
            self.emit(camera='on')
            next_frame = time.monotonic()
            last_good = next_frame
            last_framing = None
            next_preview = 0.0
            while not self.stop.is_set():
                ok, frame = camera.read()
                now = time.monotonic()
                if not ok:
                    if now - last_good > 3:
                        raise RuntimeError('Camera stopped providing frames.')
                    self.stop.wait(0.01)
                    continue
                last_good = now
                if now < next_frame:
                    continue
                next_frame = max(next_frame + 1/25, now)
                crop = crops(frame)
                if now >= next_preview:
                    # A small local-only preview lets the user see their actual camera framing.
                    preview = cv2.resize(frame, (240, 180), interpolation=cv2.INTER_AREA)
                    ok_preview, encoded = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 65])
                    if ok_preview:
                        self.emit(preview=base64.b64encode(encoded).decode('ascii'))
                    next_preview = now + .25
                if crops.framing != last_framing:
                    self.emit(framing=crops.framing)
                    last_framing = crops.framing
                if crop is None:
                    continue
                self.stream.feed(crop)
                if self.stream.done.is_set():
                    break
        except Exception as exc:
            error = str(exc)
        finally:
            if camera is not None:
                camera.release()
            if crops is not None:
                crops.close()
            self.emit(camera='off')
            self.stream.finish(error)

    def finish(self):
        self.stop.set()

    def cancel(self):
        self.cancelled = True
        self.stream.cancel()
        self.stop.set()
        self.thread.join(3)


def load_model():
    """FLARE Large, or USR 2.0 Huge with LIPREAD_MODEL=usr2. The worker runs in FLARE's folder
    with FLARE's Python, which runs USR 2.0's code too. FLARE is the default: on USR 2.0's own
    demo clip it read the sentence nearly word for word and USR 2.0 didn't (scripts/
    lipread_usr2.py), so which is better for a given face is measured, not assumed."""
    flare = Path(os.environ.get('LIPREAD_FLARE_DIR', Path.cwd()))
    if os.environ.get('LIPREAD_MODEL') == 'usr2':
        from lipread_usr2 import Usr2
        return Usr2(os.environ.get('LIPREAD_USR2_DIR', flare.parent / 'usr2'))
    from lipread_flare import Flare
    return Flare(flare)


def main():
    say(status='Loading lip reader…', final=False)
    try:
        model = load_model()
        # Compile GPU kernels while the model is loading, not during the first phrase.
        import numpy as np
        model([np.zeros(model.crop_shape, dtype=np.uint8)] * 20)
        say(ready=True, model=model.name, device=model.device)
    except Exception as exc:
        say(error=f'Lip reader could not load: {type(exc).__name__}: {exc}', final=False)
        for line in sys.stdin:
            command = json.loads(line)
            if command['command'] == 'start':
                say(session=command['session'], error=f'Lip reader could not load: {exc}', final=True)
        return 1
    recorder = None
    for line in sys.stdin:
        command = json.loads(line)
        if command['command'] == 'start':
            if recorder:
                recorder.cancel()
            recorder = Recorder(model, command['session'])
        elif command['command'] == 'stop' and recorder and command['session'] == recorder.session:
            recorder.finish()
    if recorder:
        recorder.cancel()


if __name__ == '__main__':
    sys.exit(main())
