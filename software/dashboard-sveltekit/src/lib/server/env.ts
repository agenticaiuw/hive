import { env as dynamicPrivateEnv } from "$env/dynamic/private";

export type RelayBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type RuntimeEnv = {
  ASSETS?: RelayBinding;
  RELAY?: RelayBinding;
  RELAY_URL?: string;
  RELAY_API_KEY?: string;
  DASHBOARD_ACCESS_KEY?: string;
  DASHBOARD_SESSION_SECRET?: string;
};

/**
 * On Cloudflare the Worker's bindings and secrets arrive per request through
 * `event.platform.env`. `vite dev` and `node --test` have no platform, so fall
 * back to the dynamic private env (process.env plus any `.env` file), which
 * leaves `RELAY` undefined and makes the relay helpers use `RELAY_URL`.
 */
export function resolveRuntimeEnv(
  platform: Readonly<App.Platform> | undefined,
): RuntimeEnv {
  return (
    platform?.env ?? (dynamicPrivateEnv as unknown as RuntimeEnv) ?? ({} as RuntimeEnv)
  );
}
