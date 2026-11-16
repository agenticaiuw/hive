"""Teach Hive's lip reader your face: say sentences shown on screen, then fit USR 2.0 to them.

    F=~/Library/Application\\ Support/Personal\\ Agent/lipread/flare/.venv/bin/python
    $F scripts/lipread_personal.py record    # a camera window shows a sentence: say it, then pause
    $F scripts/lipread_personal.py train     # fits USR 2.0 to what you recorded; Hive then uses it

Say the sentences the way you'll talk to Hive. `record` carries on where it stopped last time.
Every tenth sentence is never trained on: `train` measures the share of words USR 2.0 gets wrong on
those, before and after. Kept: each sentence and 88x88 grey crops of your mouth saying it, no video
or sound, in <lipread>/personal/sentences (readable only by you). Nothing is uploaded. `train`
writes <lipread>/personal/usr2_adapter.pt only if the held-out sentences come out better, and
lipread_usr2 merges it into the model when it loads (LIPREAD_PERSONAL=0 leaves it out).

Training changes small low-rank additions to each attention layer's query and value weights (LoRA,
4 M numbers) and the video front end (11 M), not the 945 M weights themselves. On an M3 MacBook Air
(24 GB) a step on a 5.7 s sentence took 0.55 s and 6 GB of GPU memory; training every weight
would take about 17 GB, too much beside Hive.
"""
import argparse
import os
from pathlib import Path
import queue
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lipread_collect import errors, home  # noqa: E402

FPS = 25
PROMPTS = Path(__file__).resolve().parent / 'lipread_prompts.txt'
HELD_OUT = 10       # every tenth sentence only measures
MARGIN = 0.5        # still lips kept each side of a take, as Hive's captions cut sentences
CLEAR = '\r\033[K'  # back to the start of the line and clear it: progress rewrites one line


def held_out(index):
    return index % HELD_OUT == HELD_OUT - 1


def sentences_folder(args=None):
    return Path(getattr(args, 'data', None) or home() / 'personal' / 'sentences')


def prompts():
    return [line.strip() for line in PROMPTS.read_text().splitlines() if line.strip()]


def plausible(frames, text, fps=FPS):
    """None if a take of `frames` frames could be someone saying `text`, else what to tell them.
    People say 2-4 words a second; a take cut at a pause inside the sentence is too short for it."""
    words = len(text.split())
    talking = frames / fps - 2 * MARGIN
    if talking < 0.15 * words:
        return 'That was cut short: say the whole sentence again.'
    if talking > 1.0 * words + 2:
        return 'That was too long for the sentence: say it again.'
    return None


def load(where):
    """The recorded sentences: [{'index', 'text', 'crops'}], by index."""
    taken = []
    for path in sorted(where.glob('[0-9][0-9][0-9][0-9].npz')):
        with np.load(path) as saved:
            taken.append({'index': int(path.stem), 'text': str(saved['text']), 'crops': saved['crops']})
    return taken


# -- record ------------------------------------------------------------------------------------

class Session:
    """`record` without the camera: takes are cut the way Hive's captions cut sentences
    (lipread_stream.Sentences), except that a sentence ends after a longer pause (1 s), since
    reading off a screen can stall mid-sentence. Each plausible take is kept as the sentence on
    screen, and the next unrecorded sentence comes up."""

    def __init__(self, where, lines, pause=1.0):
        self.where, self.lines, self.pause = where, lines, pause
        where.mkdir(parents=True, exist_ok=True)
        os.chmod(where.parent, 0o700)
        os.chmod(where, 0o700)
        self.kept = []                 # indexes kept this session, latest last
        self.takes = queue.Queue()     # takes the cutter has finished
        self.cutter = None
        self.message = 'Say the sentence, then pause.'
        self.index = self.next(0)
        self.restart()

    def path(self, index):
        return self.where / f'{index:04d}.npz'

    def next(self, start):
        return next((i for i in range(start, len(self.lines)) if not self.path(i).exists()), None)

    def recorded(self):
        return sum(self.path(i).exists() for i in range(len(self.lines)))

    def restart(self):
        """Forget the take in progress."""
        from lipread_stream import Sentences
        if self.cutter is not None:
            self.cutter.cancel()
        self.takes = queue.Queue()
        takes = self.takes
        self.cutter = Sentences(lambda batch, final=True: takes.put(batch) or '', lambda **event: None,
                                pause=self.pause, margin=MARGIN, queue=10 ** 6)

    def feed(self, crop, opening):
        self.cutter.feed(crop, opening)

    def poll(self):
        """Keeps a finished take, if there is one: True when kept, False when not, None if none."""
        try:
            batch = self.takes.get_nowait()
        except queue.Empty:
            return None
        if self.index is None:
            return False
        text = self.lines[self.index]
        why = plausible(len(batch), text)
        if why:
            self.message = why
            return False
        np.savez_compressed(self.path(self.index), crops=np.stack(batch).astype(np.uint8), text=text)
        self.kept.append(self.index)
        self.index = self.next(self.index + 1)
        self.message = f'Kept. {self.recorded()} of {len(self.lines)} recorded.'
        return True

    def redo(self):
        if not self.kept:
            return
        last = self.kept.pop()
        self.path(last).unlink(missing_ok=True)
        self.index = last
        self.message = 'Say it again.'
        self.restart()

    def skip(self):
        if self.index is not None:
            self.index = self.next(self.index + 1)
            self.message = 'Skipped.'
        self.restart()


