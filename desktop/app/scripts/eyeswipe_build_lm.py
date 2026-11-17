"""Builds the language model eye-swipe typing decodes with (tools/eyeswipe/eyeswipe-lm.bin), from a local
Qwen model, once, on a Mac that has it. Hive then ships the file; nobody else needs the model.

Words: Qwen's whole-word English tokens (" going", " internet") that macOS's spell checker accepts, common
contractions ("don't" is swiped d-o-n-t), and every word of Apple's own English dictionary (what the
system keyboard completes to: plurals, rarer words, place names; read by asking macOS for the completions
of longer and longer prefixes, the owner's own learned words left out), plus common first names. For each
of the most common words it reads Qwen's next-word probabilities after that word (one forward pass each),
and keeps the likeliest next words: a word-pair model distilled from the big one, small enough for the
phone. Words of more than one Qwen token get how likely Qwen finds them mid-sentence.

  python scripts/eyeswipe_build_lm.py <qwen folder> [--contexts 6000] [--keep 128]
      [--apple-words saved-list.txt] [--out tools/eyeswipe/eyeswipe-lm.bin]

File layout (little-endian):
  b"ESLM1", u32 words, u32 contexts, u32 keep
  words: UTF-8, one per line (lowercase letters and apostrophes, likeliest first) then a blank line;
         each line is "key<TAB>shown" (shown is how it's written: "I", "I'm", "America")
  u8 per word: -ln P(word) * 8, mid-sentence (the backoff)
  start (after a sentence ends) and then each context word in order (word ids 0..contexts-1):
      f32 the probability left over for words not kept,
      keep * (u16 word id, u8 -ln P(word | context) * 8)
"""
import argparse
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_lm import load
from mlx_lm.models.cache import ArraysCache, KVCache, make_prompt_cache

HERE = Path(__file__).resolve().parent.parent

# (written, the token it starts with, the rest). The rest is what Qwen reads after that first token.
CONTRACTIONS = [
    ("don't", ' don', "'t"), ("can't", ' can', "'t"), ("won't", ' won', "'t"), ("didn't", ' didn', "'t"),
    ("doesn't", ' doesn', "'t"), ("isn't", ' isn', "'t"), ("wasn't", ' wasn', "'t"), ("aren't", ' aren', "'t"),
    ("weren't", ' weren', "'t"), ("haven't", ' haven', "'t"), ("hasn't", ' hasn', "'t"),
    ("wouldn't", ' wouldn', "'t"), ("couldn't", ' couldn', "'t"), ("shouldn't", ' shouldn', "'t"),
    ("I'm", ' I', "'m"), ("I've", ' I', "'ve"), ("I'll", ' I', "'ll"), ("I'd", ' I', "'d"),
    ("it's", ' it', "'s"), ("that's", ' that', "'s"), ("there's", ' there', "'s"), ("what's", ' what', "'s"),
    ("he's", ' he', "'s"), ("she's", ' she', "'s"), ("let's", ' let', "'s"), ("here's", ' here', "'s"),
    ("you're", ' you', "'re"), ("we're", ' we', "'re"), ("they're", ' they', "'re"),
    ("you've", ' you', "'ve"), ("we've", ' we', "'ve"), ("they've", ' they', "'ve"),
    ("you'll", ' you', "'ll"), ("we'll", ' we', "'ll"), ("they'll", ' they', "'ll"), ("it'll", ' it', "'ll"),
    ("you'd", ' you', "'d"), ("he'd", ' he', "'d"), ("she'd", ' she', "'d"), ("they'd", ' they', "'d"),
]

# Qwen reads every word after this, so its next-word guesses are about everyday spoken English (the "..."
# puts the word mid-sentence). Sentence starts are read right after the colon.
PREFIX = 'Here is a transcript of people talking in everyday English:\n\n'
# The only two-letter words kept (the spell checker also takes "de", "er", "vs" and the like).
TWO = set('ah am an as at be by do go ha he hi if in is it me my no of oh ok on or ow so to uh um up us we ya ye yo'.split())

SPELL = r'''
import AppKit
let checker = NSSpellChecker.shared
while let line = readLine() {
    let r = checker.checkSpelling(of: line, startingAt: 0, language: "en", wrap: false,
                                  inSpellDocumentWithTag: 0, wordCount: nil)
    print(r.location == NSNotFound ? "1" : "0")
}
'''


