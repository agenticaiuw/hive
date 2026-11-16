"""USR 2.0 Huge inference adapter, video only. Published weights, no retraining or LLM rewriting.

github.com/ahaliassos/usr2 (MIT), "huge_high_resource_lrs2lrs3vox2avsp.pth": 945M parameters,
17.6% word error rate reading lips on LRS3. On an M3 the encoder reads 8 s of video in about
0.4 s on the GPU. The release decodes with ESPnet's beam search, which takes 25-50 s here and
runs out of GPU memory at its default beam of 40; on test video a greedy pass of the decoder gave
the same words in 2 s, so that is what the final text uses. Drafts use the CTC head, one pass.

On its own README demo (assets/demo.gif, a sentence about USR 2.0) it read "you can find space
recognitional 2 significant improved training spaces and robustness through domain shifts" from
the release's own offline crop, and a little worse from the live crop (MouthCrops); FLARE Large
read "unified speech recognition 20 significantly improves the trading space and robustness to
domain shifts".

On the owner's own video (2026-11-16, MacBook Air camera, said aloud) it did better: "what's the
weather going to be like tomorrow afternoon" word for word (FLARE: "what when going to midnight
tomorrow afternoon"), and 2 words off on "please open safari and check my email from this morning"
(FLARE: 5). On eight short commands read off the screen ("set a timer for twenty minutes", ...)
both did badly: USR 2.0 got 47 of 60 words wrong ("i sat at the table for 20 minutes"), FLARE 50,
and reading each sentence with 0.5 s more on each side didn't help. So it is Hive's lip reader when
it is installed, as the less bad one; LIPREAD_MODEL=flare picks FLARE.
"""
import os
from pathlib import Path
import re
import sys
import threading
import time
from types import SimpleNamespace

WEIGHTS = 'huge_high_resource_lrs2lrs3vox2avsp.pth'


def FramePool(pool):
    """The video front end's max pool, one frame at a time: its time kernel is 1, so this is the
    same pool, and torch 2.6 (FLARE's) can't run a 3-D max pool on the Mac's GPU."""
    import torch

    class FramePool(torch.nn.Module):
        def forward(self, x):
            b, c, t, h, w = x.shape
            x = x.transpose(1, 2).reshape(b * t, c, h, w)
            x = torch.nn.functional.max_pool2d(x, pool.kernel_size[1:], pool.stride[1:], pool.padding[1:])
            return x.reshape(b, t, c, *x.shape[-2:]).transpose(1, 2)

    return FramePool()


