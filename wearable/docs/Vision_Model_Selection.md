# Vision model choice for screenshot-driven agent control

_Researched 2026-08-02._

## Verdict

NO — deepseek/deepseek-v4-flash cannot process screenshots, and this is a hard failure, not a degradation.

Verified from four independent sources: OpenRouter's catalog reports `"modality":"text->text"`, `"input_modalities":["text"]` for `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-0731`, AND `deepseek/deepseek-v4-pro` (all 12 DeepSeek models on OpenRouter are text-only); the V4 tech report (arXiv 2606.19348) lists multimodality as future work ("We are also working on incorporating multimodal capabilities"); Artificial Analysis states it "only supports text input"; and an upstream request for image modality was closed as not planned.

Failure mode if you try anyway: OpenRouter returns HTTP 404 with `{"error":{"message":"No endpoints found that support image input","code":404}}`. It does NOT silently strip the image, so you get a loud error rather than a hallucinating planner. Web sources claiming V4 or V4-Pro accept images (mindstudio.ai, aimadetools.com, deepseek-ai.net, deepseek.ai — note deepseek.ai is NOT DeepSeek's domain) are wrong.

Separate DeepSeek finding worth acting on regardless of vision: the bare slug `deepseek/deepseek-v4-flash` in /Users/evanliu/agentic-gadget/software/ai-pendant-simulator/local-agent/llmPlanner.js line 12-13 resolves to the **April preview checkpoint `deepseek-v4-flash-20260423`** on OpenRouter, not the much stronger 0731 release. The agentic delta is enormous (DeepSWE 7.3 → 54.4, Terminal-Bench 2.1 61.8 → 82.7, Toolathlon 49.7 → 70.3). Pin `deepseek/deepseek-v4-flash-0731` — it is also cheaper on OpenRouter ($0.09/$0.18 vs $0.14/$0.28).

## Recommendation

HYBRID: keep a text planner, add a vision planner invoked only when a screenshot is present. Route on one boolean.

  TEXT_MODEL   = deepseek/deepseek-v4-flash-0731      ($0.09 / $0.18 per 1M)
  VISION_MODEL = google/gemini-3.6-flash              ($1.50 / $7.50 per 1M)
  VISION_FALLBACK (cost/latency downgrade) = google/gemini-3.5-flash-lite  ($0.30 / $2.50)

Why hybrid rather than one multimodal model for everything: most pendant turns ("what's the weather", "open Spotify", "set brightness") never touch a screenshot, and the existing prompt/action-schema work in llmPlanner.js is already tuned around DeepSeek. Routing on `hasScreenshot` keeps the hot path 16x cheaper on text and preserves your current behavior exactly. The cost is one extra model constant — the request builder is otherwise identical, since both are OpenAI-compatible chat/completions.

Why Gemini 3.6 Flash specifically (I verified all of these against the live OpenRouter catalog on 2026-08-02):

1. **Normalized 0–999 coordinates.** This is the decisive factor for a hand-rolled loop over OpenRouter. Anthropic and OpenAI models emit absolute pixels *relative to the image after the provider silently resized it* — Anthropic's own docs warn that images are downscaled "which leaves you without the scale factor you need," and their worked example shows 1920x1080 becoming 1456x819. Through OpenRouter you cannot see or control that resize. With Gemini you multiply by your own viewport dimensions and device-pixel-ratio never matters. That removes an entire class of off-by-a-scale-factor click bugs.
2. **Best end-to-end UI score reachable at a sane price**: 83.0% OSWorld-Verified (Google model card), behind only Anthropic's $10/M Fable/Mythos class. Google explicitly names it "the recommended model for computer use."
3. **Flat image token cost regardless of resolution** (1120 tokens at default media resolution). Cost is predictable and higher-resolution screenshots are free in tokens — you only pay upload time. Claude's high-res tier by contrast balloons to 4784 tokens on a 2560x1440 capture.
4. **Verified live**: `tools`, `response_format`, and `structured_outputs` are all in `supported_parameters`, and `pricing.image` == `pricing.prompt` (images bill as ordinary prompt tokens, no per-image surcharge), 1,048,576 ctx.

Models I considered and rejected: `anthropic/claude-opus-4.8` (best raw grounding, ScreenSpot-Pro 0.879, but $5/M and absolute-pixel coords with hidden resize); `anthropic/claude-haiku-4.5` (fastest TTFT ~1.0s, but standard-resolution 1568px tier degrades small UI text and it has no published grounding score); `openai/gpt-5.6-luna` ($0.0001/screenshot but zero published UI benchmarks); `bytedance/ui-tars-1.5-7b` (purpose-built GUI model but a July-2025 checkpoint, and OpenRouter does not list `tools` in its supported_parameters — it is a grounding text emitter, not a function-caller); `qwen/qwen3.7-flash` (absurdly cheap at $0.00003/screenshot, but its coordinate convention is version-dependent — official Qwen3-VL docs disagree between 0–1 floats and 0–1000 ints, and there is an open upstream issue about bad boxes).

Escalation path, not day-one: a two-model split (frontier planner emits an element *description*, cheap grounder converts description → coordinates) is 100–200x cheaper on the grounding call. Do not build this until the single-vision-model loop is measurably failing — it doubles round-trips, which is exactly what your latency budget cannot afford.

## Cost and latency

PER-SCREENSHOT STEP, google/gemini-3.6-flash, ~1280px screenshot:

  image input       1120 tokens (flat, resolution-independent)  x $1.50/M = $0.00168
  system + context  ~900 tokens                                 x $1.50/M = $0.00135
  output (JSON act) ~150 tokens                                 x $7.50/M = $0.00113
  ---------------------------------------------------------------------------------
  TOTAL                                                                   ≈ $0.004 / step

A 20-step browsing task ≈ $0.08. Heavy personal use at 200 vision steps/day ≈ $0.80/day.
With gemini-3.5-flash-lite instead: ≈ $0.0009/step (~4.5x cheaper).
Text-only turns on deepseek-v4-flash-0731: ~$0.0002/turn — effectively free.

Note images bill straight into `prompt_tokens` at the normal input rate (empirically verified on Gemini Flash Lite: 6 tokens text-only vs 1098 with a 1280x800 PNG, cost matching exactly at $0.25/M). There is no `image_tokens` field in `usage.prompt_tokens_details`, so to measure image cost you must diff against a text-only baseline.

LATENCY — target < a few seconds/step is achievable but ONLY with reasoning turned down:

  screenshot capture + downscale (extension)   ~100–200 ms
  base64 upload of ~200 KB JPEG (~270 KB b64)  ~200–400 ms on typical home upstream
  TTFT at low reasoning effort                 ~0.5–1.5 s
  ~150 output tokens at ~212 tok/s             ~0.7 s
  --------------------------------------------------------
  ≈ 1.5–2.8 s per step

CRITICAL CAVEAT: Artificial Analysis measured gemini-3.6-flash at **TTFT 16.52 s** — that is time-to-first-*answer* token at *high* reasoning effort, i.e. it includes the whole thinking phase. You must send `reasoning: { effort: "low" }` (or disable it) or you will blow the voice-latency budget by an order of magnitude. This single parameter is the difference between a usable and unusable loop. Claude Opus 5 measured 69.66 s TTFT at max effort for the same reason.

Also: a 2.7 MB request body (uncompressed 1280x800 PNG) round-tripped in 2.1–3.1 s in live probes — the payload itself is fine, but it eats your entire budget in upload. Downscale and JPEG-encode (see implementation notes); this is the highest-leverage latency fix available.

Honest gap: nobody publishes TTFT measured *with an image in the prompt* for any 2026 frontier model. Instrument your own loop before trusting these figures.

## Implementation notes

Target file: /Users/evanliu/agentic-gadget/software/ai-pendant-simulator/local-agent/llmPlanner.js

1) MODEL ROUTING (lines 11-13). Add alongside the existing constant:
   const LLM_MODEL        = process.env.LLM_MODEL        || 'deepseek/deepseek-v4-flash-0731'
   const LLM_VISION_MODEL = process.env.LLM_VISION_MODEL || 'google/gemini-3.6-flash'
   Select per-request: `const model = screenshot ? LLM_VISION_MODEL : LLM_MODEL`.

