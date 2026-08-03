/**
 * Stand-in for the `cloudflare:workers` module the adapter's Worker entry
 * imports. Under `node --test` there is no workerd, and nothing in this app
 * reads the module-scoped `env` — bindings arrive per request through
 * `event.platform.env`, which the tests supply directly.
 */
export const env = {};

export class WorkerEntrypoint {}
export class DurableObject {}
export class RpcTarget {}