def wrap(text, width):
    lines, line = [], ''
    for word in text.split():
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f'{line} {word}'.strip()
    return lines + [line] if line else lines


def draw(frame, session, note):
    import cv2
    shown = cv2.resize(cv2.flip(frame, 1), (960, 720))
    shade = shown.copy()
    cv2.rectangle(shade, (0, 0), (960, 210), (0, 0, 0), -1)
    cv2.rectangle(shade, (0, 650), (960, 720), (0, 0, 0), -1)
    shown = cv2.addWeighted(shade, 0.6, shown, 0.4, 0)
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(shown, f'REC  {session.recorded()} of {len(session.lines)} recorded', (16, 34), font, 0.8,
                (0, 0, 255), 2)
    say = 'All sentences recorded. Press q.' if session.index is None else session.lines[session.index]
    for i, line in enumerate(wrap(say, 34)[:3]):
        cv2.putText(shown, line, (16, 95 + 48 * i), font, 1.3, (255, 255, 255), 3, cv2.LINE_AA)
    note = (note or session.message).encode('ascii', 'replace').decode()
    colour = (120, 255, 120) if note.startswith('Kept') else (0, 200, 255)
    cv2.putText(shown, note, (16, 690), font, 0.75, colour, 2)
    cv2.putText(shown, 'r: redo last   s: skip   q: stop', (640, 712), font, 0.5, (200, 200, 200), 1)
    return shown


def record(args):
    import cv2
    from lipread_vision import MouthCrops
    session = Session(sentences_folder(args), prompts())
    if session.index is None:
        sys.exit(f'All {len(session.lines)} sentences are recorded. Next: train.')
    camera = cv2.VideoCapture(0)
    deadline = time.monotonic() + 10
    while not camera.isOpened() and time.monotonic() < deadline:
        time.sleep(0.5)
        camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        sys.exit('Camera unavailable: allow your terminal in System Settings > Privacy & Security > Camera.')
    # As Hive's lip worker reads the camera, so takes look like what Hive will read.
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_FPS, 25)
    crops = MouthCrops(home() / 'usr2/preprocessing/20words_mean_face.npy')
    window = 'Lip reading: say each sentence, then pause'
    cv2.namedWindow(window)
    cv2.setWindowProperty(window, cv2.WND_PROP_TOPMOST, 1)
    began, next_frame, kept_at = time.monotonic(), 0.0, 0.0
    last_good, why = began, None
    print(f'{session.recorded()} of {len(session.lines)} recorded so far; q stops, and the next run carries on.',
          flush=True)
    try:
        while True:
            ok, frame = camera.read()
            now = time.monotonic()
            if not ok:
                if now - last_good > 3:
                    why = 'the camera stopped giving frames'
                    break
                continue
            last_good = now
            if now < next_frame:
                continue
            next_frame = max(next_frame + 1 / FPS, now)
            note = None
            if now - began < 3:
                note = f'Starting in {3 - int(now - began)}...'
            else:
                crop = crops(frame)
                if crop is None:
                    note = crops.framing
                else:
                    session.feed(crop, crops.opening)
                if session.poll():
                    kept_at = now
                    print(f'  kept {session.kept[-1] + 1:3d}: {session.lines[session.kept[-1]]}', flush=True)
            cv2.imshow(window, draw(frame, session, note))
            key = cv2.waitKey(1) & 0xFF
            if now - began < 3:   # the window takes the keyboard: ignore keys meant for something else
                continue
            if key in (ord('q'), 27):
                why = f'you pressed {"q" if key == ord("q") else "Esc"}'
                break
            if session.index is None and now - kept_at > 2:
                why = 'every sentence is recorded'
                break
            if key == ord('r'):
                session.redo()
            elif key == ord('s'):
                session.skip()
    finally:
        session.cutter.cancel()
        camera.release()
        crops.close()
        cv2.destroyAllWindows()
        cv2.waitKey(1)
    left = len(session.lines) - session.recorded()
    print(f'Stopped because {why}. Kept {len(session.kept)} this time; '
          f'{session.recorded()} of {len(session.lines)} recorded'
          + (f', {left} to go.' if left else '. Next: train.'))


