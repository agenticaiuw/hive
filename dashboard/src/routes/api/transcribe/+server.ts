import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";

export const prerender = false;

/** Whisper on Workers AI: the cloud model the website reads dictation with. */
const MODEL = "@cf/openai/whisper-large-v3-turbo";
/** Five minutes of 16 kHz 16-bit audio is 9.6 MB. */
const MOST_BYTES = 12_000_000;

/** A 16 kHz WAV of what you said (the page records it) → `{text}`. */
export const POST: RequestHandler = async ({ locals, request }) => {
  const ai = locals.runtimeEnv.AI;
  if (!ai) {
    return json({ error: "This site has no speech model." }, { status: 503, headers: NO_STORE_HEADERS });
  }
  const audio = await request.arrayBuffer();
  if (audio.byteLength <= 44) {
    return json({ error: "Nothing was recorded." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (audio.byteLength > MOST_BYTES) {
    return json({ error: "That's too long to read at once." }, { status: 413, headers: NO_STORE_HEADERS });
  }
  try {
    const answer = await ai.run(MODEL, {
      audio: Buffer.from(audio).toString("base64"),
      language: "en",
      vad_filter: true,
    });
    return json({ text: String(answer?.text ?? "").trim() }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return json({ error: `The speech model couldn't read it: ${why}` }, { status: 502, headers: NO_STORE_HEADERS });
  }
};