# Every word Apple's English dictionary completes to: ask for the completions of each prefix, and of longer
# prefixes wherever the answer is cut off at 20. Words the owner taught their Mac are left out (this file is
# shared). Takes about 7 minutes; mostly waiting on the spelling service, so it uses almost no CPU.
APPLE = r'''
import AppKit
let c = NSSpellChecker.shared
let letters = Array("abcdefghijklmnopqrstuvwxyz'")
var seen = Set<String>(), queue = letters.dropLast().map { String($0) }, at = 0
while at < queue.count {
    let p = queue[at]; at += 1
    let r = c.completions(forPartialWordRange: NSRange(location: 0, length: p.utf16.count), in: p, language: "en",
                          inSpellDocumentWithTag: 0) ?? []
    for w in r where seen.insert(w).inserted && !c.hasLearnedWord(w) { print(w) }
    if r.count >= 20 { for l in letters { queue.append(p + String(l)) } }
}
'''


def apple_words(saved):
    if saved and Path(saved).exists():
        return Path(saved).read_text().split('\n')
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / 'apple.swift'
        src.write_text(APPLE)
        subprocess.run(['swiftc', '-O', str(src), '-o', str(Path(d) / 'apple')], check=True)
        out = subprocess.run([str(Path(d) / 'apple')], capture_output=True, text=True, check=True).stdout
    if saved:
        Path(saved).write_text(out)
    return out.split('\n')


