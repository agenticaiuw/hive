import type { RuntimeEnv } from "$lib/server/env";

declare global {
  namespace App {
    interface Locals {
      /** Bindings + secrets resolved once per request in `hooks.server.ts`. */
      runtimeEnv: RuntimeEnv;
    }

    interface Platform {
      env?: RuntimeEnv;
      ctx?: {
        waitUntil(promise: Promise<unknown>): void;
        passThroughOnException(): void;
      };
      caches?: unknown;
      cf?: unknown;
    }
  }
}

export {};
