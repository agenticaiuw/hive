/*
 * The wiring: everything the loop needs to run inside the actual app.
 *
 * mobileBrain.js is deliberately pure — you hand it an `infer` function and a
 * context of capabilities and it never touches Capacitor, the DOM or the
 * network directly. That is what lets the whole loop be tested with no
 * network. This file is the other half: it assembles the real context out of
 * the real device, and it is the only place in src/brain/ that imports a
 * platform plugin.
 *
 * It also refreshes the credential's scopes on every run rather than caching
 * them. Re-pairing the phone — which is what an owner does after a revoke, or
 * after the relay widens a role — must widen what the brain is offered on the
 * very next command, not after an app restart.
 */
import { Capacitor } from '@capacitor/core'
import { createMeshListener } from './meshMailbox.js'
import { runMobileBrain } from './mobileBrain.js'
import { createRelayInference } from './relayInference.js'

/**
 * @param client      src/cloudClient.js, already holding the paired credential
 * @param deviceId    this phone's stable id
 * @param accountId   product-state account for memory tools
 * @param speak       (text, {language}) => void — the app's own speech path,
 *                    so a mid-loop `speak` sounds identical to a final answer
 */
export function createPhoneBrainSession({
  client,
  deviceId,
  accountId = undefined,
  speak = null,
  inferencePath = undefined,
} = {}) {
  if (!client) throw new TypeError('createPhoneBrainSession needs a cloud client.')

  const infer = createRelayInference({
    client,
    ...(inferencePath ? { path: inferencePath } : {}),
  })

  return {
    /*
     * Hold the mesh doorbell open, and hand back the stop.
     *
     * Deliberately NOT started by this factory. The session is built in a
     * useMemo and rebuilt whenever the client is, so a socket opened here would
     * be a socket leaked on every rebuild; the caller owns the lifetime because
     * only the caller knows when it ends. One effect is the whole wiring:
     *
     *   useEffect(() => phoneBrain.startMeshListener(), [phoneBrain])
     *
     * Without it the mesh still works — mesh_inbox drains over HTTP whenever
     * the model asks — but only when the model thinks to ask. The doorbell is
     * what makes a message from another node arrive rather than be found.
     */
    startMeshListener({ onMail = null, onStatus = null } = {}) {
      return createMeshListener({ client, deviceId, onMail, onStatus })
    },

    async run(command, { sessionId = null, onProgress = null, confirm = null, maxSteps } = {}) {
      const credential = await client.credentialSummary()

      return runMobileBrain({
        command,
        infer,
        onProgress,
        confirm,
        ...(maxSteps ? { maxSteps } : {}),
        /* null when the phone is not paired: the catalogue treats that as
         * "unknown" and offers everything rather than reporting a phone that
         * can do nothing. The first tool call then fails honestly. */
        scopes: credential.paired ? credential.scopes : null,
        ctx: {
          client,
          deviceId,
          accountId,
          sessionId,
          credential,
          platform: Capacitor.getPlatform?.() ?? 'web',
          navigator: globalThis.navigator,
          speak: speak ? (text, options) => speak(text, options) : null,
          haptic: buzz,
          openUrl: (url) => {
            globalThis.open?.(url, '_blank', 'noopener')
          },
        },
      })
    },
  }
}

/*
 * Haptics are a nice-to-have, and a phone that cannot buzz must not be a phone
 * that cannot think. The import is dynamic so a web build without the plugin
 * costs nothing, and every failure below degrades to "no buzz".
 */
async function buzz(style = 'medium') {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
    const impact =
      { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy }[style] ??
      ImpactStyle.Medium
    await Haptics.impact({ style: impact })
  } catch {
    globalThis.navigator?.vibrate?.(style === 'heavy' ? 60 : style === 'light' ? 15 : 30)
  }
}
