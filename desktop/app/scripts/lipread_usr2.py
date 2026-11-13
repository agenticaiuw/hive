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
domain shifts". So it is opt-in (LIPREAD_MODEL=usr2) until the two are compared on the user's own video.
"""
import os
from pathlib import Path
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


class Usr2:
    crop_shape = (88, 88)

    def __init__(self, root):
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
        del state
        frontend = self.model.encoder.frontend_v.frontend3D
        if isinstance(frontend[-1], torch.nn.MaxPool3d) and frontend[-1].kernel_size[0] == 1:
            frontend[-1] = FramePool(frontend[-1])
        self.model.eval().to(self.device)
        self.tokens = UNIGRAM1000_LIST
        self.subsequent_mask = subsequent_mask
        self.mean_face = root / 'preprocessing/20words_mean_face.npy'
        self.name = 'USR 2.0 Huge (2026)'
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
                for _ in range(min(150, max(8, len(crops)))):
                    mask = self.subsequent_mask(ys.size(1), device=self.device).unsqueeze(0)
                    y, cache = self.model.decoder.forward_one_step(ys, mask, features, cache=cache)
                    token = self.model.decoder.out_layer_v(y).argmax(-1, keepdim=True)
                    if token.item() == self.model.eos:
                        break
                    ys = torch.cat([ys, token], dim=1)
                ids = ys[0, 1:].tolist()
            self.last_seconds = time.monotonic() - began
            return self.words(ids)
