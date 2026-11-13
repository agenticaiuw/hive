"""Bounded rolling video transcription, independent of the model and camera.

Only final results are commands. Drafts are replaceable captions. At most one decode is
in flight; capture never waits for inference and no queue of obsolete drafts builds up.

Drafts read rolling windows joined by text. Two decodes of the same overlap can disagree
("domain shifts" / "domain shifting"), so a text join can repeat words. The final therefore
reads a phrase of up to `whole` seconds in one decode; only longer phrases fall back to windows.
"""
from __future__ import annotations

import threading
import time


def join_overlap(previous: str, current: str) -> str:
    """Join independently decoded overlapping windows without duplicating their shared words."""
    left, right = previous.split(), current.split()
    norm = lambda s: s.lower().strip('.,!?;:')
    for n in range(min(len(left), len(right), 20), 0, -1):
        if [norm(w) for w in left[-n:]] == [norm(w) for w in right[:n]]:
            return ' '.join(left + right[n:])
    return ' '.join(left + right)


class Stream:
    def __init__(self, decode, emit, *, fps=25, interval=0.6, window=8, overlap=1.2, whole=16):
        self.decode, self.emit = decode, emit
        self.fps, self.interval = fps, interval
        self.limit, self.overlap = int(window * fps), int(overlap * fps)
        self.whole = int(whole * fps)
        self.frames = []
        # Every frame of the phrase while it fits in `whole`, for the final; None once it doesn't.
        # Same frame objects as self.frames, so this costs list slots, not copies.
        self.phrase = []
        self.base = self.count = 0
        self.committed = ''
        self.last_text = ''
        self.last_end = 0
        self.error = None
        self.closed = False
        self.cancelled = False
        self.condition = threading.Condition()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def feed(self, frame):
        with self.condition:
            if self.closed:
                return
            # Bounded even if inference is slower than capture. Report lost context, don't hide it.
            if len(self.frames) >= self.limit * 2:
                self.error = 'Lip reader cannot keep up. Try a shorter phrase.'
                self.closed = True
            else:
                self.frames.append(frame)
                self.count += 1
                if self.phrase is not None and self.count <= self.whole:
                    self.phrase.append(frame)
                else:
                    self.phrase = None
            self.condition.notify_all()

    def finish(self, error=None):
        with self.condition:
            self.error = error or self.error
            self.closed = True
            self.condition.notify_all()

    def cancel(self):
        with self.condition:
            self.cancelled = True
            self.closed = True
            self.condition.notify_all()

    def run(self):
        next_decode = 0.0
        try:
            while True:
                with self.condition:
                    while not self.closed and (self.count == self.last_end or len(self.frames) < 20 or time.monotonic() < next_decode):
                        self.condition.wait(timeout=0.1)
                    if self.cancelled:
                        return
                    if self.error:
                        self.emit(error=self.error, final=True)
                        return
                    if self.closed and self.count == 0:
                        self.emit(text=self.last_text, final=True)
                        return
                    whole = self.closed and self.phrase is not None
                    if self.closed and len(self.phrase if whole else self.frames) < 12:
                        self.emit(text=self.committed, final=True)
                        return
                    if whole:
                        batch, start = list(self.phrase), 0
                    else:
                        batch, start = list(self.frames[:self.limit]), self.base
                    end = start + len(batch)
                    final = whole or (self.closed and len(self.frames) <= self.limit)
                began = time.monotonic()
                # A full window is kept for good, so it gets the careful decode as the last one does.
                text = self.decode(batch, final=final or len(batch) == self.limit).strip()
                elapsed = time.monotonic() - began
                with self.condition:
                    if self.cancelled:
                        return
                    self.last_text = join_overlap('' if whole else self.committed, text)
                    self.last_end = end
                    # A full window becomes context for the next one. Keep an overlapping tail.
                    if len(batch) == self.limit and not final:
                        self.committed = self.last_text
                        consumed = len(batch) - self.overlap
                        del self.frames[:consumed]
                        self.base = start + consumed
                    complete = final and self.count == end
                self.emit(**({'text': self.last_text, 'final': True} if complete else
                             {'partial': self.last_text, 'final': False}),
                          inference_seconds=round(elapsed, 3), video_seconds=round(end / self.fps, 3))
                if complete:
                    return
                next_decode = began + self.interval
        except Exception as exc:
            if not self.cancelled:
                self.emit(error=f'{type(exc).__name__}: {exc}', final=True)
        finally:
            self.done.set()
