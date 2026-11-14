/**
 * The transport rule for "Ask the hive" — one composer, decided per submission.
 *
 * Extracted into this dependency-free module (no $app, no fetch) so the node
 * test suite can import the exact code the component runs, not a description
 * of it.
 *
 * The rule, derived from how the two pre-merge boxes decided:
 *
 *  - TYPED commands go LOCAL exactly when the page is served by the Mac agent
 *    itself (the build with `kit.paths.base === "/dashboard"`, which is what
 *    `$lib/dataSource` reads as `backend === "agent"`): same-origin
 *    `POST /plan` / `POST /execute` with the loopback session. Every other
 *    surface has no route to the Mac at all, so typed commands go through this
 *    app's `/api/command` server route, which holds the relay key.
 *
 *  - VOICE is always the relay: the browser-speech pipeline is
 *    `/api/command/audio` (Workers AI transcription, then the same relay plan
 *    job), and that server route exists only on the Worker build. The Mac
 *    agent serves no transcription route, so there is no local voice
 *    transport to claim — on the agent build the mic is disabled with the
 *    reason, rather than recording audio that has nowhere to go.
 */

/** @typedef {"agent" | "relay"} Backend */
/** @typedef {"local" | "relay"} CommandTransport */
/** @typedef {"typed" | "voice"} CommandKind */

/**
 * Which transport carries a submission of `kind` on a page served by
 * `backend`.
 *
 * @param {Backend} backend
 * @param {CommandKind} kind
 * @returns {CommandTransport}
 */
export function transportFor(backend, kind) {
  if (kind === "voice") return "relay";
  return backend === "agent" ? "local" : "relay";
}

/**
 * Whether this build has a voice pipeline at all. Only the Worker build does:
 * `/api/command/audio` is a server route, and the Mac agent has no
 * speech-to-text route of its own.
 *
 * @param {Backend} backend
 * @returns {boolean}
 */
export function voiceAvailable(backend) {
  return backend === "relay";
}

/**
 * The per-submission badge shown on a submission's status card. Recorded at
 * dispatch time from the transport that actually carried that submission —
 * never a page-level constant, so it cannot drift from what happened.
 *
 * @param {CommandTransport} transport
 * @param {CommandKind} kind
 * @returns {{ label: string, title: string }}
 */
export function submissionBadge(transport, kind) {
  if (transport === "local") {
    return {
      label: "via this Mac",
      title:
        "This submission ran same-origin through the Mac agent's /plan and /execute routes with the loopback session. The relay was not involved.",
    };
  }
  if (kind === "voice") {
    return {
      label: "via relay",
      title:
        "This recording went to the dashboard's own /api/command/audio server route: Workers AI transcribed it, then the transcript became a relay plan job for the Mac. The relay key never reached this browser.",
    };
  }
  return {
    label: "via relay",
    title:
      "This submission went through the dashboard's own /api/command server route, which created the relay plan job with a server-held key and polled it. The relay key never reached this browser.",
  };
}
