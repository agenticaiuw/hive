import type { LayoutLoad } from "./$types";

/*
 * The Mac agent serves this same build as plain static files, with no server
 * behind it — so nothing here may be a server load, and the shell must render
 * in the browser. The Cloudflare build keeps SSR, which is what makes the
 * deployed page useful before its JavaScript arrives.
 */
export const ssr = import.meta.env.VITE_DASHBOARD_BACKEND !== "agent";

/**
 * The Open Graph image is absolute, so it has to be built from the origin the
 * request actually arrived on (the dashboard answers on both the workers.dev
 * URL and the Sites host).
 */
export const load: LayoutLoad = ({ url }) => ({
  imageUrl: new URL("/og.png", url.origin).href,
});
