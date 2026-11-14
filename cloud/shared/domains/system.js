/*
 * The system capability domain: this Mac's own dials — volume, brightness,
 * battery, clipboard, keyboard language — and the owner's standing settings
 * for them.
 */
export default Object.freeze({
  name: 'system',
  what: 'Mac volume, brightness, battery, clipboard, keyboard language — and the owner’s standing levels.',

  tools: Object.freeze({
    exact: Object.freeze([
      'set_volume',
      'get_volume',
      'set_mute',
      'set_brightness',
      'get_brightness',
      'get_battery',
      'get_mac_status',
      'get_clipboard',
      'copy_to_clipboard',
      'set_clipboard',
      'set_input_source',
      'get_input_source',
      'set_keyboard_language',
      'open_app',
      'open_url',
    ]),
    prefixes: Object.freeze([]),
  }),

  /*
   * Fact names under dom.system.*:
   *   level.<setting>   — a level the owner keeps returning to ("volume 30 at night")
   *   language.<label>  — a keyboard language the owner switches into
   */
  capture: Object.freeze([
    Object.freeze({
      id: 'system.input-language',
      action: 'set_input_source',
      param: 'language',
      name: (value) => `language.${value}`,
      scope: 'node',
    }),
  ]),

  clarify: Object.freeze([]),
})
