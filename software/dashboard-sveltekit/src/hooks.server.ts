import type { Handle } from "@sveltejs/kit";
import { hasValidSession, login, logout } from "$lib/server/auth";
import { resolveRuntimeEnv } from "$lib/server/env";

/**
 * The whole gate lives here so the ordering matches the Worker entry it
 * replaces: login/logout first (they must be reachable anonymously), then the
 * public-path allowlist, then the session check. Pages get a 302 to /login,
 * `/api/*` gets a 401 before any relay call is made.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const env = resolveRuntimeEnv(event.platform);
  event.locals.runtimeEnv = env;

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
    // SvelteKit's immutable build output (+ legacy prefixes that may still
    // be bookmarked from older dashboard builds).
    url.pathname.startsWith("/_app/") ||
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/_vinext/");

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
