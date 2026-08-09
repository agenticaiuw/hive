/*
 * What the phone can actually do — the executor, and the only authority on it.
 *
 * This is the iOS node's answer to local-agent/computerControl.js: one dispatch
 * table, and everything the model is ever told about the phone's capabilities
 * is derived from it (see mobileDiscovery.js). Nothing restates the roster in
 * prose, so a tool cannot be added here and be missing from the prompt — the
 * failure mode that has already cost this repo three silent capability losses.
 *
 * WHY THE PHONE NEEDS ITS OWN TABLE AT ALL. Until now the iOS app had exactly
 * two ways to answer anything: src/agent.js, a regex that recognises three
 * sentence shapes, or a round trip to the Mac. Both are useless at 2am with the
 * laptop lid shut, which is precisely when the phone is the only node awake.
 * So the table below is split by what survives that:
 *
 *   hive, memory, mesh,         — reachable with a `mobile` device token alone.
 *   voice, phone                  These work with the Mac asleep. This is the
 *                                 part that makes the phone a node rather than
 *                                 a remote control. `mesh` is the sharpest case
 *                                 of it: until the node mesh existed, the only
 *                                 way this phone could reach the browser
 *                                 extension was to queue a mac:* job, i.e. only
 *                                 while the laptop was awake. Now the relay
 *                                 switches it, and the relay is awake by
 *                                 construction.
 *   mac                         — delegation. Queues a bridge job, so it is
 *                                 dead while the Mac is offline, and the model
 *                                 is told so by mac_status rather than by
 *                                 discovering it through a timeout.
 *
 * WHAT IS DERIVED. `needs` on each tool is the list of relay scopes the tool's
 * HTTP calls actually require, and the catalogue filters the prompt by the
 * scopes the LIVE credential reports. Revoke a scope, or pair a narrower role,
 * and the model simply stops being offered the tool — no second list to edit,
 * and no prompt that advertises a capability the token cannot exercise.
 *
 * NO PER-TOOL GUARDRAILS. Standing policy on this project: every tool is
 * enabled and the model calls it. There is no allow/deny table, no "read-only
 * tools run freely, write tools need confirmation" split. The model asks for
 * permission when it is about to act beyond what the owner requested, and that
 * judgement lives in the prompt (mobileBrain.js), not in a switch here.
 */
import { drainMeshInbox, takeBufferedMeshMail } from './meshMailbox.js'

/* Scope names as the relay spells them; cloud-relay/deviceAuth.js is the
 * authority and this file only ever compares against what a credential says it
 * holds, so a rename there degrades to "tool not offered", never to a tool that
 * is offered and 403s. */
export const RELAY_SCOPES = Object.freeze({
  STATE_READ: 'state:read',
  PRODUCT_READ: 'product:read',
  PRODUCT_WRITE: 'product:write',
  DEVICE_STATUS: 'device:status:read',
  MAC_PLAN: 'mac:plan',
  MAC_EXECUTE: 'mac:execute',
  MAC_JOBS: 'mac:jobs:read',
  SPEECH_SYNTHESIZE: 'speech:synthesize',
  NODE_SEND: 'node:message:send',
  NODE_RECEIVE: 'node:message:receive',
})

const DEFAULT_ACCOUNT_ID = 'single-owner'

/*
 * Shelf labels. The one thing in this file written for a reader rather than
 * derived, and — as on the Mac — the entire basis on which the model decides
 * where to look. Name the subject the owner would say out loud, not the module.
 */
export const MOBILE_DOMAIN_NOTES = Object.freeze({
  hive: 'What the other nodes are doing right now: the Mac, the pendant, the relay, the browser.',
  mac: "The owner's Mac, when it is awake: run anything it can do, or check whether it is reachable.",
  memory: 'Remember something for later, or recall what was said on any device.',
  mesh: 'Message another node directly — the Mac, the browser, the pendant, the relay — and read what they sent you. Works while the Mac is asleep.',
  phone: 'This phone itself: battery, network, clipboard, location, time, opening a link.',
  voice: 'Say something out loud through the phone.',
  /* Never written to by hand — populated only when a tool declares a domain
   * this map has no label for, so a taxonomy that falls behind the executor is
   * visible instead of silent. */
  uncategorised: 'Tools whose domain has no description yet.',
})

