import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { NO_STORE_HEADERS } from "$lib/server/relay";
import { NOT_YET } from "$lib/server/agents";

export const prerender = false;

/** `{agent, text}` → `{accepted, receiptId?, error?}` on hosts that can send; not yet here. */
export const POST: RequestHandler = () =>
  json({ accepted: false, error: NOT_YET }, { status: 501, headers: NO_STORE_HEADERS });
