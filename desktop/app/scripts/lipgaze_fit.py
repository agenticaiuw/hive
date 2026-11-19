"""Teaches the lip reader the owner's own face from the practice takes the eye keyboard keeps
(hive-eye-keyboard --lips-record DIR): low-rank additions to USR 2.0's attention (query and value) and
its video front end, as on 2026-11-16, when 12 of the owner's sentences took it from 95% of words wrong
to 72% and 96 to 41% (the owner's light, glasses, hood and slow silent speech are far from what it was
trained on; published one-speaker fits gain far less because their speakers are much closer).

    lipgaze_fit.py check DIR    each take's words and whether it is used (cut short: not)
    lipgaze_fit.py test DIR     how much fitting helps: each take read by a fit to the others (k folds)
    lipgaze_fit.py fit DIR      fits to every usable take and saves <lipgaze>/usr2_adapter.pt, which
                                lipgaze.py serve loads from its next start

A take's words are the practice sentence shown, unless the take was cut short (less than LEARN_SPOKEN
seconds of mouth movement per word): those are left out, or labelled from --words, words heard in the
same session's audio with their times (for debugging; the real use is silent). Nothing leaves the Mac.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lipgaze  # noqa: E402
from lipgaze import GazeScorer, Server, at_fps, fused_search, key_path, normalise, squeeze, word_errors  # noqa: E402

ADAPTER = 'usr2_adapter.pt'


def pieces(text, units):
    """`text` as USR 2.0's word pieces (indexes into `units`): each word upper-cased after '▁', in the
    fewest pieces (the model splits text the same way)."""
    index = {unit: i for i, unit in enumerate(units)}
    ids = []
    for word in normalise(text).upper().split():
        word = '▁' + word
        best = [None] * (len(word) + 1)
        best[0] = []
        for i in range(len(word)):
            if best[i] is None:
                continue
            for j in range(i + 1, len(word) + 1):
                if word[i:j] in index and (best[j] is None or len(best[i]) + 1 < len(best[j])):
                    best[j] = best[i] + [index[word[i:j]]]
        ids += best[-1] if best[-1] is not None else [index['<unk>']]
    return ids


def heard_words(path):
    """{'words': [{'w', 'S', 'E'}]} (camera-clock times) from a transcript of the session's audio."""
    data = json.loads(Path(path).read_text())
    return [(normalise(w['w']), w['S'], w['E']) for w in data['words'] if normalise(w['w'])]


def label(take, heard=None):
    """(words, why): the take's words, or None and why it is left out."""
    meant = normalise(str(take['meant']))
    times = take['times']
    if heard is not None:
        said = [w for w, s, e in heard if e > times[0] and s < times[-1]]
        if said:
            text = ' '.join(said)
            # Where the audio heard the sentence meant (bar a misheard word), the sentence meant.
            if meant and len(said) == len(meant.split()) and word_errors(text, meant) <= 1:
                return meant, 'heard as meant'
            return text, 'heard'
    if not meant:
        return None, 'no sentence'
    spoken = float(take['spoken']) if 'spoken' in take else 0.0
    if spoken < Server.LEARN_SPOKEN * len(meant.split()):
        return None, f'cut short ({spoken:.1f} s of mouth for {len(meant.split())} words)'
    return meant, 'meant'


def load(folder, heard=None):
    out = []
    for path in sorted(p for p in Path(folder).glob('*.npz') if p.stem.isdigit()):
        take = np.load(path)
        words, why = label(take, heard)
        times, kept, _ = squeeze(take['times'], list(take['crops']), list(take['openings']))
        frames = np.stack(at_fps(times, kept))
        gaze = take['gaze']
        samples = [(x, y) for t, x, y in gaze if take['times'][0] <= t <= take['times'][-1]]
        out.append({'name': path.stem, 'words': words, 'why': why, 'frames': frames, 'gaze': samples,
                    'meant': normalise(str(take['meant'])), 'from': float(take['times'][0]),
                    'to': float(take['times'][-1])})
    return out


def add_lora(model, rank=16, alpha=32):
    """Low-rank additions beside every attention layer's query and value weights, starting at zero."""
    import torch

    class LoRA(torch.nn.Module):
        def __init__(self, base):
            super().__init__()
            self.base, self.scale = base, alpha / rank
            self.a = torch.nn.Parameter(torch.randn(rank, base.in_features, device=base.weight.device)
                                        / base.in_features ** 0.5)
            self.b = torch.nn.Parameter(torch.zeros(base.out_features, rank, device=base.weight.device))

        def forward(self, x):
            return self.base(x) + (x @ self.a.T @ self.b.T) * self.scale

    added = {}
    for name, module in list(model.named_modules()):
        for part in ('linear_q', 'linear_v'):
            base = getattr(module, part, None)
            if isinstance(base, torch.nn.Linear):
                setattr(module, part, LoRA(base))
                added[f'{name}.{part}'] = getattr(module, part)
    return added


