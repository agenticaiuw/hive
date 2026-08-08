import { httpServerHandler } from 'cloudflare:node'
import { setCloudflareBindings } from '../cloud-relay/cloudflareBindings.js'

/*
 * The bridge doorbell Durable Object. Wrangler requires DO classes to be
 * exported from the entry module; the class itself lives in bridgeHub.js and
 * keeps its module scope light so this re-export costs the 10 ms cron budget
 * nothing. Bound as BRIDGE_HUB in wrangler.jsonc (new_sqlite_classes — the
 * Free plan only allows SQLite-backed DO classes).
 */
export { BridgeHub } from './bridgeHub.js'

let relayHandlerPromise

export default {
  /*
   * The relay's clock. Fires every minute (wrangler.jsonc triggers.crons) so
   * a routine keeps its promise while the owner's Mac is a closed lid.
   *
   * Imported lazily and kept off the fetch path on purpose: a cron invocation
   * on the Workers Free plan gets 10 ms of CPU, so it must not pay to
   * evaluate the Express relay it never uses. Bindings are set the same way
   * fetch() sets them — a scheduled invocation gets its own isolate as often
   * as not, and the D1 store reads env.DB through this module-level handoff.
   */
  async scheduled(controller, env, context) {
    setCloudflareBindings(env)
    const { runScheduledTick } = await import('../cloud-relay/scheduler.js')
    const work = runScheduledTick({
      trigger: 'cron',
      now: controller.scheduledTime || Date.now(),
    }).catch((error) => {
      // Swallowing keeps Cloudflare from retrying a tick that will fail the
      // same way; the next minute's cron is the retry that matters.
      console.warn(`[worker] scheduled tick failed: ${error?.message || error}`)
    })
    context.waitUntil(work)
    await work
  },

  async fetch(request, env, context) {
    setCloudflareBindings(env)

    // Second clock. Runs in waitUntil so it cannot add a millisecond to any
    // response, and rate-limits itself to once a minute across the fleet —
    // see maybeTickOnTraffic() for why the cron alone is not enough.
    context.waitUntil(
      import('../cloud-relay/scheduler.js')
        .then(({ maybeTickOnTraffic }) => maybeTickOnTraffic())
        .catch(() => {}),
    )

    // Full-duplex pendant WebSocket: must be claimed BEFORE the express
    // bridge — httpServerHandler cannot complete an Upgrade handshake.
    const url = new URL(request.url)
    if (url.pathname === '/v1/pendant/converse') {
      const { isPendantConverseRequest, handlePendantConverse } =
        await import('../cloud-relay/pendantConverse.js')
      if (isPendantConverseRequest(request, url)) {
        return handlePendantConverse(request, context)
      }
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    /*
     * Mac bridge doorbell socket: same rule as the pendant socket — claimed
     * before Express because httpServerHandler cannot complete an Upgrade.
     * The handler authenticates (admin key or scoped device token, the same
     * check the Express routes run) BEFORE forwarding the upgrade to the
     * device's BridgeHub Durable Object.
     */
    if (url.pathname === '/v1/bridge/socket') {
      const { handleBridgeSocketUpgrade } = await import('./bridgeHub.js')
      return handleBridgeSocketUpgrade(request, env)
    }

    if (!relayHandlerPromise) {
      relayHandlerPromise = import('../cloud-relay/server.js').then(() =>
        httpServerHandler({ port: 8787 }),
      )
    }
    const relayHandler = await relayHandlerPromise
    return relayHandler.fetch(request, env, context)
  },
}