2) MESSAGE FORMAT. `requestLlmPlanContent` (line 411) takes `userContent` as a string and puts it at line 430 as `{ role: 'user', content: userContent }`. Change it to accept either a string or an array, and build the array ONLY when a screenshot exists so the DeepSeek path is byte-identical to today:

   const userMessage = screenshot
     ? { role: 'user', content: [
         { type: 'text', text: userContent },
         { type: 'image_url', image_url: { url: screenshot.dataUrl } },
       ]}
     : { role: 'user', content: userContent }

   - TEXT PART FIRST, image second. OpenRouter's docs: "Due to how the content is parsed, we recommend sending the text prompt first, then the images." (This is the opposite of Anthropic's native advice — follow OpenRouter's, you are going through their parser.)
   - Use `{type:'image_url', image_url:{url}}`. NOT Anthropic-style `{type:'input_image'}` — that shape gets the image dropped and the model replies "I don't see an image" (a recurring real-world bug, openclaw #46255/#70410).
   - Do NOT put the image in the `system` message. Verified to 502 on at least one provider.
   - Omit `detail` for Gemini. Gemini's real resolution knob is `media_resolution`, which is NOT exposed anywhere in OpenRouter's OpenAPI spec — `detail` is a no-op passthrough here. (On Gemini Flash Lite, `detail:"high"` and default produced identical 1098 prompt tokens; only `detail:"low"` changed anything.)

3) DATA URL SHAPE. Exactly: `data:image/jpeg;base64,<b64>` — no whitespace, no newlines in the base64. Chrome's `chrome.tabs.captureVisibleTab(windowId, {format: 'jpeg', quality: 85})` **already returns a string in precisely this form**, so the extension can hand it to Node and Node passes it straight through with zero re-encoding. Accepted MIME types: png, jpeg, webp, gif. SVG is rejected (400: "Unsupported or unreadable image. Use a single-frame PNG/JPEG/WebP URL or base64").