/* ------------------------------------------------------------------ helpers */

function requireClient(ctx) {
  if (!ctx?.client) {
    throw new Error('This tool needs a relay client. The phone is not paired.')
  }
  return ctx.client
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max)
}

/*
 * A tool result is always JSON-serialisable and always small enough to put back
 * into a prompt. Tools return the shape they want; this is the last chance to
 * stop a 200 KB hive snapshot from becoming a 200 KB prompt.
 */
export const TOOL_RESULT_MAX_CHARS = 6000

export function summariseToolResult(value) {
  const encoded = JSON.stringify(value ?? null)
  if (encoded.length <= TOOL_RESULT_MAX_CHARS) return value
  return {
    truncated: true,
    note: `Result was ${encoded.length} characters; the first ${TOOL_RESULT_MAX_CHARS} are below. Ask for a narrower slice if you need more.`,
    preview: encoded.slice(0, TOOL_RESULT_MAX_CHARS),
  }
}

/* ------------------------------------------------------------- the dispatch */

/**
 * Every tool the phone can run.
 *
 * Each entry:
 *   domain      which shelf it sits on
 *   description full prose, level 3 of discovery
 *   params      parameter hints, level 3 of discovery
 *   needs       relay scopes the call requires; [] means it needs no network
 *   run         (params, ctx) => JSON-serialisable result
 *
 * `ctx` carries { client, deviceId, accountId, sessionId, platform }. `client`
 * is src/cloudClient.js — the same paired-credential client the rest of the app
 * uses, so every call below is authenticated by the phone's own `mobile` token
 * and nothing here has ever seen the administrator key.
 */
