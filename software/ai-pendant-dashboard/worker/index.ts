/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  RELAY?: Fetcher;
  RELAY_URL?: string;
  RELAY_API_KEY?: string;
  DASHBOARD_ACCESS_KEY?: string;
  DASHBOARD_SESSION_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const SESSION_COOKIE = "__Host-pendant_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MIN_ACCESS_KEY_LENGTH = 16;
const MIN_SESSION_SECRET_LENGTH = 32;

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    (
      globalThis as typeof globalThis & {
        __PENDANT_RUNTIME_ENV__?: Env;
      }
    ).__PENDANT_RUNTIME_ENV__ = env;
    const url = new URL(request.url);

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
      url.pathname.startsWith("/_next/") ||
      url.pathname.startsWith("/_vinext/");

    if (!publicAsset && !(await hasValidSession(request, env))) {
      if (url.pathname.startsWith("/api/")) {
        return Response.json(
          { ok: false, error: "Sign in to Mission Control." },
          { status: 401 },
        );
      }

      const loginUrl = new URL("/login", url);
      loginUrl.searchParams.set(
        "returnTo",
        `${url.pathname}${url.search}`,
      );
      return Response.redirect(loginUrl, 302);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

async function login(request: Request, env: Env): Promise<Response> {
  if (!hasSecureAuthConfiguration(env)) {
    return Response.json(
      { ok: false, error: "Mission Control authentication is not configured." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const contentType = request.headers.get("content-type") || "";
  let accessKey = "";
  let returnTo = "/";

  if (contentType.includes("application/json")) {
    const payload = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    accessKey = String(payload.accessKey || "");
    returnTo = safeReturnTo(payload.returnTo);
  } else {
    const form = await request.formData();
    accessKey = String(form.get("accessKey") || "");
    returnTo = safeReturnTo(form.get("returnTo"));
  }

  if (!(await equalSecrets(accessKey, env.DASHBOARD_ACCESS_KEY))) {
    const failureUrl = new URL("/login", request.url);
    failureUrl.searchParams.set("error", "1");
    failureUrl.searchParams.set("returnTo", returnTo);
    return Response.redirect(failureUrl, 303);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession(expiresAt, env.DASHBOARD_SESSION_SECRET);
  return redirectWithCookie(
    new URL(returnTo, request.url),
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  );
}

function logout(request: Request): Response {
  return redirectWithCookie(
    new URL("/login", request.url),
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
}

async function hasValidSession(request: Request, env: Env): Promise<boolean> {
  if (!hasSecureAuthConfiguration(env)) {
    return false;
  }

  const cookies = request.headers.get("cookie") || "";
  const token = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (!token) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [expiresRaw, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000) ||
    !signature
  ) {
    return false;
  }

  const expected = await sessionSignature(
    expiresRaw,
    env.DASHBOARD_SESSION_SECRET,
  );
  return equalSecrets(signature, expected);
}

async function signSession(
  expiresAt: number,
  secret: string,
): Promise<string> {
  const expiresRaw = String(expiresAt);
  return `${expiresRaw}.${await sessionSignature(expiresRaw, secret)}`;
}

async function sessionSignature(
  value: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return base64Url(new Uint8Array(signature));
}

async function equalSecrets(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function safeReturnTo(value: unknown): string {
  const raw = String(value || "/");
  if (raw.length > 2048 || !raw.startsWith("/")) {
    return "/";
  }

  const base = new URL("https://mission-control.invalid/");
  const destination = new URL(raw, base);
  if (destination.origin !== base.origin) {
    return "/";
  }

  return `${destination.pathname}${destination.search}${destination.hash}`;
}

function hasSecureAuthConfiguration(env: Env): env is Env & {
  DASHBOARD_ACCESS_KEY: string;
  DASHBOARD_SESSION_SECRET: string;
} {
  return Boolean(
    env.DASHBOARD_ACCESS_KEY &&
      env.DASHBOARD_ACCESS_KEY.length >= MIN_ACCESS_KEY_LENGTH &&
      env.DASHBOARD_SESSION_SECRET &&
      env.DASHBOARD_SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH,
  );
}

function redirectWithCookie(location: URL, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
      "Set-Cookie": cookie,
    },
  });
}
