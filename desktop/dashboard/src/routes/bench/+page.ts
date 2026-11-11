import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/*
 * Off the Mac there is no bench, so there is no page.
 *
 * `vite.config.ts` already strips the component from every non-agent build, so
 * the hosted bundle carries none of the instrument. This is the other half:
 * without it the hosted URL would resolve to an empty page inside the dashboard
 * chrome, which reads as a broken route rather than an absent one. Sending it
 * home says the truth — there is nothing here — in the one way a browser
 * understands.
 *
 * The flag is the same compile-time constant `hooks.server.ts` gates on, so the
 * agent build folds this to a no-op and ships no redirect.
 */
const AGENT_BUILD = import.meta.env.VITE_DASHBOARD_BACKEND === "agent";

export const load: PageLoad = () => {
  if (!AGENT_BUILD) redirect(307, "/");
};
