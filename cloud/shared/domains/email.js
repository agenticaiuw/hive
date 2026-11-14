/*
 * The email capability domain.
 *
 * The owner, 2026-08-12, on why domains exist at all: "the tools for reading
 * emails are in the same folder as the memories for email preferences." A
 * domain module is that folder: the email verbs every executor dispatches, the
 * memory names email facts live under, what is worth capturing about email
 * use, and the one question worth asking before acting on an ambiguous email
 * request.
 *
 * The owner's own worked example lives here: "which email account is personal
 * vs school vs club" is an `account.*` fact, and "check my email" against
 * three known accounts and no `account.default` is the clarification case.
 */
export default Object.freeze({
  name: 'email',
  what: 'Send or draft email, triage the inbox, and the accounts and people mail goes to.',

  /* Mac executor action types. Browser email work rides browser_* verbs and
   * belongs to the browser domain; what makes it EMAIL again is the memory the
   * planner attaches when the request says so. */
  tools: Object.freeze({
    exact: Object.freeze(['send_email', 'triage_inbox', 'triage_notifications']),
    prefixes: Object.freeze([]),
  }),

  /*
   * Fact names under dom.email.*:
   *   account.<label>   — an address the owner owns ("personal", "school", "club")
   *   account.default   — which label wins when they do not say
   *   contact.<slug>    — a person mail actually went to
   *   task.<slug>       — a repeated email task shape
   */
  capture: Object.freeze([
    Object.freeze({
      id: 'email.account-from-command',
      /* "my school email is liu@uni.edu" — the identity capture the owner
       * described: save it because the same connection will be used again. */
      pattern:
        /\bmy\s+(?<label>[\p{L}\p{N}-]{2,24})\s+(?:email|e-mail|mail|account)\s+(?:address\s+)?(?:is|=)\s+(?<value>[^\s@]+@[^\s@]+\.[\p{L}\p{N}-]+)/iu,
      name: (groups) => `account.${groups.label.toLowerCase()}`,
      value: (groups) => groups.value,
      scope: 'hive',
    }),
  ]),

  clarify: Object.freeze([
    Object.freeze({
      id: 'email.account',
      /* Generic email request — no account named in it. */
      trigger: /\b(email|e-mail|mail|inbox)\b/i,
      distinguisher: 'account',
      ask: (labels) => `Which email account should I use — ${labels.join(', ')}?`,
    }),
  ]),
})
