import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * The bench page is built for the Mac agent only, and is not shipped to the
 * hosted Worker at all.
 *
 * The owner's ruling: "remember that the bench should only be available
 * locally." An earlier version satisfied that in the page's CONTENTS — the
 * hosted copy rendered a line saying "open this on the Mac" — which still
 * shipped the whole instrument to a public URL: the tiles, the SSE client, and
 * the literal device paths (`/dev/cu.usbmodem0009600365811`) baked into its
 * empty-state copy. Publishing the names of the ports on someone's desk is a
 * small leak, but it is one nobody asked for, and "hidden" is not "absent".
 *
 * So for every build except `DASHBOARD_TARGET=agent`, the route's component is
 * replaced at load time with an empty one. Rollup then has nothing to bundle:
 * no tile markup, no EventSource, no port names. The route's `+page.ts`
 * separately redirects the hosted URL home, so nothing renders bench chrome
 * either.
 *
 * What this does NOT do, stated plainly because the difference is checkable:
 * SvelteKit builds its route table from the filesystem and has no supported
 * per-build route exclusion, so the hosted manifest still carries an empty
 * `/bench` entry. The URL resolves and redirects rather than 404ing. The code
 * behind it is gone, which is the part that mattered.
 */
function benchIsAgentOnly(): Plugin {
  const agentBuild = process.env.DASHBOARD_TARGET === "agent";
  const BENCH_PAGE = "/src/routes/bench/+page.svelte";

  return {
    name: "bench-is-agent-only",
    // Ahead of the Svelte plugin, so it compiles the stub and never sees the
    // real source.
    enforce: "pre",
    load(id) {
      if (agentBuild) return null;
      const path = id.split("?")[0];
      if (!path.endsWith(BENCH_PAGE)) return null;
      return "<!-- The bench is local-only; it is not built for this target. -->";
    },
  };
}

export default defineConfig({
  // Vite otherwise looks beside this package and misses the monorepo's single
  // private env file. Keep the short, non-VITE names server-only; env.ts maps
  // the dashboard aliases without ever creating a public VITE_* credential.
  envDir: "../..",
  plugins: [benchIsAgentOnly(), sveltekit()],
});
