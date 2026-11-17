/** Every `/api/*` answer is about the owner's live board, so nothing caches it. */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;
