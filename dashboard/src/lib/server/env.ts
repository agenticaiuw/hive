import { env as dynamicPrivateEnv } from "$env/dynamic/private";

export type RelayBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type RuntimeEnv = {
  ASSETS?: RelayBinding;
  RELAY?: RelayBinding;
  RELAY_URL?: string;
  RELAY_API_KEY?: string;
  PAIRING_CODE?: string;
  SESSION_SECRET?: string;
  DASHBOARD_ACCESS_KEY?: string;
  DASHBOARD_SESSION_SECRET?: string;
};

/**
 * On Cloudflare the Worker's bindings and secrets arrive per request through
 * `event.platform.env`. Vite reads the repo-root `.env` into the dynamic
 * private env, while Wrangler may also provide a partial platform object in
 * local development. Merge both sources so one partial object cannot hide the
 * other; real Worker bindings win. The root file uses the shared short auth
 * names, which are mapped here without creating any client-visible VITE_* key.
 */
export function resolveRuntimeEnv(
  platform: Readonly<App.Platform> | undefined,
): RuntimeEnv {
  const privateEnv = dynamicPrivateEnv as unknown as RuntimeEnv;
  const merged: RuntimeEnv = {
    ...privateEnv,
    ...(platform?.env ?? {}),
  };

  return {
    ...merged,
    DASHBOARD_ACCESS_KEY:
      merged.DASHBOARD_ACCESS_KEY || merged.PAIRING_CODE,
    DASHBOARD_SESSION_SECRET:
      merged.DASHBOARD_SESSION_SECRET || merged.SESSION_SECRET,
  };
}
