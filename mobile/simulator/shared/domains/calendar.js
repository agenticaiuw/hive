/*
 * The calendar capability domain: reminders, meetings, day plans, focus
 * blocks — and the lists and calendars the owner actually files them on.
 */
export default Object.freeze({
  name: 'calendar',
  what: 'Reminders, meetings, day plans, focus blocks, and which list or calendar they land on.',

  tools: Object.freeze({
    exact: Object.freeze([
      'create_reminder',
      'remind_me',
      'plan_my_day',
      'prepare_for_meeting',
      'meeting_followup',
      'schedule_routine',
      'start_focus_session',
      'end_focus_session',
    ]),
    prefixes: Object.freeze([]),
  }),

  /*
   * Fact names under dom.calendar.*:
   *   list.<label>   — a Reminders list the owner files into
   *   list.default   — where reminders go when they do not say
   *   task.<slug>    — a repeated scheduling shape
   */
  capture: Object.freeze([
    Object.freeze({
      id: 'calendar.list-from-action',
      /* A reminder filed onto a NAMED list is the owner teaching us where that
       * kind of thing goes; the same connection gets used again. */
      action: 'create_reminder',
      param: 'list',
      name: (value) => `list.${value}`,
      scope: 'hive',
    }),
  ]),

  clarify: Object.freeze([
    Object.freeze({
      id: 'calendar.list',
      trigger: /\b(remind(er)?s?|todo|to-do)\b/i,
      distinguisher: 'list',
      ask: (labels) => `Which list should that go on — ${labels.join(', ')}?`,
    }),
  ]),
})