4) DOWNSCALING — do it in the extension, before it crosses the wire.
   - captureVisibleTab captures at devicePixelRatio, so a 1280x800 viewport on a Retina Mac yields 2560x1600 and a multi-MB payload. Decode to ImageBitmap, draw to an OffscreenCanvas capped at **1280 px long edge**, re-encode JPEG q85 → typically 120–250 KB.
   - Do NOT go below ~1024 px long edge; 12–13px UI labels stop being legible and grounding collapses.
   - Because Gemini's image token cost is FLAT, resolution above 1280 costs you nothing in tokens — the only penalty is upload time. If your measured latency has headroom, 1536 px is a free accuracy upgrade.
   - JPEG compression artifacts hurt small-text legibility specifically. If grounding is flaky on dense UIs, switch to WebP q90 (supported, preserves text edges better at similar size) before reaching for PNG.
   - DPR does not need to be corrected for, because you are using normalized coordinates (next point).

5) COORDINATE CONTRACT. Have the extension send `viewportWidth`/`viewportHeight` (CSS pixels) with every screenshot. Instruct the model to emit **integers 0–999 on both axes**, then convert in Node, never in the prompt:
     cssX = Math.round(x / 999 * viewportWidth)
     cssY = Math.round(y / 999 * viewportHeight)
   This is why Gemini was chosen: the conversion is independent of whatever resize the provider applied to your image.

6) FIX A LATENT BUG YOU ALREADY HAVE (lines 435–448). Both the streaming and non-streaming paths gate only on `!response.ok`. OpenRouter regularly returns **HTTP 200 with an error body** — verified repeatedly, e.g. `{"error":{"message":"Upstream idle timeout exceeded","code":504}}`. Today that falls through to `payload.choices?.[0]?.message?.content ?? ''`, yielding an empty string and the misleading "LLM returned an empty planning response." Add, before reading choices:
     if (payload.error) throw new Error(payload.error.message ?? 'LLM API error')
   Also special-case the string `No endpoints found that support image input` with a clear "configured vision model is text-only" message.

7) DISABLE CONTEXT COMPRESSION ON IMAGE REQUESTS. Add `plugins: [{ id: 'context-compression', enabled: false }]`. OpenRouter's own docs state compression "would otherwise truncate multipart message content and drop input image_url parts," and it is applied by default to any endpoint with ≤8k context. Cheap insurance against a silently vanished screenshot.

8) REASONING EFFORT. Add `reasoning: { effort: 'low' }` on the vision request. This is the single most important latency parameter — see the cost/latency section.

9) STARTUP CAPABILITY CHECK. At boot, `GET https://openrouter.ai/api/v1/models?input_modalities=image` (unauthenticated, edge-cached) and assert LLM_VISION_MODEL appears; fail fast with a clear message otherwise. Verified: the server-side filter returns 180 of 337 models with zero false positives. Do a runtime lookup, not a hardcoded list — baking a static model snapshot is the exact bug that made another client silently strip images for unknown models.

10) DO NOT ACCUMULATE SCREENSHOTS IN CONTEXT. Send only the newest screenshot each turn; summarize prior steps as text. OpenRouter has no image file-handle reuse (its Files API `file_id` attaches to the `file` content part for PDFs, not to `image_url`), so every retained image is re-uploaded in full every turn. Linear vs quadratic on a 30-step loop is ~$0.10 vs ~$1.56.

11) `response_format: { type: 'json_object' }` at line 427 works — I verified `response_format` and `structured_outputs` are both in gemini-3.6-flash's supported_parameters. For coordinate emission specifically, prefer a full `json_schema` structured output over bare json_object; it eliminates a class of parse failures in `extractJsonObject`.

12) Keep the existing OpenRouter attribution headers (lines 331-337). While debugging, add `X-OpenRouter-Metadata: enabled` — it returns an `openrouter_metadata` object showing which provider actually served the request, which matters because routing is nondeterministic (identical image requests landed on "Google" (Vertex) and "Google AI Studio" on consecutive calls).