# -- train -------------------------------------------------------------------------------------

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


def augment(crops, rng):
    """As lip readers are trained: mirrored half the time, shifted a few pixels, and up to 0.4 s in
    each second blanked out. Trimmed to a multiple of 8 frames, so the GPU sees fewer shapes."""
    x = crops[:, :, ::-1] if rng.random() < 0.5 else crops
    dy, dx = rng.integers(-4, 5, 2)
    x = np.roll(x, (dy, dx), axis=(1, 2)).copy()
    for _ in range(max(1, len(x) // FPS)):
        width = int(rng.integers(0, 11))
        start = int(rng.integers(0, max(1, len(x) - width)))
        x[start:start + width] = int(x.mean())
    extra = len(x) % 8 if len(x) > 16 else 0
    return x[extra // 2:len(x) - (extra - extra // 2)]


def train(args):
    import torch
    import torch.nn.functional as F
    taken = load(sentences_folder(args))
    learn = [t for t in taken if not held_out(t['index'])]
    test = [t for t in taken if held_out(t['index'])]
    if len(learn) < args.least or not test:
        sys.exit(f'{len(taken)} sentences recorded: record at least {args.least + args.least // 9} first.')
    os.chdir(home() / 'flare')   # where Hive's lip worker runs; FLARE's Python runs USR 2.0 too
    from lipread_usr2 import Usr2, pieces
    reader = Usr2(home() / 'usr2', personal=False)
    model, device = reader.model, reader.device
    targets = {t['index']: pieces(t['text'], reader.tokens) for t in taken}
    for p in model.parameters():
        p.requires_grad_(False)
    lora = add_lora(model)
    frontend = model.encoder.frontend_v
    added = [p for layer in lora.values() for p in (layer.a, layer.b)]
    for p in [*added, *frontend.parameters()]:
        p.requires_grad_(True)
    learning = [*added, *frontend.parameters()]
    optimizer = torch.optim.AdamW([{'params': added, 'lr': args.lr},
                                   {'params': list(frontend.parameters()), 'lr': args.lr / 10}],
                                  weight_decay=0.01)

    def measure():
        """Reads the held-out sentences, printing each as it goes."""
        model.eval()
        wrong = said = 0
        for k, t in enumerate(test, 1):
            read = reader(list(t['crops']), final=True)
            w, n = errors(t['text'], read)
            wrong, said = wrong + w, said + n
            print(f'{CLEAR}    {k:2d}. {w}/{n} wrong  read "{read}"  for "{t["text"]}"', flush=True)
        return wrong / max(said, 1), f'{100 * wrong / max(said, 1):.1f}% ({wrong}/{said} words)'

    def loss_of(t, rng):
        x = torch.from_numpy(augment(t['crops'], rng)).to(device, dtype=torch.float32)
        x = ((x / 255.0 - 0.421) / 0.165)[None]
        target = targets[t['index']]
        features = model.encoder(xs_v=x)
        # 0.1 CTC + 0.9 attention, as USR 2.0 decodes (decode/default.yaml ctc_weight 0.1). Torch has
        # no CTC loss on the Mac's GPU: it runs on the CPU, and gradients flow back.
        logp = model.ctc_v.log_softmax(features).float().cpu()
        ctc = F.ctc_loss(logp.transpose(0, 1), torch.tensor([target]), torch.tensor([logp.size(1)]),
                         torch.tensor([len(target)]), blank=0, reduction='sum', zero_infinity=True) / len(target)
        given = torch.tensor([[model.sos] + target], device=device)
        wanted = torch.tensor([target + [model.eos]], device=device)
        mask = reader.subsequent_mask(given.size(1), device=device).unsqueeze(0)
        hidden, _ = model.decoder(given, mask, features, None)
        attention = F.cross_entropy(model.decoder.out_layer_v(hidden)[0], wanted[0], label_smoothing=0.1)
        return 0.1 * ctc.to(device) + 0.9 * attention

    def snapshot():
        return {'lora': {name: {'a': layer.a.detach().cpu().clone(), 'b': layer.b.detach().cpu().clone(),
                                'scale': layer.scale} for name, layer in lora.items()},
                'frontend': {k: v.detach().cpu().clone() for k, v in frontend.state_dict().items()}}

    began = time.monotonic()
    print(f'{len(learn)} sentences to learn from, {len(test)} held out. Reading the held-out ones before training:',
          flush=True)
    before, shown = measure()
    print(f'Before: {shown} wrong.', flush=True)
    best, best_rate, stale = None, before, 0
    rng = np.random.default_rng(0)
    for epoch in range(1, args.epochs + 1):
        model.train()
        for module in model.modules():   # one face: keep the batch-norm statistics it was trained with
            if isinstance(module, torch.nn.modules.batchnorm._BatchNorm):
                module.eval()
        total, started = 0.0, time.monotonic()
        order = rng.permutation(len(learn))
        optimizer.zero_grad()
        for k, i in enumerate(order, 1):
            loss = loss_of(learn[i], rng) / args.accumulate
            loss.backward()
            total += loss.item() * args.accumulate
            if k % args.accumulate == 0 or k == len(order):
                torch.nn.utils.clip_grad_norm_(learning, 5.0)
                optimizer.step()
                optimizer.zero_grad()
            print(f'{CLEAR}epoch {epoch}: learning from sentence {k} of {len(order)}, loss so far {total / k:.3f} '
                  f'({time.monotonic() - started:.0f} s)', end='', flush=True)
        print(f'{CLEAR}epoch {epoch}: learned from {len(order)} sentences, loss {total / len(order):.3f} '
              f'({time.monotonic() - started:.0f} s). Reading the held-out ones:', flush=True)
        rate, shown = measure()
        print(f'epoch {epoch}: held out {shown} wrong (best so far '
              f'{100 * min(rate, best_rate):.1f}%, {time.monotonic() - began:.0f} s in all)', flush=True)
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if rate < best_rate:
            best, best_rate, stale = snapshot(), rate, 0
        else:
            stale += 1
            if stale >= args.patience:
                break
    took = (time.monotonic() - began) / 60
    if best is None:
        print(f'No better than before after {took:.0f} min; nothing saved.')
        return
    out = Path(args.out or home() / 'personal' / 'usr2_adapter.pt')
    best.update({'before': before, 'after': best_rate, 'sentences': len(learn), 'held_out': len(test),
                 'made': time.strftime('%Y-%m-%d %H:%M')})
    if out.exists():
        old = torch.load(out, map_location='cpu', weights_only=True)
        # Measured on the same sentences: keep whichever did better.
        if (old.get('sentences'), old.get('held_out')) == (len(learn), len(test)) and old.get('after', 1) <= best_rate:
            print(f'Held out: {100 * best_rate:.1f}% wrong, no better than the saved one\'s '
                  f'{100 * old["after"]:.1f}%; kept {out}.')
            return
        out.replace(out.with_suffix('.previous.pt'))
    torch.save(best, out)
    os.chmod(out, 0o600)
    print(f'Held out: {100 * before:.1f}% of words wrong before, {100 * best_rate:.1f}% after ({took:.0f} min). '
          f'Saved {out}; Hive\'s lip reader uses it from the next time it starts.')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('record', help='say the sentences shown on screen; carries on where it stopped')
    p.add_argument('--data', help='where the takes go (default <lipread>/personal/sentences)')
    p.set_defaults(run=record)
    p = commands.add_parser('train', help='fit USR 2.0 to the recorded sentences')
    p.add_argument('--data', help='the recorded sentences (default <lipread>/personal/sentences)')
    p.add_argument('--out', help='the adapter (default <lipread>/personal/usr2_adapter.pt)')
    p.add_argument('--epochs', type=int, default=15)
    p.add_argument('--patience', type=int, default=3, help='stop after this many epochs without a better score')
    p.add_argument('--lr', type=float, default=5e-4)
    p.add_argument('--accumulate', type=int, default=4, help='sentences per update')
    p.add_argument('--least', type=int, default=45, help='sentences to learn from, at least')
    p.set_defaults(run=train)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    main()
