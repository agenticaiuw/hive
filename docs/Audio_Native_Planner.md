# Audio-native planner (collapse Whisper + LLM)

**Status:** architecture decision from the incomplete Claude workflow `audio-native-planner` (2026-08-02), finished after the weekly limit.

## Goal

Cut end-to-end latency from “button release → Mac does the thing” toward **under 5s**.

### Measured baseline (2026-08-02 hardware, ~2.8 s “Open Outlook.”)

See `docs/Latency_Cut_Plan.md` for full tables. Short version:

| Stage | Measured |
|-------|----------|
| On-device Opus encode | **~5.1 s** (not 0.2–0.5 — dominated by SD read + SILK) |
| Announce TLS+HTTP | ~3.7 s |
| Upload + **Whisper server_wait** | **~14.3 s** (of which **~11.6 s** waiting on STT) |
| Dispatch TLS+HTTP | ~3–10 s (TLS alone was 9.8 s once) |
| Mac plan | ~1–5 s |
| Execute | ~0.2 s |
| TTS | ~1.2 s |
| **cycle_to_dispatch** | **~33.7 s** |

### Multimodal time savings (research estimate)

Collapsing Whisper + DeepSeek into one audio→JSON model:

| | Today | Multimodal | Savings |
|--|------:|-----------:|--------:|
| STT + plan neural path | ~13–17 s | ~2–4 s | **~9–13 s** |

**That alone does not hit &lt; 5 s.** You still need streaming encode + TLS reuse. Multimodal is the biggest *cloud* win; encode + TLS are the biggest *device* wins.

## Decision

**Near term (ship now): keep Whisper + text LLM, but stop paying for unused context.**

- Conditional memory already gates long-term / multi-turn prompt blocks (`commandNeedsMemory` in `conversationContext.js`).
- Reasoning effort stays `auto` / `low` for simple one-shot commands (`chooseReasoningEffort` in `llmPlanner.js`).
- Always produce a spoken reply so “silent success” is never mistaken for a hang.

**Next term: dual path STT.**

| Path | When | Model | Notes |
|------|------|-------|-------|
| A. Workers AI Whisper large-v3-turbo | Default for short commands | Fast, already wired | Keep as baseline |
| B. OpenRouter / provider speech-to-intent | When `AUDIO_NATIVE_PLANNER=1` | Multimodal that accepts audio and returns tool JSON | Pilot behind a flag |

Do **not** replace Whisper with a slower “smart” model until B’s p50 end-to-end beats path A on the same 5s utterances.

## Multimodal candidates (as of mid-2026 research notes)

Evaluated for: audio in, structured tool-call / JSON out, low TTFT, OpenRouter availability, cost.

1. **Gemini Flash family (OpenRouter)** — strong audio+text, tool use, good latency. Already used as vision model (`google/gemini-3.6-flash`). Best candidate for a pilot: same provider stack, one API key.
2. **GPT-4o-mini / realtime-class models** — excellent audio, higher cost; reserve for hard multi-step.
3. **DeepSeek V4 Flash** — current text planner (`deepseek/deepseek-v4-flash-0731`); **text-only**, so it cannot collapse STT. Keep for text plan after Whisper unless DeepSeek ships audio input.
4. **Cloudflare Whisper alone** — not a planner; only transcription.

**Recommendation:** pilot **Gemini Flash with audio** as `LLM_AUDIO_MODEL` for pendant-origin jobs only. Fall back to Whisper→DeepSeek on any parse failure or timeout.

## Conditional memory (implemented)

Always including prior memory slows every turn. Heuristic:

- Include full short-term + long-term memory when the command has anaphora / continuation markers (`that`, `again`, `continue`, Korean equivalents, etc.) or is long (>120 chars).
- Otherwise send a compact prompt with only the current request (machine context still lives in the system prompt).

This is the correct default for a voice pendant: most presses are atomic (“open Outlook”, “mute”).

## Latency budget target (software)

| Stage | Target | Notes |
|-------|--------|-------|
| Upload | unavoidable | Opus 16 kb/s already near optimal for speech |
| STT or audio-native | ≤1.5s p50 | Path B goal |
| Plan | ≤1.0s p50 | low reasoning, no memory for one-shots |
| Execute open_app etc. | ≤0.5s | verify process actually launched |
| TTS | ≤0.8s | keep macOS `say` locally; never skip |
| Bridge poll | ≤0.1s | already 100ms |

## Implementation checklist

- [x] Conditional memory (`commandNeedsMemory`)
- [x] Always-speak TTS path
- [ ] `LLM_AUDIO_MODEL` pilot path on relay (audio bytes → planner JSON)
- [ ] Side-by-side latency metrics in pipeline events (`meta.durationMs` already partial)
- [ ] Cache short canned PCM replies (“Done.”, “Waiting for approval”) to skip `say` for fixed strings

## Cost note (Gemini Flash)

Ballpark for short audio turns is typically **well under $0.01/turn** on Flash-class pricing; exact rates change—check OpenRouter model cards before enabling for all traffic. Prefer Flash over Pro for the pendant hot path; escalate reasoning only on retries / multi-step wording.