export const MOBILE_TOOLS = Object.freeze({
  /* ---------------------------------------------------------------- hive */
  hive_read: {
    domain: 'hive',
    description:
      "Read one key out of the hive's shared state store. Start with key 'hive' — that snapshot lists every node, its up/down status and the reason, the live source feeds, and what is shared between nodes, so it tells you what other keys are worth asking for. Key 'agent-snapshot' is the Mac's own world model. This works while the Mac is asleep; the relay holds the last snapshot each node pushed.",
    params: {
      key: "state key, e.g. 'hive' or 'agent-snapshot'",
      path: "optional dotted path into the document, e.g. 'nodes' or 'shared.fleet', to avoid pulling the whole thing",
    },
    needs: [RELAY_SCOPES.STATE_READ],
    async run(params, ctx) {
      const key = text(params?.key || 'hive', 120)
      const document = await requireClient(ctx).readSharedState(key)
      const picked = params?.path ? pickPath(document, String(params.path)) : document
      return {
        key,
        path: params?.path ?? null,
        value: summariseToolResult(picked),
      }
    },
  },

  /* ----------------------------------------------------------------- mac */
  mac_status: {
    domain: 'mac',
    description:
      'Is the Mac reachable right now? Returns whether the relay currently holds a live socket from the Mac bridge, and when each registered device was last seen. Ask this BEFORE planning anything through mac_run, and if it says the Mac is offline, solve the request with the tools that do not need it, or tell the owner plainly that this one needs the laptop awake.',
    params: {},
    needs: [RELAY_SCOPES.DEVICE_STATUS],
    async run(_params, ctx) {
      const client = requireClient(ctx)
      const [presence, devices] = await Promise.all([
        client.bridgePresence().catch((error) => ({ error: error.message })),
        client.deviceStatus().catch((error) => ({ error: error.message })),
      ])
      return {
        macReachable: presence?.connected === true,
        presence,
        devices: (devices?.devices || []).map((device) => ({
          deviceId: device.deviceId,
          deviceType: device.deviceType,
          online: device.online,
          lastSeenAt: device.lastSeenAt,
        })),
      }
    },
  },

  mac_preview: {
    domain: 'mac',
    description:
      "Ask the Mac what it WOULD do for a request, without running it. Send one plain-English instruction; the Mac's own planner answers with the steps it would take, using its full tool library. Use this when you want to show the owner the steps first, or when you are unsure the Mac can do a thing at all.",
    params: { command: 'one plain-English instruction for the Mac' },
    needs: [RELAY_SCOPES.MAC_PLAN, RELAY_SCOPES.MAC_JOBS],
    async run(params, ctx) {
      const command = text(params?.command, 2000)
      if (!command) throw new Error('mac_preview needs a command.')
      const job = await requireClient(ctx).requestPlan(command, ctx?.sessionId)
      return {
        status: job.status,
        plan: summariseToolResult(job.result ?? null),
        error: job.error ?? null,
        planJobId: job.jobId ?? null,
      }
    },
  },

  mac_run: {
    domain: 'mac',
    description:
      "Have the Mac carry out a request end to end. Send ONE plain-English instruction — not a list of steps and not a tool name. The Mac has its own planner and its own full tool library (screen, browser, files, email, calendar, shell, its own iPhone control); it decides how. Do not try to spell out its steps for it, and do not enumerate its tools: you do not have that list and it does not need it from you. Requires the Mac to be awake — check mac_status first.",
    params: {
      command: 'one plain-English instruction for the Mac',
    },
    needs: [
      RELAY_SCOPES.MAC_PLAN,
      RELAY_SCOPES.MAC_EXECUTE,
      RELAY_SCOPES.MAC_JOBS,
    ],
    async run(params, ctx) {
      const command = text(params?.command, 2000)
      if (!command) throw new Error('mac_run needs a command.')
      const client = requireClient(ctx)

      const planJob = await client.requestPlan(command, ctx?.sessionId)
      if (planJob.status === 'failed') {
        return { ran: false, stage: 'plan', error: planJob.error ?? 'The Mac could not plan that.' }
      }

      const plan = planJob.result ?? {}
      /* The Mac answered without needing to touch anything — that IS the
       * result, and running an empty action list would only cost a round trip. */
      if (plan.status === 'instant' || !Array.isArray(plan.actions) || !plan.actions.length) {
        return {
          ran: false,
          stage: 'plan',
          macAnswer: text(plan.response, 2000),
          macStatus: plan.status ?? null,
          error: plan.error ?? null,
        }
      }

      const executeJob = await client.executePlan({
        command,
        actions: plan.actions,
        planJobId: planJob.jobId,
        sessionId: ctx?.sessionId,
      })
      if (executeJob.status === 'failed') {
        return { ran: false, stage: 'execute', error: executeJob.error ?? 'The Mac failed to run that.' }
      }

      const payload = executeJob.result ?? {}
      return {
        ran: true,
        steps: (plan.actions || []).map((action) => action.label || action.type),
        results: summariseToolResult(
          (payload.results || []).map((item) => ({
            ok: item.ok ?? null,
            message: text(item.message, 800),
          })),
        ),
      }
    },
  },

  /* -------------------------------------------------------------- memory */
  memory_recall: {
    domain: 'memory',
    description:
      "What has been said or saved before, across every device the owner uses. Searches the shared product store: saved facts, and the turns of past conversations. Leave `query` empty to get the most recent turns, which is what you want for 'what were we just doing'.",
    params: {
      query: 'optional words to match; omit for the most recent activity',
      limit: 'how many records, 1-30, default 12',
    },
    needs: [RELAY_SCOPES.PRODUCT_READ],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const state = await client.getProductState(ctx?.accountId || DEFAULT_ACCOUNT_ID)
      const query = text(params?.query, 200).toLowerCase().trim()
      const limit = clamp(params?.limit, 1, 30, 12)

      const facts = (state?.memory?.entities || [])
        .filter((entity) => !entity.deletedAt)
        .map((entity) => ({
          id: entity.id,
          name: entity.name ?? null,
          kind: entity.kind ?? null,
          observations: entity.observations ?? entity.content ?? null,
          updatedAt: entity.updatedAt,
        }))

      const turns = (state?.sessions || [])
        .filter((session) => !session.deletedAt)
        .flatMap((session) =>
          (session.turns || [])
            .filter((turn) => !turn.deletedAt)
            .map((turn) => ({
              sessionId: session.sessionId,
              sessionTitle: session.title ?? null,
              role: turn.role,
              content: text(turn.content, 600),
              updatedAt: turn.updatedAt,
              sourceDeviceId: turn.sourceDeviceId ?? null,
            })),
        )

      const matches = (record) =>
        !query || JSON.stringify(record).toLowerCase().includes(query)
      const newestFirst = (left, right) =>
        String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))

      return summariseToolResult({
        query: query || null,
        facts: facts.filter(matches).sort(newestFirst).slice(0, limit),
        turns: turns.filter(matches).sort(newestFirst).slice(0, limit),
        totals: { facts: facts.length, turns: turns.length },
      })
    },
  },

  memory_save: {
    domain: 'memory',
    description:
      'Remember something so any device can recall it later — the Mac, the pendant and the browser read the same store. Save the fact itself, in the words that will still make sense in a month, not a summary of this conversation.',
    params: {
      name: 'short label for the thing being remembered',
      kind: "optional category, e.g. 'preference', 'person', 'project'",
      observations: 'one string, or an array of strings, of what to remember',
    },
    needs: [RELAY_SCOPES.PRODUCT_READ, RELAY_SCOPES.PRODUCT_WRITE],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const accountId = ctx?.accountId || DEFAULT_ACCOUNT_ID
      const name = text(params?.name, 200).trim()
      if (!name) throw new Error('memory_save needs a name.')

      const observations = (
        Array.isArray(params?.observations)
          ? params.observations
          : [params?.observations]
      )
        .map((observation) => text(observation, 1000).trim())
        .filter(Boolean)
      if (!observations.length) {
        throw new Error('memory_save needs at least one observation.')
      }

      const state = await client.getProductState(accountId)
      const now = new Date().toISOString()
      const entity = {
        id: `mem-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
        name,
        kind: text(params?.kind, 60) || 'note',
        observations,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        sourceDeviceId: ctx?.deviceId ?? null,
      }

      const saved = await client.saveProductState({
        ...state,
        accountId,
        sourceDeviceId: ctx?.deviceId ?? state?.sourceDeviceId ?? null,
        revision: Number(state?.revision || 0) + 1,
        generatedAt: now,
        sessions: state?.sessions || [],
        memory: {
          entities: [...(state?.memory?.entities || []), entity],
          relations: state?.memory?.relations || [],
        },
      })

      return { saved: true, id: entity.id, name, revision: saved?.revision ?? null }
    },
  },

  /* ---------------------------------------------------------------- mesh */
  mesh_send: {
    domain: 'mesh',
    description:
      'Send a message straight to another node — the Mac, the browser extension, the pendant, or the relay\'s own brain at "@relay". The relay queues it durably, so a node that is asleep gets it when it wakes, and the answer says which happened. The receiver can trust who sent it: the relay stamps the sender from this phone\'s credential.',
    params: {
      to: 'the receiving node\'s deviceId, or "@relay" for the relay\'s brain',
      kind: 'what to do, as a dotted lowercase verb: "ios.notify", "browser.tab.open"',
      payload: 'a JSON object, under 64 KiB serialised — send a reference, not a file',
      correlationId: 'optional: the id of the message you are answering',
      ttlMs: 'optional: how long it stays deliverable. Default 10 minutes, max 24 hours',
    },
    needs: [RELAY_SCOPES.NODE_SEND],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const to = text(params?.to, 128).trim()
      const kind = text(params?.kind, 64).trim()
      if (!to) throw new Error('mesh_send needs a `to` address.')
      if (!kind) throw new Error('mesh_send needs a `kind`.')

      const payload =
        params?.payload && typeof params.payload === 'object' && !Array.isArray(params.payload)
          ? params.payload
          : { text: text(params?.payload, 2000) }

      const sent = await client.sendNodeMessage({
        to,
        kind,
        payload,
        correlationId: params?.correlationId ?? null,
        ttlMs: Number(params?.ttlMs) || null,
      })
      return {
        messageId: sent?.messageId ?? null,
        to: sent?.to ?? to,
        from: sent?.from ?? null,
        expiresAt: sent?.expiresAt ?? null,
        /* Which of the two really happened, rather than a cheerful "sent". */
        delivered: sent?.pushed === true,
        note:
          sent?.pushed === true
            ? 'That node was connected and has it now.'
            : 'That node is not connected; the relay is holding it until it is.',
      }
    },
  },

  mesh_inbox: {
    domain: 'mesh',
    description:
      "Read the messages other nodes have sent to this phone. Everything waiting comes back at once, already acknowledged so it will not arrive twice, and anything you have been shown before is filtered out for you. Each `from` is stamped by the relay and can be trusted.",
    params: {
      ack: 'optional, default true. false leaves the batch to be redelivered in about a minute',
    },
    needs: [RELAY_SCOPES.NODE_RECEIVE],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const ack = params?.ack !== false
      /* Whatever the doorbell already pulled down comes first: the socket
       * drains on its own, so the relay's copy is gone by the time a tool asks
       * for it. Without this, mail that arrived seconds ago reads as no mail. */
      const buffered = takeBufferedMeshMail()
      const drained = await drainMeshInbox({ client, deviceId: ctx?.deviceId, ack })
      const messages = [...buffered, ...drained.messages]

      return summariseToolResult({
        count: messages.length,
        messages: messages.map((envelope) => ({
          id: envelope.id,
          from: envelope.from,
          kind: envelope.kind,
          payload: envelope.payload,
          correlationId: envelope.corr ?? null,
          sentAt: envelope.createdAt,
        })),
        /* Not `pending`: the relay counts what it just leased to you, so that
         * number is non-zero the instant after a complete drain. */
        moreWaiting: drained.more,
        /*
         * Only when the caller asked not to ack, and only for the envelopes
         * this drain leased — anything that came out of the socket buffer was
         * acked by the listener already. A bare `acknowledged: 0` was the
         * alternative here and it was worse than useless: after a doorbell
         * drain it reads as "your mail was not acknowledged" when the mail was
         * acknowledged by someone else a second earlier.
         */
        ...(ack
          ? {}
          : {
              unacknowledged: drained.messages.map((envelope) => envelope.id),
              note: 'These are leased, not deleted. Call mesh_ack with these ids or they arrive again in about a minute.',
            }),
      })
    },
  },

  mesh_ack: {
    domain: 'mesh',
    description:
      'Acknowledge messages by id, deleting them from this phone\'s inbox. mesh_inbox does this already, so you only need it after reading with ack false. Acknowledging means "I have this", not "I did this" — never withhold one because a message could not be acted on, or it returns every minute forever.',
    params: { messageIds: 'array of message ids from mesh_inbox' },
    needs: [RELAY_SCOPES.NODE_RECEIVE],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const messageIds = (Array.isArray(params?.messageIds) ? params.messageIds : [params?.messageIds])
        .map((id) => text(id, 80).trim())
        .filter(Boolean)
      if (!messageIds.length) throw new Error('mesh_ack needs at least one message id.')
      const result = await client.ackNodeMessages(ctx?.deviceId, messageIds)
      return { acknowledged: Number(result?.acknowledged || 0), stillWaiting: Number(result?.pending || 0) }
    },
  },

  mesh_presence: {
    domain: 'mesh',
    description:
      'Is a node holding a live connection to the relay this second? Ask about any node by deviceId, or omit it for this phone. Answers with whether it is connected, how much mail is waiting for it, and whether the relay could observe it at all.',
    params: { deviceId: "which node; omit for this phone" },
    needs: [RELAY_SCOPES.DEVICE_STATUS],
    async run(params, ctx) {
      const client = requireClient(ctx)
      const deviceId = text(params?.deviceId, 128).trim() || String(ctx?.deviceId ?? '')
      if (!deviceId) throw new Error('mesh_presence needs a deviceId.')
      const presence = await client.nodePresence(deviceId)
      return {
        deviceId,
        connected: presence?.connected === true,
        /* False means the relay could not reach that node's hub to ask. It is
         * NOT "offline", and the difference is the whole reason the field is
         * here — see the working rule in mobileBrain.js. */
        observed: presence?.observed === true,
        sockets: Number(presence?.sockets || 0),
        connectedSince: presence?.since ?? null,
        mailWaiting: Number(presence?.pending || 0),
      }
    },
  },

  /* --------------------------------------------------------------- voice */
  speak: {
    domain: 'voice',
    description:
      'Say something out loud through the phone, now, without ending your turn. Use it to keep the owner with you during a long job ("checking the Mac, one moment"). Your final answer is spoken automatically — do not speak it twice.',
    params: { text: 'what to say', language: "optional language code, e.g. 'en' or 'ko'" },
    needs: [RELAY_SCOPES.SPEECH_SYNTHESIZE],
    async run(params, ctx) {
      const said = text(params?.text, 600).trim()
      if (!said) throw new Error('speak needs text.')
      await ctx?.speak?.(said, { language: params?.language })
      return { spoke: said }
    },
  },

  /* --------------------------------------------------------------- phone */
  phone_status: {
    domain: 'phone',
    description:
      'This phone, right now: local time and time zone, language, whether it has a network at all, battery level and charging state when the platform reports them, and whether the app is in the foreground. Ask this before assuming anything about connectivity or the hour.',
    params: {},
    needs: [],
    async run(_params, ctx) {
      const navigatorRef = ctx?.navigator ?? globalThis.navigator
      const now = new Date()
      const battery = await readBattery(navigatorRef)
      return {
        localTime: now.toString(),
        isoTime: now.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
        language: navigatorRef?.language ?? null,
        online: navigatorRef?.onLine ?? null,
        platform: ctx?.platform ?? 'web',
        appActive: ctx?.appActive ?? null,
        battery,
      }
    },
  },

  phone_clipboard_read: {
    domain: 'phone',
    description:
      "Read what is on this phone's clipboard. iOS shows the owner a paste banner when this happens, so it is never silent.",
    params: {},
    needs: [],
    async run(_params, ctx) {
      const clipboard = (ctx?.navigator ?? globalThis.navigator)?.clipboard
      if (!clipboard?.readText) throw new Error('This phone exposes no clipboard read.')
      return { clipboard: text(await clipboard.readText(), 4000) }
    },
  },

  phone_clipboard_write: {
    domain: 'phone',
    description: "Put text on this phone's clipboard so the owner can paste it anywhere.",
    params: { text: 'what to copy' },
    needs: [],
    async run(params, ctx) {
      const clipboard = (ctx?.navigator ?? globalThis.navigator)?.clipboard
      if (!clipboard?.writeText) throw new Error('This phone exposes no clipboard write.')
      const copied = text(params?.text, 4000)
      await clipboard.writeText(copied)
      return { copied: copied.length }
    },
  },

  phone_location: {
    domain: 'phone',
    description:
      'Where the phone is, from the OS location service. iOS prompts the owner the first time. Use it when the answer depends on where they are — the weather here, how far away something is — not as a default.',
    params: { highAccuracy: 'true for GPS-grade accuracy, slower and costlier' },
    needs: [],
    async run(params, ctx) {
      const geolocation = (ctx?.navigator ?? globalThis.navigator)?.geolocation
      if (!geolocation?.getCurrentPosition) {
        throw new Error('This phone exposes no location service.')
      }
      const position = await new Promise((resolve, reject) => {
        geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: Boolean(params?.highAccuracy),
          timeout: 15000,
          maximumAge: 60000,
        })
      })
      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMetres: position.coords.accuracy,
        at: new Date(position.timestamp).toISOString(),
      }
    },
  },

  phone_open_url: {
    domain: 'phone',
    description:
      'Open a link on this phone, in the browser or in whichever app claims the scheme. This puts something on the owner\'s screen, so it is an action, not a lookup.',
    params: { url: 'absolute URL, including https://' },
    needs: [],
    async run(params, ctx) {
      const url = text(params?.url, 2000).trim()
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        throw new Error('phone_open_url needs an absolute URL.')
      }
      const open = ctx?.openUrl ?? ((target) => globalThis.open?.(target, '_blank'))
      await open(url)
      return { opened: url }
    },
  },

  phone_haptic: {
    domain: 'phone',
    description:
      'Buzz the phone. A way to reach the owner when the screen is not being watched and speech would be intrusive.',
    params: { style: "'light', 'medium' or 'heavy'" },
    needs: [],
    async run(params, ctx) {
      const style = ['light', 'medium', 'heavy'].includes(String(params?.style))
        ? String(params.style)
        : 'medium'
      if (!ctx?.haptic) throw new Error('This phone exposes no haptics.')
      await ctx.haptic(style)
      return { buzzed: style }
    },
  },
})

/* --------------------------------------------------------------- execution */

export const MOBILE_TOOL_TYPES = Object.freeze(Object.keys(MOBILE_TOOLS).sort())

export function isMobileTool(type) {
  return Object.hasOwn(MOBILE_TOOLS, String(type ?? ''))
}

/**
 * Run one tool.
 *
 * Failure is a RESULT, not an exception: the loop's next turn shows the model
 * what went wrong and lets it choose differently, which is the whole reason a
 * brain beats a plan. An unknown type is the same kind of result, and names the
 * tools that do exist so the retry can be right.
 */
export async function runMobileTool(type, params = {}, ctx = {}) {
  const name = String(type ?? '')
  const tool = MOBILE_TOOLS[name]
  if (!tool) {
    return {
      tool: name,
      ok: false,
      error: `No such tool: ${name}.`,
      available: MOBILE_TOOL_TYPES,
    }
  }

  const startedAt = Date.now()
  try {
    const result = await tool.run(params ?? {}, ctx)
    return { tool: name, ok: true, ms: Date.now() - startedAt, result }
  } catch (error) {
    return {
      tool: name,
      ok: false,
      ms: Date.now() - startedAt,
      error: text(error?.message || String(error), 600),
      /*
       * The relay's machine-readable half, when it sent one. Two 403s that read
       * almost identically in prose need completely different answers:
       * `credential_predates_capability` means this credential was minted
       * with an explicit scope ceiling that leaves this out (ordinary
       * credentials track their role's live scopes since 9c5c859), so
       * RE-PAIRING WITH A WIDER SCOPE LIST FIXES IT, while `scope_denied`
       * means re-pairing will not help. Keying on message text is how a client ends
       * up telling an owner to re-pair forever, so the code travels and the
       * text does not have to be parsed.
       */
      ...(error?.code ? { code: String(error.code) } : {}),
    }
  }
}

/* ------------------------------------------------------------------ paths */

/* Dotted path lookup for hive_read, so the model can ask for `shared.fleet`
 * instead of pulling a 200 KB snapshot to read six fields. Array indices are
 * numeric segments. A miss returns undefined, which serialises to null and
 * reads to the model as "not there" rather than as an error. */
export function pickPath(document, path) {
  const segments = String(path ?? '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  let cursor = document
  for (const segment of segments) {
    if (cursor == null) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

async function readBattery(navigatorRef) {
  if (typeof navigatorRef?.getBattery !== 'function') return null
  try {
    const battery = await navigatorRef.getBattery()
    return {
      level: typeof battery.level === 'number' ? Math.round(battery.level * 100) : null,
      charging: battery.charging ?? null,
    }
  } catch {
    /* Safari does not implement getBattery. Absent is honest; a guess is not. */
    return null
  }
}
