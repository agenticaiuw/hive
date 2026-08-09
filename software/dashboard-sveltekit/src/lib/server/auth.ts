/**
 * Pairing-code session auth for the dashboard
 * hand-written Worker entry (`worker/index.ts`). Every constant, status code,
 * header and comparison here is load-bearing: the deployed dashboard is a
 * public URL that gates itself, and the test-suite asserts the exact bytes.
 */
import type { RuntimeEnv } from "./env";

const SESSION_COOKIE = "__Host-pendant_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MIN_ACCESS_KEY_LENGTH = 16;
const MIN_SESSION_SECRET_LENGTH = 32;

type SecureEnv = RuntimeEnv & {
  DASHBOARD_ACCESS_KEY: string;
  DASHBOARD_SESSION_SECRET: string;
};

function hasSecureAuthConfiguration(env: RuntimeEnv): env is SecureEnv {
  return Boolean(
    env.DASHBOARD_ACCESS_KEY &&
      env.DASHBOARD_ACCESS_KEY.length >= MIN_ACCESS_KEY_LENGTH &&
      env.DASHBOARD_SESSION_SECRET &&
      env.DASHBOARD_SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH,
  );
}

export async function login(
  request: Request,
  env: RuntimeEnv,
): Promise<Response> {
  if (!hasSecureAuthConfiguration(env)) {
    return Response.json(
      { ok: false, error: "Dashboard authentication is not configured." },
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
    return redirect(failureUrl, 303);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession(expiresAt, env.DASHBOARD_SESSION_SECRET);
  return redirectWithCookie(
    new URL(returnTo, request.url),
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  );
}

export function logout(request: Request): Response {
  return redirectWithCookie(
    new URL("/login", request.url),
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
}

export async function hasValidSession(
  request: Request,
  env: RuntimeEnv,
): Promise<boolean> {
  if (!hasSecureAuthConfiguration(env)) {
    return false;
  }

  // Raw string parsing, not a cookie API: the token is unpadded base64url and
  // must not be re-decoded on the way in or out.
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

async function signSession(expiresAt: number, secret: string): Promise<string> {
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

/** Length- and content-independent comparison over SHA-256 digests. */
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

/**
 * WHATWG URL parsing is what neutralises `"/\\attacker.example/escape"`; a
 * string-prefix check would let it through.
 */
export function safeReturnTo(value: unknown): string {
  const raw = String(value || "/");
  if (raw.length > 2048 || !raw.startsWith("/")) {
    return "/";
  }

  const base = new URL("https://dashboard.invalid/");
  const destination = new URL(raw, base);
  if (destination.origin !== base.origin) {
    return "/";
  }

  return `${destination.pathname}${destination.search}${destination.hash}`;
}

/**
 * Built by hand rather than with `Response.redirect()` or SvelteKit's
 * `redirect()` so the status, `Location` and cookie stay byte-identical and the
 * headers remain mutable for the rest of the pipeline.
 */
function redirect(location: URL, status: number): Response {
  return new Response(null, {
    status,
    headers: { Location: location.toString() },
  });
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
