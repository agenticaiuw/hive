"""Bounded video transcription, independent of the model and camera: Sentences (what Hive uses)
captions a sentence at a time once your lips stop; Stream (LIPREAD_CAPTIONS=drafts) shows a rolling
draft while you talk.

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

    def feed(self, frame, opening=None):
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


class Sentences:
    """Captions a sentence at a time. Lips that stop moving end a sentence, and only then is it read,
    in one decode of just that sentence. A draft of a sentence the model hasn't seen the end of is a
    guess: on the owner's own video FLARE's drafts read "the screen is a bit more complicated" and
    "and the film is admitted to the film" for "what's the weather going to be like tomorrow
    afternoon", which USR 2.0 then read word for word from the whole sentence. So nothing is shown
    while you talk; each sentence appears about a second after you finish it.

    The still frames around a sentence are left out (all but `margin`): given five seconds of a closed
    mouth after a sentence, USR 2.0 made up "oh my god" six times. Too little margin hurts too: with
    0.3 s it read the start of "please open safari..." as "the tone means", with 0.5 s "comb in".

    feed(frame, opening): `opening` is the inner lips' gap over the mouth's width
    (lipread_vision.Crops.opening), about 0.06-0.10 at rest and up to 0.5 talking. Inside a sentence
    lips close for at most about 0.25 s, so `pause` of stillness ends one. Without openings (None) the
    whole phrase is read when it's finished, as Stream's final is.
    """

    def __init__(self, decode, emit, *, fps=25, pause=0.6, margin=0.5, longest=12, moving=0.15, most=0.2,
                 queue=3):
        self.decode, self.emit = decode, emit
        self.fps = fps
        self.pause, self.margin = int(pause * fps), int(margin * fps)
        self.longest = int(longest * fps)
        self.moving, self.most = moving, most
        self.most_queued = queue
        self.frames = []          # frames from index self.base on
        self.base = self.count = 0
        self.first = self.last = None   # the current sentence's first and last moving frames
        self.moved = 0            # its moving frames
        self.openings = []        # the last 10 s, for your mouth's resting opening
        self.whole = False        # frames without an opening: read the whole phrase at the end
        self.queue = []           # (first frame index, frames) waiting to be read
        self.sentences = []
        self.started = False
        self.error = None
        self.closed = False
        self.cancelled = False
        self.condition = threading.Condition()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def threshold(self):
        """Moving: open well beyond your resting mouth (some people rest with lips apart), but never
        above `most`. Ten seconds of non-stop talk has no resting frames: on the owner's video a tenth
        of talking frames are under 0.08, while the median is 0.27. Without the cap, talk that never
        stops raises the bar over the talk itself, and the sentence never ends."""
        if len(self.openings) < 25:
            return self.moving
        rest = sorted(self.openings)[len(self.openings) // 10]
        return min(self.most, max(self.moving, 2 * rest))

    def feed(self, frame, opening=None):
        started = False
        with self.condition:
            if self.closed:
                return
            index = self.count
            self.count += 1
            self.frames.append(frame)
            if opening is None:
                self.whole = True
            else:
                self.openings.append(opening)
                del self.openings[:-10 * self.fps]
                if opening > self.threshold():
                    if self.first is None:
                        self.first, self.moved = index, 0
                    self.last = index
                    self.moved += 1
                    if not self.started:
                        self.started = started = True
            if self.whole:
                if len(self.frames) > self.longest + self.pause:
                    self.error = 'Lip reader cannot read a phrase this long. Try a shorter one.'
                    self.closed = True
            elif self.first is not None:
                if index - self.last >= self.pause or index - self.first >= self.longest:
                    self.cut(index + 1)
            else:
                # Nothing said: keep only what the next sentence's margin needs.
                drop = len(self.frames) - self.margin
                if drop > 0:
                    del self.frames[:drop]
                    self.base += drop
            if len(self.queue) > self.most_queued:
                self.error = 'Lip reader cannot keep up. Try a shorter phrase.'
                self.closed = True
            self.condition.notify_all()
        if started:
            self.emit(status='Reading your lips…', final=False)

    def cut(self, end):
        """The current sentence, from `margin` before its first moving frame to `margin` after its
        last (or to `end`, exclusive), goes to be read. A twitch of under 0.25 s isn't a sentence."""
        start = max(self.first - self.margin, self.base)
        stop = min(self.last + self.margin + 1, end)
        segment = self.frames[start - self.base:stop - self.base]
        if self.moved >= self.fps // 4 and len(segment) >= 12:
            self.queue.append((start, segment))
        del self.frames[:stop - self.base]
        self.base = stop
        self.first = self.last = None
        self.moved = 0

    def finish(self, error=None):
        with self.condition:
            self.error = error or self.error
            if not self.closed:
                if self.whole and len(self.frames) >= 12 and not self.sentences and not self.queue:
                    self.queue.append((self.base, list(self.frames)))
                elif self.first is not None:
                    self.cut(self.count)
            self.closed = True
            self.condition.notify_all()

    def cancel(self):
        with self.condition:
            self.cancelled = True
            self.closed = True
            self.condition.notify_all()

    def run(self):
        try:
            while True:
                with self.condition:
                    while not self.queue and not self.closed:
                        self.condition.wait(timeout=0.1)
                    if self.cancelled:
                        return
                    if self.error:
                        self.emit(error=self.error, final=True)
                        return
                    if not self.queue:
                        self.emit(text=' '.join(self.sentences), final=True)
                        return
                    start, batch = self.queue.pop(0)
                    last = self.closed and not self.queue
                began = time.monotonic()
                text = self.decode(batch, final=True).strip()
                elapsed = time.monotonic() - began
                with self.condition:
                    if self.cancelled:
                        return
                    if text:
                        self.sentences.append(text)
                    said = ' '.join(self.sentences)
                    timing = {'inference_seconds': round(elapsed, 3),
                              'video_seconds': round((start + len(batch)) / self.fps, 3)}
                    if last and not self.error:
                        self.emit(text=said, final=True, **timing)
                        return
                self.emit(partial=said, final=False, **timing)
        except Exception as exc:
            if not self.cancelled:
                self.emit(error=f'{type(exc).__name__}: {exc}', final=True)
        finally:
            self.done.set()
