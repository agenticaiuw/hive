import cloudflare from "@sveltejs/adapter-cloudflare";
import staticAdapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/*
 * One source, two outputs: the Cloudflare Worker (the website), and with `DASHBOARD_TARGET=desktop`
 * the same app as a static SPA for Hive's Mac app, which serves it from hive://app/ (no base path)
 * and answers /api/* itself (desktop/app/workspace-engine, dashboard.swift).
 */
const desktopBuild = process.env.DASHBOARD_TARGET === "desktop";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: desktopBuild
      ? staticAdapter({
          pages: "build-desktop",
          assets: "build-desktop",
          fallback: "index.html",
          precompress: false,
          strict: false,
        })
      : cloudflare({
          // `vite dev` emulates the Worker bindings through Wrangler against the `local`
          // environment (same vars, no service bindings): the board is reached by TASKS_URL.
          platformProxy: { environment: "local" },
        }),

    // The Worker this replaces had no origin check, and the same UI is loaded
    // by a macOS WKWebView and an iOS Capacitor WebView whose origins are not
    // the site origin — SvelteKit's default would 403 their login form post.
    // Cross-site POSTs still cannot authenticate: the session cookie is
    // `__Host-` scoped and `SameSite=Lax`, so it is not sent on them.
    csrf: { checkOrigin: false },

    // Absolute `/_app/...` asset URLs, which is what the public-path allowlist
    // in `hooks.server.ts` lets through before a session exists.
    paths: { relative: false },
  },
};

export default config;
