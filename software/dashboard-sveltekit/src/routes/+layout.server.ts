import type { LayoutServerLoad } from "./$types";

/**
 * The Open Graph image is absolute, so it has to be built from the host the
 * request actually arrived on (the dashboard answers on both the workers.dev
 * URL and the Sites host).
 */
export const load: LayoutServerLoad = ({ request }) => {
  const host = request.headers.get("host") || "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  return { imageUrl: `${protocol}://${host}/og.png` };
};
