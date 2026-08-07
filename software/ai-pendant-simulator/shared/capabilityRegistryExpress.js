/*
 * How a surface registers ITSELF, for the surface that cannot today.
 *
 * The Mac publishes ~120 routes at GET /capabilities, derived from the live
 * Express router by local-agent/capabilityManifest.js. The relay publishes
 * nothing: 41 routes and no inventory, so nothing outside the process can
 * enumerate its surface. That is not a cosmetic gap. POST /v1/pendant/announce
 * has existed for weeks and was invisible, which is why the capability it
 * belongs to was proposed eighteen times by agents that could not see it.
 *
 * The obvious fix — teach the relay to describe itself the way the Mac does —
 * runs into the thing that makes the relay different: its auth is not a single
 * bearer token, it is a scope table, and the function that computes it
 * (requiredScopesForRequest in cloud-relay/server.js) is security-critical.
 * Rewriting it into a declarative map to make it enumerable would be a
 * refactor of the one function in this repo where a mistake is a
 * vulnerability, undertaken for a discovery feature. Not worth it, and not
 * necessary.
 *
 * So this module READS it instead. Route paths come off the router; for each
 * one a concrete sample path is synthesized (':jobId' -> a placeholder segment)
 * and handed to the surface's own scope function as data. Every regex and
 * prefix test in that function answers exactly as it does at runtime, and not a
 * line of it changes. The relay's entire cost to appear in the registry is:
 *
 *   1. `export` on the existing requiredScopesForRequest — one keyword, no
 *      logic touched.
 *   2. One call to registerExpressSurface() at startup.
 *   3. Optionally a GET /v1/capabilities that serves the result, so the
 *      inventory is readable from outside the process rather than only inside
 *      it. Without step 3 the relay is legible to code that shares its heap;
 *      with it, to everything.
 *
 * The probe is advisory and says so. If it and the runtime ever disagree, the
 * runtime is right — this module never gates a request, it only answers
 * questions about one.
 */

import {
  pathParams,
  registerCapabilities,
  registerSurface,
} from './capabilityRegistry.js'

/* Stands in for a path parameter when probing the scope function. Deliberately
 * not a plausible id: if it ever escapes into a log or a report it should read
 * as obviously synthetic rather than as a real job someone can go looking for. */
export const SAMPLE_PATH_SEGMENT = '__probe__'

/**
 * Every route the app actually has, read off the live router.
 *
 * The same derivation as capabilityManifest.listRoutes(), duplicated on purpose
 * rather than imported: that module reaches into the Mac's config, executor and
 * macOS permission probes at import time, and the relay — the surface that most
 * needs this — cannot load any of it, least of all under Workers.
 * Method-less middleware layers are skipped; they match everything and describe
 * nothing.
 */
export function listExpressRoutes(app) {
  const layers = app?.router?.stack ?? app?._router?.stack ?? []
  const routes = []

  for (const layer of layers) {
    if (!layer.route) continue
    const paths = Array.isArray(layer.route.path)
      ? layer.route.path
      : [layer.route.path]

    for (const routePath of paths) {
      if (typeof routePath !== 'string') continue
      for (const method of Object.keys(layer.route.methods ?? {})) {
        routes.push({
          method: method.toUpperCase(),
          path: routePath,
          params: pathParams(routePath),
        })
      }
    }
  }

  return routes.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  )
}

/**
 * Replace path parameters with a sample segment so a path-matching function can
 * be asked about the route.
 *
 * '/v1/mac/jobs/:jobId' -> '/v1/mac/jobs/__probe__', which the relay's own
 * /^\/v1\/mac\/jobs\/[^/]+$/ matches exactly as it would a real request. This
 * is the whole trick: the scope table stays imperative and untouched, and is
 * still enumerable.
 */
export function samplePathFor(routePath) {
  return String(routePath ?? '/').replace(
    /[:{][A-Za-z0-9_]+\}?/g,
    SAMPLE_PATH_SEGMENT,
  )
}

/**
 * Register a live Express app as a capability surface.
 *
 * `scopesFor` and `isPublicPath` are injected, never imported: each surface
 * guards itself differently — the Mac has one bearer token and a public-path
 * allowlist, the relay has per-device scopes — and a discovery module that
 * hard-coded either would be asserting a security policy it does not own.
 *
 * A route whose scope function answers null gets auth `unknown`, not a guessed
 * default. capabilityRegistryReport() lists those under undeclaredAuth, so the
 * gap is a line in a report rather than a caller confidently told it is allowed
 * through.
 */
export function registerExpressSurface(
  registry,
  app,
  {
    surface,
    credential = 'unknown',
    baseUrl = null,
    isPublicPath = null,
    scopesFor = null,
    publishesAt = null,
    inventorySource = 'express-router',
    note = null,
    provides = {},
    skip = null,
    now = Date.now(),
  } = {},
) {
  if (!app) throw new TypeError('registerExpressSurface needs an Express app.')

  registerSurface(
    registry,
    { surface, inventorySource, publishesAt, note },
    { now },
  )

  const routes = listExpressRoutes(app).filter(
    (route) => !(typeof skip === 'function' && skip(route)),
  )

  const inputs = routes.map((route) => {
    const isPublic =
      typeof isPublicPath === 'function' ? Boolean(isPublicPath(route.path)) : false
    const scopes = isPublic ? [] : probeScopes(scopesFor, route)

    return {
      name: `${route.method} ${route.path}`,
      surface,
      kind: 'http',
      status: 'implemented',
      invoke: { method: route.method, path: route.path, baseUrl },
      auth: {
        credential: isPublic ? 'none' : scopes === null ? 'unknown' : credential,
        scopes: scopes ?? [],
        note:
          scopes === null && !isPublic
            ? 'No scope declared for this route by the surface that owns it.'
            : null,
      },
      /* Path parameters become requirements automatically inside
       * defineCapability(); only what a route YIELDS has to be declared, and
       * only by the surface that knows. */
      provides: provides[`${route.method} ${route.path}`] ?? provides[route.path] ?? [],
    }
  })

  return registerCapabilities(registry, inputs, { now })
}

/**
 * Ask the surface's own scope function about a route, as data.
 *
 * Wrapped in a try/catch that swallows nothing quietly: a scope function that
 * throws on a synthetic path is telling us it needs more of a request than a
 * method and a path, and the honest answer for that route is `unknown`. Better
 * an admitted gap than an inventory that reports a guarded route as open.
 */
function probeScopes(scopesFor, route) {
  if (typeof scopesFor !== 'function') return null

  try {
    const scopes = scopesFor({
      method: route.method,
      path: samplePathFor(route.path),
    })
    if (scopes == null) return null
    return Array.isArray(scopes) ? scopes.map(String) : [String(scopes)]
  } catch {
    return null
  }
}
