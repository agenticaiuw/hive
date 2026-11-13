"""Your own lip-reading data: record yourself talking, let Parakeet write down what you said, and
see how each lip model reads you. The clips and their words are what fine-tuning learns from.

    F=~/Library/Application\\ Support/Personal\\ Agent/lipread/flare/.venv/bin/python
    $F scripts/lipread_collect.py record                 # camera + microphone until you press q
    .venv/bin/python scripts/lipread_collect.py label    # Parakeet: short clips and their words
    $F scripts/lipread_collect.py score                  # each lip model's word error rate on you

Recordings stay in <lipread>/personal (Hive's lip-reading folder, readable only by you) and
nothing is uploaded. The camera and microphone are on only while `record` runs, in a window that
shows what the camera sees. `record` and `score` run on FLARE's Python (OpenCV, the lip models);
`label` runs on Hive's (Parakeet, as python/listen.py uses it).
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import wave

import numpy as np

RATE = 16000
FPS = 25
PARAKEET = 'mlx-community/parakeet-tdt-0.6b-v2'


def home() -> Path:
    """Hive's lip-reading folder (hive-sidecars' lipread::home)."""
    if os.environ.get('LIPREAD_DIR'):
        return Path(os.environ['LIPREAD_DIR'])
    state = os.environ.get('AGENT_STATE_DIR') or Path.home() / 'Library/Application Support/Personal Agent'
    return Path(state) / 'lipread'


def recordings():
    folder = home() / 'personal'
    return sorted(p for p in folder.iterdir() if (p / 'audio.wav').exists()) if folder.is_dir() else []


# -- record ------------------------------------------------------------------------------------

def record(args):
    import cv2
    import sounddevice
    prompts = [l.strip() for l in Path(args.prompts).read_text().splitlines() if l.strip()] if args.prompts else []
    camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        sys.exit('Camera unavailable: allow your terminal in System Settings › Privacy & Security › Camera.')
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_FPS, 30)
    folder = home() / 'personal' / time.strftime('%Y%m%d-%H%M%S')
    folder.mkdir(parents=True)
    os.chmod(folder.parent, 0o700)
    chunks, began = [], []

    def heard(block, frames, _time, _status):
        if not began:
            began.append(time.monotonic() - frames / RATE)
        chunks.append(block[:, 0].copy())

    writer, times, line = None, [], 0
    title = 'Lip reading data: q stops' + (', space shows the next line' if prompts else '')
    try:
        with sounddevice.InputStream(samplerate=RATE, channels=1, dtype='int16', callback=heard):
            last = time.monotonic()
            while True:
                ok, frame = camera.read()
                now = time.monotonic()
                if not ok:
                    if now - last > 3:
                        print('The camera stopped giving frames.', file=sys.stderr)
                        break
                    continue
                last = now
                if writer is None:
                    h, w = frame.shape[:2]
                    writer = cv2.VideoWriter(str(folder / 'video.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 30, (w, h))
                writer.write(frame)
                times.append(now)
                shown = cv2.flip(frame, 1)
                seconds = now - times[0]
                cv2.putText(shown, f'REC {int(seconds // 60)}:{int(seconds % 60):02d}', (12, 28),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                hint = prompts[line % len(prompts)] if prompts else 'Talk normally. Keep your mouth in view.'
                cv2.putText(shown, hint[:60], (12, shown.shape[0] - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                cv2.imshow(title, shown)
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                if key == ord(' '):
                    line += 1
    except KeyboardInterrupt:
        pass
    finally:
        camera.release()
        if writer is not None:
            writer.release()
        cv2.destroyAllWindows()
    if not times or not chunks:
        sys.exit('Nothing was recorded.')
    with wave.open(str(folder / 'audio.wav'), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(np.concatenate(chunks).tobytes())
    # Each video frame's time in the audio, in seconds.
    np.save(folder / 'times.npy', np.array(times) - began[0])
    print(f'Recorded {times[-1] - times[0]:.0f} s to {folder}. Next: label (Hive\'s Python).')


# -- label -------------------------------------------------------------------------------------

def split(tokens, longest=6.0, pause=0.6):
    """Parakeet's timed tokens as clips of whole words, cut at pauses and sentence ends and at
    most about `longest` seconds, since lip models are trained on short utterances."""
    clips, words = [], []

    def close():
        text = ' '.join(''.join(t.text for t in words).split())
        if text:
            clips.append({'start': round(words[0].start, 3),
                          'end': round(words[-1].start + words[-1].duration, 3), 'text': text})
        words.clear()

    for token in tokens:
        if words and token.text.startswith(' '):
            gap = token.start - (words[-1].start + words[-1].duration)
            ended = words[-1].text.rstrip().endswith(('.', '?', '!'))
            if gap > pause or ended or token.start + token.duration - words[0].start > longest:
                close()
        words.append(token)
    if words:
        close()
    return clips


def label(args):
    import mlx.core as mx
    from parakeet_mlx import from_pretrained
    try:
        from huggingface_hub import snapshot_download
        source = snapshot_download(args.model, local_files_only=True)
    except Exception:
        source = args.model
    model = from_pretrained(source, dtype=mx.float32)
    for folder in recordings():
        if (folder / 'labels.json').exists() and not args.again:
            continue
        result = model.transcribe(folder / 'audio.wav', chunk_duration=120, overlap_duration=15)
        clips = split([t for s in result.sentences for t in s.tokens])
        (folder / 'labels.json').write_text(json.dumps({'model': args.model, 'text': result.text, 'clips': clips}, indent=1))
        print(f'{folder.name}: {len(clips)} clips, {sum(c["end"] - c["start"] for c in clips):.0f} s of speech')


# -- score -------------------------------------------------------------------------------------

def clip_frames(times, start, end, pad=0.15, fps=FPS):
    """The recorded frames nearest each 1/fps tick from start - pad to end + pad (seconds)."""
    ticks = start - pad + np.arange(round((end - start + 2 * pad) * fps)) / fps
    ticks = ticks[(ticks >= times[0]) & (ticks <= times[-1])]
    right = np.searchsorted(times, ticks).clip(1, len(times) - 1)
    return right - ((ticks - times[right - 1]) <= (times[right] - ticks))


def words(text):
    return re.sub(r"[^a-z0-9']+", ' ', text.lower()).split()


def errors(said, read):
    """Word edits from what was said to what was read, and the number of words said."""
    ref, hyp = words(said), words(read)
    row = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, row[0] = row[0], i
        for j, h in enumerate(hyp, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (r != h))
    return row[-1], len(ref)


def crops_for(folder, model, needed):
    """The model's crop of each needed frame (None where the face wasn't found), cached."""
    import cv2
    crops = model.crops()
    cache = folder / f'crops_{type(crops).__name__}.npz'
    if cache.exists():
        saved = np.load(cache)
        if set(needed) <= set(saved['index'].tolist()):
            return dict(zip(saved['index'].tolist(), saved['crops'])), saved['missing'].tolist()
    video, kept, missing, i = cv2.VideoCapture(str(folder / 'video.mp4')), {}, [], 0
    last = max(needed)
    while i <= last:
        ok, frame = video.read()
        if not ok:
            break
        crop = crops(frame)
        if i in needed:
            if crop is None:
                missing.append(i)
            else:
                kept[i] = crop
        i += 1
    crops.close()
    index = sorted(kept)
    np.savez(cache, index=np.array(index, dtype=np.int64), missing=np.array(missing, dtype=np.int64),
             crops=np.stack([kept[k] for k in index]) if index else np.zeros((0,) + model.crop_shape, np.uint8))
    return kept, missing


def score(args):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lipread_worker import load_model
    os.environ.setdefault('LIPREAD_FLARE_DIR', str(home() / 'flare'))
    labeled = [f for f in recordings() if (f / 'labels.json').exists()]
    if not labeled:
        sys.exit('Nothing labeled yet: record, then label.')
    usr2 = (home() / 'usr2/weights/huge_high_resource_lrs2lrs3vox2avsp.pth').exists()
    for name in args.models or ['flare'] + ['usr2'] * usr2:
        os.environ['LIPREAD_MODEL'] = name
        model = load_model()
        total_errors = total_words = skipped = 0
        for folder in labeled:
            times = np.load(folder / 'times.npy')
            clips = [c for c in json.loads((folder / 'labels.json').read_text())['clips'] if c['end'] - c['start'] >= 0.5]
            frames = [clip_frames(times, c['start'], c['end']) for c in clips]
            kept, _ = crops_for(folder, model, {int(i) for f in frames for i in f})
            results = []
            for clip, index in zip(clips, frames):
                have = [kept[int(i)] for i in index if int(i) in kept]
                if len(have) < max(12, 0.9 * len(index)):
                    skipped += 1
                    continue
                read = model(have, final=True)
                wrong, said = errors(clip['text'], read)
                total_errors, total_words = total_errors + wrong, total_words + said
                results.append({**clip, 'read': read, 'errors': wrong})
                if args.verbose:
                    print(f'  said: {clip["text"]}\n  read: {read}')
            (folder / f'score_{name}.json').write_text(json.dumps(results, indent=1))
        print(f'{model.name}: {100 * total_errors / max(total_words, 1):.1f}% word error rate over {total_words} words'
              + (f' ({skipped} clips skipped: face not found)' if skipped else ''), flush=True)
        del model
        import gc
        import torch
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('record', help='record yourself talking: camera and microphone, until q')
    p.add_argument('--prompts', help='a text file of lines to read, one shown at a time (space: next)')
    p.set_defaults(run=record)
    p = commands.add_parser('label', help="Parakeet writes down each recording's words, in short clips")
    p.add_argument('--model', default=os.environ.get('STT_MODEL') or PARAKEET)
    p.add_argument('--again', action='store_true', help='label recordings that already have labels')
    p.set_defaults(run=label)
    p = commands.add_parser('score', help='how each lip model reads your labeled clips')
    p.add_argument('models', nargs='*', help='flare, usr2 (default: those installed)')
    p.add_argument('-v', '--verbose', action='store_true', help='show each clip: said and read')
    p.set_defaults(run=score)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    main()
