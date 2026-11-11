/*
 * The browser capability domain: live web pages in the owner's signed-in
 * browser — and which sites the owner actually uses for what.
 *
 * Membership covers BOTH executors' vocabularies: the Mac planner's browser_*
 * action family and the extension executor's bare verbs (bridge-core
 * COMMAND_TYPES). The bare names are listed exactly, minus `scroll`, which the
 * Mac executor also dispatches as desktop input — a brain that only speaks
 * browser verbs claims the remainder through domainForTool's fallback instead.
 */
export default Object.freeze({
  name: 'browser',
  what: 'Live web pages in the logged-in browser: tabs, forms, reads — and the sites the owner uses.',

  tools: Object.freeze({
    exact: Object.freeze([
      'watch_page',
      /* extension executor verbs (bridge-core COMMAND_TYPES) */
      'activate_tab',
      'navigate',
      'snapshot',
      'read_page',
      'click',
      'type',
      'select',
      'press_key',
      'wait_for',
      'list_tabs',
      'capture',
    ]),
    prefixes: Object.freeze(['browser_']),
  }),

  /*
   * Fact names under dom.browser.*:
   *   site.<label>   — a site the owner actually works in (acted on, not just read)
   *   task.<slug>    — a repeated browser task shape
   */
  capture: Object.freeze([]),

  clarify: Object.freeze([
    Object.freeze({
      id: 'browser.site',
      /* "order it again", "log my hours" — a site-shaped request that names no
       * site, against several known candidates and no default. */
      trigger: /\b(order|checkout|log in|login|sign in|book|reserve)\b/i,
      distinguisher: 'site',
      ask: (labels) => `On which site — ${labels.join(', ')}?`,
    }),
  ]),
})
