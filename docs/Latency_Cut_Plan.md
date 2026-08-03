# End-to-end latency cut plan

**Status:** hardware-measured 2026-08-02 (Claude `latency-hunt` measure agent), completed after the weekly limit cut the design/cut phases.

## Headline number

Real button-style path for a **~2.8 s** utterance that Whisper transcribed as `"Open Outlook."`:

| Metric | Value |
|--------|------:|
| **Button/boot → Mac job dispatched** | **~33.7 s** (`LAT cycle_to_dispatch_ms=33708`) |
| User-visible complaint (same day) | **~25 s** until Outlook *claimed* done |
| Target | **&lt; 5 s** to action verified |

So we are roughly **5–7×** over budget on the full path. The Mac half after the transcript exists is already close to fine; the device + radio + STT path is not.

## Hardware measurements (nRF9160, Opus 16 kb/s, LTE-M → Cloudflare)

Source: serial `LAT` lines from instrumented firmware (`scratchpad/lat/run1.log`). Audio on disk: 88 320 PCM bytes ≈ **2.85 s** at 15.625 kHz; Ogg out **5 433 B**.

| Stage | ms | Notes |
|-------|---:|-------|
| **Encode (read SD + Opus + Ogg write)** | **5 087** | Split: read **1 591**, opus **3 646**, oggwrite **247** |
| **Announce** (new TLS + HTTP 201) | **3 688** | DNS 585 + TLS ~2.5 s + body |
| **Upload + Whisper** (new TLS + HTTP 200) | **14 331** | body_send **351**; **server_wait 11 593** (Whisper-dominated); TLS ~2.4 s |
| **Dispatch plan to Mac** (new TLS + HTTP 202) | **10 545** | **TLS alone 9 873** on this run — outlier-bad connect |
| **cycle_to_dispatch** (sum path) | **33 708** | End of recording → Mac queue |

Second boot run hit SD path issues (`latest.opus` missing) and is not used for totals.

### What “server_wait 11.6 s” means

Almost all of the upload HTTP time after the body is sent is **Workers AI Whisper** (plus Worker glue). Multimodal research targets this line item + the separate Mac LLM plan.

## Mac-side measurements (after transcript exists)

Pipeline events for the same job (`job_bb1f4221…`, `"Open Outlook."`):

| Stage | ms |
|-------|---:|
| Bridge picks up job | ~7 |
| **LLM plan** | **2 983** |
| **Execute open_app** | **165** |
| **macOS `say` TTS** | **1 241** |
| Upload result + PCM to relay | **914** |
| **Mac total after transcript** | **~5.3 s** |

Synthetic dispatch probes (POST `/v1/mac/plan` with text only):

| Sample | claim+poll | plan | execute | queue→executed |
|--------|----------:|-----:|--------:|---------------:|
| A | 562 | 1 345 | 166 | 2 087 |
| B | 115 | 3 209 | 180 | 3 521 |
| C | 365 | 4 938 | 136 | 5 467 |
| D | 108 | 5 148 | 134 | 5 395 |

Direct planner calls (OpenRouter DeepSeek V4 Flash, low effort): **~1.1–2.6 s** (warm).  
Live probe 2026-08-03: compact plan **~3.4 s** (low reasoning).

**Bridge poll is no longer the villain** after the fix (100 ms poll / 120 ms relay check). Claim latency is usually **0.1–0.6 s**.

## Where the ~25–34 s goes (budget picture)

```
[encode ~5s] → [TLS+announce ~4s] → [TLS+upload+Whisper ~14s] → [TLS+dispatch ~3–10s]
                                                                      ↓
                                                         [plan ~1–5s] → [exec ~0.2s] → [TTS ~1s]
```

Rough share of a 34 s cycle:

| Bucket | ~ms | % | Multimodal helps? |
|--------|----:|--:|-------------------|
| Opus encode on device | 5 000 | 15% | No |
| TLS handshakes (×3 sequential) | 6–15 000 | 20–45% | Partially (fewer round trips) |
| Whisper server wait | 11 600 | 34% | **Yes — primary target** |
| Mac LLM plan | 1–5 000 | 5–15% | **Yes — fold into same call** |
| TTS + result upload | 2 000 | 6% | No (cache canned PCM) |
| Execute app open | 200 | &lt;1% | No |

## Multimodal model: how much time would it save?

### What it can collapse

Today: **audio → Whisper text → DeepSeek plan JSON** (two neural systems, two network hops after upload).

Multimodal (e.g. Gemini Flash with audio via OpenRouter): **audio → plan JSON** in one call.

