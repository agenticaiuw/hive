/**
 * Module-resolution hook that lets bare Node import the built Cloudflare
 * Worker entry. Only the `cloudflare:` scheme is redirected; every other
 * specifier resolves normally, so the code under test is the real build
 * output, unmodified.
 */
const SHIM = new URL("./cloudflare-workers.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: SHIM, format: "module" };
  }
  return nextResolve(specifier, context);
}
