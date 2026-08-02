import { httpServerHandler } from 'cloudflare:node'
import { setCloudflareBindings } from '../cloud-relay/cloudflareBindings.js'

let relayHandlerPromise

export default {
  async fetch(request, env, context) {
    setCloudflareBindings(env)
    if (!relayHandlerPromise) {
      relayHandlerPromise = import('../cloud-relay/server.js').then(() =>
        httpServerHandler({ port: 8787 }),
      )
    }
    const relayHandler = await relayHandlerPromise
    return relayHandler.fetch(request, env, context)
  },
}