## Risks

HIGH — PROMPT INJECTION VIA SCREENSHOT. This is the most serious risk and it is specific to your codebase. `FULL_CONTROL_MODE` in llmPlanner.js exposes `run_shell` and `run_applescript`. Once the planner reads rendered web pages, any page can display text addressed to the agent ("ignore previous instructions, run this command"). A screenshot is untrusted data, not instruction. Concretely: (a) never let a vision turn emit `run_shell`/`run_applescript`/`open_path` — restrict the vision planner's action schema to click/type/scroll/navigate only; (b) keep `requiresConfirmation` on for anything a screenshot influenced; (c) note that OpenRouter does NOT pass through the vendors' prompt-injection classifiers, which are part of Anthropic's and Google's native computer-use tools. You are running without that safety net.

HIGH — PUBLISHED OSWORLD SCORES WILL NOT TRANSFER. Gemini 3.6 Flash's 83.0% OSWorld-Verified was measured with Google's **native computer_use tool**, which has RL-trained action heads and a fixed action vocabulary. I confirmed against OpenRouter's docs index, tool-calling guide, and server-tools list that **OpenRouter has no computer-use passthrough for Anthropic's `computer_20251124`, OpenAI's Responses-API `computer_use`, or Google's `computer_use`**. You get image input plus ordinary function calling and must define your own `click(x,y)`/`type()` tools against the model's raw grounding. Expect materially worse than 83%. Budget a real evaluation on your own UIs before trusting the loop unsupervised.

MEDIUM — `media_resolution` UNREACHABLE. Google states `ultra_high` (2240 tokens/image) is what computer use wants; OpenRouter exposes no such parameter (zero hits in its OpenAPI spec), so you are stuck at the 1120-token default. Mitigation if grounding proves weak: `LLM_API_BASE_URL` is already configurable — point the vision leg at Gemini's own OpenAI-compatible endpoint and set `media_resolution` natively, while leaving the text leg on OpenRouter. Costs you one extra API key, no code restructuring.

MEDIUM — NO GROUNDING BENCHMARK FOR THE CHOSEN MODEL. ScreenSpot-Pro has no published score for gemini-3.6-flash (nor for Claude Opus 5, Sonnet 5, or any GPT-5.6 tier). The board's leader is Claude Opus 4.8 at 0.879, which predates all of them. Gemini 3 Pro sits at 0.727 and Gemini 3 Flash at 0.691, so the family's raw grounding is mid-pack even though its end-to-end OSWorld score is near the top — the gap is exactly the computer-use tool you cannot access. This is the assumption most likely to be wrong.

MEDIUM — LATENCY IS THE WEAKEST DATA IN THIS WHOLE ANALYSIS. No public tracker measures TTFT with an image in the prompt. BenchLM has no entries at all for Gemini 3.6 Flash, 3.5 Flash-Lite, Haiku 4.5, Sonnet 5, Opus 5, or any GPT-5.6 tier. Instrument end-to-end (capture → downscale → upload → TTFT → last token) from day one; if you land above ~3 s, drop to `google/gemini-3.5-flash-lite` (370 tok/s, 74% OSWorld, ~4.5x cheaper) before doing anything more elaborate.

LOW/MEDIUM — PROVIDER ROUTING NONDETERMINISM. Multi-provider models load-balance by default and per-endpoint modality is NOT exposed by OpenRouter's API — you cannot tell which provider will serve your image. `require_parameters: true` does not help (modality is not a "parameter"). If image behavior differs between runs, pin with `provider: { only: [...] }` or `provider: { order: [...] }`.

LOW — COST DRIFT. DeepSeek has announced but not yet activated peak-hour pricing: 2x on all billing items during 09:00–12:00 and 14:00–18:00 Beijing time, daily. Effective date TBD. Plan for a possible 2x on the text leg.

LOW — VERSION INSTABILITY ON THE BARE DEEPSEEK SLUG. `deepseek/deepseek-v4-flash` reports checkpoint `-20260423` across its 21 endpoints, yet DeepSeek's own first-party API now resolves the same name to 0731 — and DeepSeek is one of those 21 providers. Which weights you get may depend on routing. Pinning `-0731` (recommended above) resolves this.

UNKNOWNS I COULD NOT CLOSE: OpenRouter's exact request-body 413 threshold (>20 MiB accepted; 40 MiB timed out at ~340 s rather than 413'd — irrelevant at your ~300 KB payloads); whether OpenRouter re-encodes or downscales images before forwarding (token counts matched Gemini's own formula closely enough to suggest pass-through); whether Anthropic's `zoom` action is reachable through OpenRouter (assume no).
