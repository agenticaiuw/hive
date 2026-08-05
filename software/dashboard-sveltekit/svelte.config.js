import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Emits `.svelte-kit/cloudflare/_worker.js` plus the client assets, wired
    // up by `wrangler.jsonc` (`main` + `assets.directory`).
    adapter: adapter({
      // `vite dev` emulates the Worker bindings through Wrangler. It cannot
      // stand up the remote `ai-pendant-relay` service, and a
      // half-emulated binding is worse than none, so dev runs against the
      // `local` environment (same vars, no services) and the server falls back
      // to `fetch(RELAY_URL + path)`. Deploys still use the top-level config.
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
