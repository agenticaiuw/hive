"""Lip reading confirmed by a rough eye swipe: you say a sentence and glance across its letters on the
eye keyboard at the same time. No blinks between words, no space bar; the sentence ends when your
mouth stops (0.6 s still).

The lips carry the words. USR 2.0 Huge (github.com/ahaliassos/usr2, MIT) reads the mouth video, and
its decoder proposes word pieces one at a time. The gaze doesn't have to land on keys: each guess is
scored by how well the gaze path could have swept its letters in order (a blur of about a key around
each key, a share of samples allowed anywhere, the whole path allowed to sit off by a shift). Lips and
eyes confuse different things: the lips can't tell p from b from m, or t from d from n, and those
letters are far apart on the keyboard; the gaze confuses neighbouring keys, which mostly look
different on the lips. In simulation on the practice sentences (2026-11-18), the words the lips can't
tell apart were picked right by the gaze 98% of the time at today's eye accuracy (0.86 keys off).

One beam search runs over the lip model's word pieces with the gaze score added to each guess
(shallow fusion). A guess's gaze score while it is unfinished is the best its letters could do so far
plus the best any key could do for the gaze still unexplained, so short and long guesses compare
fairly; a finished guess pays for gaze it left unexplained.

    hive-eye-keyboard --lips                   types each sentence (runs lipgaze.py serve)
    hive-eye-keyboard --lips --lips-record DIR  shows practice sentences and keeps each take's mouth + gaze in DIR
    lipgaze.py eval DIR [--sigma 1.0 --weight 1.0]   reads the kept takes again: lips alone vs lips + eyes
    lipgaze.py check                           loads the model and reads a still mouth

Set up by scripts/setup-lipgaze.sh (model under ~/Library/Application Support/Hive/lipgaze).
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import numpy as np

WEIGHTS = 'huge_high_resource_lrs2lrs3vox2avsp.pth'

# The eye keyboard (tools/eyeswipe/EyeSwipe.swift EyeLayout): keys 1 x 1, rows staggered by half a key.
ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm.?']
OFFSETS = [0.0, 0.5, 1.0]
CENTERS = np.array([(OFFSETS[r] + i + 0.5, r + 0.5) for r, row in enumerate(ROWS) for i in range(len(row))])
KEY = {ch: i for i, ch in enumerate(ch for row in ROWS for ch in row)}
WIDTH, HEIGHT = 10.0, 3.0


def key_path(text, last=None):
    """The keys a piece of text sweeps, in order: letters only (spaces, word starts '▁' and apostrophes
    aren't keys), a key repeated back to back once, also across words ("will look" is w-i-l-o-k).
    None if a character can't be typed on the keyboard. `last`: the key the text before ended on."""
    out = []
    for ch in text.lower():
        if ch in " '▁":
            continue
        k = KEY.get(ch)
        if k is None:
            return None
        if (out[-1] if out else last) != k:
            out.append(k)
    return out


@dataclass
class GazeSettings:
    sigma: float = 1.0          # keys: how far a glance lands from the key meant (the owner's ~0.86 keys, rounded up)
    outlier: float = 0.1        # share of samples that can be anywhere (glances, saccades, a blink's edge)
    dwell: int = 1              # samples a key must hold at least
    temperature: float = 4.0    # gaze samples come ~30 a second and aren't independent: their sum counts this much less
    weight: float = 1.0         # gaze against lips
    shift_sigma: float = 0.6    # keys: how far the whole path may sit off (webcam drift), as a prior
    shifts: tuple = tuple(np.arange(-1.5, 1.51, 0.25))


class GazeScorer:
    """Scores key paths against one sentence's gaze samples. A path's state is L[t]: the best log score of
    samples 0..t with sample t on the path's last key (earlier samples on earlier keys, in order, or
    before the first key anywhere)."""

    def __init__(self, samples, settings=GazeSettings(), shift=(0.0, 0.0)):
        self.s = settings
        self.samples = np.asarray(samples, dtype=np.float64).reshape(-1, 2)
        self.shift = shift
        self.T = len(self.samples)
        self.emit = self.emissions(shift)
        self.anywhere = math.log(settings.outlier / ((WIDTH + 2) * (HEIGHT + 2)))
        best = self.emit.max(axis=1) if self.T else np.zeros(0)
        # rest[t]: the best any keys could do for samples t.. (an optimistic finish); tail[t]: samples t.. anywhere.
        self.rest = np.concatenate([np.cumsum(best[::-1])[::-1], [0.0]])
        self.tail = self.anywhere * (self.T - np.arange(self.T + 1))
        self.lead = self.anywhere * np.arange(self.T + 1)    # lead[t]: samples 0..t-1 anywhere

    def emissions(self, shift):
        """ln P(sample t | looking at key k), T x keys: a round blur around the key plus a share anywhere."""
        if not len(self.samples):
            return np.zeros((0, len(CENTERS)))
        g = self.samples - np.asarray(shift)
        d2 = ((g[:, None, :] - CENTERS[None, :, :]) ** 2).sum(-1) / self.s.sigma ** 2
        norm = 1 / (2 * math.pi * self.s.sigma ** 2)
        anywhere = self.s.outlier / ((WIDTH + 2) * (HEIGHT + 2))
        return np.log((1 - self.s.outlier) * norm * np.exp(-d2 / 2) + anywhere)

    def start(self):
        return None                                  # no keys yet

    def extend(self, state, keys, emit=None):
        """The state after the path sweeps `keys` more. Entering key k at sample s, holding it to t:
        L_k[t] = max over s <= t-dwell+1 of (A[s-1] + C[t] - C[s-1]), C the running sum of k's emissions,
        A the previous key's L (or, for the first key, the samples before anywhere), so it is one running max."""
        e = self.emit if emit is None else emit
        T, d = self.T, self.s.dwell
        L = state
        for k in keys:
            if T == 0:
                return np.zeros(0)
            C = np.cumsum(e[:, k])
            Cprev = np.concatenate([[0.0], C[:-1]])           # C[s-1]
            A = self.lead[:T] if L is None else np.concatenate([[-np.inf], L[:-1]])   # score before sample s
            M = np.maximum.accumulate(A - Cprev)
            enter = np.full(T, -np.inf)
            enter[d - 1:] = M[:T - d + 1]
            L = C + enter
        return L

    def bound(self, state):
        """The most this path could still score once finished: its keys so far, then the best keys for the rest."""
        if state is None:
            return self.rest[0]
        return float(np.max(state + self.rest[1:])) if self.T else 0.0

    def final(self, state):
        """A finished path's score: the samples after its last key are anywhere."""
        if state is None:
            return self.tail[0]
        return float(np.max(state + self.tail[1:])) if self.T else 0.0

    def score(self, keys, shift=None):
        """A whole path's finished score, at a given shift of the gaze (default this scorer's)."""
        emit = None if shift is None else self.emissions(shift)
        return self.final(self.extend(self.start(), keys, emit))

    def best_shift(self, keys):
        """The path's best finished score over shifts of the whole gaze path, with the shift's prior, and the shift."""
        best = (-np.inf, (0.0, 0.0))
        for dx in self.s.shifts:
            for dy in self.s.shifts:
                sx, sy = self.shift[0] + dx, self.shift[1] + dy
                prior = -(sx * sx + sy * sy) / (2 * self.s.shift_sigma ** 2) * self.s.temperature
                v = self.score(keys, (sx, sy)) + prior
                if v > best[0]:
                    best = (v, (sx, sy))
        return best


class CtcPrefix:
    """The lip model's CTC head as a prefix score (Watanabe et al. 2017, as ESPnet's CTCPrefixScore):
    how well a guess's pieces so far can line up with the frames. USR 2.0's own decoding weighs it 0.1
    against the attention decoder; it keeps a guess from ending early or saying words twice."""

    def __init__(self, logp, blank=0):
        self.x = np.asarray(logp, dtype=np.float64)       # frames x pieces, log-probs
        self.blank = blank
        self.T = len(self.x)

    def start(self):
        return (np.full(self.T, -np.inf), np.cumsum(self.x[:, self.blank]), 0.0, None)

    def final(self, state):
        """ln P(exactly these pieces | frames)."""
        return float(np.logaddexp(state[0][-1], state[1][-1]))

    def extend(self, states, tokens):
        """Each state with one more piece; a state is (ends on the piece, ends on blank, prefix score, last piece)."""
        T, n = self.T, len(tokens)
        tokens = np.asarray(tokens)
        rn_g = np.stack([st[0] for st in states], 1)
        rb_g = np.stack([st[1] for st in states], 1)
        same = np.array([st[3] == c for st, c in zip(states, tokens)])
        empty = np.array([st[3] is None for st in states])
        xc, xb = self.x[:, tokens], self.x[:, self.blank]
        phi = np.where(same[None, :], rb_g, np.logaddexp(rn_g, rb_g))
        rn = np.full((T, n), -np.inf)
        rb = np.full((T, n), -np.inf)
        rn[0] = np.where(empty, xc[0], -np.inf)
        psi = rn[0].copy()
        for t in range(1, T):
            rn[t] = np.logaddexp(rn[t - 1], phi[t - 1]) + xc[t]
            rb[t] = np.logaddexp(rb[t - 1], rn[t - 1]) + xb[t]
            psi = np.logaddexp(psi, phi[t - 1] + xc[t])
        return [(rn[:, i], rb[:, i], float(psi[i]), int(tokens[i])) for i in range(n)]


@dataclass
class Guess:
    ids: list
    lips: float                          # ln P(pieces | mouth video), from the lip model
    state: object = None                 # GazeScorer state of its keys
    ctc: object = None                   # CtcPrefix state
    last: int | None = None              # its last key
    keys: list = field(default_factory=list)
    total: float = 0.0
    gaze: float = 0.0


def piece_keys(units):
    """Each word piece's keys (as typed after nothing), or None for pieces that can't be typed (digits, <unk>)."""
    out = []
    for u in units:
        if u.startswith('<'):
            out.append(None)
        else:
            out.append(key_path(u) if re.fullmatch(r"[A-Za-z'▁]+", u) else None)
    return out


def fused_search(lips, features, scorer, *, beam=10, per_guess=30, longest=150, use_gaze=True):
    """Beam search over the lip model's pieces with the gaze score added. `lips` has units (the pieces'
    text), eos, words(ids), start(features) -> (ys, cache), step(ys, features, cache) -> (log-probs
    B x units, cache) and extend(ys, parents, tokens, cache) -> (ys, cache) for the guesses kept; and
    optionally ctc_prefix(features) -> CtcPrefix and ctc_weight. Returns the finished guesses, best first,
    as (text, Guess, the gaze shift that fit it best)."""
    s = scorer.s
    units, eos = lips.units, lips.eos
    keys_of = piece_keys(units)
    allowed = np.array([k is not None for k in keys_of])
    allowed[eos] = True
    w = s.weight / s.temperature if use_gaze else 0.0
    ctc = lips.ctc_prefix(features) if hasattr(lips, 'ctc_prefix') else None
    lam = getattr(lips, 'ctc_weight', 0.0) if ctc is not None else 0.0
    guesses = [Guess(ids=[], lips=0.0, state=scorer.start(), ctc=ctc.start() if ctc else None)]
    finished = []
    ys, cache = lips.start(features)
    if ctc is not None:
        longest = min(longest, ctc.T)
    for _ in range(longest):
        logp, cache = lips.step(ys, features, cache)
        logp = np.where(allowed[None, :], logp, -np.inf)
        k = min(per_guess, logp.shape[1] - 1)
        pairs = []                                  # (guess, piece): the decoder's best pieces for each guess
        for b in range(len(guesses)):
            pairs += [(b, int(tok)) for tok in np.argpartition(-logp[b], k)[:k + 1] if np.isfinite(logp[b, tok])]
        grown = {}
        if ctc is not None:
            more = [(b, tok) for b, tok in pairs if tok != eos]
            if more:
                grown = dict(zip(more, ctc.extend([guesses[b].ctc for b, _ in more], [t for _, t in more])))
        options = []
        for b, tok in pairs:
            g = guesses[b]
            lp = g.lips + (1 - lam) * float(logp[b, tok])
            if tok == eos:
                if g.ids:
                    if ctc is not None:
                        lp += lam * (ctc.final(g.ctc) - g.ctc[2])
                    gaze = scorer.final(g.state)
                    if np.isfinite(lp):
                        finished.append(Guess(ids=g.ids, lips=lp, state=g.state, last=g.last, keys=g.keys,
                                              total=lp + w * gaze, gaze=gaze))
                continue
            state_ctc = grown.get((b, tok))
            if state_ctc is not None:
                lp += lam * (state_ctc[2] - g.ctc[2])
            if not np.isfinite(lp):
                continue
            keys = key_path(units[tok], g.last)
            state = scorer.extend(g.state, keys)
            gaze = scorer.bound(state)
            options.append((lp + w * gaze, b, tok, lp, state, keys, state_ctc))
        if not options:
            break
        options.sort(key=lambda o: -o[0])
        options = options[:beam]
        best_done = max((f.total for f in finished), default=-np.inf)
        if options[0][0] < best_done:
            break                                   # nothing unfinished can still beat the best finished one
        parents = [o[1] for o in options]
        guesses = [Guess(ids=guesses[o[1]].ids + [int(o[2])], lips=o[3], state=o[4], ctc=o[6],
                         last=(o[5][-1] if o[5] else guesses[o[1]].last), keys=guesses[o[1]].keys + o[5])
                   for o in options]
        ys, cache = lips.extend(ys, parents, [int(o[2]) for o in options], cache)
    # The whole path may sit off (the camera's map drifts): the finished guesses again at their best shift.
    rescored = []
    for f in sorted(finished, key=lambda f: -f.total)[:beam]:
        if use_gaze and f.keys:
            gaze, shift = scorer.best_shift(f.keys)
        else:
            gaze, shift = f.gaze, scorer.shift
        f.total = f.lips + w * gaze
        f.gaze = gaze
        rescored.append((lips.words(f.ids), f, shift))
    rescored.sort(key=lambda r: -r[1].total)
    return rescored


class Usr2Lips:
    """USR 2.0 Huge, video only, its attention decoder one piece at a time for a beam."""
    crop_shape = (88, 88)

    def __init__(self, root):
        import torch
        from omegaconf import OmegaConf
        root = Path(root)
        sys.path.insert(0, str(root))
        from espnet.nets.pytorch_backend.e2e_asr_transformer import E2E
        from espnet.nets.pytorch_backend.transformer.mask import subsequent_mask
        from utils.utils import UNIGRAM1000_LIST

        self.torch = torch
        self.lock = threading.Lock()
        self.device = os.environ.get('LIPGAZE_DEVICE', 'mps' if torch.backends.mps.is_available() else 'cpu')
        state = torch.load(root / 'weights' / WEIGHTS, map_location='cpu', weights_only=False, mmap=True)
        # The release holds the model and its training-time teacher; only the model reads lips.
        state = {k.replace('_orig_mod.', '', 1): v for k, v in state.items()}
        state = {k[len('model.backbone.'):]: v for k, v in state.items() if k.startswith('model.backbone.')}
        backbone = OmegaConf.create({'model': {'backbone': OmegaConf.load(
            root / 'conf/model/backbone/resnet_transformer_huge.yaml')}})
        backbone = OmegaConf.to_container(backbone, resolve=True)['model']['backbone']
        backbone.pop('_target_', None)
        with torch.device(self.device):             # built straight on the GPU: no second copy in memory
            self.model = E2E(len(UNIGRAM1000_LIST), SimpleNamespace(**backbone))
        self.model.load_state_dict(state, strict=True)
        del state
        frontend = self.model.encoder.frontend_v.frontend3D
        if isinstance(frontend[-1], torch.nn.MaxPool3d) and frontend[-1].kernel_size[0] == 1:
            frontend[-1] = frame_pool(frontend[-1])     # Apple's GPU can't run a 3-D max pool
        self.model.eval().to(self.device)
        self.units = list(UNIGRAM1000_LIST)
        self.eos = self.model.eos
        self.subsequent_mask = subsequent_mask
        self.mean_face = root / 'preprocessing/20words_mean_face.npy'

    def crops(self):
        from lipread_vision import MouthCrops
        return MouthCrops(self.mean_face)

    def encode(self, crops):
        torch = self.torch
        with torch.inference_mode():
            x = torch.from_numpy(np.stack(crops)).to(self.device, dtype=torch.float32)
            return self.model.encoder(xs_v=((x / 255.0 - 0.421) / 0.165)[None])

    ctc_weight = 0.1

    def ctc_prefix(self, features):
        with self.torch.inference_mode():
            logp = self.model.ctc_v.log_softmax(features)[0]
        return CtcPrefix(logp.float().cpu().numpy(), blank=0)

    def start(self, features):
        return self.torch.tensor([[self.model.sos]], device=self.device), None

    def step(self, ys, features, cache):
        torch = self.torch
        with torch.inference_mode():
            memory = features.expand(ys.size(0), -1, -1)
            mask = self.subsequent_mask(ys.size(1), device=self.device).unsqueeze(0)
            y, cache = self.model.decoder.forward_one_step(ys, mask, memory, cache=cache)
            logp = torch.log_softmax(self.model.decoder.out_layer_v(y), dim=-1)
            return logp.float().cpu().numpy(), cache

    def extend(self, ys, parents, tokens, cache):
        torch = self.torch
        index = torch.tensor(parents, device=self.device)
        ys = torch.cat([ys.index_select(0, index), torch.tensor(tokens, device=self.device)[:, None]], dim=1)
        cache = [c.index_select(0, index) for c in cache] if cache is not None else None
        return ys, cache

    def words(self, ids):
        text = ''.join(self.units[i] for i in ids).replace('▁', ' ').replace('<unk>', '')
        return ' '.join(text.split()).lower()


def at_fps(times, frames, fps=25):
    """The frames resampled to `fps` by nearest camera time: USR 2.0 was trained on 25 fps video."""
    times = np.asarray(times, dtype=float)
    if len(times) < 2:
        return list(frames)
    want = np.arange(times[0], times[-1] + 0.5 / fps, 1 / fps)
    idx = np.clip(np.searchsorted(times, want), 1, len(times) - 1)
    idx = np.where(want - times[idx - 1] <= times[idx] - want, idx - 1, idx)
    return [frames[i] for i in idx]


def frame_pool(pool):
    """The video front end's max pool one frame at a time (its time kernel is 1, so it is the same pool)."""
    import torch

    class FramePool(torch.nn.Module):
        def forward(self, x):
            b, c, t, h, w = x.shape
            x = x.transpose(1, 2).reshape(b * t, c, h, w)
            x = torch.nn.functional.max_pool2d(x, pool.kernel_size[1:], pool.stride[1:], pool.padding[1:])
            return x.reshape(b, t, c, *x.shape[-2:]).transpose(1, 2)

    return FramePool()


def speaking(openings, fps, *, moving=0.15, most=0.2, margin=0.5):
    """The frames from `margin` before the mouth first moves to `margin` after it last moves, or None.
    Moving: the inner lips open well beyond the resting opening (lipread_vision.Crops.opening), capped at
    `most` so non-stop talk still counts. On the owner's video USR 2.0 made up "oh my god" over still frames."""
    known = [o for o in openings if o is not None]
    if not known:
        return None
    rest = sorted(known)[len(known) // 10]
    bar = min(most, max(moving, 2 * rest))
    moving_at = [i for i, o in enumerate(openings) if o is not None and o > bar]
    if len(moving_at) < fps // 4:
        return None
    pad = int(margin * fps)
    return max(0, moving_at[0] - pad), min(len(openings), moving_at[-1] + pad + 1)


def word_errors(said, meant):
    a, b = said.split(), meant.split()
    row = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, row[0] = row[0], i
        for j in range(1, len(b) + 1):
            cur = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return row[len(b)]


class Cutter:
    """Cuts the camera stream into sentences: a sentence ends once the mouth has been still for `pause`
    (inside a sentence lips close for at most about 0.25 s), or after `longest`. Each sentence keeps
    `margin` of still frames on each side (with 0.3 s USR 2.0 lost first words, and given seconds of a
    closed mouth it made up words). feed() returns a finished sentence's frames, or None."""

    def __init__(self, fps=30, *, pause=0.6, margin=0.5, longest=12, moving=0.15, most=0.2):
        self.fps = fps
        self.pause, self.margin, self.longest = int(pause * fps), int(margin * fps), int(longest * fps)
        self.moving, self.most = moving, most
        self.frames = []          # (t, crop, opening) from index self.base on
        self.base = self.count = 0
        self.first = self.last = None
        self.moved = 0
        self.openings = []

    def threshold(self):
        if len(self.openings) < 25:
            return self.moving
        rest = sorted(self.openings)[len(self.openings) // 10]
        return min(self.most, max(self.moving, 2 * rest))

    def feed(self, t, crop, opening):
        index = self.count
        self.count += 1
        self.frames.append((t, crop, opening))
        if opening is not None:
            self.openings.append(opening)
            del self.openings[:-10 * self.fps]
            if opening > self.threshold():
                if self.first is None:
                    self.first, self.moved = index, 0
                self.last = index
                self.moved += 1
        if self.first is None:
            drop = len(self.frames) - self.margin       # nothing said: keep only the next sentence's margin
            if drop > 0:
                del self.frames[:drop]
                self.base += drop
            return None
        if index - self.last >= self.pause or index - self.first >= self.longest:
            return self.cut(index + 1)
        return None

    def finish(self):
        return self.cut(self.count) if self.first is not None else None

    def cut(self, end):
        start = max(self.first - self.margin, self.base)
        stop = min(self.last + self.margin + 1, end)
        part = self.frames[start - self.base:stop - self.base]
        moved = self.moved
        del self.frames[:stop - self.base]
        self.base = stop
        self.first = self.last = None
        self.moved = 0
        if moved < self.fps // 4 or len(part) < 12:     # a twitch, not a sentence
            return None
        return part


def read_messages(stream):
    """The keyboard's messages: one JSON line each; a {"frame": {"t", "w", "h"}} line is followed by w*h
    bytes of grey face picture, top row first."""
    while True:
        line = stream.readline()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if 'frame' in message:
            f = message['frame']
            size = int(f['w']) * int(f['h'])
            data = stream.read(size)
            if len(data) < size:
                return
            message['pixels'] = np.frombuffer(data, dtype=np.uint8).reshape(int(f['h']), int(f['w']))
        yield message


class Server:
    """lipgaze.py serve: the eye keyboard (hive-eye-keyboard --lips) sends each camera frame's face, grey,
    and each gaze point on the keyboard, both in camera time; each sentence comes back as {"text"} to type.
    With `record`, each sentence's mouth crops, gaze and what was read are kept in that folder (no face
    pictures, just the 88 x 88 mouth), and practice sentences are shown to say ({"prompt"})."""

    def __init__(self, lips, out, settings=GazeSettings(), record=None, prompts=None):
        import collections
        self.lips, self.out, self.settings = lips, out, settings
        self.crops = lips.crops() if hasattr(lips, 'crops') else None
        self.gaze = collections.deque(maxlen=30 * 60)
        self.frames = collections.deque(maxlen=30 * 20)  # a backlog of 20 s at most while a sentence is read
        self.ready = threading.Condition()
        self.closed = False
        self.shift = (0.0, 0.0)
        self.record = Path(record) if record else None
        self.prompts = list(prompts or [])
        self.prompt = None
        self.taken = 0
        if self.record:
            self.record.mkdir(parents=True, exist_ok=True)
            self.taken = len(list(self.record.glob('*.npz')))
        self.cutter = None

    def say(self, **message):
        self.out.write(json.dumps(message) + '\n')
        self.out.flush()

    def next_prompt(self):
        if self.prompts:
            self.prompt = self.prompts[self.taken % len(self.prompts)]
            self.say(prompt=self.prompt)

    def listen(self, stream):
        for m in read_messages(stream):
            if 'gaze' in m:
                self.gaze.append(tuple(m['gaze']))
            elif 'frame' in m:
                with self.ready:
                    self.frames.append((float(m['frame']['t']), m['pixels']))
                    self.ready.notify()
            elif m.get('on') is False:
                with self.ready:
                    self.frames.append((None, None))     # the keyboard closed: finish the sentence
                    self.ready.notify()
        with self.ready:
            self.closed = True
            self.ready.notify()

    def run(self):
        times = []
        last_crop = None
        self.next_prompt()
        while True:
            with self.ready:
                while not self.frames and not self.closed:
                    self.ready.wait(0.2)
                if not self.frames:
                    break
                t, pixels = self.frames.popleft()
            if t is None:
                if self.cutter is not None:
                    part = self.cutter.finish()
                    if part:
                        self.read(part)
                continue
            if self.cutter is None:
                times.append(t)
                if len(times) < 15:
                    continue
                fps = max(10, min(60, round((len(times) - 1) / max(1e-3, times[-1] - times[0]))))
                self.cutter = Cutter(fps)
            crop = self.crops(np.repeat(pixels[:, :, None], 3, axis=2))   # grey to BGR
            if crop is not None:
                last_crop = crop
            part = self.cutter.feed(t, crop if crop is not None else last_crop, self.crops.opening)
            if part:
                self.read(part)

    def read(self, part):
        import time
        part = [p for p in part if p[1] is not None]
        if len(part) < 12:
            return
        began = time.monotonic()
        t0, t1 = part[0][0], part[-1][0]
        samples = [(x, y) for t, x, y in list(self.gaze) if t0 <= t <= t1]
        crops = np.stack([p[1] for p in part])
        features = self.lips.encode(at_fps([p[0] for p in part], list(crops)))
        scorer = GazeScorer(samples, self.settings, self.shift)
        fused = fused_search(self.lips, features, scorer)
        text = fused[0][0] if fused else ''
        if fused and samples:
            self.shift = fused[0][2]
        message = {'text': text, 'seconds': round(t1 - t0, 2), 'gaze_points': len(samples),
                   'ms': round(1000 * (time.monotonic() - began))}
        if self.record:
            alone = fused_search(self.lips, features, scorer, use_gaze=False)
            message['lips'] = alone[0][0] if alone else ''
            if self.prompt:
                meant = normalise(self.prompt)
                message['meant'] = meant
                message['wrong'] = {'lips': word_errors(message['lips'], meant), 'fused': word_errors(text, meant),
                                    'words': len(meant.split())}
            gaze = np.array([g for g in list(self.gaze) if t0 - 1 <= g[0] <= t1 + 1]).reshape(-1, 3)
            np.savez_compressed(self.record / f'{self.taken:04d}.npz', crops=crops,
                                times=np.array([p[0] for p in part]),
                                openings=np.array([np.nan if p[2] is None else p[2] for p in part]),
                                gaze=gaze, meant=self.prompt or '', lips=message['lips'], fused=text)
            self.taken += 1
            self.say(result=message)
            self.next_prompt()
        else:
            self.say(**message)


def normalise(text):
    return ' '.join(re.sub(r"[^a-z' ]+", ' ', text.lower()).split())


def evaluate(recording, model_root, settings=GazeSettings()):
    """Reads again every sentence kept by serve --record, with the lips alone and with lips + gaze (to tune
    the gaze settings on the owner's own takes)."""
    lips = Usr2Lips(model_root)
    totals = {'lips': 0, 'fused': 0, 'words': 0}
    shift = (0.0, 0.0)
    for path in sorted(Path(recording).glob('*.npz')):
        take = np.load(path)
        meant = str(take['meant'])
        times, gaze = take['times'], take['gaze']
        samples = [(x, y) for t, x, y in gaze if times[0] <= t <= times[-1]]
        features = lips.encode(at_fps(times, list(take['crops'])))
        scorer = GazeScorer(samples, settings, shift)
        alone = fused_search(lips, features, scorer, use_gaze=False)
        fused = fused_search(lips, features, scorer)
        a, f = (alone[0][0] if alone else ''), (fused[0][0] if fused else '')
        if fused and samples:
            shift = fused[0][2]
        if meant:
            ea, ef = word_errors(a, meant), word_errors(f, meant)
            totals['lips'] += ea
            totals['fused'] += ef
            totals['words'] += len(meant.split())
            print(f'{meant}\n   lips: {a}  ({ea} wrong)\n   lips+eyes: {f}  ({ef} wrong)', flush=True)
    n = max(1, totals['words'])
    print(f'{totals["words"]} words: lips alone {100 * totals["lips"] / n:.1f}% wrong, '
          f'lips + eyes {100 * totals["fused"] / n:.1f}% wrong')
    return totals


def check(model_root):
    """Loads the model and reads two seconds of a still grey mouth: a broken install fails here."""
    import time
    began = time.monotonic()
    lips = Usr2Lips(model_root)
    loaded = time.monotonic()
    features = lips.encode([np.full((88, 88), 110, np.uint8)] * 50)
    found = fused_search(lips, features, GazeScorer([]))
    done = time.monotonic()
    print(json.dumps({'ok': True, 'device': lips.device, 'load_seconds': round(loaded - began, 1),
                      'read_seconds': round(done - loaded, 2), 'read': found[0][0] if found else ''}))


def default_root():
    state = os.environ.get('AGENT_STATE_DIR') or str(Path.home() / 'Library/Application Support/Hive')
    return Path(state) / 'lipgaze' / 'usr2'


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    for name, text in [('serve', 'read sentences for hive-eye-keyboard --lips (messages on stdin and stdout)'),
                       ('eval', 'read again the sentences kept by serve --record'),
                       ('check', 'load the model and read a still mouth')]:
        p = sub.add_parser(name, help=text)
        p.add_argument('--model', default=str(default_root()))
        p.add_argument('--sigma', type=float, default=GazeSettings.sigma)
        p.add_argument('--weight', type=float, default=GazeSettings.weight)
        if name == 'serve':
            p.add_argument('--record', help='keep each sentence here and show practice sentences to say')
            p.add_argument('--prompts', default=str(Path(__file__).with_name('lipgaze_prompts.txt')))
        if name == 'eval':
            p.add_argument('recording')
    args = parser.parse_args()
    settings = GazeSettings(sigma=args.sigma, weight=args.weight)
    if args.command == 'check':
        check(args.model)
    elif args.command == 'eval':
        evaluate(args.recording, args.model, settings)
    else:
        out = sys.stdout                               # the keyboard's channel; anything else printed goes to stderr
        sys.stdout = sys.stderr
        prompts = None
        if args.record:
            import random
            prompts = [l.strip() for l in Path(args.prompts).read_text().splitlines() if l.strip()]
            random.Random(len(list(Path(args.record).glob('*.npz'))) if Path(args.record).exists() else 0).shuffle(prompts)
        server = Server(None, out, settings, args.record, prompts)
        reader = threading.Thread(target=server.listen, args=(sys.stdin.buffer,), daemon=True)
        reader.start()                                 # read the keyboard from the start, so it never waits on the model
        server.say(status='Loading the lip reader…')
        server.lips = Usr2Lips(args.model)
        server.crops = server.lips.crops()
        # The GPU's first read takes about 14 s while it builds its kernels: do it now, not on the first sentence.
        fused_search(server.lips, server.lips.encode([np.full((88, 88), 110, np.uint8)] * 50), GazeScorer([]))
        server.say(ready=True)
        server.run()


if __name__ == '__main__':
    main()
