"""FLARE Large inference adapter. Published weights, no retraining or LLM rewriting.

The upstream release assumes a Linux training filesystem. Build its published architecture
from the supplied config and load the complete fine-tuned state strictly, without needing
its separate pretraining checkpoint or training-only Whisper statistics file.
"""
from pathlib import Path
import os
import sys
import threading
import time


class Flare:
    def __init__(self, root):
        import numpy as np
        import torch
        from omegaconf import OmegaConf
        from unittest.mock import patch
        root = Path(root)
        sys.path.insert(0, str(root))
        # Upstream switches to broken top-level imports when len(argv)==1.
        if len(sys.argv) == 1:
            sys.argv.append('--worker')
        from flare.hubert_distill_frm_whisper_offline_bestrq import AVHubertModel, AVHubertConfig
        from flare.hubert_pretraining import AVHubertPretrainingConfig
        from flare.hubert_asr import AVHubertSeq2SeqConfig, AVHubertSeq2Seq, HubertEncoderWrapper
        from flare.decoder import TransformerDecoder
        from fairseq.data import Dictionary

        torch.set_num_threads(4)
        self.lock = threading.Lock()
        self.device = os.environ.get('LIPREAD_DEVICE', 'mps' if torch.backends.mps.is_available() else 'cpu')
        checkpoint = torch.load(root / 'large.pt', map_location='cpu', weights_only=False, mmap=True)
        pretrained = OmegaConf.load(root / 'flare/conf/pretrain/base_whisper_distill_offline_bestrq.yaml')
        # Architecture overrides from the released run_22_2_dual_large.sh.
        enc_cfg = OmegaConf.merge(OmegaConf.structured(AVHubertConfig), pretrained.model,
            {'encoder_embed_dim':768, 'encoder_layers':18, 'encoder_attention_heads':12,
             'num_key_value_heads':2, 'frontend':'convnet', 'encoder_type':'qwenconv',
             'masking_type':'input2', 'input_modality':'image'})
        task_cfg = OmegaConf.merge(OmegaConf.structured(AVHubertPretrainingConfig),
                                  {'sample_rate':25, 'avg':1, 'label_rate':25, 'input_modality':'image'})
        dictionary = Dictionary.load(str(root / 'flare/data_demo/tsv_merge_face_lip_dataset/dict.wrd.txt'))
        state = checkpoint['model']
        original_load = np.load
        def training_statistics(path, *args, **kwargs):
            if str(path).endswith('whisper_last1.stat.npy'):
                return state['encoder.w2v_model.whisper_stat'].numpy()
            return original_load(path, *args, **kwargs)
        with patch('numpy.load', side_effect=training_statistics):
            encoder = AVHubertModel(enc_cfg, task_cfg, [dictionary])
        cfg = OmegaConf.merge(OmegaConf.structured(AVHubertSeq2SeqConfig), checkpoint['cfg']['model'],
                              {'normalize':True, 'data':str(root / 'flare/data_demo/tsv_merge_face_lip_dataset')})
        embedding = torch.nn.Embedding(len(dictionary), cfg.decoder_embed_dim, padding_idx=dictionary.pad())
        self.model = AVHubertSeq2Seq(HubertEncoderWrapper(encoder), TransformerDecoder(cfg, dictionary, embedding), dictionary, cfg)
        self.model.load_state_dict(state, strict=True)
        self.model.eval().to(self.device)
        self.dictionary = dictionary
        from flare.sequence_generator import SequenceGenerator
        self.final_decoder = SequenceGenerator([self.model], dictionary, beam_size=5,
                                              max_len_a=1.0, max_len_b=0)
        del checkpoint, state
        self.name = 'FLARE Large (2026)'
        self.last_seconds = 0

    def __call__(self, crops, final=False):
        import numpy as np
        import torch
        with self.lock, torch.inference_mode():
            began = time.monotonic()
            # Input list: T x 2 x 88 x 88, order face, lips.
            x = torch.from_numpy(np.stack(crops)).to(self.device, dtype=torch.float32)
            x = (x / 255.0 - 0.421) / 0.165
            source = {'audio':None, 'video':(x[:, 0][None, None], x[:, 1][None, None]),
                      'face_lip_mask':(torch.ones(1, device=self.device), torch.ones(1, device=self.device))}
            padding = torch.zeros((1, len(crops)), dtype=torch.bool, device=self.device)
            if final:
                result = self.final_decoder.generate([self.model],
                    {'net_input': {'source': source, 'padding_mask': padding}})[0][0]['tokens'].cpu()
                text = ''.join(self.dictionary[int(i)] for i in result if int(i) not in
                               (self.dictionary.eos(), self.dictionary.pad()))
                self.last_seconds = time.monotonic() - began
                return ' '.join(text.replace('▁', ' ').replace('<unk>', '').split())
            encoded = self.model.encoder(source=source, padding_mask=padding)
            # Incremental decoder caches keys/values for the current video window.
            tokens = torch.tensor([[self.dictionary.eos()]], device=self.device)
            cache = {}
            for _ in range(min(120, max(8, len(crops)))):
                logits, _ = self.model.decoder(tokens, encoder_out=encoded, incremental_state=cache)
                token = logits[:, -1].argmax(-1, keepdim=True)
                if token.item() == self.dictionary.eos():
                    break
                tokens = torch.cat([tokens, token], dim=1)
            text = ''.join(self.dictionary[int(i)] for i in tokens[0, 1:].cpu()).replace('▁', ' ').replace('<unk>', '').strip()
            self.last_seconds = time.monotonic() - began
            return ' '.join(text.split())