def looping(ids, times=3):
    """If the decoder is saying the same thing over and over (the last few tokens three times in a
    row), what it said with one copy of them; else None. Greedy decoding loops like this on video it
    can't read: "... from this morning oh my god oh my god oh my god oh my god"."""
    for n in range(1, min(10, len(ids) // times) + 1):
        tail = ids[-n:]
        if all(ids[-(k + 1) * n:len(ids) - k * n] == tail for k in range(1, times)):
            return ids[:len(ids) - (times - 1) * n]
    return None


def pieces(text, units):
    """`text` as USR 2.0's word pieces (indexes into `units`): each word upper-cased after '▁', in
    the fewest pieces. The model splits text the same way: reading "what's the weather going to be
    like tomorrow afternoon" it wrote ▁WHAT ' S ▁THE ▁WE A TH ER ... ▁AFTER NO ON, piece for piece."""
    index = {unit: i for i, unit in enumerate(units)}
    ids = []
    for word in re.sub(r"[^a-z0-9' ]+", ' ', text.lower()).upper().split():
        word = '▁' + word
        best = [None] * (len(word) + 1)   # best[i]: the fewest pieces spelling word[:i]
        best[0] = []
        for i in range(len(word)):
            if best[i] is None:
                continue
            for j in range(i + 1, len(word) + 1):
                if word[i:j] in index and (best[j] is None or len(best[i]) + 1 < len(best[j])):
                    best[j] = best[i] + [index[word[i:j]]]
        ids += best[-1] if best[-1] is not None else [index['<unk>']]
    return ids


def add_personal(model, path):
    """Merges what lipread_personal.py learned from the owner's own face into the model: low-rank
    changes to the attention layers' query and value weights, and the video front end's weights."""
    import torch
    saved = torch.load(path, map_location='cpu', weights_only=True)
    modules = dict(model.named_modules())
    with torch.no_grad():
        for name, change in saved['lora'].items():
            linear = modules[name]
            linear.weight += (change['scale'] * change['b'] @ change['a']).to(linear.weight)
        model.encoder.frontend_v.load_state_dict(saved['frontend'])
    return saved


class Usr2:
    crop_shape = (88, 88)

    def __init__(self, root, personal=True):
        import torch
        from omegaconf import OmegaConf
        root = Path(root)
        sys.path.insert(0, str(root))
        from espnet.nets.pytorch_backend.e2e_asr_transformer import E2E
        from espnet.nets.pytorch_backend.transformer.mask import subsequent_mask
        from utils.utils import UNIGRAM1000_LIST

        torch.set_num_threads(4)
        self.lock = threading.Lock()
        self.device = os.environ.get('LIPREAD_DEVICE', 'mps' if torch.backends.mps.is_available() else 'cpu')
        state = torch.load(root / 'weights' / WEIGHTS, map_location='cpu', weights_only=False, mmap=True)
        # The release holds the model twice: the model and its training-time teacher. Only the
        # model reads lips.
        state = {k.replace('_orig_mod.', '', 1): v for k, v in state.items()}
        state = {k[len('model.backbone.'):]: v for k, v in state.items() if k.startswith('model.backbone.')}
        # Plain values: the yaml refers to itself as model.backbone, and FLARE's OmegaConf (2.0)
        # answers None for settings it lacks where E2E expects its defaults.
        backbone = OmegaConf.create({'model': {'backbone': OmegaConf.load(
            root / 'conf/model/backbone/resnet_transformer_huge.yaml')}})
        backbone = OmegaConf.to_container(backbone, resolve=True)['model']['backbone']
        backbone.pop('_target_', None)
        self.model = E2E(len(UNIGRAM1000_LIST), SimpleNamespace(**backbone))
        self.model.load_state_dict(state, strict=True)
        self.name = 'USR 2.0 Huge (2026)'
        self.personal = None
        adapter = Path(os.environ.get('LIPREAD_PERSONAL_ADAPTER') or root.parent / 'personal' / 'usr2_adapter.pt')
        if personal and os.environ.get('LIPREAD_PERSONAL') != '0' and adapter.exists():
            try:
                self.personal = add_personal(self.model, adapter)
                self.name = 'USR 2.0 Huge (2026), fitted to you'
            except Exception as exc:   # a bad adapter must not stop lip reading
                print(f'lipread_usr2: not using {adapter}: {type(exc).__name__}: {exc}', file=sys.stderr)
                self.model.load_state_dict(state, strict=True)
        del state
        frontend = self.model.encoder.frontend_v.frontend3D
        if isinstance(frontend[-1], torch.nn.MaxPool3d) and frontend[-1].kernel_size[0] == 1:
            frontend[-1] = FramePool(frontend[-1])
        self.model.eval().to(self.device)
        self.tokens = UNIGRAM1000_LIST
        self.subsequent_mask = subsequent_mask
        self.mean_face = root / 'preprocessing/20words_mean_face.npy'
        self.last_seconds = 0

    def crops(self):
        from lipread_vision import MouthCrops
        return MouthCrops(self.mean_face)

    def words(self, ids) -> str:
        text = ''.join(self.tokens[i] for i in ids)
        text = text.replace('▁', ' ').replace('<unk>', '').replace('<eos>', '')
        return ' '.join(text.split()).lower()

    def __call__(self, crops, final=False):
        import numpy as np
        import torch
        with self.lock, torch.inference_mode():
            began = time.monotonic()
            # Input list: T x 88 x 88 mouth crops, gray.
            x = torch.from_numpy(np.stack(crops)).to(self.device, dtype=torch.float32)
            x = ((x / 255.0 - 0.421) / 0.165)[None]
            features = self.model.encoder(xs_v=x)
            if not final:
                best = self.model.ctc_v.log_softmax(features).argmax(-1)[0].tolist()
                ids = [t for i, t in enumerate(best) if t != 0 and (i == 0 or t != best[i - 1])]
            else:
                ys = torch.tensor([[self.model.sos]], device=self.device)
                cache = None
                ids = []
                # Speech is about 4 tokens a second (0.16 a frame); half a token a frame is plenty.
                for _ in range(min(150, max(8, len(crops) // 2))):
                    mask = self.subsequent_mask(ys.size(1), device=self.device).unsqueeze(0)
                    y, cache = self.model.decoder.forward_one_step(ys, mask, features, cache=cache)
                    token = self.model.decoder.out_layer_v(y).argmax(-1, keepdim=True)
                    if token.item() == self.model.eos:
                        break
                    ys = torch.cat([ys, token], dim=1)
                    ids.append(token.item())
                    if looping(ids):
                        ids = looping(ids)
                        break
            self.last_seconds = time.monotonic() - began
            return self.words(ids)