def spelled_right(words):
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / 'spell.swift'
        src.write_text(SPELL)
        subprocess.run(['swiftc', '-O', str(src), '-o', str(Path(d) / 'spell')], check=True)
        out = subprocess.run([str(Path(d) / 'spell')], input='\n'.join(words) + '\n', capture_output=True,
                             text=True, check=True).stdout.split()
    return {w for w, ok in zip(words, out) if ok == '1'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('--contexts', type=int, default=6000)
    ap.add_argument('--keep', type=int, default=128)
    ap.add_argument('--apple-words', help='where to keep the list of Apple\'s words (read from there if it exists)')
    ap.add_argument('--batch', type=int, default=16, help='words per forward pass (each one copies the model state)')
    ap.add_argument('--out', default=str(HERE / 'tools' / 'eyeswipe' / 'eyeswipe-lm.bin'))
    args = ap.parse_args()
    mx.set_cache_limit(256 << 20)                  # keep MLX's buffer cache small: this runs beside other work
    model, tokenizer = load(args.model)
    head = tokenizer.encode(PREFIX, add_special_tokens=False)
    mid = head + tokenizer.encode('...', add_special_tokens=False)

    # Whole-word tokens: " word" mid-sentence, and "Word" at the start of a text (for sentence starts).
    pieces = {}
    for token, i in tokenizer.vocab.items():
        text = tokenizer.decode([i])
        if re.fullmatch(r' [A-Za-z]{1,20}', text):
            pieces[i] = ('mid', text[1:])
        elif re.fullmatch(r'[A-Z][a-z]{0,19}|I', text):
            pieces[i] = ('start', text)
    keys = sorted({w.lower() for _, w in pieces.values()})
    right = spelled_right(keys + [k.capitalize() for k in keys])      # names are only right capitalized
    ok = {k for k in keys if (k in right or k.capitalize() in right)
          and (len(k) > 2 or k in TWO or k in ('a', 'i'))}
    print(f'{len(pieces)} whole-word tokens, {len(keys)} words, {len(ok)} spelled right', flush=True)

    def logprobs(prompts):
        """Next-token log-probabilities after each prompt (lists of token ids, all the same length)."""
        logits = model(mx.array(prompts))[:, -1, :].astype(mx.float32)
        lp = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        return np.array(lp)

    # Everything else is read after the same opening (mid): read it once and give each word in a batch its
    # own copy of the model's state there. This model is slow per word, not per token, so this is most of
    # the speed.
    opened = make_prompt_cache(model)
    mid_lp = model(mx.array([mid]), cache=opened)[:, -1, :].astype(mx.float32)
    mid_lp = mid_lp - mx.logsumexp(mid_lp, axis=-1, keepdims=True)
    mx.eval(mid_lp)

    def copies(n):
        out = []
        for c in opened:
            if isinstance(c, KVCache):
                k = KVCache()
                k.keys = mx.repeat(c.keys[..., :c.offset, :], n, axis=0)
                k.values = mx.repeat(c.values[..., :c.offset, :], n, axis=0)
                k.offset = c.offset
            elif isinstance(c, ArraysCache):
                k = ArraysCache(len(c.cache))
                k.cache = [None if a is None else mx.repeat(a, n, axis=0) for a in c.cache]
            else:
                raise SystemExit(f'unexpected cache type {type(c).__name__}')
            out.append(k)
        return out

    def after_mid(rows):
        """Log-probabilities of the next token at every position of rows (token lists of one length) read
        right after mid, as an mlx array (rows, length, vocabulary)."""
        logits = model(mx.array(rows), cache=copies(len(rows))).astype(mx.float32)
        return logits - mx.logsumexp(logits, axis=-1, keepdims=True)

    mid_ids = np.array([i for i, (kind, w) in pieces.items() if kind == 'mid' and w.lower() in ok])
    mid_key = [pieces[i][1].lower() for i in mid_ids]
    start_ids = np.array([i for i, (kind, w) in pieces.items() if kind == 'start' and w.lower() in ok])
    start_key = [pieces[i][1].lower() for i in start_ids]
    vocab = sorted(set(mid_key))
    index = {w: k for k, w in enumerate(vocab)}
    mid_col = np.array([index[w] for w in mid_key])

    # The rest of each contraction after its first token (and what's left for the plain word).
    rest, share = {}, {}
    for written, first_piece, tail in CONTRACTIONS:
        h = tokenizer.encode(first_piece, add_special_tokens=False)
        t = tokenizer.encode(tail, add_special_tokens=False)
        if len(h) != 1 or len(t) != 1:
            continue
        p = float(np.exp(np.array(after_mid([[h[0]]])[0, -1])[t[0]]))
        rest[written] = (h[0], p)
        share[h[0]] = share.get(h[0], 0.0) + p
    cvocab = [w for w in rest]                     # contractions go after the plain words
    allwords = vocab + [w.lower() for w in cvocab]

    def word_dist(lp, ids, cols):
        """Probability of every word in allwords from one next-token distribution."""
        p = np.zeros(len(allwords), np.float32)
        np.add.at(p, cols, np.exp(lp[ids]))
        for k, (written, (h, q)) in enumerate(rest.items()):
            p[len(vocab) + k] = np.exp(lp[h]) * q
        for h, s in share.items():                 # " I" also stands for "I'm" etc.: take that out of "i"
            w = tokenizer.decode([h])[1:].lower()
            if w in index:
                p[index[w]] -= np.exp(lp[h]) * s
        return np.clip(p, 1e-12, None)

    start_col = np.array([index.get(w, -1) for w in start_key])
    keep_start = start_col >= 0
    sp = word_dist(logprobs([head])[0], start_ids[keep_start], start_col[keep_start])

    # Mid-sentence word probabilities: start from the probabilities at the start of a sentence, then average the
    # next-word distributions over the common words (weighted by how common they are), twice. Only the
    # likeliest next words of each context are kept, in small batches, so it needs little memory.
    uni = sp / sp.sum()
    order = np.argsort(-uni)
    for last in (False, True):
        ctx = [w for w in order if w < len(vocab)][:args.contexts]
        acc = np.zeros(len(allwords), np.float32)
        kept, tok_of, tacc = {}, {}, np.zeros(len(mid_ids), np.float32)
        for w in ctx:
            t = tokenizer.encode(' ' + vocab[w], add_special_tokens=False)
            if len(t) == 1:
                tok_of[w] = t[0]
        batch = [w for w in ctx if w in tok_of]
        for s in range(0, len(batch), args.batch):
            chunk = batch[s:s + args.batch]
            lp = np.array(after_mid([[tok_of[w]] for w in chunk])[:, -1, :])
            for w, row in zip(chunk, lp):
                d = word_dist(row, mid_ids, mid_col)
                d /= d.sum()
                acc += uni[w] * d
                if last:
                    tacc += uni[w] * np.exp(row[mid_ids])
                    top = np.argpartition(-d, args.keep)[:args.keep]
                    top = top[np.argsort(-d[top])]
                    kept[w] = (top, d[top])
            del lp
        uni = acc / acc.sum()
        order = np.argsort(-uni)
        print(f'pass: {len(batch)} context words', flush=True)

    # How each word is written: the casing Qwen likes best mid-sentence ("I", "America", "the").
    shown, best = {}, {}
    for i, w, p in zip(mid_ids, mid_key, tacc):
        if p > best.get(w, -1.0):
            best[w], shown[w] = p, pieces[i][1]
    allshown = [shown.get(w, w) for w in vocab] + cvocab

    # The rest of Apple's dictionary and common first names: words of more than one token. How likely each is
    # mid-sentence (the product of its tokens' probabilities after "..."), put on the same scale as the
    # one-token words by the typical gap between the two for those.
    known = set(allwords)
    extra = {}
    names = Path('/usr/share/dict/propernames')
    for w in apple_words(args.apple_words) + (names.read_text().split() if names.exists() else []):
        w = w.strip().replace('\u2019', "'")
        k = w.lower()
        if not re.fullmatch(r"[a-z']+", k) or k in known or k.strip("'") != k:
            continue
        if k not in extra or w == k:                   # lowercase if Apple has it lowercase
            extra[k] = w
    for c in 'bcdefghjklmnopqrstuvwxyz':               # single letters ("c", "t")
        if c not in known:
            extra[c] = c
    ekeys = sorted(extra)
    pieces_of = {k: tokenizer.encode(' ' + extra[k], add_special_tokens=False) for k in ekeys}
    by_len = {}
    for k in ekeys:
        by_len.setdefault(len(pieces_of[k]), []).append(k)
    elp = {}
    done = 0
    first_lp = np.array(mid_lp[0])
    for n, group in sorted(by_len.items()):
        for s0 in range(0, len(group), args.batch):
            chunk = group[s0:s0 + args.batch]
            total = np.array([first_lp[pieces_of[k][0]] for k in chunk], np.float64)
            if n > 1:
                lp = after_mid([pieces_of[k][:-1] for k in chunk])
                ids = mx.array([pieces_of[k][1:] for k in chunk])
                total += np.array(mx.take_along_axis(lp, ids[:, :, None], axis=-1).sum(axis=(1, 2)))
                del lp
            for k, v in zip(chunk, total):
                elp[k] = float(v)
            done += len(chunk)
            if done % (args.batch * 200) < args.batch:
                print(f'extra words: {done} of {len(ekeys)}', flush=True)
    base = word_dist(np.array(mid_lp[0]), mid_ids, mid_col)
    base /= base.sum()
    common = order[:5000]
    gap = float(np.median(np.log(uni[common]) - np.log(base[common])))
    eprob = np.array([np.exp(elp[k] + gap) for k in ekeys], np.float32)
    print(f'{len(ekeys)} more words (scale gap {gap:.2f}), their share {eprob.sum():.3f}', flush=True)
    first_extra = len(allwords)
    allwords += ekeys
    allshown += [extra[k] for k in ekeys]
    uni = np.concatenate([uni, eprob])
    uni /= uni.sum()
    order = np.argsort(-uni)

    # Renumber words likeliest-first so the contexts are word ids 0..n-1. Word pairs only name one-token
    # words, kept below id 65536: contexts first, the other one-token words, then the rest.
    rank = list(order)
    ctx = [w for w in rank if w in kept][:args.contexts]
    inctx = set(ctx)
    rank = (ctx + [w for w in rank if w not in inctx and w < first_extra]
            + [w for w in rank if w >= first_extra])
    assert max(int(w) for t, _ in kept.values() for w in t) < first_extra < 65536
    newid = {w: k for k, w in enumerate(rank)}
    q = lambda p: np.clip(np.round(-np.log(p) * 8), 0, 255).astype(np.uint8)  # noqa: E731

    out = bytearray(b'ESLM1')
    out += struct.pack('<III', len(rank), len(ctx), args.keep)
    out += ('\n'.join(f'{allwords[w]}\t{allshown[w]}' for w in rank) + '\n\n').encode()
    out += q(uni[rank]).tobytes()
    sp = sp / sp.sum()
    top = np.argsort(-sp)[:args.keep]
    for top, probs in [(top, sp[top])] + [kept[w] for w in ctx]:
        out += struct.pack('<f', float(max(0.0, 1 - probs.sum())))
        for w, p in zip(top, probs):
            out += struct.pack('<HB', newid[w], int(q(p)))
    Path(args.out).write_bytes(bytes(out))
    print(f'wrote {args.out}: {len(rank)} words, {len(ctx)} contexts, {len(out) / 1e6:.1f} MB')
    print('likeliest words:', ' '.join(allshown[w] for w in rank[:40]))


if __name__ == '__main__':
    sys.exit(main())