| Component | Today (measured) | Multimodal estimate | Saved |
|-----------|-----------------:|--------------------:|------:|
| Whisper server_wait | ~11.6 s | (gone) | **~10–12 s** |
| Separate DeepSeek plan | ~1–5 s | (folded) | **~1–5 s** |
| Multimodal audio→JSON | — | **~1.5–4 s** TTFT+decode (Flash-class; live audio RTTs often ~2–3.5 s) | — |
| **Net STT+plan** | **~13–17 s** | **~2–4 s** | **~9–13 s** |

**Best realistic software-only cut from multimodal alone: ~10 s off a 25–34 s path → ~15–24 s remaining.**  
That is **necessary but not sufficient** for a **&lt; 5 s** goal.

### What multimodal does *not* fix

1. **On-device encode ~5 s for 2.8 s of audio** (~1.8× real-time Opus on nRF9160 from SD). Must stream-encode *during* recording or shrink post-roll encode.
2. **Three cold TLS sessions** (announce, upload, dispatch). Keep-alive / session tickets / combine endpoints.
3. **TTS ~1.2 s** for a short confirmation (cache “Done.” / “Opened Outlook on Mac”).
4. **LTE attach** when the modem is cold (not in the 33.7 s warm path above).

### Break-even rule

Only ship multimodal as default if:

`p50(audio→plan_json) + p50(Mac execute)  <  p50(Whisper) + p50(DeepSeek plan)`

on the same 3–5 s utterances. Keep Whisper→DeepSeek as automatic fallback on parse failure / timeout.

**Candidate:** `google/gemini-3.6-flash` (already vision model) as `LLM_AUDIO_MODEL`. DeepSeek V4 Flash stays text planner; it cannot take audio.

## Agent suggestions to reach &lt; 5 s (ordered)

### Tier A — must-do (get to ~8–12 s)

1. **Encode during capture, not after**  
   Target: encode_ms → **&lt; 200 ms** after button release (only finalize Ogg). Saves **~5 s**.

2. **Reuse one TLS connection** for announce + upload + dispatch (or one combined `/v1/pendant/command` that accepts Ogg and returns job id). Saves **~4–12 s** of handshakes (dispatch TLS was 9.8 s once).

3. **Multimodal audio→plan** on the relay for short pendant clips; Mac only **executes**. Saves **~9–13 s** of Whisper+plan.

4. **Conditional memory + low/off reasoning** for one-shots (landed). Saves **~0.5–2 s** on fat prompts.

### Tier B — get under 5 s once radio is warm

5. **Overlap TTS with result metadata upload**; cache PCM for fixed strings. Saves **~0.5–1.2 s** on the reply leg.  
6. **Skip announce as a separate RTT** if dashboard can show “uploading” from first byte. Saves **~3–4 s**.  
7. **Keep modem warm** / avoid full LTE re-attach between presses (firmware roadmap).  
8. **Cap speech** to ~3–4 s for commands (smaller encode + upload).

### Tier C — already done or small

- Bridge poll 100 ms / relay work check 120 ms (**~1.5 s idle removed** vs old 1 s + 800 ms).  
- Always-speak confirmations (no silent “success”).  
- `open_app` process verification (stops false “done” that felt like a hang).

## Plausible under-5s path (warm modem, short command)

| Stage | Target ms |
|-------|----------:|
| Finalize encode (streamed during speech) | 150 |
| Single TLS + upload audio | 800 |
| Multimodal plan | 2 000 |
| Bridge claim | 150 |
| Execute | 200 |
| Canned or short TTS (optional parallel) | 400 |
| **Total** | **~3.7 s** |

If multimodal is flaky, Whisper turbo + DeepSeek low with connection reuse:

| Stage | Target ms |
|-------|----------:|
| Finalize encode | 150 |
| Single TLS + upload | 800 |
| Whisper | 1 500 |
| Plan | 1 200 |
| Claim + execute | 350 |
| **Total** | **~4.0 s** |

Without encode streaming + TLS reuse, **&lt; 5 s is not reachable** even with a perfect multimodal model.

## Implementation checklist

- [x] Measure real stages on hardware (`LAT *` logs)  
- [x] Cut poll idle (~1.5 s)  
- [x] Conditional memory for one-shots  
- [x] Always-speak + verify `open_app`  
- [ ] Stream Opus encode during record  
- [ ] TLS session reuse / combined pendant endpoint  
- [ ] `LLM_AUDIO_MODEL` pilot + fallback  
- [ ] Canned PCM for fixed replies  
- [ ] Dashboard stage timers always show `meta.durationMs`

## Acceptance criteria

- Simple one-shot Mac control (app installed, bridge online, modem warm): **p50 &lt; 5 s** button-up → action verified  
- Spoken confirmation within **1 s** of verification  
- Multi-step / research commands may take longer; every stage still streams to the dashboard  
