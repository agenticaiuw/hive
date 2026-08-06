import { httpServerHandler } from 'cloudflare:node'
import { setCloudflareBindings } from '../cloud-relay/cloudflareBindings.js'

let relayHandlerPromise

export default {
  async fetch(request, env, context) {
    setCloudflareBindings(env)

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

    if (!relayHandlerPromise) {
      relayHandlerPromise = import('../cloud-relay/server.js').then(() =>
        httpServerHandler({ port: 8787 }),
      )
    }
    const relayHandler = await relayHandlerPromise
    return relayHandler.fetch(request, env, context)
  },
}
