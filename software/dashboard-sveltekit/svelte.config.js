import cloudflare from "@sveltejs/adapter-cloudflare";
import staticAdapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/*
 * One source, two outputs.
 *
 * `DASHBOARD_TARGET=agent` emits a plain static SPA that the Mac agent serves
 * at `http://127.0.0.1:8000/dashboard`; anything else emits the Cloudflare
 * Worker. They are the same components and the same data layer — only the
 * backend behind `$lib/dataSource` and the hosting differ. Two builds of one
 * app is the cheap kind of duplication; two apps was the expensive kind.
 */
const agentBuild = process.env.DASHBOARD_TARGET === "agent";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: agentBuild
      ? staticAdapter({
          pages: "build-agent",
          assets: "build-agent",
          // No server to route unknown paths, and the agent only ever hands
          // back this one file, so every path resolves to the SPA shell.
          fallback: "index.html",
          precompress: false,
          strict: false,
        })
      : cloudflare({
          // `vite dev` emulates the Worker bindings through Wrangler. It cannot
          // stand up the remote `ai-pendant-relay` service, and a
          // half-emulated binding is worse than none, so dev runs against the
          // `local` environment (same vars, no services) and the server falls
          // back to `fetch(RELAY_URL + path)`. Deploys still use the top-level
          // config.
          platformProxy: { environment: "local" },
        }),

    // The agent mounts the build under /dashboard, so its asset URLs have to
    // carry that prefix. `$lib/dataSource` also reads this as the marker for
    // which backend it is talking to.
    ...(agentBuild ? { paths: { base: "/dashboard", relative: false } } : {}),

    // The Worker this replaces had no origin check, and the same UI is loaded
    // by a macOS WKWebView and an iOS Capacitor WebView whose origins are not
    // the site origin — SvelteKit's default would 403 their login form post.
    // Cross-site POSTs still cannot authenticate: the session cookie is
    // `__Host-` scoped and `SameSite=Lax`, so it is not sent on them.
    csrf: { checkOrigin: false },

    // Absolute `/_app/...` asset URLs, which is what the public-path allowlist
    // in `hooks.server.ts` lets through before a session exists.
    ...(agentBuild ? {} : { paths: { relative: false } }),
  },
};

export default config;