def augment(frames, rng):
    """As lip readers are trained: mirrored half the time, shifted a few pixels, up to 0.4 s in each
    second blanked, a little brighter or darker, and now and then a little faster or slower."""
    x = frames[:, :, ::-1] if rng.random() < 0.5 else frames
    dy, dx = rng.integers(-4, 5, 2)
    x = np.roll(x, (dy, dx), axis=(1, 2)).astype(np.float32)
    x = np.clip(x * rng.uniform(0.8, 1.2) + rng.uniform(-15, 15), 0, 255)
    if rng.random() < 0.3 and len(x) > 20:
        keep = np.round(np.arange(0, len(x), rng.uniform(0.85, 1.15))).astype(int)
        x = x[keep[keep < len(x)]]
    for _ in range(max(1, len(x) // 25)):
        width = int(rng.integers(0, 11))
        start = int(rng.integers(0, max(1, len(x) - width)))
        x[start:start + width] = x.mean()
    extra = len(x) % 8 if len(x) > 16 else 0
    return x[extra // 2:len(x) - (extra - extra // 2)]


class Fitter:
    def __init__(self, root):
        import torch
        self.torch = torch
        self.lips = lipgaze.Usr2Lips(root, personal=False)    # from the model as released
        self.model = self.lips.model
        for p in self.model.parameters():
            p.requires_grad_(False)
        self.lora = add_lora(self.model)
        self.frontend = self.model.encoder.frontend_v
        self.start_frontend = {k: v.detach().clone() for k, v in self.frontend.state_dict().items()}

    def reset(self, seed=0):
        torch = self.torch
        g = torch.Generator().manual_seed(seed)
        with torch.no_grad():
            for layer in self.lora.values():
                layer.a.copy_(torch.randn(layer.a.shape, generator=g) / layer.a.shape[1] ** 0.5)
                layer.b.zero_()
            self.frontend.load_state_dict(self.start_frontend)

    def loss(self, frames, target, rng):
        torch, F, model = self.torch, self.torch.nn.functional, self.model
        x = torch.from_numpy(augment(frames, rng)).to(self.lips.device, dtype=torch.float32)
        features = model.encoder(xs_v=((x / 255.0 - 0.421) / 0.165)[None])
        # 0.1 CTC + 0.9 attention, as USR 2.0 decodes. No CTC loss on the Mac's GPU: it runs on the CPU.
        logp = model.ctc_v.log_softmax(features).float().cpu()
        ctc = F.ctc_loss(logp.transpose(0, 1), torch.tensor([target]), torch.tensor([logp.size(1)]),
                         torch.tensor([len(target)]), blank=0, reduction='sum', zero_infinity=True) / len(target)
        given = torch.tensor([[model.sos] + target], device=self.lips.device)
        wanted = torch.tensor([target + [model.eos]], device=self.lips.device)
        mask = self.lips.subsequent_mask(given.size(1), device=self.lips.device).unsqueeze(0)
        hidden, _ = model.decoder(given, mask, features, None)
        attention = F.cross_entropy(model.decoder.out_layer_v(hidden)[0], wanted[0], label_smoothing=0.1)
        return 0.1 * ctc.to(self.lips.device) + 0.9 * attention

    def train(self, takes, *, epochs=12, lr=5e-4, accumulate=4, seed=0, say=print):
        torch, model = self.torch, self.model
        self.reset(seed)
        added = [p for layer in self.lora.values() for p in (layer.a, layer.b)]
        front = list(self.frontend.parameters())
        for p in added + front:
            p.requires_grad_(True)
        opt = torch.optim.AdamW([{'params': added, 'lr': lr}, {'params': front, 'lr': lr / 10}], weight_decay=0.01)
        targets = [pieces(t['words'], self.lips.units) for t in takes]
        rng = np.random.default_rng(seed)
        for epoch in range(1, epochs + 1):
            model.train()
            for m in model.modules():      # one face: keep the batch-norm statistics it was trained with
                if isinstance(m, torch.nn.modules.batchnorm._BatchNorm):
                    m.eval()
            total = 0.0
            opt.zero_grad()
            order = rng.permutation(len(takes))
            for k, i in enumerate(order, 1):
                loss = self.loss(takes[i]['frames'], targets[i], rng) / accumulate
                loss.backward()
                total += loss.item() * accumulate
                if k % accumulate == 0 or k == len(order):
                    torch.nn.utils.clip_grad_norm_(added + front, 5.0)
                    opt.step()
                    opt.zero_grad()
            say(f'  epoch {epoch}: loss {total / len(order):.3f}')
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
        model.eval()
        for p in added + front:
            p.requires_grad_(False)

    def read(self, take, w=1.0):
        """What each way of reading makes of a take: lips alone, the lips' n-best picked by the gaze, and the
        gaze inside the search (what lipgaze serve types)."""
        features = self.lips.encode(list(take['frames']))
        scorer = GazeScorer(take['gaze'])
        nbest = fused_search(self.lips, features, scorer, use_gaze=False)
        alone = nbest[0][0] if nbest else ''
        if not take['gaze'] or not nbest:
            return {'lips': alone, 'pick': alone, 'fused': alone}
        s = scorer.s

        def total(r):
            keys = key_path(r[0])
            return r[1].lips + w * s.weight / s.temperature * scorer.best_shift(keys)[0] if keys else -np.inf
        fused = fused_search(self.lips, features, scorer)
        return {'lips': alone, 'pick': max(nbest, key=total)[0], 'fused': fused[0][0] if fused else ''}

    def snapshot(self, **info):
        return {'lora': {n: {'a': l.a.detach().cpu().clone(), 'b': l.b.detach().cpu().clone(), 'scale': l.scale}
                         for n, l in self.lora.items()},
                'frontend': {k: v.detach().cpu().clone() for k, v in self.frontend.state_dict().items()}, **info}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('what', choices=['check', 'test', 'fit'])
    p.add_argument('takes')
    p.add_argument('--root', default=str(lipgaze.default_root()))
    p.add_argument('--words', help="the session audio's words with camera-clock times (debugging labels)")
    p.add_argument('--gaze', help='--learn-replay HIVE_REPLAY_GAZE lines: the gaze as the self-correcting map put it')
    p.add_argument('--folds', type=int, default=4)
    p.add_argument('--epochs', type=int, default=12)
    p.add_argument('--lr', type=float, default=5e-4)
    a = p.parse_args()
    heard = heard_words(a.words) if a.words else None
    takes = load(a.takes, heard)
    if a.gaze:
        rows = [json.loads(l) for l in open(a.gaze)]
        for t in takes:
            r = next((r for r in rows if abs(r['from'] - t['from']) < 1.0), None)
            if r:
                t['gaze'] = [(x, y) for tt, x, y in r['now'] if t['from'] <= tt <= t['to']]
    use = [t for t in takes if t['words']]
    for t in takes:
        print(f"{t['name']}  {t['why']:28s} {t['words'] or ''}   ({len(t['frames'])} frames, {len(t['gaze'])} gaze)")
    if a.what == 'check':
        return
    began = time.monotonic()
    fit = Fitter(a.root)
    print(f'{len(use)} takes to use; model loaded in {time.monotonic() - began:.0f} s', flush=True)
    if a.what == 'fit':
        fit.train(use, epochs=a.epochs, lr=a.lr)
        out = Path(a.root).parent / ADAPTER
        fit.torch.save(fit.snapshot(takes=len(use), made=time.strftime('%Y-%m-%d %H:%M')), out)
        os.chmod(out, 0o600)
        print(f'saved {out}')
        return
    folds = [use[k::a.folds] for k in range(a.folds)]
    ways = ('lips', 'pick', 'fused')
    tally = {(when, way): 0 for when in ('before', 'fitted') for way in ways}
    words = 0
    for k, test in enumerate(folds):
        learn = [t for t in use if t not in test]
        fit.reset()
        before = [fit.read(t) for t in test]
        print(f'fold {k + 1}: fitting to {len(learn)} takes, reading {len(test)}', flush=True)
        fit.train(learn, epochs=a.epochs, lr=a.lr)
        after = [fit.read(t) for t in test]
        for t, b, f in zip(test, before, after):
            words += len(t['words'].split())
            print(f"  {t['words']}")
            for when, got in (('before', b), ('fitted', f)):
                e = {way: word_errors(got[way], t['words']) for way in ways}
                for way in ways:
                    tally[when, way] += e[way]
                print(f"     {when}: " + ' / '.join(f"{way} {got[way]} ({e[way]})" for way in ways), flush=True)
    n = max(1, words)
    print(f"{words} words, % wrong: " + '; '.join(
        f"{when} " + ', '.join(f"{way} {100 * tally[when, way] / n:.1f}" for way in ways) for when in ('before', 'fitted'))
        + f"  ({(time.monotonic() - began) / 60:.0f} min)")


if __name__ == '__main__':
    main()
