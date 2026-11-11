import type { Handle } from "@sveltejs/kit";
import { hasValidSession, login, logout } from "$lib/server/auth";
import { resolveRuntimeEnv } from "$lib/server/env";

/**
 * The whole gate lives here so the ordering matches the Worker entry it
 * replaces: login/logout first (they must be reachable anonymously), then the
 * public-path allowlist, then the session check. Pages get a 302 to /login,
 * `/api/*` gets a 401 before any relay call is made.
 */
/*
 * The agent build ships as static files with no server behind it, so this hook
 * runs only while generating the shell. Its gate would 302 that render to
 * /login and there would be no page at all. Access control for that build is
 * the Mac agent's own loopback session, which is a stronger gate than a
 * pairing code: it is unreachable from the network.
 */
const AGENT_BUILD = import.meta.env.VITE_DASHBOARD_BACKEND === "agent";

export const handle: Handle = async ({ event, resolve }) => {
  const env = resolveRuntimeEnv(event.platform);
  event.locals.runtimeEnv = env;

  if (AGENT_BUILD) return resolve(event);

  const { url, request } = event;

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    return login(request, env);
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return logout(request);
  }

  const publicAsset =
    url.pathname === "/login" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/og.png" ||
    url.pathname.startsWith("/assets/") ||
    // SvelteKit's immutable build output.
    url.pathname.startsWith("/_app/");

  if (!publicAsset && !(await hasValidSession(request, env))) {
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { ok: false, error: "Sign in to the dashboard." },
        { status: 401 },
      );
    }

    const loginUrl = new URL("/login", url);
    loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
    return new Response(null, {
      status: 302,
      headers: { Location: loginUrl.toString() },
    });
  }

  return resolve(event);
};
